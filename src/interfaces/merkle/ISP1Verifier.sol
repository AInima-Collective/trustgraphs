// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title ISP1Verifier
/// @notice Minimal interface to Succinct's SP1 verifier / verifier gateway, vendored to avoid a
///         heavyweight contracts dependency. Matches `sp1-contracts` (SP1 v6.x).
interface ISP1Verifier {
    /// @notice Verifies a proof with the given program verification key and public values.
    /// @param programVKey The verification key for the SP1 program (== our guest image id).
    /// @param publicValues The ABI-encoded public values the guest committed.
    /// @param proofBytes The proof bytes (Groth16/PLONK seal, prefixed with the verifier selector).
    /// @dev MUST revert if the proof is invalid.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
