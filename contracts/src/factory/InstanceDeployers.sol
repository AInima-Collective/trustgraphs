// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {TrustgraphsParamsController} from "src/factory/TrustgraphsParamsController.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {
    SignerSyncZkModule,
    ISignerSyncCheckpointSource,
    ISignerActivitySource
} from "src/zodiac/SignerSyncZkModule.sol";

/// @title MerkleSnapshotDeployer
/// @notice A one-per-chain singleton whose only job is to hold `MerkleSnapshot`'s creation code so
///         `TrustgraphsFactory` doesn't have to.
/// @dev    Why this exists at all: a factory that deploys N child types carries every child's
///         creation code in its own RUNTIME bytecode. Resolver + snapshot + distributor initcode is
///         ~22.6 KB before the factory's own logic, which blows the 24,576-byte EIP-170 limit. The
///         two large children therefore get thin deployer singletons; the factory keeps only the
///         resolver.
///
///         Deploying through a helper is safe here because `MerkleSnapshot` takes both admins as
///         constructor arguments — nothing is derived from `msg.sender`, so this contract never
///         holds a role on anything it creates and is permissionless by design. Anyone may call it;
///         a snapshot that is not registered by the factory is simply an unlisted contract.
contract MerkleSnapshotDeployer {
    /// @notice Deploy a `MerkleSnapshot` with the given wiring and admins.
    /// @param verifier The proof verifier gating root updates (the shared `SP1JournalVerifier`).
    /// @param paramsHash The canonical params hash the guest must match.
    /// @param accumulator The instance's `EASIndexerResolver` (its attestation accumulator).
    /// @param constitutionalAdmin Holder of `CONSTITUTIONAL_ROLE` at birth (the factory, transiently).
    /// @param operationalAdmin Holder of `OPERATIONAL_ROLE` at birth (the instance admin).
    function deploy(
        IZkVerifier verifier,
        bytes32 paramsHash,
        IAttestationAccumulator accumulator,
        address constitutionalAdmin,
        address operationalAdmin
    ) external returns (MerkleSnapshot) {
        return new MerkleSnapshot(verifier, paramsHash, accumulator, constitutionalAdmin, operationalAdmin);
    }
}

/// @title MerkleFundDistributorDeployer
/// @notice The same trick for `MerkleFundDistributor` (see `MerkleSnapshotDeployer` for why).
/// @dev    Safe for the same reason: since the distributor's constructor sets `owner = owner_`
///         directly (research/DEVIATIONS.md), this deployer is never the owner of what it deploys.
contract MerkleFundDistributorDeployer {
    /// @notice Deploy a `MerkleFundDistributor` owned by `owner`.
    /// @param owner The distributor's owner (the instance admin), set outright — no pending transfer.
    /// @param merkleSnapshot The snapshot whose proven root gates claims.
    /// @param feeRecipient Where the distribution fee goes.
    /// @param feePercentage The fee taken from each distribution (1e18 = 100%).
    /// @param allowlistEnabled Whether only allowlisted addresses may fund distributions.
    function deploy(
        address owner,
        address merkleSnapshot,
        address feeRecipient,
        uint256 feePercentage,
        bool allowlistEnabled
    ) external returns (MerkleFundDistributor) {
        return new MerkleFundDistributor(owner, merkleSnapshot, feeRecipient, feePercentage, allowlistEnabled);
    }
}

/// @title TrustgraphsParamsControllerDeployer
/// @notice Holds the typed controller's creation code outside `TrustgraphsFactory` for EIP-170.
contract TrustgraphsParamsControllerDeployer {
    function deploy(
        bytes32 instanceId,
        address snapshot,
        IInstanceRegistry registry,
        ParamsCodec.Params calldata initialParams,
        address owner
    ) external returns (TrustgraphsParamsController) {
        return new TrustgraphsParamsController(instanceId, snapshot, registry, initialParams, owner, msg.sender);
    }
}

/// @title GovernedAuthorityDeployer
/// @notice Holds the guard and delayed-recovery creation code outside
///         `GovernedTrustgraphsFactory`, preserving that public factory's EIP-170 margin.
/// @dev Both children take every authority explicitly. This permissionless helper retains no Safe
///      privilege and cannot alter a deployment after construction.
contract GovernedAuthorityDeployer {
    function deploy(address safe, address bootstrapper, address recoveryProposer, uint48 recoveryDelay)
        external
        returns (SafeExecutionGuard guard, DelayedRecoveryModule recovery)
    {
        guard = new SafeExecutionGuard(safe, bootstrapper);
        recovery = new DelayedRecoveryModule(safe, recoveryProposer, recoveryDelay);
    }
}

