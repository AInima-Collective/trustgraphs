// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract OB_Snapshot is IMerkleSnapshot {
    MerkleState internal _s;

    function set(bytes32 root, uint256 totalValue) external {
        _s = MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: bytes32(uint256(1)),
            ipfsHashCid: "cid",
            totalValue: totalValue
        });
    }

    function getLatestState() external view returns (MerkleState memory) {
        return _s;
    }
}

contract OB_Token is ERC20 {
    constructor() ERC20("t", "t") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract OmegaPassB_Distributor is Test {
    OB_Snapshot internal honest;
    OB_Snapshot internal rogue;
    OB_Token internal token;
    MerkleFundDistributor internal dist;

    address internal owner = address(0xA0);
    address internal funderA = address(0xF1);
    address internal funderB = address(0xF2);
    address internal attacker = address(0xBAD);

    // one-leaf tree: leaf = keccak(bytes.concat(keccak(abi.encode(account,value)))) is the ROOT
    function _oneLeafRoot(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function setUp() public {
        honest = new OB_Snapshot();
        rogue = new OB_Snapshot();
        token = new OB_Token();
        dist = new MerkleFundDistributor(owner, address(honest), owner, 0, false);

        token.mint(funderA, 1_000_000e18);
        token.mint(funderB, 1_000_000e18);
        token.mint(attacker, 1e18);
    }

    /// H-3 regression: even an owner-manufactured inconsistent snapshot cannot let one round spend
    /// another round's funds because cumulative claims are capped at the round's own budget.
    function test_H3_OwnerCannotDrainOtherFundersViaSetMerkleSnapshot() public {
        // Two honest, independent funders each open a real distribution against a real
        // one-leaf tree (funderA is the sole claimant, value == totalValue).
        honest.set(_oneLeafRoot(funderA, 1_000e18), 1_000e18);
        vm.startPrank(funderA);
        token.approve(address(dist), type(uint256).max);
        dist.distribute(address(token), 500_000e18, bytes32(0));
        vm.stopPrank();

        vm.startPrank(funderB);
        token.approve(address(dist), type(uint256).max);
        dist.distribute(address(token), 400_000e18, bytes32(0));
        vm.stopPrank();

        uint256 held = token.balanceOf(address(dist));
        assertEq(held, 900_000e18, "both funders' money sits in one balance");

        // --- the attack -------------------------------------------------------------------
        // 1. owner points the distributor at a snapshot it controls: root = a one-leaf tree
        //    paying `attacker` a huge value, totalValue = 1.
        bytes32 rogueRoot = _oneLeafRoot(attacker, 900_000e18);
        rogue.set(rogueRoot, 1);
        vm.prank(owner);
        dist.setMerkleSnapshot(address(rogue));

        // 2. owner opens a 1 wei distribution against it (anyone may fund: allowlist disabled).
        vm.startPrank(attacker);
        token.approve(address(dist), type(uint256).max);
        uint256 idx = dist.distribute(address(token), 1, bytes32(0));
        vm.stopPrank();

        // 3. The formula proposes a huge claim, but the round cap rejects it before transfer.
        bytes32[] memory proof = new bytes32[](0);
        uint256 before = token.balanceOf(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, 900_000e18, uint256(1))
        );
        dist.claim(idx, attacker, 900_000e18, proof);
        uint256 gained = token.balanceOf(attacker) - before;

        console2.log("attacker funded (wei):", uint256(1));
        console2.log("attacker received   :", gained);
        assertEq(gained, 0, "over-budget claim transferred funds");
        assertEq(token.balanceOf(address(dist)), 900_000e18 + 1, "sibling rounds remain backed");

        // 4. both honest distributions remain claimable.
        assertEq(dist.claim(0, funderA, 1_000e18, proof), 500_000e18);
        assertEq(dist.claim(1, funderA, 1_000e18, proof), 400_000e18);
    }

    /// M-8 regression: pause gates claims, but an expired round remains sweepable without owner
    /// cooperation.
    function test_M8_PauseDoesNotTrapExpiredSweep() public {
        honest.set(_oneLeafRoot(funderA, 1_000e18), 1_000e18);
        vm.startPrank(funderA);
        token.approve(address(dist), type(uint256).max);
        uint256 idx = dist.distribute(address(token), 1_000e18, bytes32(0), uint64(block.timestamp + 1 days));
        vm.stopPrank();

        vm.prank(owner);
        dist.pause();

        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(); // EnforcedPause
        dist.claim(idx, funderA, 1_000e18, proof);

        vm.warp(block.timestamp + 2 days);
        uint256 swept = dist.sweep(idx);

        assertEq(swept, 1_000e18);
        assertEq(token.balanceOf(address(dist)), 0, "expired round remains trapped by pause");
        assertEq(token.balanceOf(funderA), 1_000_000e18, "sweep paid the recorded funder");
    }

    /// LEAD-supporting: `distribute` with amount 0 is accepted and pushes an unbounded row that
    /// nobody can ever claim or sweep, at attacker-chosen cost.
    function test_ZeroAmountDistributionsAreAccepted() public {
        honest.set(_oneLeafRoot(funderA, 1_000e18), 1_000e18);
        vm.startPrank(attacker);
        token.approve(address(dist), type(uint256).max);
        uint256 i0 = dist.distribute(address(token), 0, bytes32(0));
        vm.stopPrank();
        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(i0);
        assertEq(d.amountFunded, 0);
        assertEq(dist.getDistributionCount(), 1);
    }
}
