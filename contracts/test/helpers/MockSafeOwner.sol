// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal Safe-shaped owner used to isolate distributor ownership policy in unit tests.
/// @dev This is not a transaction executor; governed-wrapper tests exercise real Gnosis Safe
///      proxies. It only supplies the two read methods the factory validates at its trust seam.
contract MockSafeOwner {
    address[] private _owners;
    uint256 private _threshold;

    constructor(address owner, uint256 threshold_) {
        if (owner != address(0)) _owners.push(owner);
        _threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }
}

contract NotASafe {}
