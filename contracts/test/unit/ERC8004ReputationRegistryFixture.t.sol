// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ERC8004IdentityRegistryFixture} from "../fixtures/ERC8004IdentityRegistryFixture.sol";
import {ERC8004ReputationRegistryFixture} from "../fixtures/ERC8004ReputationRegistryFixture.sol";

contract ERC8004ReputationRegistryFixtureTest is Test {
    ERC8004IdentityRegistryFixture private identity;
    ERC8004ReputationRegistryFixture private reputation;
    address private targetOwner = makeAddr("target-owner");
    address private reviewerOwner = makeAddr("reviewer-owner");
    address private walletBefore = makeAddr("reviewer-wallet-before");
    address private walletAfter = makeAddr("reviewer-wallet-after");
    address private responder = makeAddr("responder");
    uint256 private targetAgent;
    uint256 private reviewerAgent;

    function setUp() public {
        identity = new ERC8004IdentityRegistryFixture();
        reputation = new ERC8004ReputationRegistryFixture(address(identity));
        vm.prank(targetOwner);
        targetAgent = identity.register("ipfs://target");
        vm.startPrank(reviewerOwner);
        reviewerAgent = identity.register("ipfs://reviewer");
        identity.setAgentWallet(reviewerAgent, walletBefore);
        vm.stopPrank();
    }

    function test_twoPoliciesResponseRevocationAndWalletRotation() public {
        vm.prank(walletBefore);
        reputation.giveFeedback(
            targetAgent,
            87,
            0,
            "quality",
            "points/100",
            "https://agent.example/task",
            "ipfs://quality",
            bytes32(uint256(1))
        );

        vm.prank(reviewerOwner);
        identity.setAgentWallet(reviewerAgent, walletAfter);
        vm.prank(walletAfter);
        reputation.giveFeedback(
            targetAgent,
            560,
            0,
            "responseTime",
            "ms",
            "https://agent.example/task",
            "ipfs://latency",
            bytes32(uint256(2))
        );

        vm.prank(responder);
        reputation.appendResponse(targetAgent, walletBefore, 1, "ipfs://response", bytes32(uint256(3)));
        vm.prank(walletBefore);
        reputation.revokeFeedback(targetAgent, 1);

        (int128 valueA, uint8 decimalsA, string memory tagA, string memory unitA, bool revokedA) =
            reputation.readFeedback(targetAgent, walletBefore, 1);
        (int128 valueB, uint8 decimalsB, string memory tagB, string memory unitB, bool revokedB) =
            reputation.readFeedback(targetAgent, walletAfter, 1);
        assertEq(valueA, 87);
        assertEq(decimalsA, 0);
        assertEq(tagA, "quality");
        assertEq(unitA, "points/100");
        assertTrue(revokedA);
        assertEq(valueB, 560);
        assertEq(decimalsB, 0);
        assertEq(tagB, "responseTime");
        assertEq(unitB, "ms");
        assertFalse(revokedB);
        assertEq(reputation.responseCount(targetAgent, walletBefore, 1), 1);
        assertEq(identity.getAgentWallet(reviewerAgent), walletAfter);
    }
}
