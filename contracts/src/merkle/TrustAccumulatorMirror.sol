// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

/// @title TrustAccumulatorMirror
/// @notice The contributions instance's lane-1 (journal slot A) seam: a checkpointing wrapper
///         around the TRUST instance's live accumulator. Checkpoints are per-accumulator state, so
///         a second `MerkleSnapshot` cannot push checkpoints into the trust accumulator without
///         racing the trust instance's own trigger cadence. The mirror resolves that wiring
///         question (CONTRIBUTION_FUNDING.md §3) by never pushing into the trust accumulator at
///         all: `checkpoint()` READS the trust accumulator's live `(acc, leafCount)` and records
///         the frozen pair in the mirror's own checkpoint array. The trust instance's state and
///         checkpoint history are untouched; the proven input commitment is identical either way,
///         because `acc` already commits to the full ordered edge log.
/// @dev Deliberately NO `NoNewInputs` guard (unlike `AttestationAccumulator.checkpoint`): a round
///      can legitimately close while the vouch graph was quiet, and a revert here would wedge the
///      contributions `MerkleSnapshot.trigger()` for as long as no one vouches. Emits
///      `InputsCheckpointed` like the real accumulator so provers can watch one event shape
///      everywhere.
///
///      `checkpoint()` is callable ONLY by the bound snapshot (research/audits/2026-07-M6.md finding M6-1): a
///      directly-minted mirror checkpoint would carry an id that `trigger()` never created, so the
///      snapshot's `anchorCheckpoints[id]` (the lane-2 contribution freeze) would sit at the
///      default `(0, 0)` — and a proof over an EMPTY contribution log against that id verifies,
///      applying a contributions-blind root. Binding the mirror to the snapshot makes `trigger()`
///      the only checkpoint mint, so every id has both lanes frozen at one block.
contract TrustAccumulatorMirror is IAttestationAccumulator {
    /// @notice The trust instance's accumulator this mirror reads (the live `EASIndexerResolver`).
    IAttestationAccumulator public immutable trustAccumulator;

    /// @notice The only address allowed to mint checkpoints (the contributions `MerkleSnapshot`,
    ///         whose `trigger()` freezes BOTH lanes under one id). Set once via `bindSnapshot`.
    address public snapshot;

    /// @notice The deployer address allowed to perform the one-shot `bindSnapshot`.
    address public immutable binder;

    /// @notice The mirror's own frozen checkpoints (never the trust accumulator's).
    Checkpoint[] private _checkpoints;

    /// @notice The wrapped accumulator must be nonzero.
    error ZeroAddress();
    /// @notice `checkpoint()` called by anything other than the bound snapshot (or pre-bind).
    error NotSnapshot();
    /// @notice `bindSnapshot` called twice or by a non-binder.
    error AlreadyBound();
    /// @notice `bindSnapshot` caller is not the binder.
    error NotBinder();

    /// @notice Emitted when the snapshot is bound.
    event SnapshotBound(address snapshot);

    /// @param _trustAccumulator The trust accumulator to mirror. Immutable: pre-checkpoint
    ///        re-pointing is a constitutional event on the snapshot (`setAccumulator` to a new
    ///        mirror), never a mutation here. Historical instances migrate to a new snapshot.
    constructor(IAttestationAccumulator _trustAccumulator) {
        if (address(_trustAccumulator) == address(0)) {
            revert ZeroAddress();
        }
        trustAccumulator = _trustAccumulator;
        binder = msg.sender;
    }

    /// @notice One-shot: bind the contributions `MerkleSnapshot` whose `trigger()` may mint
    ///         checkpoints. Deploy-time circularity (snapshot's constructor takes the mirror)
    ///         makes this a post-deploy call, mirroring the resolver's `setSchemas` pattern.
    function bindSnapshot(address _snapshot) external {
        if (msg.sender != binder) {
            revert NotBinder();
        }
        if (snapshot != address(0)) {
            revert AlreadyBound();
        }
        if (_snapshot == address(0)) {
            revert ZeroAddress();
        }
        snapshot = _snapshot;
        emit SnapshotBound(_snapshot);
    }

    /// @inheritdoc IAttestationAccumulator
    /// @dev Live pass-through to the trust accumulator.
    function acc() external view returns (bytes32) {
        return trustAccumulator.acc();
    }

    /// @inheritdoc IAttestationAccumulator
    /// @dev Live pass-through to the trust accumulator.
    function leafCount() external view returns (uint64) {
        return trustAccumulator.leafCount();
    }

    /// @inheritdoc IAttestationAccumulator
    /// @dev Freezes the trust accumulator's CURRENT state into a local checkpoint. Never reverts
    ///      on an unchanged accumulator (see the contract-level dev note on the missing
    ///      `NoNewInputs` guard). Only the bound snapshot may mint (M6-1): both lanes must be
    ///      frozen under one id by `trigger()`, or the unset lane-2 freeze reads `(0, 0)`.
    function checkpoint() external returns (uint256 id) {
        if (msg.sender != snapshot || snapshot == address(0)) {
            revert NotSnapshot();
        }
        bytes32 currentAcc = trustAccumulator.acc();
        uint64 currentLeafCount = trustAccumulator.leafCount();

        id = _checkpoints.length;
        _checkpoints.push(Checkpoint({acc: currentAcc, leafCount: currentLeafCount, blockNumber: uint64(block.number)}));
        emit InputsCheckpointed(id, currentAcc, currentLeafCount, uint64(block.number));
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
