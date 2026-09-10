// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ISnapshotAccumulatorView} from "interfaces/merkle/ISnapshotAccumulatorView.sol";

/// @title EmptyLaneAccumulator
/// @notice The lane-1 seam for a LANE-2-ONLY instance (e.g. the hypercerts pilot, which has
///         no EAS feed): every checkpoint freezes the empty lane — `acc = 0, leafCount = 0` —
///         which is exactly what the instance's guest asserts (empty-lane-as-zero,
///         MULTI_PROGRAM_PLATFORM §4). `MerkleSnapshot.trigger()` needs a checkpointable
///         accumulator; a real `EASIndexerResolver` would revert `NoNewInputs` forever on an
///         instance where lane 1 never moves.
/// @dev No fold path exists at all: this lane cannot become nonzero without redeploying a
///      real accumulator through the constitutional `setAccumulator` knob before the first
///      checkpoint. After history exists, opening lane 1 requires a replacement snapshot and
///      explicit vault migration so checkpoint ids and freeze blocks cannot be rewritten.
contract EmptyLaneAccumulator is IAttestationAccumulator {
    Checkpoint[] private _checkpoints;

    /// @notice The only address allowed to mint checkpoints (the instance's `MerkleSnapshot`).
    /// @dev Same one-time binding as `AttestationAccumulator` and `TrustAccumulatorMirror`, and
    ///      needed for the same reason: an id minted outside `trigger()` has no
    ///      pinned `paramsHash` and no paired lane-2 freeze. It matters MORE here than anywhere
    ///      else, because on a lane-2-only instance lane 1 is constant `(0, 0)` — so the id is
    ///      the ONLY thing distinguishing one epoch's inputs from another's.
    address public snapshot;

    /// @notice The deployer, and the only address that may perform the one-shot `bindSnapshot`.
    address public immutable binder;

    /// @notice Emitted once, when the accumulator is bound to the snapshot that owns its epochs.
    event SnapshotBound(address snapshot);

    /// @notice `checkpoint()` called by anything other than the bound snapshot (or before binding).
    error NotSnapshot();
    /// @notice `bindSnapshot` called twice.
    error AlreadyBound();
    /// @notice `bindSnapshot` called by anyone but the deployer.
    error NotBinder();
    /// @notice `bindSnapshot` given the zero address.
    error ZeroSnapshot();
    /// @notice `bindSnapshot` given a snapshot whose `accumulator()` is not this contract.
    error SnapshotReadsAnotherAccumulator(address reads);

    constructor() {
        binder = msg.sender;
    }

    /// @notice One-shot: bind the `MerkleSnapshot` whose `trigger()` may mint checkpoints here.
    function bindSnapshot(address _snapshot) external {
        if (msg.sender != binder) revert NotBinder();
        if (snapshot != address(0)) revert AlreadyBound();
        if (_snapshot == address(0)) revert ZeroSnapshot();

        address reads = ISnapshotAccumulatorView(_snapshot).accumulator();
        if (reads != address(this)) revert SnapshotReadsAnotherAccumulator(reads);

        snapshot = _snapshot;
        emit SnapshotBound(_snapshot);
    }

    /// @inheritdoc IAttestationAccumulator
    function acc() external pure returns (bytes32) {
        return bytes32(0);
    }

    /// @inheritdoc IAttestationAccumulator
    function leafCount() external pure returns (uint64) {
        return 0;
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpoint() external returns (uint256 id) {
        if (msg.sender != snapshot || snapshot == address(0)) revert NotSnapshot();

        id = _checkpoints.length;
        _checkpoints.push(Checkpoint({acc: bytes32(0), leafCount: 0, blockNumber: uint64(block.number)}));
        emit InputsCheckpointed(id, bytes32(0), 0, uint64(block.number));
    }

    /// @inheritdoc IAttestationAccumulator
    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return _checkpoints[id];
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpointCount() external view returns (uint256) {
        return _checkpoints.length;
    }
}
