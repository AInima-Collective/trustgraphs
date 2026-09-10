// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Shared bounds for deploying and updating the signer selection policy.
library SignerSelectionPolicy {
    uint32 internal constant MAX_SIGNERS = 64;

    function isValid(
        uint32 topN,
        uint32 minThreshold,
        uint32 targetThresholdBps,
        uint64 maxInactiveBlocks,
        uint32 minActivityWitnesses
    ) internal pure returns (bool) {
        return topN >= 2 && topN <= MAX_SIGNERS && minThreshold >= 2 && minThreshold <= topN && targetThresholdBps > 0
            && targetThresholdBps <= 10_000 && maxInactiveBlocks > 0 && minActivityWitnesses >= 2
            && minActivityWitnesses <= topN;
    }
}
