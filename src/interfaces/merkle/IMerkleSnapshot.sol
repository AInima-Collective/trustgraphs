// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IMerkleSnapshot
/// @notice Types for the MerkleSnapshot contract.
interface IMerkleSnapshot {
    error NoMerkleStates();
    error NoMerkleStateAtBlock(uint256 requested, uint256 firstBlock);
    error NoMerkleStateAtIndex(uint256 requested, uint256 total);

    error HookAlreadyAdded();
    error HookNotAdded();

    /// @notice Thrown when a proof targets a checkpoint that is not newer than the last applied one.
    error StaleCheckpoint(uint256 checkpointId, uint256 lastApplied);

    /// @notice Thrown when a truth-defining address (verifier / accumulator) would be set to zero.
    error ZeroAddress();

    event MerkleRootUpdated(
        bytes32 indexed root,
        bytes32 ipfsHash,
        string ipfsHashCid,
        uint256 totalValue
    );

    /// @notice Emitted when a ZK proof successfully updates the merkle root for a checkpoint.
    event MerkleProofSubmitted(
        uint256 indexed checkpointId,
        bytes32 indexed root,
        address indexed prover
    );

    /// @notice Emitted when a snapshot is triggered (a checkpoint is frozen).
    event SnapshotTriggered(uint256 indexed checkpointId);

    /// @notice Emitted when the constitutional authority updates the ZK verifier.
    event ZkVerifierUpdated(address indexed zkVerifier);

    /// @notice Emitted when the constitutional authority updates the accumulator.
    event AccumulatorUpdated(address indexed accumulator);

    /// @notice Emitted when the operational authority updates the params hash.
    event ParamsHashUpdated(bytes32 indexed paramsHash);

    struct MerkleState {
        /// @notice The block number the merkle tree was set at
        uint256 blockNumber;
        /// @notice The timestamp the merkle tree was set at
        uint256 timestamp;
        /// @notice The root of the merkle tree
        bytes32 root;
        /// @notice The IPFS hash of the merkle tree
        bytes32 ipfsHash;
        /// @notice The IPFS hash CID of the merkle tree
        string ipfsHashCid;
        /// @notice The total value of the merkle tree
        uint256 totalValue;
    }

    /// @notice Get the latest merkle state.
    /// @return state The latest merkle state.
    function getLatestState() external view returns (MerkleState memory);
}
