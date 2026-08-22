// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title ISnapshotAccumulatorView
/// @notice The one thing an accumulator needs to read off a `MerkleSnapshot`: which accumulator
///         that snapshot considers its input lane. Used by `bindSnapshot` so a binding can only
///         name a snapshot that already points back at the accumulator being bound.
/// @dev A separate minimal interface rather than importing `MerkleSnapshot`: the accumulator is a
///      mix-in inherited by EAS resolvers and must not pull the whole snapshot into their
///      bytecode (EIP-170 is already tight on the factory path).
interface ISnapshotAccumulatorView {
    /// @notice The accumulator this snapshot reads checkpoints from.
    function accumulator() external view returns (address);
}
