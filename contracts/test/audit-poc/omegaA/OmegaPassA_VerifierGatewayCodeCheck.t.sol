// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";

/// @notice PASS A PoC / empirical check.
///
/// `SP1JournalVerifier`'s constructor validates NEITHER argument:
///
///     constructor(ISP1Verifier _gateway, bytes32 _programVKey) {
///         gateway = _gateway;
///         programVKey = _programVKey;
///     }
///
/// `verify()` then delegates to `gateway.verifyProof(...)`, which returns nothing. This test
/// records what the EVM actually does when `gateway` has no code, so the severity of the missing
/// constructor check is measured rather than argued.
contract OmegaPassA_VerifierGatewayCodeCheck is Test {
    function test_PassA_ZeroGatewayBehaviour() public {
        SP1JournalVerifier v = new SP1JournalVerifier(ISP1Verifier(address(0)), bytes32(0));
        bytes memory publicValues = hex"deadbeef";
        bytes memory proof = abi.encode(publicValues, bytes(hex""));

        bool accepted = true;
        try v.verify(proof, keccak256(publicValues)) {}
        catch {
            accepted = false;
        }
        emit log_named_string("gateway=address(0): forged proof accepted?", accepted ? "YES" : "no");
        assertEq(v.programVKey(), bytes32(0), "zero vkey accepted by the constructor");
    }

    function test_PassA_EoaGatewayBehaviour() public {
        address eoa = makeAddr("not-a-contract");
        assertEq(eoa.code.length, 0);
        SP1JournalVerifier v = new SP1JournalVerifier(ISP1Verifier(eoa), keccak256("vkey"));
        bytes memory publicValues = hex"c0ffee";
        bytes memory proof = abi.encode(publicValues, bytes(hex""));

        bool accepted = true;
        try v.verify(proof, keccak256(publicValues)) {}
        catch {
            accepted = false;
        }
        emit log_named_string("gateway=EOA: forged proof accepted?", accepted ? "YES" : "no");
    }
}
