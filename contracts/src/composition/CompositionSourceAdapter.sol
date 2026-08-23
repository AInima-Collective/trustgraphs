// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";
import {
    ICompositionSourceAdapter,
    ICompositionSourceAdapterFactory
} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

interface ICompositionSnapshot is IMerkleSnapshot, IMerkleSnapshotProvenance {
    function getStateCount() external view returns (uint256);
    function getStateAtIndex(uint256 index) external view returns (MerkleState memory);
}

/// @title CompositionSourceAdapter
/// @notice Pins one reviewed registry row and proves every captured output came from its exact
///         snapshot, controller, verifier bytecode, SP1 vkey, checkpoint, and parameter version.
/// @dev Instances are created only by `CompositionSourceAdapterFactory`; the composition
///      accumulator checks that append-only registry so an ABI-compatible lookalike is rejected.
contract CompositionSourceAdapter is ICompositionSourceAdapter {
    bytes32 public constant COMPOSITION_PROGRAM = keccak256("trust-compose");

    IInstanceRegistry public immutable registry;
    bytes32 public immutable instanceId;
    uint64 public immutable chainId;
    bytes32 public immutable sourceId;
    address public immutable snapshot;
    bytes32 public immutable familyId;
    bytes32 public immutable programId;
    bytes32 public immutable outputKind;
    bytes32 public immutable deploymentProvenance;
    address public immutable registryOrAccumulator;
    address public immutable paramsAuthority;
    address public immutable verifier;
    bytes32 public immutable snapshotCodehash;
    bytes32 public immutable verifierCodehash;
    bytes32 public immutable programVKey;

    error ZeroAddress();
    error ZeroIdentity();
    error ChainIdTooLarge(uint256 chainId);
    error CompositeSourceUnsupported();
    error UncontrolledSource();
    error InvalidVerifier();
    error RegistryRecordChanged();
    error SourceCodeChanged(bytes32 expected, bytes32 actual);
    error SourceUnavailable();
    error InvalidStateIndex(uint256 stateIndex);
    error InvalidFreezeBlock(uint256 blockNumber);
    error InvalidTotalValue(uint256 totalValue);
    error EmptySourceOutput();
    error WrongVerifier(address expected, address actual);
    error WrongVerifierCodehash(bytes32 expected, bytes32 actual);
    error WrongProgramVKey(bytes32 expected, bytes32 actual);
    error WrongCheckpoint(uint256 expected, uint256 actual);
    error ProvenanceDisabled();

    constructor(
        IInstanceRegistry registry_,
        bytes32 instanceId_,
        bytes32 sourceId_,
        bytes32 familyId_,
        bytes32 outputKind_,
        bytes32 deploymentProvenance_
    ) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (
            instanceId_ == bytes32(0) || sourceId_ == bytes32(0) || familyId_ == bytes32(0) || outputKind_ == bytes32(0)
                || deploymentProvenance_ == bytes32(0)
        ) revert ZeroIdentity();
        if (block.chainid > type(uint64).max) revert ChainIdTooLarge(block.chainid);

        IInstanceRegistry.Instance memory record = registry_.getInstance(instanceId_);
        if (record.snapshot == address(0) || record.verifier == address(0)) revert ZeroAddress();
        if (record.program == COMPOSITION_PROGRAM) revert CompositeSourceUnsupported();
        if (!ICompositionSnapshot(record.snapshot).provenanceEnabled()) revert ProvenanceDisabled();
        address authority = registry_.paramsAuthority(instanceId_);
        if (authority == address(0)) revert UncontrolledSource();

        bytes32 sourceSnapshotCodehash = record.snapshot.codehash;
        bytes32 sourceVerifierCodehash = record.verifier.codehash;
        (bool ok, bytes memory returned) = record.verifier.staticcall(abi.encodeWithSignature("programVKey()"));
        if (!ok || returned.length != 32) revert InvalidVerifier();
        bytes32 sourceProgramVKey = abi.decode(returned, (bytes32));
        if (
            sourceSnapshotCodehash == bytes32(0) || sourceVerifierCodehash == bytes32(0)
                || sourceProgramVKey == bytes32(0)
        ) revert InvalidVerifier();

        registry = registry_;
        instanceId = instanceId_;
        chainId = uint64(block.chainid);
        sourceId = sourceId_;
        snapshot = record.snapshot;
        familyId = familyId_;
        programId = record.program;
        outputKind = outputKind_;
        deploymentProvenance = deploymentProvenance_;
        registryOrAccumulator = record.registryOrAccumulator;
        paramsAuthority = authority;
        verifier = record.verifier;
        snapshotCodehash = sourceSnapshotCodehash;
        verifierCodehash = sourceVerifierCodehash;
        programVKey = sourceProgramVKey;
    }

    /// @inheritdoc ICompositionSourceAdapter
    function readLatest() external view returns (CapturedState memory captured) {
        _assertIdentity();

        ICompositionSnapshot source = ICompositionSnapshot(snapshot);
        uint256 count = source.getStateCount();
        if (count == 0) revert SourceUnavailable();
        return _readAt(source, count - 1);
    }

    /// @inheritdoc ICompositionSourceAdapter
    function readAt(uint256 stateIndex) external view returns (CapturedState memory captured) {
        _assertIdentity();
        return _readAt(ICompositionSnapshot(snapshot), stateIndex);
    }

    /// @inheritdoc ICompositionSourceAdapter
    function readCheckpoint(uint256 checkpointId) external view returns (CapturedState memory captured) {
        _assertIdentity();
        (IMerkleSnapshot.MerkleState memory state, IMerkleSnapshotProvenance.StateProvenance memory provenance) =
            ICompositionSnapshot(snapshot).getAcceptedCheckpoint(checkpointId);
        if (provenance.checkpointId != checkpointId) revert WrongCheckpoint(checkpointId, provenance.checkpointId);
        return _readState(state, provenance, provenance.stateIndex);
    }

    function _readAt(ICompositionSnapshot source, uint256 index) private view returns (CapturedState memory captured) {
        if (index > type(uint64).max) revert InvalidStateIndex(index);
        IMerkleSnapshot.MerkleState memory state = source.getStateAtIndex(index);
        IMerkleSnapshotProvenance.StateProvenance memory provenance = source.getStateProvenance(index);
        return _readState(state, provenance, index);
    }

    function _readState(
        IMerkleSnapshot.MerkleState memory state,
        IMerkleSnapshotProvenance.StateProvenance memory provenance,
        uint256 index
    ) private view returns (CapturedState memory captured) {
        if (index > type(uint64).max) revert InvalidStateIndex(index);
        if (state.blockNumber == 0 || state.blockNumber > type(uint64).max) {
            revert InvalidFreezeBlock(state.blockNumber);
        }
        if (state.totalValue == 0 || state.totalValue > type(uint128).max) {
            revert InvalidTotalValue(state.totalValue);
        }
        if (
            state.root == bytes32(0) || state.ipfsHash == bytes32(0) || bytes(state.ipfsHashCid).length == 0
                || provenance.paramsHash == bytes32(0) || provenance.acceptedAtBlock == 0
        ) revert EmptySourceOutput();
        if (provenance.verifier != verifier) revert WrongVerifier(verifier, provenance.verifier);
        if (provenance.verifierCodehash != verifierCodehash) {
            revert WrongVerifierCodehash(verifierCodehash, provenance.verifierCodehash);
        }
        if (provenance.programVKey != programVKey) {
            revert WrongProgramVKey(programVKey, provenance.programVKey);
        }

        return CapturedState({
            stateIndex: uint64(index),
            freezeBlock: uint64(state.blockNumber),
            outputRoot: state.root,
            blobSha256: state.ipfsHash,
            cidDigest: keccak256(bytes(state.ipfsHashCid)),
            totalValue: uint128(state.totalValue),
            checkpointId: provenance.checkpointId,
            acceptedAtBlock: provenance.acceptedAtBlock,
            paramsHash: provenance.paramsHash,
            verifier: provenance.verifier,
            verifierCodehash: provenance.verifierCodehash,
            programVKey: provenance.programVKey
        });
    }

    function _assertIdentity() private view {
        if (block.chainid != chainId) revert RegistryRecordChanged();
        if (snapshot.codehash != snapshotCodehash) revert SourceCodeChanged(snapshotCodehash, snapshot.codehash);
        if (verifier.codehash != verifierCodehash) revert SourceCodeChanged(verifierCodehash, verifier.codehash);

        IInstanceRegistry.Instance memory record = registry.getInstance(instanceId);
        if (
            record.program != programId || record.snapshot != snapshot || record.verifier != verifier
                || record.registryOrAccumulator != registryOrAccumulator
                || registry.paramsAuthority(instanceId) != paramsAuthority
        ) revert RegistryRecordChanged();
    }
}