/// @title MerkleGovModuleDeployer
/// @notice Holds `MerkleGovModule`'s creation code — the governed wrappers' single biggest
///         initcode line item — outside every governed factory's runtime bytecode, so ONE deployed
///         singleton preserves EIP-170 headroom for all three wrappers at once.
/// @dev    Safe for the `MerkleSnapshotDeployer` reason: every authority (owner, avatar, target)
///         is an explicit constructor argument, nothing is derived from `msg.sender`, so this
///         permissionless helper never holds any power over what it creates. Construction is
///         SILENT (see `MerkleGovModule.initialBindingPublished`): the calling wrapper emits its
///         discovery event first and then calls `publishInitialSnapshotBinding()` on the module,
///         so a streaming indexer never sees a child log before the event that teaches it the
///         child exists.
contract MerkleGovModuleDeployer {
    /// @notice Deploy a `MerkleGovModule` owned/avatared/targeted as given, bound to `snapshot`.
    function deploy(address owner, address avatar, address target, address snapshot)
        external
        returns (MerkleGovModule)
    {
        return new MerkleGovModule(owner, avatar, target, snapshot);
    }
}

/// @title SignerSyncModuleDeployer
/// @notice Keeps the signer guest module's creation code out of the governed factory runtime.
/// @dev Every authority and dependency is explicit; this permissionless helper retains nothing.
contract SignerSyncModuleDeployer {
    uint32 public constant MAX_SIGNERS = 64;

    error InvalidSignerVerifier();
    error SignerProgramVKeyMismatch(bytes32 supplied, bytes32 verifierVKey);
    error InvalidSignerSelection(uint32 topN, uint32 minThreshold, uint32 targetThresholdBps);
    error HybridScoreSnapshotUnsupported(address anchorRegistry);

    event SignerSyncModuleConfigured(
        bytes32 indexed instanceId,
        address indexed safe,
        address indexed signerSyncModule,
        bytes32 operatorInstanceId,
        address scoreSnapshot,
        address activitySource,
        address accumulator,
        address verifier,
        bytes32 programVKey,
        bytes32 selectionParamsHash,
        uint32 topN,
        uint32 minThreshold,
        uint32 targetThresholdBps,
        uint64 maxInactiveBlocks,
        uint32 minActivityWitnesses
    );

    function deploy(
        bytes32 instanceId,
        address safe,
        IZkVerifier verifier,
        IAttestationAccumulator accumulator,
        ISignerSyncCheckpointSource scoreSnapshot,
        ISignerActivitySource activitySource,
        bytes32 paramsHash,
        bytes32 programVKey,
        uint32 topN,
        uint32 minThreshold,
        uint32 targetThresholdBps,
        uint64 maxInactiveBlocks,
        uint32 minActivityWitnesses
    ) external returns (SignerSyncZkModule) {
        if (address(verifier) == address(0) || programVKey == bytes32(0)) {
            revert InvalidSignerVerifier();
        }
        if (
            topN < 2 || topN > MAX_SIGNERS || minThreshold < 2 || minThreshold > topN || targetThresholdBps == 0
                || targetThresholdBps > 10_000 || maxInactiveBlocks == 0 || minActivityWitnesses < 2
                || minActivityWitnesses > topN
        ) revert InvalidSignerSelection(topN, minThreshold, targetThresholdBps);

        // Signer-sync's current guest authenticates lane 1 only. Keep it fail-closed for any
        // score snapshot that advertises a live lane-2 registry. The staticcall is a foreign-type
        // guard, not a back-compatibility shim: `scoreSnapshot` is caller-supplied and need not be
        // a MerkleSnapshot, so a contract without this getter is treated as lane-1-only.
        (bool anchorOk, bytes memory anchorResult) =
            address(scoreSnapshot).staticcall(abi.encodeWithSignature("anchorRegistry()"));
        if (anchorOk && anchorResult.length == 32) {
            address anchorRegistry = abi.decode(anchorResult, (address));
            if (anchorRegistry != address(0)) revert HybridScoreSnapshotUnsupported(anchorRegistry);
        }

        (bool ok, bytes memory returned) = address(verifier).staticcall(abi.encodeWithSignature("programVKey()"));
        if (!ok || returned.length != 32) revert InvalidSignerVerifier();
        bytes32 verifierVKey = abi.decode(returned, (bytes32));
        if (verifierVKey != programVKey) revert SignerProgramVKeyMismatch(programVKey, verifierVKey);

        bytes32 selectionParamsHash =
            keccak256(abi.encode(topN, minThreshold, targetThresholdBps, maxInactiveBlocks, minActivityWitnesses));
        SignerSyncZkModule module = new SignerSyncZkModule(
            safe,
            safe,
            safe,
            verifier,
            accumulator,
            scoreSnapshot,
            activitySource,
            paramsHash,
            topN,
            minThreshold,
            targetThresholdBps,
            maxInactiveBlocks,
            minActivityWitnesses
        );
        bytes32 operatorInstanceId = keccak256(abi.encode(instanceId, address(module), keccak256("signer-sync")));
        emit SignerSyncModuleConfigured(
            instanceId,
            safe,
            address(module),
            operatorInstanceId,
            address(scoreSnapshot),
            address(activitySource),
            address(accumulator),
            address(verifier),
            programVKey,
            selectionParamsHash,
            topN,
            minThreshold,
            targetThresholdBps,
            maxInactiveBlocks,
            minActivityWitnesses
        );
        return module;
    }
}
