// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
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

/// @title GovernedTrustgraphsFactory
/// @notice Creates a factory trust graph and a module-only DAO Safe as one transaction, with member
///         governance plus delayed recovery installed as every execution route from genesis.
/// @dev The base factory remains the canonical instance creator. This wrapper temporarily owns a
///      fresh one-owner Safe, has that Safe call `TrustgraphsFactory.createInstance`, installs the
///      snapshot-specific governance module, a 14-day recovery module, and a permanently sealed
///      owner-execution guard. The caller remains the Safe owner and recovery proposer for visible
///      identity/recovery, but cannot execute a Safe transaction directly. Targets therefore see
///      the Safe — never this wrapper or the creator EOA — as `msg.sender`, and no creator-only
///      zero-delay path exists after the creation transaction.
contract GovernedTrustgraphsFactory {
    address internal constant SENTINEL_OWNERS = address(0x1);
    address internal constant SENTINEL_MODULES = address(0x1);
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    uint256 public constant MAX_BOOTSTRAP_SAFE_ATTEMPTS = 16;
    uint48 public constant RECOVERY_DELAY = 14 days;
    uint256 public constant MEMBER_VOTING_DELAY = 1;
    uint256 public constant MEMBER_VOTING_PERIOD = 50_400;
    uint256 public constant MEMBER_EXECUTION_DELAY = 7_200;
    /// @notice Creation-time guardrail. The DAO may deliberately raise its cap later through the
    ///         vault, but the one-click wizard may not accidentally authorize more than $10,000
    ///         (8-decimal oracle USD) for one root.
    uint96 public constant MAX_INITIAL_MAX_PER_ROOT_USD = 10_000e8;

    struct InitialPolicy {
        uint64 minPaidIntervalBlocks;
        uint96 maxPerRootUsd;
    }

    /// @notice Optional score-selected Safe owner rotation. Verifier identity is deliberately not
    ///         part of this per-instance tuple: the wrapper pins one canonical pair at deployment.
    struct SignerSyncConfig {
        bool enabled;
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

    TrustgraphsFactory public immutable FACTORY;
    GnosisSafeProxyFactory public immutable SAFE_FACTORY;
    address public immutable SAFE_SINGLETON;
    GovernedAuthorityDeployer public immutable AUTHORITY_DEPLOYER;
    SignerSyncModuleDeployer public immutable SIGNER_SYNC_DEPLOYER;
    MerkleGovModuleDeployer public immutable GOV_MODULE_DEPLOYER;
    IZkVerifier public immutable SIGNER_SYNC_VERIFIER;
    bytes32 public immutable SIGNER_SYNC_PROGRAM_VKEY;
    bytes32 public immutable SAFE_PROXY_DEPLOYMENT_CODE_HASH;
    bytes32 public immutable SAFE_PROXY_RUNTIME_CODE_HASH;

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
    error HybridSignerSyncUnsupported();
    error InvalidSignerSyncVerifier();
    error SignerSyncProgramVKeyMismatch(bytes32 expected, bytes32 actual);
    error BootstrapSafeUnavailable(uint256 baseNonce);

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
        TrustgraphsFactory factory_,
        GnosisSafeProxyFactory safeFactory_,
        address safeSingleton_,
        GovernedAuthorityDeployer authorityDeployer_,
        SignerSyncModuleDeployer signerSyncDeployer_,
        MerkleGovModuleDeployer govModuleDeployer_,
        IZkVerifier signerSyncVerifier_,
        bytes32 signerSyncProgramVKey_
    ) {
        if (
            address(factory_) == address(0) || address(safeFactory_) == address(0) || safeSingleton_ == address(0)
                || address(authorityDeployer_) == address(0) || address(signerSyncDeployer_) == address(0)
                || address(govModuleDeployer_) == address(0) || address(signerSyncVerifier_) == address(0)
        ) {
            revert ZeroAddress();
        }
        if (signerSyncProgramVKey_ == bytes32(0)) revert InvalidSignerSyncVerifier();
        (bool ok, bytes memory returned) =
            address(signerSyncVerifier_).staticcall(abi.encodeWithSignature("programVKey()"));
        if (!ok || returned.length != 32) revert InvalidSignerSyncVerifier();
        bytes32 verifierVKey = abi.decode(returned, (bytes32));
        if (verifierVKey != signerSyncProgramVKey_) {
            revert SignerSyncProgramVKeyMismatch(signerSyncProgramVKey_, verifierVKey);
        }
        FACTORY = factory_;
        SAFE_FACTORY = safeFactory_;
        SAFE_SINGLETON = safeSingleton_;
        AUTHORITY_DEPLOYER = authorityDeployer_;
        SIGNER_SYNC_DEPLOYER = signerSyncDeployer_;
        GOV_MODULE_DEPLOYER = govModuleDeployer_;
        SIGNER_SYNC_VERIFIER = signerSyncVerifier_;
        SIGNER_SYNC_PROGRAM_VKEY = signerSyncProgramVKey_;
        SAFE_PROXY_DEPLOYMENT_CODE_HASH =
            keccak256(abi.encodePacked(safeFactory_.proxyCreationCode(), uint256(uint160(safeSingleton_))));
        SAFE_PROXY_RUNTIME_CODE_HASH = keccak256(safeFactory_.proxyRuntimeCode());
    }

    function authorityOf(bytes32 instanceId) external view returns (Authority memory) {
        return _authorities[instanceId];
    }

    /// @notice Create one DAO-governed trust graph. `requested.admin` is deliberately ignored:
    ///         the newly-created Safe is the instance admin, controller owner and fund owner.
    /// @param requested The canonical factory arguments; its effective epoch bounds paid cadence.
    /// @param policy Initial vault terms. Must be zero/zero without value and fully enabled with it.
    /// @notice Create one governed trust graph with optional ZK-proven Safe owner rotation.
    function createGovernedInstance(
        TrustgraphsFactory.CreateArgs calldata requested,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        TrustgraphsFactory.OffchainEasConfig memory disabled;
        return _createGovernedInstance(requested, policy, signerSync, disabled, false);
    }

    /// @notice Create a governed strict-hybrid instance. Signer-sync is deliberately unavailable:
    ///         its current guest authenticates lane 1 only and must never rotate owners from a
    ///         score root that also depends on strict off-chain history.
    function createGovernedHybridInstance(
        TrustgraphsFactory.CreateArgs calldata requested,
        TrustgraphsFactory.OffchainEasConfig calldata offchain,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        if (signerSync.enabled) revert HybridSignerSyncUnsupported();
        TrustgraphsFactory.OffchainEasConfig memory config = offchain;
        return _createGovernedInstance(requested, policy, signerSync, config, true);
    }

    function _createGovernedInstance(
        TrustgraphsFactory.CreateArgs calldata requested,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync,
        TrustgraphsFactory.OffchainEasConfig memory offchain,
        bool hybrid
    ) internal returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
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
            // Ask the vault which band a newborn (empty) instance of this program lands in
            // rather than assuming band 1: flat-banded programs (trust-compose) start at band 3,
            // and an unrecognised program answers 0 (unpriced) and must refuse the prepay path.
            uint8 initialBand = vault.bandOf(program, 0, 0);
            uint256 initialFeeUsd = initialBand == 0 ? 0 : vault.feePerRootUsd(program, initialBand);
            if (initialFeeUsd == 0) revert InitialFeeUnpriced(program, initialBand);
            if (policy.maxPerRootUsd < initialFeeUsd) {
                revert InitialCapBelowFee(policy.maxPerRootUsd, initialFeeUsd);
            }
        }

        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);
        safeAddress = address(safe);

        TrustgraphsFactory.CreateArgs memory args = requested;
        args.admin = safeAddress;

        if (msg.value != 0) {
            (bool funded,) = payable(safeAddress).call{value: msg.value}("");
            if (!funded) revert SafeFundingFailed();
        }

        bytes memory createCall = hybrid
            ? abi.encodeCall(TrustgraphsFactory.createHybridInstance, (args, offchain))
            : abi.encodeCall(TrustgraphsFactory.createInstance, (args));
        _execSafe(safe, address(FACTORY), msg.value, createCall);

        // The Safe is the actual factory caller, hence part of the canonical instance id.
        instanceId = FACTORY.computeInstanceId(safeAddress, args.name, args.salt);
        IInstanceRegistry.Instance memory record = FACTORY.INSTANCE_REGISTRY().getInstance(instanceId);
        snapshot = record.snapshot;
        if (snapshot == address(0)) revert InstanceDiscoveryFailed(instanceId);

        // The base factory's deposit bound the vault account to `snapshot`, and the Safe has held
        // that snapshot's constitutional role since `createInstance` returned. Install the paid
        // policy through the Safe before replacing this wrapper as its bootstrap owner. Thus one
        // transaction either creates a funded, payable instance or creates nothing at all.
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

        // Deployed through the shared singleton (EIP-170) and constructed SILENTLY: the module's
        // snapshot-binding announcement is published after this wrapper's discovery event below,
        // so an indexer discovering the module from `GovernedInstanceCreated` never sees one of
        // its logs before the event that teaches it the module exists.
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
                SIGNER_SYNC_VERIFIER,
                IAttestationAccumulator(address(MerkleSnapshot(snapshot).accumulator())),
                ISignerSyncCheckpointSource(snapshot),
                ISignerActivitySource(merkleGovModule),
                MerkleSnapshot(snapshot).paramsHash(),
                SIGNER_SYNC_PROGRAM_VKEY,
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

        Authority memory authority = Authority({
            safe: safeAddress,
            governanceModule: merkleGovModule,
            recoveryModule: address(recoveryModule),
            executionGuard: address(executionGuard),
            initialRecoveryProposer: msg.sender,
            recoveryDelay: RECOVERY_DELAY,
            signerSyncModule: address(signerModule)
        });
        _authorities[instanceId] = authority;

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
        // the module's row when its snapshot-binding announcement arrives (the
        // `publishInitialVersion()` discipline).
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
        uint256 baseNonce = uint256(keccak256(abi.encode(block.chainid, creator, name, salt)));
        for (uint256 bump; bump < MAX_BOOTSTRAP_SAFE_ATTEMPTS; ++bump) {
            uint256 nonce = bump == 0 ? baseNonce : uint256(keccak256(abi.encode(baseNonce, bump)));
            address candidate = _bootstrapSafeAddress(initializer, nonce);
            if (candidate.code.length != 0) {
                if (_isAdoptableBootstrapSafe(candidate)) return GnosisSafe(payable(candidate));
                continue;
            }
            return GnosisSafe(payable(SAFE_FACTORY.createProxyWithNonce(SAFE_SINGLETON, initializer, nonce)));
        }
        revert BootstrapSafeUnavailable(baseNonce);
    }

    function _bootstrapSafeAddress(bytes memory initializer, uint256 nonce) internal view returns (address) {
        bytes32 create2Salt = keccak256(abi.encodePacked(keccak256(initializer), nonce));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(SAFE_FACTORY), create2Salt, SAFE_PROXY_DEPLOYMENT_CODE_HASH
                        )
                    )
                )
            )
        );
    }

    function _isAdoptableBootstrapSafe(address candidate) internal view returns (bool) {
        if (candidate.codehash != SAFE_PROXY_RUNTIME_CODE_HASH) return false;

        (bool ok, bytes memory result) = candidate.staticcall(abi.encodeWithSignature("masterCopy()"));
        if (!ok || result.length != 32 || _word(result, 0) != uint256(uint160(SAFE_SINGLETON))) return false;

        (ok, result) = candidate.staticcall(abi.encodeWithSignature("getOwners()"));
        if (
            !ok || result.length != 96 || _word(result, 0) != 32 || _word(result, 32) != 1
                || _word(result, 64) != uint256(uint160(address(this)))
        ) return false;

        (ok, result) = candidate.staticcall(abi.encodeWithSignature("getThreshold()"));
        if (!ok || result.length != 32 || _word(result, 0) != 1) return false;

        (ok, result) = candidate.staticcall(abi.encodeWithSignature("nonce()"));
        if (!ok || result.length != 32 || _word(result, 0) != 0) return false;

        if (!_storageWordIsZero(candidate, GUARD_STORAGE_SLOT)) return false;
        if (!_storageWordIsZero(candidate, FALLBACK_HANDLER_STORAGE_SLOT)) return false;

        (ok, result) =
            candidate.staticcall(abi.encodeWithSignature("getModulesPaginated(address,uint256)", SENTINEL_MODULES, 1));
        return ok && result.length == 96 && _word(result, 0) == 64
            && _word(result, 32) == uint256(uint160(SENTINEL_MODULES)) && _word(result, 64) == 0;
    }

    function _storageWordIsZero(address candidate, bytes32 slot) internal view returns (bool) {
        (bool ok, bytes memory result) =
            candidate.staticcall(abi.encodeWithSignature("getStorageAt(uint256,uint256)", uint256(slot), 1));
        return ok && result.length == 96 && _word(result, 0) == 32 && _word(result, 32) == 32 && _word(result, 64) == 0;
    }

    function _word(bytes memory data, uint256 offset) internal pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := mload(add(add(data, 0x20), offset))
        }
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
