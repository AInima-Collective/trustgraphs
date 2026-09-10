// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {HandoffAccessControl} from "script/HandoffAccessControl.s.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {SubnetworkRegistry} from "src/registry/SubnetworkRegistry.sol";

/// Drives the chain context directly so the test does not depend on process-wide env, and signs
/// with a prank because a broadcast inside `forge test` does not change `msg.sender`.
contract HandoffHarness is HandoffAccessControl {
    function setDeployer(uint256 privateKey) external {
        _privateKey = privateKey;
    }

    function _expectedChainId() internal view override returns (uint256) {
        return block.chainid;
    }

    function _beginSigning() internal override {
        vm.startPrank(vm.addr(_privateKey));
    }

    function _endSigning() internal override {
        vm.stopPrank();
    }
}

contract HandoffAccessControlScriptTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xD0;
    address internal deployer;
    address internal constant ADMIN = address(0xA11CE);
    HandoffHarness internal script;
    SubnetworkRegistry internal registry;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_KEY);
        script = new HandoffHarness();
        script.setDeployer(DEPLOYER_KEY);
        registry = new SubnetworkRegistry(IInstanceRegistry(address(1)), deployer);
    }

    function _run(string memory roles) internal {
        script.run(vm.toString(address(registry)), vm.toString(ADMIN), roles);
    }

    function test_MovesDefaultAdminAndNamedRolesToTheAdmin() public {
        // Read the constants first: an external getter inside the pranked call would consume the prank.
        bytes32 registrar = registry.REGISTRAR_ROLE();
        bytes32 admin = registry.DEFAULT_ADMIN_ROLE();
        vm.prank(deployer);
        registry.grantRole(registrar, deployer);

        _run("DEFAULT_ADMIN_ROLE,REGISTRAR_ROLE");

        assertTrue(registry.hasRole(admin, ADMIN));
        assertTrue(registry.hasRole(registrar, ADMIN));
        assertFalse(registry.hasRole(admin, deployer));
        assertFalse(registry.hasRole(registrar, deployer));
        // The admin can keep administering: the handoff did not strand the contract.
        vm.prank(ADMIN);
        registry.grantRole(registrar, address(0xBEEF));
        assertTrue(registry.hasRole(registrar, address(0xBEEF)));
    }

    function test_RefusesWhenTheDeployerLacksANamedRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                HandoffAccessControl.DeployerLacksRole.selector, keccak256("REGISTRAR_ROLE"), deployer
            )
        );
        _run("DEFAULT_ADMIN_ROLE,REGISTRAR_ROLE");
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), deployer));
    }

    function test_RefusesWhenTheDeployerCannotGrant() public {
        SubnetworkRegistry foreign = new SubnetworkRegistry(IInstanceRegistry(address(1)), ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(HandoffAccessControl.DeployerCannotGrant.selector, address(foreign), deployer)
        );
        script.run(vm.toString(address(foreign)), vm.toString(address(0xB0B)), "DEFAULT_ADMIN_ROLE");
    }

    function test_RefusesTheDeployerAsItsOwnSuccessor() public {
        vm.expectRevert(abi.encodeWithSelector(HandoffAccessControl.AdminIsDeployer.selector, deployer));
        script.run(vm.toString(address(registry)), vm.toString(deployer), "DEFAULT_ADMIN_ROLE");
    }

    function test_RefusesAZeroAdmin() public {
        vm.expectRevert(HandoffAccessControl.ZeroAdmin.selector);
        script.run(vm.toString(address(registry)), vm.toString(address(0)), "DEFAULT_ADMIN_ROLE");
    }
}
