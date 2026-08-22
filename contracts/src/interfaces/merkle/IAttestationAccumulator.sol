// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IAttestationAccumulator
/// @notice A chained running hash over the ordered attestation/revocation log, plus checkpoints that
///         freeze a `(acc, leafCount, blockNumber)` snapshot for an in-flight proof. This converts a
///         prover-chosen input set into a chain-pinned one: a proof of `root == PageRank(E)` is only
///         meaningful if the chain committed exactly which edges `E` existed.
interface IAttestationAccumulator {
    /// @notice A frozen snapshot of the accumulator at a point in time.
    struct Checkpoint {
        bytes32 acc;
        uint64 leafCount;
        uint64 blockNumber;
    }

    /// @notice Emitted for every folded edge (lets provers/indexers reconstruct fold order).
    event EdgeFolded(uint64 indexed index, bytes32 leaf, bytes32 acc);

    /// @notice Emitted when a checkpoint freezes the current accumulator.
    event InputsCheckpointed(uint256 indexed id, bytes32 acc, uint64 leafCount, uint64 blockNumber);

    /// @notice Reverts when checkpointing would produce no new inputs since the last checkpoint.
    error NoNewInputs();

    /// @notice The current running accumulator hash.
    function acc() external view returns (bytes32);

    /// @notice The number of edges folded so far.
    function leafCount() external view returns (uint64);

    /// @notice Freeze the current accumulator as a new checkpoint. Permissionless.
    /// @return id The new checkpoint id (also its index).
    function checkpoint() external returns (uint256 id);

    /// @notice Read a checkpoint by id.
    function getCheckpoint(uint256 id) external view returns (Checkpoint memory);

    /// @notice The number of checkpoints created.
    function checkpointCount() external view returns (uint256);
}
