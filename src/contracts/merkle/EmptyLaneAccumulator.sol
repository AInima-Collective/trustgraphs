// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

/// @title EmptyLaneAccumulator
/// @notice The lane-1 seam for a LANE-2-ONLY instance (e.g. the hypercerts pilot, which has
///         no EAS feed): every checkpoint freezes the empty lane — `acc = 0, leafCount = 0` —
///         which is exactly what the instance's guest asserts (empty-lane-as-zero,
///         MULTI_PROGRAM_PLATFORM §4). `MerkleSnapshot.trigger()` needs a checkpointable
///         accumulator; a real `EASIndexerResolver` would revert `NoNewInputs` forever on an
///         instance where lane 1 never moves.
/// @dev No fold path exists at all: this lane cannot become nonzero without redeploying a
///      real accumulator through the constitutional `setAccumulator` knob — opening lane 1
///      is deliberately a governance event, not a drift.
contract EmptyLaneAccumulator is IAttestationAccumulator {
    Checkpoint[] private _checkpoints;

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
        id = _checkpoints.length;
        _checkpoints.push(
            Checkpoint({acc: bytes32(0), leafCount: 0, blockNumber: uint64(block.number)})
        );
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
