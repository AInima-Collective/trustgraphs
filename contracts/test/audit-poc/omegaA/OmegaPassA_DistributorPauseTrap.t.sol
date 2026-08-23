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
/// `pause()` is `onlyOwner` and gates `claim`, `distribute` AND `sweep`. There is no
/// owner-independent rescue path and no unpause deadline, so a paused distributor is a state in
/// which NO account — claimant, funder, or anyone else — can get an already-funded round's money
/// out. The funder cannot even reclaim after the claim deadline, which is the one exit the
/// expiry+sweep design was added to provide.
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

    function test_PassA_PauseFreezesClaimAndSweepWithNoRescue() public {
        vm.prank(funder);
        uint256 index = dist.distribute(address(token), 1_000, root, uint64(block.timestamp + 1 days));
        assertEq(token.balanceOf(address(dist)), 1_000);

        dist.pause();

        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(); // EnforcedPause
        dist.claim(index, member, 100, noProof);

        // Wait past the claim deadline: the sweep path is the funder's documented exit.
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(); // EnforcedPause — the funder cannot reclaim either
        vm.prank(funder);
        dist.sweep(index);

        // Nothing else moves value: no admin rescue, no per-token sweep.
        assertEq(token.balanceOf(address(dist)), 1_000, "funds are trapped behind one owner flag");
    }
}
