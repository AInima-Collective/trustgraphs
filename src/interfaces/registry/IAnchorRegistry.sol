// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IAnchorRegistry
/// @notice The lane-2 anchor log's checkpointable surface (see AnchorRegistry).
interface IAnchorRegistry {
    /// @notice The running anchor fold (`keccak256(abi.encode(prev, leaf))`, acc_0 = 0).
    function anchorAcc() external view returns (bytes32);

    /// @notice Number of anchors folded so far.
    function anchorCount() external view returns (uint64);
}
