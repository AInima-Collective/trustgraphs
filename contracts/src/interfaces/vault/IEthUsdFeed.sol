// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IEthUsdFeed
/// @notice The two things the vault needs from a price oracle: an ETH/USD answer and when it was
///         last updated. Chainlink's `AggregatorV3Interface` shape, declared locally so the repo
///         does not take a dependency on the whole aggregator surface for one call.
/// @dev The vault treats a non-positive answer, a zero timestamp, an answer older than
///      `FEED_MAX_STALENESS`, or a reverting call as identical: no usable price. That pays a zero
///      proving fee and still lands the root — fail open on correctness, closed on money.
interface IEthUsdFeed {
    /// @return roundId The round the answer belongs to.
    /// @return answer ETH/USD, scaled by `decimals()` (8 for Chainlink USD feeds).
    /// @return startedAt When the round started.
    /// @return updatedAt When the answer was last written. This is the staleness clock.
    /// @return answeredInRound The round the answer was computed in.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    /// @notice Decimals of `answer`. The vault assumes 8 (`ProvingVault.USD`).
    function decimals() external view returns (uint8);
}
