// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

/// @notice Test double for IZkVerifier. Accepts by default; can be flipped to reject, and can assert
///         the exact journal digest MerkleSnapshot computed (to lock the on-chain journal encoding).
contract MockZkVerifier is IZkVerifier {
    bool public accept = true;
    bytes32 public expectedDigest;
    bytes public lastProof;

    function setAccept(bool a) external {
        accept = a;
    }

    function setExpectedDigest(bytes32 d) external {
        expectedDigest = d;
    }

    function verify(bytes calldata proof, bytes32 journalDigest) external view {
        require(accept, "MockZkVerifier: rejected");
        if (expectedDigest != bytes32(0)) {
            require(journalDigest == expectedDigest, "MockZkVerifier: digest mismatch");
        }
        // touch calldata so the signature is exercised
        proof;
    }
}
