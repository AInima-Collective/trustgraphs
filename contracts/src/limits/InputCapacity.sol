// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title InputCapacity
/// @notice Absolute protocol proof-input ceiling used by on-chain ingress and payment policy.
/// @dev This is not a claim about any particular prover host's capacity. The Rust operator pins
///      the same protocol value for cross-language reporting, but its configurable capability
///      profile and cycle limit intentionally may refuse valid checkpoints far below this ceiling.
///      Solidity consumers import this definition so on-chain ingress and payment cannot silently
///      drift apart.
library InputCapacity {
    /// @notice Preserved at 200,000 as the protocol DoS ceiling; operator policy is separate.
    uint64 internal constant MAX_TOTAL_INPUTS = 200_000;
}
