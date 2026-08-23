// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

contract PauseTrapSnapshot {
    IMerkleSnapshot.MerkleState internal _state;

    function set(bytes32 root, uint256 totalValue) external {
        _state = IMerkleSnapshot.MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: bytes32(uint256(1)),
            ipfsHashCid: "cid",
            totalValue: totalValue
        });
    }

    function getLatestState() external view returns (IMerkleSnapshot.MerkleState memory) {
        return _state;
    }
}

/// @notice PASS A PoC.
///
/// `pause()` remains an incident-response gate for new rounds and claims, but it must not gate an
/// expired round's permissionless funder exit.
contract OmegaPassA_DistributorPauseTrap is Test {
    MerkleFundDistributor internal dist;
    PauseTrapSnapshot internal snap;
    TestUSDC internal token;

    address internal funder = address(0xF00D);
    address internal member = address(0x1CE);
    bytes32 internal root;

    function setUp() public {
        token = new TestUSDC();
        snap = new PauseTrapSnapshot();
        root = keccak256(bytes.concat(keccak256(abi.encode(member, uint256(100)))));
        snap.set(root, 100);
        dist = new MerkleFundDistributor(address(this), address(snap), address(this), 0, false);
        token.mint(funder, 1_000);
        vm.prank(funder);
        token.approve(address(dist), type(uint256).max);
        vm.warp(1_000_000);
    }

    function test_M8_PauseDoesNotFreezeExpiredSweep() public {
        vm.prank(funder);
        uint256 index = dist.distribute(address(token), 1_000, root, uint64(block.timestamp + 1 days));
        assertEq(token.balanceOf(address(dist)), 1_000);

        dist.pause();

        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(); // EnforcedPause
        dist.claim(index, member, 100, noProof);

        // Wait past the claim deadline: the sweep path is the funder's documented exit.
        vm.warp(block.timestamp + 2 days);
        vm.prank(funder);
        uint256 swept = dist.sweep(index);

        assertEq(swept, 1_000);
        assertEq(token.balanceOf(address(dist)), 0, "expired funds exited while paused");
        assertEq(token.balanceOf(funder), 1_000, "sweep still pays the recorded funder");
    }
}
