// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";

/// @notice Test double at the GATEWAY seam (vs `MockZkVerifier` at the `IZkVerifier` seam).
///         Lets a local e2e run the real `SP1JournalVerifier` — journal-digest binding, vkey
///         pinning, proof-blob decoding — while stubbing only the SNARK check itself (which
///         needs a Groth16-capable prover: SP1_PROVER=network or a 16-32 GiB box). Pair with
///         `SP1_PROVER=mock` proofs: real publicValues, dummy seal.
contract MockSP1Gateway is ISP1Verifier {
    bool public accept = true;
    /// @notice If nonzero, only this program vkey is accepted (mirrors the gateway's routing).
    bytes32 public expectedVKey;

    function setAccept(bool a) external {
        accept = a;
    }

    function setExpectedVKey(bytes32 v) external {
        expectedVKey = v;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes)
        external
        view
    {
        require(accept, "MockSP1Gateway: rejected");
        if (expectedVKey != bytes32(0)) {
            require(programVKey == expectedVKey, "MockSP1Gateway: wrong vkey");
        }
        publicValues;
        proofBytes;
    }
}
