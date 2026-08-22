// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";

/// @title SP1JournalVerifier
/// @notice Adapts the SP1 verifier gateway to the `IZkVerifier` seam. Journal-agnostic: it binds
/// `keccak256(publicValues)` to the consumer-computed journal digest and delegates proof checking
/// to the gateway — the consumer (`MerkleSnapshot`, `SignerSyncZkModule`, …) owns the journal
/// shape. Same bytecode serves every program, deployed once per program with its own vkey.
///
/// The `programVKey` (the SP1 guest's verification key) is the constitutional "what is correct
/// for this program" knob and is IMMUTABLE here: to change the guest, deploy a new verifier and
/// re-point the consumer's `zkVerifier` through the constitutional timelock (D8). This avoids any
/// drift between a stored image id and the key the gateway actually checks.
contract SP1JournalVerifier is IZkVerifier {
    /// @notice The SP1 verifier (or verifier gateway) this adapter delegates to.
    ISP1Verifier public immutable gateway;

    /// @notice The SP1 program verification key (guest image id).
    bytes32 public immutable programVKey;

    /// @notice Thrown when the committed public values do not hash to the expected journal digest.
    error JournalMismatch();

    constructor(ISP1Verifier _gateway, bytes32 _programVKey) {
        gateway = _gateway;
        programVKey = _programVKey;
    }

    /// @inheritdoc IZkVerifier
    /// @param proof `abi.encode(bytes publicValues, bytes proofBytes)` produced by the prover host.
    /// @param journalDigest keccak256 of the journal the guest committed as `publicValues`.
    function verify(bytes calldata proof, bytes32 journalDigest) external view {
        (bytes memory publicValues, bytes memory proofBytes) = abi.decode(proof, (bytes, bytes));

        // Bind the proof's public values to the exact journal MerkleSnapshot computed on-chain.
        if (keccak256(publicValues) != journalDigest) {
            revert JournalMismatch();
        }

        // Reverts if the SP1 proof is invalid for (programVKey, publicValues).
        gateway.verifyProof(programVKey, publicValues, proofBytes);
    }
}
