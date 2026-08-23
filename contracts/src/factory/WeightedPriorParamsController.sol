// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "src/params/WeightedPriorValidator.sol";
import {IWeightedPriorParamsController} from "interfaces/factory/IWeightedPriorParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title WeightedPriorParamsController
/// @notice Validates full prior bytes at proposal time and activates only their O(1) commitment.
/// @dev The proposal calldata is the recovery source. No manifest or entry array is stored.
///      Cancelled proposal versions are never reused.
contract WeightedPriorParamsController is IWeightedPriorParamsController, Ownable2Step {
    bytes32 public immutable instanceId;
    address public immutable snapshot;
    IInstanceRegistry public immutable registry;
    address public immutable initialPublisher;
    uint48 public immutable activationDelay;

    uint64 public version;
    uint64 public latestVersion;
    bytes32 public currentParamsHash;
    bool public versionOnePublished;

    WeightedPriorParamsCodec.Params private _initialParams;
    WeightedPriorParamsCodec.Params private _currentParams;
    PendingPrior private _pending;
    mapping(uint64 version_ => VersionCommitment commitment) private _versionCommitments;

    error ZeroAddress();
    error ZeroActivationDelay();
    error InitialHashMismatch(bytes32 encoded, bytes32 live);
    error InitialVersionAlreadyPublished();
    error InitialVersionNotPublished();
    error NotInitialPublisher(address caller);
    error PendingPriorExists(uint64 version, bytes32 proposalId);
    error NoPendingPrior();
    error PendingVersionMismatch(uint64 expected, uint64 actual);
    error ActivationDelayNotElapsed(uint48 readyAt);
    error NoopPrior(bytes32 priorRoot, bytes32 manifestSha256);
    error SnapshotHashMismatch(bytes32 expected, bytes32 actual);
    error RegistryHashMismatch(bytes32 expected, bytes32 actual);
    error RegistrySnapshotMismatch(address expected, address actual);
    error ControllerNotRegistered(address registeredAuthority);

    constructor(
        bytes32 instanceId_,
        address snapshot_,
        IInstanceRegistry registry_,
        WeightedPriorParamsCodec.Params memory initialParams,
        bytes memory initialManifest,
        bytes32 initialMetadataDigest,
        address initialOwner,
        address initialPublisher_,
        uint48 activationDelay_
    ) Ownable(initialOwner) {
        if (snapshot_ == address(0) || address(registry_) == address(0) || initialPublisher_ == address(0)) {
            revert ZeroAddress();
        }
        if (activationDelay_ == 0) revert ZeroActivationDelay();

        WeightedPriorValidator.validateComputationalEnvelope(initialParams);
        WeightedPriorValidator.Commitment memory prior =
            WeightedPriorValidator.validateManifestMemory(initialManifest, initialParams.chainId);
        if (
            initialParams.priorRoot != prior.priorRoot || initialParams.priorCount != prior.priorCount
                || initialParams.manifestSha256 != prior.manifestSha256
        ) revert WeightedPriorValidator.PriorCommitmentMismatch();

        bytes32 encoded = WeightedPriorParamsCodec.hash(initialParams);
        bytes32 live = MerkleSnapshot(snapshot_).paramsHash();
        if (encoded != live) revert InitialHashMismatch(encoded, live);

        instanceId = instanceId_;
        snapshot = snapshot_;
        registry = registry_;
        initialPublisher = initialPublisher_;
        activationDelay = activationDelay_;
        version = 1;
        latestVersion = 1;
        currentParamsHash = encoded;
        _initialParams = initialParams;
        _currentParams = initialParams;
        uint48 now48 = uint48(block.timestamp);
        _versionCommitments[1] = VersionCommitment({
            paramsHash: encoded,
            priorRoot: prior.priorRoot,
            priorCount: prior.priorCount,
            manifestSha256: prior.manifestSha256,
            metadataDigest: initialMetadataDigest,
            proposedAt: now48,
            activatedAt: now48
        });
    }

    function getCurrentParams() external view returns (WeightedPriorParamsCodec.Params memory) {
        return _currentParams;
    }

    function getPendingPrior() external view returns (PendingPrior memory) {
        return _pending;
    }

    function versionCommitment(uint64 version_) external view returns (VersionCommitment memory) {
        return _versionCommitments[version_];
    }

    /// @notice Publish V1 only after the factory has emitted the controller discovery event.
    function publishInitialVersion() external {
        if (msg.sender != initialPublisher) revert NotInitialPublisher(msg.sender);
        if (versionOnePublished) revert InitialVersionAlreadyPublished();
        versionOnePublished = true;
        emit InitialPriorPublished(
            instanceId, 1, currentParamsHash, _versionCommitments[1].metadataDigest, _currentParams
        );
    }

    /// @notice Validate a complete manifest now and schedule only its commitment for activation.
    function proposePrior(bytes calldata manifest, bytes32 metadataDigest)
        external
        onlyOwner
        returns (uint64 pendingVersion, bytes32 proposalId, uint48 readyAt)
    {
        if (!versionOnePublished) revert InitialVersionNotPublished();
        if (_pending.version != 0) revert PendingPriorExists(_pending.version, _pending.proposalId);

        WeightedPriorValidator.Commitment memory prior =
            WeightedPriorValidator.validateManifest(manifest, _currentParams.chainId);
        if (prior.priorRoot == _currentParams.priorRoot && prior.manifestSha256 == _currentParams.manifestSha256) {
            revert NoopPrior(prior.priorRoot, prior.manifestSha256);
        }

        WeightedPriorParamsCodec.Params memory next = _currentParams;
        next.priorRoot = prior.priorRoot;
        next.priorCount = prior.priorCount;
        next.manifestSha256 = prior.manifestSha256;
        WeightedPriorValidator.validateRotation(next, _initialParams);

        pendingVersion = latestVersion + 1;
        latestVersion = pendingVersion;
        readyAt = uint48(block.timestamp) + activationDelay;
        bytes32 nextHash = WeightedPriorParamsCodec.hash(next);
        proposalId = keccak256(
            abi.encode(
                instanceId, pendingVersion, prior.priorRoot, prior.priorCount, prior.manifestSha256, metadataDigest
            )
        );

        _pending = PendingPrior({
            version: pendingVersion,
            readyAt: readyAt,
            proposalId: proposalId,
            priorRoot: prior.priorRoot,
            priorCount: prior.priorCount,
            manifestSha256: prior.manifestSha256,
            metadataDigest: metadataDigest,
            paramsHash: nextHash
        });
        _versionCommitments[pendingVersion] = VersionCommitment({
            paramsHash: nextHash,
            priorRoot: prior.priorRoot,
            priorCount: prior.priorCount,
            manifestSha256: prior.manifestSha256,
            metadataDigest: metadataDigest,
            proposedAt: uint48(block.timestamp),
            activatedAt: 0
        });

        emit PriorProposed(
            instanceId,
            pendingVersion,
            proposalId,
            prior.priorRoot,
            prior.priorCount,
            prior.manifestSha256,
            metadataDigest,
            nextHash,
            readyAt
        );
    }

    /// @notice Cancel the pending rotation; its proposal transaction remains an auditable record.
    function cancelPrior() external onlyOwner {
        PendingPrior memory pending = _pending;
        if (pending.version == 0) revert NoPendingPrior();
        delete _pending;
        delete _versionCommitments[pending.version];
        emit PriorProposalCancelled(instanceId, pending.version, pending.proposalId);
    }

    /// @notice Permissionlessly activate a previously validated commitment after its delay.
    function activatePrior(uint64 expectedVersion) external returns (bytes32 newHash) {
        PendingPrior memory pending = _pending;
        if (pending.version == 0) revert NoPendingPrior();
        if (expectedVersion != pending.version) revert PendingVersionMismatch(expectedVersion, pending.version);
        // Timestamp comparison is the intended governance timelock boundary.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.readyAt) revert ActivationDelayNotElapsed(pending.readyAt);

        bytes32 previousHash = currentParamsHash;
        _assertLiveState(previousHash);

        WeightedPriorParamsCodec.Params memory next = _currentParams;
        next.priorRoot = pending.priorRoot;
        next.priorCount = pending.priorCount;
        next.manifestSha256 = pending.manifestSha256;
        WeightedPriorValidator.validateRotation(next, _initialParams);
        newHash = WeightedPriorParamsCodec.hash(next);
        assert(newHash == pending.paramsHash);

        // Snapshot, registry, and local state move atomically or all roll back.
        MerkleSnapshot(snapshot).setParamsHash(newHash);
        registry.updateParamsHash(instanceId, newHash);

        version = pending.version;
        currentParamsHash = newHash;
        _currentParams = next;
        _versionCommitments[pending.version].activatedAt = uint48(block.timestamp);
        delete _pending;

        emit PriorActivated(
            instanceId, version, newHash, previousHash, pending.proposalId, pending.metadataDigest, next
        );
    }

    function _assertLiveState(bytes32 expectedHash) private view {
        bytes32 snapshotHash = MerkleSnapshot(snapshot).paramsHash();
        if (snapshotHash != expectedHash) revert SnapshotHashMismatch(expectedHash, snapshotHash);

        IInstanceRegistry.Instance memory record = registry.getInstance(instanceId);
        if (record.snapshot != snapshot) revert RegistrySnapshotMismatch(snapshot, record.snapshot);
        if (record.paramsHash != expectedHash) revert RegistryHashMismatch(expectedHash, record.paramsHash);
        address authority = registry.paramsAuthority(instanceId);
        if (authority != address(this)) revert ControllerNotRegistered(authority);
    }
}
