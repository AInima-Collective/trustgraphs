// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title InputCapacity
/// @notice Shared on-chain proof-input ceiling. The Rust operator pins the same value and tests the
///         cross-language boundary; Solidity consumers import this definition so ingress and
///         payment cannot silently drift apart.
library InputCapacity {
    uint64 internal constant MAX_TOTAL_INPUTS = 200_000;
}