/// @title CompositionSourceAdapterFactory
/// @notice Permissionless provenance-checking deployer and append-only authenticity registry.
contract CompositionSourceAdapterFactory is ICompositionSourceAdapterFactory {
    IInstanceRegistry public immutable registry;
    mapping(address adapter => bool) public isAdapter;

    error ZeroAddress();
    error ForeignRegistry(address expected, address actual);

    event SourceAdapterCreated(
        address indexed adapter,
        address indexed registry,
        bytes32 indexed instanceId,
        bytes32 sourceId,
        address snapshot,
        bytes32 programId,
        bytes32 deploymentProvenance
    );

    constructor(IInstanceRegistry registry_) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        registry = registry_;
    }

    function create(
        IInstanceRegistry registry_,
        bytes32 instanceId,
        bytes32 sourceId,
        bytes32 familyId,
        bytes32 outputKind,
        bytes32 deploymentProvenance
    ) external returns (CompositionSourceAdapter adapter) {
        if (address(registry_) != address(registry)) {
            revert ForeignRegistry(address(registry), address(registry_));
        }
        adapter =
            new CompositionSourceAdapter(registry, instanceId, sourceId, familyId, outputKind, deploymentProvenance);
        isAdapter[address(adapter)] = true;
        emit SourceAdapterCreated(
            address(adapter),
            address(registry),
            instanceId,
            sourceId,
            adapter.snapshot(),
            adapter.programId(),
            deploymentProvenance
        );
    }
}
