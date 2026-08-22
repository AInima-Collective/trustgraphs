// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";

/// @notice Test double for the lane-2 anchor registry: lets tests set an arbitrary (anchorAcc,
///         anchorCount) so MerkleSnapshot's two-lane checkpoint/journal binding can be driven without
///         a live anchor log.
contract MockAnchorRegistry is IAnchorRegistry {
    bytes32 public anchorAcc;
    uint64 public anchorCount;

    function setState(bytes32 _anchorAcc, uint64 _anchorCount) external {
        anchorAcc = _anchorAcc;
        anchorCount = _anchorCount;
    }
}
