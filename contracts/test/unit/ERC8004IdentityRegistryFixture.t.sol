// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {ERC8004IdentityRegistryFixture} from "../fixtures/ERC8004IdentityRegistryFixture.sol";

contract ERC8004IdentityRegistryFixtureTest is Test {
    ERC8004IdentityRegistryFixture private registry;
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");
    address private wallet = makeAddr("wallet");

    function setUp() public {
        registry = new ERC8004IdentityRegistryFixture();
    }

    function test_twoAgentLifecycleAndTransferEventOrder() public {
        vm.startPrank(alice);
        uint256 first = registry.register("data:application/json;base64,e30=");
        uint256 second = registry.register("ipfs://fixture-agent-two");
        assertEq(first, 0);
        assertEq(second, 1);
        assertEq(registry.getAgentWallet(first), alice);

        registry.setAgentWallet(first, wallet);
        assertEq(registry.getAgentWallet(first), wallet);
        registry.unsetAgentWallet(second);
        assertEq(registry.getAgentWallet(second), address(0));

        vm.recordLogs();
        registry.transferFrom(alice, bob, first);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.stopPrank();

        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], keccak256("MetadataSet(uint256,string,string,bytes)"));
        assertEq(logs[1].topics[0], keccak256("Transfer(address,address,uint256)"));
        assertEq(registry.ownerOf(first), bob);
        assertEq(registry.getAgentWallet(first), address(0));
    }
}
