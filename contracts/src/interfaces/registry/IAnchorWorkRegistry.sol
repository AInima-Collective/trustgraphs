// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IAnchorWorkRegistry
/// @notice Optional extension for lane-2 registries whose authenticated work exceeds anchor count.
/// @dev `MerkleSnapshot` probes this interface with `staticcall` and safely falls back to
///      `IAnchorRegistry.anchorCount()` for registries without it.
interface IAnchorWorkRegistry {
    /// @notice Current lane-2 work units, excluding lane-1 leaves.
    function workCount() external view returns (uint64);
}
