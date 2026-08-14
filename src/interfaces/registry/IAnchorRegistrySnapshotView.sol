// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IAnchorRegistrySnapshotView
/// @notice Minimal reciprocal-binding and lane-size surface used by `AnchorRegistry`.
interface IAnchorRegistrySnapshotView {
    function accumulator() external view returns (address);
    function anchorRegistry() external view returns (address);
}
