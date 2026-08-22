// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IZkVerifier
/// @notice The write-gate seam for MerkleSnapshot. An implementation verifies that a proof attests
///         to a given journal digest, reverting if it does not. This abstracts the proving stack
///         (SP1 today) so it is reversible without touching MerkleSnapshot, the accumulator, or any
///         consumer. See SP1JournalVerifier for the SP1 adapter.
interface IZkVerifier {
    /// @notice Verify `proof` commits to `journalDigest`. MUST revert if the proof is invalid.
    /// @param proof Opaque proof blob (encoding is verifier-specific).
    /// @param journalDigest keccak256 of the ABI-encoded public journal the guest committed.
    function verify(bytes calldata proof, bytes32 journalDigest) external view;
}
