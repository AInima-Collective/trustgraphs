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
///      contributions `MerkleSnapshot.trigger()` for as long as no one vouches. Checkpoint spam is
///      bounded by the snapshot's `epochLength` gate (trigger is the only expected caller, and the
///      contract-fixed epoch schedule paces it); a direct spam call costs the spammer gas and adds
///      a redundant-but-harmless checkpoint. Emits `InputsCheckpointed` like the real accumulator
///      so provers can watch one event shape everywhere.
contract TrustAccumulatorMirror is IAttestationAccumulator {
    /// @notice The trust instance's accumulator this mirror reads (the live `EASIndexerResolver`).
    IAttestationAccumulator public immutable trustAccumulator;

    /// @notice The mirror's own frozen checkpoints (never the trust accumulator's).
    Checkpoint[] private _checkpoints;

    /// @notice The wrapped accumulator must be nonzero.
    error ZeroAddress();

    /// @param _trustAccumulator The trust accumulator to mirror. Immutable: re-pointing the input
    ///        lane is a constitutional event on the snapshot (`setAccumulator` to a new mirror),
    ///        never a mutation here.
    constructor(IAttestationAccumulator _trustAccumulator) {
        if (address(_trustAccumulator) == address(0)) {
            revert ZeroAddress();
        }
        trustAccumulator = _trustAccumulator;
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
    ///      `NoNewInputs` guard).
    function checkpoint() external returns (uint256 id) {
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
