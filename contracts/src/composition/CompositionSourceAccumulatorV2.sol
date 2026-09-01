// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustComposeValidatorV2} from "src/params/TrustComposeValidatorV2.sol";
import {ICompositionSourceAdapter} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ISnapshotAccumulatorView} from "interfaces/merkle/ISnapshotAccumulatorView.sol";

/// @title CompositionSourceAccumulatorV2
/// @notice Pulls 2–8 authenticated source states at trigger time and freezes the exact canonical
///         `TGCM` V2 bytes under the standard accumulator checkpoint interface. V2 records carry
///         each source's real output domain, derived from the adapter's authenticated program ID —
///         never from caller input — and checked against the committed policy bytes.
contract CompositionSourceAccumulatorV2 is IAttestationAccumulator {
    bytes4 public constant CAPTURE_MAGIC = 0x5447434d; // "TGCM"
    uint16 public constant MANIFEST_VERSION = 2;
    uint256 public constant POLICY_HEADER_LENGTH = 15;
    uint256 public constant POLICY_RECORD_LENGTH = 165;
    bytes32 public constant ALLOCATION_OUTPUT_KIND = keccak256("allocation");

    struct PolicySource {
        ICompositionSourceAdapter adapter;
        uint64 weight;
        uint64 maxAgeBlocks;
    }

    ICompositionSourceAdapterFactory public immutable adapterFactory;
    address public immutable binder;
    address public snapshot;
    address public controller;
    uint64 public policyVersion;
    bytes32 public policyRoot;
    bytes32 public policyManifestSha256;
    bytes32 public adapterSetHash;

    PolicySource[] private _policy;
    Checkpoint[] private _checkpoints;
    mapping(uint256 checkpointId => bytes manifest) private _captureManifests;
    mapping(uint256 checkpointId => uint64 version) public checkpointPolicyVersion;
    mapping(uint256 checkpointId => bytes32 hash) public checkpointAdapterSetHash;
    mapping(uint256 checkpointId => uint256[] sourceCheckpointIds) private _captureSourceCheckpointIds;

    event CompositionBound(address indexed snapshot, address indexed controller);
    event PolicyInstalled(
        uint64 indexed version,
        bytes32 indexed policyRoot,
        bytes32 indexed manifestSha256,
        bytes32 adapterSetHash,
        uint8 sourceCount
    );
    event CaptureManifestStored(uint256 indexed checkpointId, bytes32 indexed sha256Digest, bytes manifest);

    error ZeroAddress();
    error NotBinder();
    error AlreadyBound();
    error SnapshotReadsAnotherAccumulator(address reads);
    error NotSnapshot();
    error NotController();
    error InvalidPolicyVersion(uint64 current, uint64 proposed);
    error AdapterCountMismatch(uint256 expected, uint256 actual);
    error UnauthenticatedAdapter(uint8 index, address adapter);
    error DuplicateAdapter(uint8 index, address adapter);
    error AdapterPolicyMismatch(uint8 index);
    error UnadmittedAdapterProgram(uint8 index, bytes32 programId);
    error WrongOutputKind(uint8 index, bytes32 outputKind);
    error WrongAdapterChain(uint8 index, uint64 chainId);
    error CaptureBlockTooLarge(uint256 blockNumber);
    error SourceStateFromFuture(uint8 index, uint64 sourceBlock, uint256 captureBlock);
    error SourceAcceptanceFromFuture(uint8 index, uint64 acceptedBlock, uint256 captureBlock);
    error StaleSource(uint8 index, uint64 sourceBlock, uint64 maxAgeBlocks);

    constructor(ICompositionSourceAdapterFactory adapterFactory_, address binder_) {
        if (address(adapterFactory_) == address(0) || binder_ == address(0)) revert ZeroAddress();
        adapterFactory = adapterFactory_;
        binder = binder_;
    }

    /// @notice One-shot circular-dependency binding performed by the creating factory.
    function bind(address snapshot_, address controller_) external {
        if (msg.sender != binder) revert NotBinder();
        if (snapshot != address(0) || controller != address(0)) revert AlreadyBound();
        if (snapshot_ == address(0) || controller_ == address(0)) revert ZeroAddress();
        address reads = ISnapshotAccumulatorView(snapshot_).accumulator();
        if (reads != address(this)) revert SnapshotReadsAnotherAccumulator(reads);
        snapshot = snapshot_;
        controller = controller_;
        emit CompositionBound(snapshot_, controller_);
    }

    function policyCount() external view returns (uint256) {
        return _policy.length;
    }

    function policyAt(uint256 index) external view returns (address adapter, uint64 weight, uint64 maxAgeBlocks) {
        PolicySource storage source = _policy[index];
        return (address(source.adapter), source.weight, source.maxAgeBlocks);
    }

    /// @notice Validate the canonical TGCP V2 bytes and exact adapter bindings without changing state.
    function validatePolicy(bytes calldata manifest, address[] calldata adapters)
        external
        view
        returns (TrustComposeValidatorV2.Commitment memory commitment)
    {
        return _validatePolicy(manifest, adapters);
    }

    /// @notice Atomically replace the complete source/weight/freshness policy.
    function installPolicy(uint64 version, bytes calldata manifest, address[] calldata adapters) external {
        if (msg.sender != controller || controller == address(0)) revert NotController();
        if (version <= policyVersion) revert InvalidPolicyVersion(policyVersion, version);
        TrustComposeValidatorV2.Commitment memory commitment = _validatePolicy(manifest, adapters);

        delete _policy;
        uint8 count = commitment.sourceCount;
        for (uint8 i; i < count; ++i) {
            (,,,,, uint64 weight, uint64 maxAgeBlocks) = _policyRecord(manifest, i);
            _policy.push(
                PolicySource({
                    adapter: ICompositionSourceAdapter(adapters[i]), weight: weight, maxAgeBlocks: maxAgeBlocks
                })
            );
        }
        policyVersion = version;
        policyRoot = commitment.sourcePolicyRoot;
        policyManifestSha256 = commitment.manifestSha256;
        adapterSetHash = keccak256(abi.encode(adapters));
        emit PolicyInstalled(version, commitment.sourcePolicyRoot, commitment.manifestSha256, adapterSetHash, count);
    }

    /// @inheritdoc IAttestationAccumulator
    function acc() external view returns (bytes32) {
        (bytes memory manifest,) = _capture();
        return sha256(manifest);
    }

    /// @inheritdoc IAttestationAccumulator
    function leafCount() external view returns (uint64) {
        return uint64(_policy.length);
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpoint() external returns (uint256 id) {
        if (msg.sender != snapshot || snapshot == address(0)) revert NotSnapshot();
        (bytes memory manifest, uint256[] memory sourceCheckpointIds) = _capture();
        bytes32 digest = sha256(manifest);
        uint64 count = uint64(_policy.length);
        id = _checkpoints.length;
        _checkpoints.push(Checkpoint({acc: digest, leafCount: count, blockNumber: uint64(block.number)}));
        _captureManifests[id] = manifest;
        checkpointPolicyVersion[id] = policyVersion;
        checkpointAdapterSetHash[id] = adapterSetHash;
        for (uint256 i; i < sourceCheckpointIds.length; ++i) {
            _captureSourceCheckpointIds[id].push(sourceCheckpointIds[i]);
        }
        emit InputsCheckpointed(id, digest, count, uint64(block.number));
        emit CaptureManifestStored(id, digest, manifest);
    }

    /// @inheritdoc IAttestationAccumulator
    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return _checkpoints[id];
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpointCount() external view returns (uint256) {
        return _checkpoints.length;
    }

    /// @notice Recover the exact frozen TGCM preimage consumed by the prover.
    function getCaptureManifest(uint256 checkpointId) external view returns (bytes memory) {
        return _captureManifests[checkpointId];
    }

    /// @notice Exact source checkpoint IDs pulled into one frozen capture, in TGCM record order.
    function getCaptureSourceCheckpointIds(uint256 checkpointId) external view returns (uint256[] memory) {
        return _captureSourceCheckpointIds[checkpointId];
    }

    /// @notice Build the exact current TGCM preimage without storing a checkpoint.
    function currentCaptureManifest() external view returns (bytes memory) {
        (bytes memory manifest,) = _capture();
        return manifest;
    }

    function _capture() private view returns (bytes memory manifest, uint256[] memory sourceCheckpointIds) {
        if (block.number > type(uint64).max) revert CaptureBlockTooLarge(block.number);
        uint256 count = _policy.length;
        sourceCheckpointIds = new uint256[](count);
        manifest = abi.encodePacked(
            CAPTURE_MAGIC, MANIFEST_VERSION, uint64(block.chainid), uint64(block.number), uint8(count)
        );
        for (uint8 i; i < count; ++i) {
            PolicySource storage policy = _policy[i];
            ICompositionSourceAdapter adapter = policy.adapter;
            ICompositionSourceAdapter.CapturedState memory state = adapter.readLatest();
            sourceCheckpointIds[i] = state.checkpointId;
            if (state.freezeBlock > block.number) {
                revert SourceStateFromFuture(i, state.freezeBlock, block.number);
            }
            if (state.acceptedAtBlock > block.number) {
                revert SourceAcceptanceFromFuture(i, state.acceptedAtBlock, block.number);
            }
            if (block.number - state.freezeBlock > policy.maxAgeBlocks) {
                revert StaleSource(i, state.freezeBlock, policy.maxAgeBlocks);
            }
            bytes32 programId = adapter.programId();
            bytes32 sourceOutputDomain = TrustComposeValidatorV2.admittedSourceOutputDomain(programId);
            if (sourceOutputDomain == bytes32(0)) revert UnadmittedAdapterProgram(i, programId);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    programId,
                    sourceOutputDomain,
                    state.stateIndex,
                    state.freezeBlock,
                    state.outputRoot,
                    state.blobSha256,
                    state.cidDigest,
                    state.totalValue,
                    policy.weight,
                    policy.maxAgeBlocks,
                    uint8(1)
                )
            );
        }
    }

    function _validatePolicy(bytes calldata manifest, address[] calldata adapters)
        private
        view
        returns (TrustComposeValidatorV2.Commitment memory commitment)
    {
        commitment = TrustComposeValidatorV2.validatePolicyManifest(manifest, uint64(block.chainid), type(uint64).max);
        uint8 count = commitment.sourceCount;
        if (adapters.length != count) revert AdapterCountMismatch(count, adapters.length);

        for (uint8 i; i < count; ++i) {
            address adapterAddress = adapters[i];
            if (!adapterFactory.isAdapter(adapterAddress)) revert UnauthenticatedAdapter(i, adapterAddress);
            for (uint8 j; j < i; ++j) {
                if (adapters[j] == adapterAddress) revert DuplicateAdapter(i, adapterAddress);
            }
            ICompositionSourceAdapter adapter = ICompositionSourceAdapter(adapterAddress);
            (
                bytes32 sourceId_,
                address snapshot_,
                bytes32 familyId_,
                bytes32 programId_,
                bytes32 sourceOutputDomain_,,
                uint64 maxAgeBlocks
            ) = _policyRecord(manifest, i);
            if (
                adapter.sourceId() != sourceId_ || adapter.snapshot() != snapshot_ || adapter.familyId() != familyId_
                    || adapter.programId() != programId_ || adapter.deploymentProvenance() == bytes32(0)
                    || maxAgeBlocks == 0
            ) revert AdapterPolicyMismatch(i);
            // The committed output domain must be the one derived from the adapter's authenticated
            // program, not merely a value consistent with the manifest's own program column.
            bytes32 derivedDomain = TrustComposeValidatorV2.admittedSourceOutputDomain(adapter.programId());
            if (derivedDomain == bytes32(0)) revert UnadmittedAdapterProgram(i, adapter.programId());
            if (derivedDomain != sourceOutputDomain_) revert AdapterPolicyMismatch(i);
            bytes32 adapterOutputKind = adapter.outputKind();
            if (adapterOutputKind != ALLOCATION_OUTPUT_KIND) revert WrongOutputKind(i, adapterOutputKind);
            uint64 adapterChain = adapter.chainId();
            if (adapterChain != uint64(block.chainid)) revert WrongAdapterChain(i, adapterChain);
        }
    }

    function _policyRecord(bytes calldata manifest, uint8 index)
        private
        pure
        returns (
            bytes32 sourceId_,
            address snapshot_,
            bytes32 familyId_,
            bytes32 programId_,
            bytes32 sourceOutputDomain_,
            uint64 weight_,
            uint64 maxAgeBlocks_
        )
    {
        uint256 offset = POLICY_HEADER_LENGTH + uint256(index) * POLICY_RECORD_LENGTH;
        assembly ("memory-safe") {
            sourceId_ := calldataload(add(manifest.offset, offset))
            snapshot_ := shr(96, calldataload(add(add(manifest.offset, offset), 32)))
            familyId_ := calldataload(add(add(manifest.offset, offset), 52))
            programId_ := calldataload(add(add(manifest.offset, offset), 84))
            sourceOutputDomain_ := calldataload(add(add(manifest.offset, offset), 116))
            weight_ := shr(192, calldataload(add(add(manifest.offset, offset), 148)))
            maxAgeBlocks_ := shr(192, calldataload(add(add(manifest.offset, offset), 156)))
        }
    }
}
