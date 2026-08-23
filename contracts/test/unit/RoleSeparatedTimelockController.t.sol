// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {RoleSeparatedTimelockController} from "src/governance/RoleSeparatedTimelockController.sol";

contract RoleSeparatedTimelockControllerTest is Test {
    address internal proposer = address(0xA11CE);
    address internal canceller = address(0xCA11CE1);
    address internal executor = address(0xE0EC);

    function _deploy() internal returns (RoleSeparatedTimelockController controller) {
        address[] memory executors = new address[](1);
        executors[0] = executor;
        controller = new RoleSeparatedTimelockController(2 days, proposer, canceller, executors);
    }

    function test_AssignsIndependentRolesAndSelfAdministration() public {
        RoleSeparatedTimelockController controller = _deploy();

        assertTrue(controller.hasRole(controller.PROPOSER_ROLE(), proposer));
        assertFalse(controller.hasRole(controller.CANCELLER_ROLE(), proposer));
        assertTrue(controller.hasRole(controller.CANCELLER_ROLE(), canceller));
        assertFalse(controller.hasRole(controller.PROPOSER_ROLE(), canceller));
        assertTrue(controller.hasRole(controller.EXECUTOR_ROLE(), executor));
        assertTrue(controller.hasRole(controller.DEFAULT_ADMIN_ROLE(), address(controller)));
        assertFalse(controller.hasRole(controller.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    function test_ProposerCannotVetoItsOwnRemoval() public {
        RoleSeparatedTimelockController controller = _deploy();
        bytes memory removal = abi.encodeCall(controller.revokeRole, (controller.PROPOSER_ROLE(), proposer));
        bytes32 salt = keccak256("remove hostile proposer");

        vm.prank(proposer);
        controller.schedule(address(controller), 0, removal, bytes32(0), salt, 2 days);
        bytes32 operationId = controller.hashOperation(address(controller), 0, removal, bytes32(0), salt);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, proposer, controller.CANCELLER_ROLE()
            )
        );
        vm.prank(proposer);
        controller.cancel(operationId);

        vm.prank(canceller);
        controller.cancel(operationId);
        assertFalse(controller.isOperation(operationId));
    }

    function test_RejectsAProposerWhoIsAlsoCanceller() public {
        address[] memory executors = new address[](1);
        executors[0] = executor;
        vm.expectRevert(abi.encodeWithSelector(RoleSeparatedTimelockController.ProposerIsCanceller.selector, proposer));
        new RoleSeparatedTimelockController(2 days, proposer, proposer, executors);
    }
}
