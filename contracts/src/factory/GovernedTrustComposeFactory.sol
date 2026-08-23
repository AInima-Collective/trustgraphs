// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {
    SignerSyncZkModule,
    ISignerSyncCheckpointSource,
    ISignerActivitySource
} from "src/zodiac/SignerSyncZkModule.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

/// @title GovernedTrustComposeFactory
/// @notice Creates a trust-compose instance and a module-only DAO Safe as one transaction — the
///         `GovernedTrustgraphsFactory` shape applied to the `trust-compose` program.
/// @dev The base `TrustComposeFactory` remains the canonical instance creator and the only holder
///      of `REGISTRAR_ROLE`; this wrapper temporarily owns a fresh one-owner Safe, has that Safe
///      call `createInstance` (so the Safe is the creator AND the admin), installs the
///      snapshot-specific governance module through the shared `MerkleGovModuleDeployer`, a 14-day
///      recovery module, and a permanently sealed owner-execution guard, then swaps itself out.
///      `MerkleGovModule` is program-agnostic: the score-leaf encoding is identical across
///      trust-graph, weighted, and compose cores, and the hook only needs the constitutional role
///      the base factory grants the Safe. Emits the SAME `GovernedInstanceCreated`/
///      `GovernedAuthorityInstalled` signatures as every governed wrapper. Signer-sync is plumbed
///      (the deployer fails closed on a program-vkey mismatch) but no compose signer guest exists,
///      so the app does not offer it here.
contract GovernedTrustComposeFactory {
    address internal constant SENTINEL_OWNERS = address(0x1);
    uint48 public constant RECOVERY_DELAY = 14 days;
    uint256 public constant MEMBER_VOTING_DELAY = 1;
    uint256 public constant MEMBER_VOTING_PERIOD = 50_400;
    uint256 public constant MEMBER_EXECUTION_DELAY = 7_200;
    /// @notice Creation-time guardrail; the DAO may deliberately raise its cap later.
    uint96 public constant MAX_INITIAL_MAX_PER_ROOT_USD = 10_000e8;

    struct InitialPolicy {
        uint64 minPaidIntervalBlocks;
        uint96 maxPerRootUsd;
    }

    /// @notice Optional score-selected Safe owner rotation. Accepted and installed when supplied,
    ///         but the deployer refuses any verifier whose program vkey is not the supplied one —
    ///         and no compose signer guest exists yet, so the app does not offer this path.
    struct SignerSyncConfig {
        bool enabled;
        address verifier;
        bytes32 programVKey;
        uint32 topN;
        uint32 minThreshold;
        uint32 targetThresholdBps;
    }

    struct Authority {
        address safe;
        address governanceModule;
        address recoveryModule;
        address executionGuard;
        address initialRecoveryProposer;
        uint48 recoveryDelay;
        address signerSyncModule;
    }

    TrustComposeFactory public immutable FACTORY;
    GnosisSafeProxyFactory public immutable SAFE_FACTORY;
    address public immutable SAFE_SINGLETON;
    GovernedAuthorityDeployer public immutable AUTHORITY_DEPLOYER;
    SignerSyncModuleDeployer public immutable SIGNER_SYNC_DEPLOYER;
    MerkleGovModuleDeployer public immutable GOV_MODULE_DEPLOYER;

    mapping(bytes32 instanceId => Authority authority) private _authorities;

    error ZeroAddress();
    error SafeFundingFailed();
    error SafeExecutionFailed(address target, bytes data);
    error InstanceDiscoveryFailed(bytes32 instanceId);
    error PrepayRequiresPolicy();
    error PolicyRequiresPrepay();
    error PrepayUnavailable();
    error InitialPaidIntervalTooShort(uint64 supplied, uint64 minimum);
    error InitialCapTooHigh(uint96 supplied, uint96 maximum);
    error InitialFeeUnpriced(bytes32 program, uint8 band);
    error InitialCapBelowFee(uint96 supplied, uint256 feeUsd);
    error GovernanceDefaultsMismatch();

    event GovernedInstanceCreated(
        bytes32 indexed instanceId,
        address indexed creator,
        address indexed safe,
        address merkleGovModule,
        address snapshot
    );
    event GovernedAuthorityInstalled(
        bytes32 indexed instanceId,
        address indexed safe,
        address indexed executionGuard,
        address governanceModule,
        address recoveryModule,
        address recoveryProposer,
        uint48 recoveryDelay,
        address signerSyncModule
    );

    constructor(
        TrustComposeFactory factory_,
        GnosisSafeProxyFactory safeFactory_,
        address safeSingleton_,
        GovernedAuthorityDeployer authorityDeployer_,
        SignerSyncModuleDeployer signerSyncDeployer_,
        MerkleGovModuleDeployer govModuleDeployer_
    ) {
        if (
            address(factory_) == address(0) || address(safeFactory_) == address(0) || safeSingleton_ == address(0)
                || address(authorityDeployer_) == address(0) || address(signerSyncDeployer_) == address(0)
                || address(govModuleDeployer_) == address(0)
        ) {
            revert ZeroAddress();
        }
        FACTORY = factory_;
        SAFE_FACTORY = safeFactory_;
        SAFE_SINGLETON = safeSingleton_;
        AUTHORITY_DEPLOYER = authorityDeployer_;
        SIGNER_SYNC_DEPLOYER = signerSyncDeployer_;
        GOV_MODULE_DEPLOYER = govModuleDeployer_;
    }

    function authorityOf(bytes32 instanceId) external view returns (Authority memory) {
        return _authorities[instanceId];
    }

    /// @notice Create one DAO-governed trust-compose instance. `requested.admin` is deliberately
    ///         ignored: the newly-created Safe is the instance admin, controller owner, and fund
    ///         owner.
    function createGovernedInstance(
        TrustComposeFactory.CreateArgs calldata requested,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        IProvingVault vault = FACTORY.VAULT();
        if (msg.value == 0) {
            if (policy.minPaidIntervalBlocks != 0 || policy.maxPerRootUsd != 0) revert PolicyRequiresPrepay();
        } else {
            if (address(vault) == address(0)) revert PrepayUnavailable();
            if (policy.maxPerRootUsd == 0) revert PrepayRequiresPolicy();
            uint64 floor = FACTORY.EPOCH_FLOOR();
            uint64 effectiveEpoch = requested.epochLength < floor ? floor : requested.epochLength;
            if (policy.minPaidIntervalBlocks < effectiveEpoch) {
                revert InitialPaidIntervalTooShort(policy.minPaidIntervalBlocks, effectiveEpoch);
            }
            if (policy.maxPerRootUsd > MAX_INITIAL_MAX_PER_ROOT_USD) {
                revert InitialCapTooHigh(policy.maxPerRootUsd, MAX_INITIAL_MAX_PER_ROOT_USD);
            }
            bytes32 program = FACTORY.PROGRAM();
            // The vault decides the newborn band, never a hardcoded literal: trust-compose is
            // flat-banded at 3 (a small source counter can hide the maximum authenticated work),
            // which a copied "band 1" literal would silently misprice.
            uint8 initialBand = vault.bandOf(program, 0, 0);
            uint256 initialFeeUsd = initialBand == 0 ? 0 : vault.feePerRootUsd(program, initialBand);
            if (initialFeeUsd == 0) revert InitialFeeUnpriced(program, initialBand);
            if (policy.maxPerRootUsd < initialFeeUsd) {
                revert InitialCapBelowFee(policy.maxPerRootUsd, initialFeeUsd);
            }
        }

        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);
        safeAddress = address(safe);

        TrustComposeFactory.CreateArgs memory args = requested;
        args.admin = safeAddress;

        if (msg.value != 0) {
            (bool funded,) = payable(safeAddress).call{value: msg.value}("");
            if (!funded) revert SafeFundingFailed();
        }

        _execSafe(safe, address(FACTORY), msg.value, abi.encodeCall(TrustComposeFactory.createInstance, (args)));

        // The Safe is the actual factory caller, hence part of the canonical instance id.
        instanceId = FACTORY.computeInstanceId(safeAddress, args.name, args.salt);
        IInstanceRegistry.Instance memory record = FACTORY.INSTANCE_REGISTRY().getInstance(instanceId);
        snapshot = record.snapshot;
        if (snapshot == address(0)) revert InstanceDiscoveryFailed(instanceId);

        // The base factory's deposit bound the vault account to this instance, and the Safe has
        // held the snapshot's constitutional role since `createInstance` returned. Install the
        // paid policy through the Safe before graduating out of the bootstrap ownership.
        if (msg.value != 0) {
            _execSafe(
                safe,
                address(vault),
                0,
                abi.encodeCall(
                    IProvingVault.setPolicy, (instanceId, policy.minPaidIntervalBlocks, policy.maxPerRootUsd)
                )
            );
        }

        // Deployed through the shared singleton (EIP-170) and constructed SILENTLY; its
        // snapshot-binding announcement is published after this wrapper's discovery event below.
        MerkleGovModule module = GOV_MODULE_DEPLOYER.deploy(safeAddress, safeAddress, safeAddress, snapshot);
        merkleGovModule = address(module);
        if (
            module.votingDelay() != MEMBER_VOTING_DELAY || module.votingPeriod() != MEMBER_VOTING_PERIOD
                || module.executionDelay() != MEMBER_EXECUTION_DELAY
        ) revert GovernanceDefaultsMismatch();

        (SafeExecutionGuard executionGuard, DelayedRecoveryModule recoveryModule) =
            AUTHORITY_DEPLOYER.deploy(safeAddress, address(this), msg.sender, RECOVERY_DELAY);

        SignerSyncZkModule signerModule;
        if (signerSync.enabled) {
            signerModule = SIGNER_SYNC_DEPLOYER.deploy(
                instanceId,
                safeAddress,
                IZkVerifier(signerSync.verifier),
                IAttestationAccumulator(address(MerkleSnapshot(snapshot).accumulator())),
                ISignerSyncCheckpointSource(snapshot),
                ISignerActivitySource(merkleGovModule),
                MerkleSnapshot(snapshot).paramsHash(),
                signerSync.programVKey,
                signerSync.topN,
                signerSync.minThreshold,
                signerSync.targetThresholdBps,
                151_200,
                2
            );
        }

        // These calls must originate from the Safe: it owns its module/guard configuration and
        // holds the new snapshot's constitutional role from the instant the base factory returns.
        _execSafe(safe, safeAddress, 0, abi.encodeWithSignature("enableModule(address)", merkleGovModule));
        _execSafe(safe, safeAddress, 0, abi.encodeWithSignature("enableModule(address)", address(recoveryModule)));
        if (address(signerModule) != address(0)) {
            _execSafe(safe, safeAddress, 0, abi.encodeWithSignature("enableModule(address)", address(signerModule)));
        }
        _execSafe(safe, snapshot, 0, abi.encodeCall(MerkleSnapshot.addHook, (IMerkleSnapshotHook(merkleGovModule))));
        _execSafe(safe, safeAddress, 0, abi.encodeWithSignature("setGuard(address)", address(executionGuard)));

        // The guard permits only this wrapper while unsealed. Swap in the creator, then seal it in
        // the same outer transaction: there is no block or callback window in which the new owner
        // can execute without the module delays.
        _execSafe(
            safe,
            safeAddress,
            0,
            abi.encodeWithSignature("swapOwner(address,address,address)", SENTINEL_OWNERS, address(this), msg.sender)
        );
        executionGuard.seal();

        _authorities[instanceId] = Authority({
            safe: safeAddress,
            governanceModule: merkleGovModule,
            recoveryModule: address(recoveryModule),
            executionGuard: address(executionGuard),
            initialRecoveryProposer: msg.sender,
            recoveryDelay: RECOVERY_DELAY,
            signerSyncModule: address(signerModule)
        });

        emit GovernedInstanceCreated(instanceId, msg.sender, safeAddress, merkleGovModule, snapshot);
        emit GovernedAuthorityInstalled(
            instanceId,
            safeAddress,
            address(executionGuard),
            merkleGovModule,
            address(recoveryModule),
            msg.sender,
            RECOVERY_DELAY,
            address(signerModule)
        );
        // Emitted after the discovery events above so ordered indexers have already materialized
        // the module's row when its snapshot-binding announcement arrives.
        module.publishInitialSnapshotBinding();
    }

    function _createBootstrapSafe(address creator, string calldata name, bytes32 salt)
        internal
        returns (GnosisSafe safe)
    {
        address[] memory owners = new address[](1);
        owners[0] = address(this);
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            1,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            address(0)
        );
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, creator, name, salt)));
        safe = GnosisSafe(payable(SAFE_FACTORY.createProxyWithNonce(SAFE_SINGLETON, initializer, nonce)));
    }

    function _execSafe(GnosisSafe safe, address target, uint256 value, bytes memory data) internal {
        bool success = safe.execTransaction(
            target,
            value,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _approvedSignature(address(this))
        );
        if (!success) revert SafeExecutionFailed(target, data);
    }

    /// @dev Safe v1.3 approved-hash signature. During bootstrap this contract is the sole owner
    ///      and the direct `execTransaction` caller, so v=1 authorizes the call without an ECDSA
    ///      private key or a persistent privileged entry point.
    function _approvedSignature(address signer) internal pure returns (bytes memory) {
        return abi.encodePacked(uint256(uint160(signer)), uint256(0), uint8(1));
    }
}
