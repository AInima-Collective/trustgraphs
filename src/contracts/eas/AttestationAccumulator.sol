// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

/// @title AttestationAccumulator
/// @notice Abstract mix-in that folds every edge passing through a resolver into a chained keccak
///         hash and lets anyone checkpoint the running state. Inherited by exactly ONE live feeder
///         (the single-schema EASIndexerResolver) so there is one ordered log = one `acc`
///         (see ZK_ARCHITECTURE.md §3.2, the one-accumulator-per-checkpoint invariant).
///
/// @dev The leaf and fold encodings are frozen and reproduced byte-for-byte by the zkVM guest
///      (`pagerank-core::encode`): the guest re-folds all leaves and asserts it reproduces `acc`,
///      which is how input completeness is proven.
abstract contract AttestationAccumulator is IAttestationAccumulator {
    /// @inheritdoc IAttestationAccumulator
    bytes32 public acc;

    /// @inheritdoc IAttestationAccumulator
    uint64 public leafCount;

    /// @notice All checkpoints, indexed by id.
    Checkpoint[] public checkpoints;

    /// @notice Fold one edge into the accumulator.
    /// @dev Called INLINE from the resolver's onAttest/onRevoke, so `block.timestamp` is exactly the
    ///      attestation's block time — the ordering key the guest reconciles on. Do not call `_fold`
    ///      from a deferred/batched context or the committed timestamp would drift from the edge.
    /// @param kind 0 = attest, 1 = revoke.
    /// @param attester The attester address.
    /// @param recipient The recipient address.
    /// @param uid The attestation uid.
    /// @param dataHash keccak256 of the raw attestation data.
    function _fold(uint8 kind, address attester, address recipient, bytes32 uid, bytes32 dataHash)
        internal
    {
        bytes32 leaf =
            keccak256(abi.encode(kind, attester, recipient, uid, block.timestamp, dataHash));
        acc = keccak256(abi.encode(acc, leaf));
        emit EdgeFolded(leafCount, leaf, acc);
        leafCount++;
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpoint() external returns (uint256 id) {
        uint256 len = checkpoints.length;
        // Anti-spam / correctness: a checkpoint must capture at least one new edge, except the very
        // first (which may legitimately freeze an empty input set).
        if (len != 0 && leafCount <= checkpoints[len - 1].leafCount) {
            revert NoNewInputs();
        }
        id = len;
        checkpoints.push(
            Checkpoint({acc: acc, leafCount: leafCount, blockNumber: uint64(block.number)})
        );
        emit InputsCheckpointed(id, acc, leafCount, uint64(block.number));
    }

    /// @inheritdoc IAttestationAccumulator
    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return checkpoints[id];
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpointCount() external view returns (uint256) {
        return checkpoints.length;
    }
}
