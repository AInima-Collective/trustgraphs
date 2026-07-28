// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";

/// @notice A Chainlink-shaped ETH/USD feed the tests can make fresh, stale, negative, or hostile.
contract MockEthUsdFeed is IEthUsdFeed {
    int256 public answer = 3_000e8; // $3,000
    uint256 public updatedAt = 1;
    bool public shouldRevert;

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}
