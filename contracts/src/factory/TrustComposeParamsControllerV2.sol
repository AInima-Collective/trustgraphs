// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {CompositionSourceAccumulatorV2} from "src/composition/CompositionSourceAccumulatorV2.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustComposeParamsCodecV2} from "src/params/TrustComposeParamsCodecV2.sol";
import {TrustComposeValidatorV2} from "src/params/TrustComposeValidatorV2.sol";
import {ITrustComposeParamsControllerV2} from "interfaces/factory/ITrustComposeParamsControllerV2.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title TrustComposeParamsControllerV2
/// @notice Timelocks complete V2 source policies and atomically advances accumulator, snapshot,
///         and registry state. Cancelled proposal versions remain queryable; gaps are never
///         reused. A rotation may add, remove, reweight, or replace sources from either admitted
///         program — the compatibility class itself is immutable.
contract TrustComposeParamsControllerV2 is ITrustComposeParamsControllerV2, Ownable2Step {
    bytes32 public immutable instanceId;
    address public immutable snapshot;
    CompositionSourceAccumulatorV2 public immutable accumulator;
    IInstanceRegistry public immutable registry;
    address public immutable initialPublisher;
    uint48 public immutable activationDelay;

    uint64 public version;
    uint64 public latestVersion;
    bytes32 public currentParamsHash;
    bytes32 public currentAdapterSetHash;
    bool public versionOnePublished;

    TrustComposeParamsCodecV2.Params private _initialParams;
    TrustComposeParamsCodecV2.Params private _currentParams;
    PendingPolicy private _pending;
    mapping(uint64 version_ => VersionCommitment commitment) private _versionCommitments;

    error ZeroAddress();
    error ZeroActivationDelay();
    error InitialHashMismatch(bytes32 encoded, bytes32 live);
    error InitialPolicyMismatch();
    error InitialVersionAlreadyPublished();
    error InitialVersionNotPublished();
    error NotInitialPublisher(address caller);
    error PendingPolicyExists(uint64 version, bytes32 proposalId);
    error NoPendingPolicy();
    error PendingVersionMismatch(uint64 expected, uint64 actual);
    error ActivationDelayNotElapsed(uint48 readyAt);
    error NoopPolicy(bytes32 manifestSha256, bytes32 adapterSetHash);
    error ActivationPreimageMismatch();
    error SnapshotHashMismatch(bytes32 expected, bytes32 actual);
    error RegistryHashMismatch(bytes32 expected, bytes32 actual);
    error RegistrySnapshotMismatch(address expected, address actual);
    error ControllerNotRegistered(address registeredAuthority);
    error AccumulatorControllerMismatch(address expected, address actual);

    constructor(
        bytes32 instanceId_,
        address snapshot_,
        CompositionSourceAccumulatorV2 accumulator_,
        IInstanceRegistry registry_,
        TrustComposeParamsCodecV2.Params memory initialParams,
        bytes memory initialManifest,
        address[] memory initialAdapters,
        bytes32 initialMetadataDigest,
        address initialOwner,
        address initialPublisher_,
        uint48 activationDelay_
    ) Ownable(initialOwner) {
        if (
            snapshot_ == address(0) || address(accumulator_) == address(0) || address(registry_) == address(0)
                || initialPublisher_ == address(0)
        ) revert ZeroAddress();
        if (activationDelay_ == 0) revert ZeroActivationDelay();

        TrustComposeValidatorV2.validateComputationalEnvelope(initialParams);
        TrustComposeValidatorV2.Commitment memory policy = TrustComposeValidatorV2.validatePolicyManifestMemory(
            initialManifest, initialParams.chainId, initialParams.maxSourceAgeBlocks
        );
        if (
            initialParams.sourcePolicyRoot != policy.sourcePolicyRoot || initialParams.sourceCount != policy.sourceCount
                || initialParams.policyManifestSha256 != policy.manifestSha256
                || initialParams.accumulator != address(accumulator_)
        ) revert InitialPolicyMismatch();
        accumulator_.validatePolicy(initialManifest, initialAdapters);

        bytes32 encoded = TrustComposeParamsCodecV2.hash(initialParams);
        bytes32 live = MerkleSnapshot(snapshot_).paramsHash();
        if (encoded != live) revert InitialHashMismatch(encoded, live);

        bytes32 adapterSetHash = keccak256(abi.encode(initialAdapters));
        instanceId = instanceId_;
        snapshot = snapshot_;
        accumulator = accumulator_;
        registry = registry_;
        initialPublisher = initialPublisher_;
        activationDelay = activationDelay_;
        version = 1;
        latestVersion = 1;
        currentParamsHash = encoded;
        currentAdapterSetHash = adapterSetHash;
        _initialParams = initialParams;
        _currentParams = initialParams;
        uint48 now48 = uint48(block.timestamp);
        _versionCommitments[1] = VersionCommitment({
            paramsHash: encoded,
            sourcePolicyRoot: policy.sourcePolicyRoot,
            sourceCount: policy.sourceCount,
            manifestSha256: policy.manifestSha256,
            adapterSetHash: adapterSetHash,
            metadataDigest: initialMetadataDigest,
            proposedAt: now48,
            activatedAt: now48,
            cancelledAt: 0,
            status: ProposalStatus.Activated
        });
    }

    function getCurrentParams() external view returns (TrustComposeParamsCodecV2.Params memory) {
        return _currentParams;
    }

    function getPendingPolicy() external view returns (PendingPolicy memory) {
        return _pending;
    }

    function versionCommitment(uint64 version_) external view returns (VersionCommitment memory) {
        return _versionCommitments[version_];
    }

    /// @notice Install and publish V1 only after factory discovery/registry events exist.
    function publishInitialPolicy(bytes calldata manifest, address[] calldata adapters) external {
        if (msg.sender != initialPublisher) revert NotInitialPublisher(msg.sender);
        if (versionOnePublished) revert InitialVersionAlreadyPublished();
        _assertInitialPreimage(manifest, adapters);
        _assertLiveState(currentParamsHash);
        if (accumulator.controller() != address(this)) {
            revert AccumulatorControllerMismatch(address(this), accumulator.controller());
        }
        accumulator.installPolicy(1, manifest, adapters);
        versionOnePublished = true;
        VersionCommitment memory v1 = _versionCommitments[1];
        emit InitialPolicyPublished(
            instanceId, 1, currentParamsHash, v1.adapterSetHash, v1.metadataDigest, _currentParams
        );
    }

    function proposePolicy(bytes calldata manifest, address[] calldata adapters, bytes32 metadataDigest)
        external
        onlyOwner
        returns (uint64 pendingVersion, bytes32 proposalId, uint48 readyAt)
    {
        if (!versionOnePublished) revert InitialVersionNotPublished();
        if (_pending.version != 0) revert PendingPolicyExists(_pending.version, _pending.proposalId);

        TrustComposeValidatorV2.Commitment memory policy = TrustComposeValidatorV2.validatePolicyManifest(
            manifest, _currentParams.chainId, _currentParams.maxSourceAgeBlocks
        );
        accumulator.validatePolicy(manifest, adapters);
        bytes32 adapterSetHash = keccak256(abi.encode(adapters));
        if (policy.manifestSha256 == _currentParams.policyManifestSha256 && adapterSetHash == currentAdapterSetHash) {
            revert NoopPolicy(policy.manifestSha256, adapterSetHash);
        }

        TrustComposeParamsCodecV2.Params memory next = _currentParams;
        next.sourcePolicyRoot = policy.sourcePolicyRoot;
        next.sourceCount = policy.sourceCount;
        next.policyManifestSha256 = policy.manifestSha256;
        TrustComposeValidatorV2.validateRotation(next, _initialParams);
        bytes32 nextHash = TrustComposeParamsCodecV2.hash(next);

        pendingVersion = latestVersion + 1;
        latestVersion = pendingVersion;
        readyAt = uint48(block.timestamp) + activationDelay;
        proposalId = keccak256(
            abi.encode(
                instanceId,
                pendingVersion,
                policy.sourcePolicyRoot,
                policy.sourceCount,
                policy.manifestSha256,
                adapterSetHash,
                metadataDigest,
                nextHash
            )
        );
        _pending = PendingPolicy({
            version: pendingVersion,
            readyAt: readyAt,
            proposalId: proposalId,
            sourcePolicyRoot: policy.sourcePolicyRoot,
            sourceCount: policy.sourceCount,
            manifestSha256: policy.manifestSha256,
            adapterSetHash: adapterSetHash,
            metadataDigest: metadataDigest,
            paramsHash: nextHash
        });
        _versionCommitments[pendingVersion] = VersionCommitment({
            paramsHash: nextHash,
            sourcePolicyRoot: policy.sourcePolicyRoot,
            sourceCount: policy.sourceCount,
            manifestSha256: policy.manifestSha256,
            adapterSetHash: adapterSetHash,
            metadataDigest: metadataDigest,
            proposedAt: uint48(block.timestamp),
            activatedAt: 0,
            cancelledAt: 0,
            status: ProposalStatus.Pending
        });
        emit PolicyProposed(
            instanceId,
            pendingVersion,
            proposalId,
            policy.sourcePolicyRoot,
            policy.sourceCount,
            policy.manifestSha256,
            adapterSetHash,
            metadataDigest,
            nextHash,
            readyAt
        );
    }

    function cancelPolicy() external onlyOwner {
        PendingPolicy memory pending = _pending;
        if (pending.version == 0) revert NoPendingPolicy();
        VersionCommitment storage commitment = _versionCommitments[pending.version];
        commitment.cancelledAt = uint48(block.timestamp);
        commitment.status = ProposalStatus.Cancelled;
        delete _pending;
        emit PolicyProposalCancelled(instanceId, pending.version, pending.proposalId);
    }

    /// @notice Permissionless activation using the exact proposal calldata preimage.
    function activatePolicy(uint64 expectedVersion, bytes calldata manifest, address[] calldata adapters)
        external
        returns (bytes32 newHash)
    {
        PendingPolicy memory pending = _pending;
        if (pending.version == 0) revert NoPendingPolicy();
        if (expectedVersion != pending.version) revert PendingVersionMismatch(expectedVersion, pending.version);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pending.readyAt) revert ActivationDelayNotElapsed(pending.readyAt);

        TrustComposeValidatorV2.Commitment memory policy = TrustComposeValidatorV2.validatePolicyManifest(
            manifest, _currentParams.chainId, _currentParams.maxSourceAgeBlocks
        );
        accumulator.validatePolicy(manifest, adapters);
        bytes32 adapterSetHash = keccak256(abi.encode(adapters));
        if (
            policy.sourcePolicyRoot != pending.sourcePolicyRoot || policy.sourceCount != pending.sourceCount
                || policy.manifestSha256 != pending.manifestSha256 || adapterSetHash != pending.adapterSetHash
        ) revert ActivationPreimageMismatch();

        bytes32 previousHash = currentParamsHash;
        _assertLiveState(previousHash);
        TrustComposeParamsCodecV2.Params memory next = _currentParams;
        next.sourcePolicyRoot = policy.sourcePolicyRoot;
        next.sourceCount = policy.sourceCount;
        next.policyManifestSha256 = policy.manifestSha256;
        TrustComposeValidatorV2.validateRotation(next, _initialParams);
        newHash = TrustComposeParamsCodecV2.hash(next);
        if (newHash != pending.paramsHash) revert ActivationPreimageMismatch();

        // All three truth/discovery surfaces move atomically or the transaction rolls back.
        accumulator.installPolicy(pending.version, manifest, adapters);
        // A reviewed adapter can be replaced for the same source-policy bytes (for example after
        // provenance recovery). In that case the guest params honestly remain unchanged, while
        // the accumulator's authenticated adapter set and controller history still advance.
        if (newHash != previousHash) {
            MerkleSnapshot(snapshot).setParamsHash(newHash);
            registry.updateParamsHash(instanceId, newHash);
        }

        version = pending.version;
        currentParamsHash = newHash;
        currentAdapterSetHash = adapterSetHash;
        _currentParams = next;
        VersionCommitment storage commitment = _versionCommitments[pending.version];
        commitment.activatedAt = uint48(block.timestamp);
        commitment.status = ProposalStatus.Activated;
        delete _pending;
        emit PolicyActivated(
            instanceId, version, newHash, previousHash, pending.proposalId, adapterSetHash, pending.metadataDigest, next
        );
    }

    function _assertInitialPreimage(bytes calldata manifest, address[] calldata adapters) private view {
        VersionCommitment memory v1 = _versionCommitments[1];
        TrustComposeValidatorV2.Commitment memory policy = TrustComposeValidatorV2.validatePolicyManifest(
            manifest, _currentParams.chainId, _currentParams.maxSourceAgeBlocks
        );
        accumulator.validatePolicy(manifest, adapters);
        if (
            policy.sourcePolicyRoot != v1.sourcePolicyRoot || policy.sourceCount != v1.sourceCount
                || policy.manifestSha256 != v1.manifestSha256 || keccak256(abi.encode(adapters)) != v1.adapterSetHash
        ) revert InitialPolicyMismatch();
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
