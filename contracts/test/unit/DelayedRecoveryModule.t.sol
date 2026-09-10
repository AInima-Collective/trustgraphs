// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Enum} from "@safe-global/safe-smart-account/libraries/Enum.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";

contract RecoveryTestSafe {
    uint256 public executions;

    function execTransactionFromModule(address, uint256, bytes calldata, Enum.Operation) external returns (bool) {
        ++executions;
        return true;
    }
}

contract DelayedRecoveryModuleTest is Test {
    RecoveryTestSafe internal safe;
    DelayedRecoveryModule internal recovery;
    address internal proposer = address(0xA11CE);
    address internal target = address(0xCA11);

    function setUp() public {
        safe = new RecoveryTestSafe();
        recovery = new DelayedRecoveryModule(address(safe), proposer, 14 days);
    }

    function _schedule() internal returns (bytes32) {
        vm.prank(proposer);
        return recovery.schedule(target, 0, hex"abcd", Enum.Operation.Call);
    }

    function test_RotationInvalidatesAllPreviousActionsPermanently() public {
        _schedule();
        _schedule();
        vm.prank(address(safe));
        recovery.setProposer(address(0xB0B));
        vm.prank(address(safe));
        recovery.setProposer(proposer);
        vm.warp(block.timestamp + 14 days);
        for (uint256 nonce; nonce < 2; ++nonce) {
            bytes32 id = recovery.hashAction(nonce, target, 0, hex"abcd", Enum.Operation.Call);
            vm.expectRevert(abi.encodeWithSelector(DelayedRecoveryModule.UnknownAction.selector, id));
            recovery.execute(nonce, target, 0, hex"abcd", Enum.Operation.Call);
        }
        bytes32 currentId = _schedule();
        vm.warp(recovery.readyAt(currentId));
        recovery.execute(2, target, 0, hex"abcd", Enum.Operation.Call);
        assertEq(safe.executions(), 1);
    }

    function test_ActionExpiresAndCanStillBeCancelled() public {
        bytes32 id = _schedule();
        uint256 expiry = recovery.readyAt(id) + recovery.EXECUTION_WINDOW();
        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(DelayedRecoveryModule.RecoveryExpired.selector, id, expiry));
        recovery.execute(0, target, 0, hex"abcd", Enum.Operation.Call);
        vm.prank(address(safe));
        recovery.cancel(id);
        assertEq(recovery.readyAt(id), 0);
        assertEq(safe.executions(), 0);
    }

    function test_ActionMayExecuteAtLastSecondOfWindowOnlyOnce() public {
        bytes32 id = _schedule();
        vm.warp(recovery.readyAt(id) + recovery.EXECUTION_WINDOW());
        recovery.execute(0, target, 0, hex"abcd", Enum.Operation.Call);
        vm.expectRevert(abi.encodeWithSelector(DelayedRecoveryModule.UnknownAction.selector, id));
        recovery.execute(0, target, 0, hex"abcd", Enum.Operation.Call);
        assertEq(safe.executions(), 1);
    }
}
