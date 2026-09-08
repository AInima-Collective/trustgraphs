// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";

/// @dev Mandatory in Release's real-proof job, opt-in for ordinary offline unit tests.
///      Uses the actual gateway on a read-only Sepolia fork. Never sends a chain transaction.
contract ReleaseGroth16Test is Test {
    function test_ReleaseProofVerifiesThroughRealGatewayAndRejectsMutations() public {
        if (!vm.envOr("RELEASE_REAL_PROOF", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envString("RELEASE_PROOF_RPC_URL"), vm.envUint("RELEASE_PROOF_BLOCK"));
        address gateway = vm.envAddress("RELEASE_PROOF_GATEWAY");
        assertGt(gateway.code.length, 0, "gateway must have code");
        bytes32 vkey = vm.envBytes32("RELEASE_PROOF_VKEY");
        bytes memory blob = vm.readFileBinary(vm.envString("RELEASE_PROOF_FILE"));
        (bytes memory journal, bytes memory seal) = abi.decode(blob, (bytes, bytes));
        assertGt(seal.length, 4, "real Groth16 seal required");
        SP1JournalVerifier verifier = new SP1JournalVerifier(ISP1Verifier(gateway), vkey);
        verifier.verify(blob, keccak256(journal));

        vm.expectRevert(SP1JournalVerifier.JournalMismatch.selector);
        verifier.verify(blob, bytes32(uint256(keccak256(journal)) ^ 1));
        SP1JournalVerifier wrongProgram = new SP1JournalVerifier(ISP1Verifier(gateway), bytes32(uint256(vkey) ^ 1));
        vm.expectRevert();
        wrongProgram.verify(blob, keccak256(journal));
        seal[seal.length - 1] ^= bytes1(uint8(1));
        vm.expectRevert();
        verifier.verify(abi.encode(journal, seal), keccak256(journal));
    }
}
