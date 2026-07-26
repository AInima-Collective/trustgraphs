// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

/// @notice Test double for the accumulator: lets tests push arbitrary checkpoints and drive
///         MerkleSnapshot without a live resolver.
contract MockAccumulator is IAttestationAccumulator {
    bytes32 public acc;
    uint64 public leafCount;
    Checkpoint[] internal cps;

    function setState(bytes32 _acc, uint64 _leafCount) external {
        acc = _acc;
        leafCount = _leafCount;
    }

    function pushCheckpoint(bytes32 _acc, uint64 _leafCount, uint64 _blockNumber) external returns (uint256 id) {
        id = cps.length;
        cps.push(Checkpoint({acc: _acc, leafCount: _leafCount, blockNumber: _blockNumber}));
        emit InputsCheckpointed(id, _acc, _leafCount, _blockNumber);
    }

    function checkpoint() external returns (uint256 id) {
        id = cps.length;
        cps.push(Checkpoint({acc: acc, leafCount: leafCount, blockNumber: uint64(block.number)}));
        emit InputsCheckpointed(id, acc, leafCount, uint64(block.number));
    }

    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return cps[id];
    }

    function checkpointCount() external view returns (uint256) {
        return cps.length;
    }
}
