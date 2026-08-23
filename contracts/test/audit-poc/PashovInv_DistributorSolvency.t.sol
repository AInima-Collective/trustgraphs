// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

contract PashovInvToken is ERC20 {
    constructor() ERC20("Pashov", "PSH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PashovInvSnapshot {
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

/// @notice Handler for the stateful conservation run.
contract PashovInvDistHandler is Test {
    MerkleFundDistributor public dist;
    PashovInvToken public token;
    PashovInvSnapshot public snap;

    uint256 public totalFundedIn;
    uint256 public totalPaidOut;

    address[3] public funders = [address(0xF1), address(0xF2), address(0xF3)];

    constructor(MerkleFundDistributor d, PashovInvToken t, PashovInvSnapshot s) {
        dist = d;
        token = t;
        snap = s;
    }

    function fund(uint8 who, uint96 rawAmount, uint32 rawDeadline) external {
        address funder = funders[who % 3];
        uint256 amount = bound(uint256(rawAmount), 1, 1_000 ether);
        uint64 deadline = rawDeadline == 0 ? 0 : uint64(block.timestamp + bound(uint256(rawDeadline), 1, 30 days));
        token.mint(funder, amount);
        vm.startPrank(funder);
        token.approve(address(dist), amount);
        try dist.distribute(address(token), amount, bytes32(0), deadline) {
            totalFundedIn += amount;
        } catch {
            token.transfer(address(0xdead), amount);
        }
        vm.stopPrank();
    }

    function warp(uint32 rawSeconds) external {
        vm.warp(block.timestamp + bound(uint256(rawSeconds), 1, 5 days));
    }

    function sweep(uint8 rawIndex) external {
        uint256 count = dist.getDistributionCount();
        if (count == 0) return;
        uint256 index = rawIndex % count;
        uint256 before = token.balanceOf(address(this));
        try dist.sweep(index) {} catch {}
        // sweeps pay the funder, not the handler; balance delta stays zero here
        assertEq(token.balanceOf(address(this)), before);
    }
}

contract PashovInv_DistributorSolvency is Test {
    MerkleFundDistributor dist;
    PashovInvToken token;
    PashovInvSnapshot snap;
    PashovInvDistHandler handler;

    address owner = address(0x0142);
    address feeRecipient = address(0xFEE);
    address funderA = address(0xA1);
    address attacker = address(0xBAD);

    function setUp() public {
        snap = new PashovInvSnapshot();
        token = new PashovInvToken();
        snap.set(keccak256("good-root"), 1_000);
        dist = new MerkleFundDistributor(owner, address(snap), feeRecipient, 0, false);

        handler = new PashovInvDistHandler(dist, token, snap);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](3);
        sels[0] = handler.fund.selector;
        sels[1] = handler.warp.selector;
        sels[2] = handler.sweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 24
    function invariant_DistributorHoldsWhatEveryOpenDistributionStillOwes() public view {
        uint256 outstanding;
        uint256 count = dist.getDistributionCount();
        for (uint256 i; i < count; ++i) {
            IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(i);
            if (d.token != address(token)) continue;
            outstanding += d.amountFunded - d.feeAmount - d.amountDistributed - d.sweptAmount;
        }
        assertGe(token.balanceOf(address(dist)), outstanding, "distributor is insolvent");
    }

    /*//////////////////////////////////////////////////////////////
      H-3 REGRESSION — the per-distribution spend cap contains even a
      malicious tree whose leaf values exceed its recorded
      `totalMerkleValue` to that round's own budget.
    //////////////////////////////////////////////////////////////*/
    function test_H3_OneDistributionCannotDrainAnotherFundersRound() public {
        // Round 0: an honest third party funds 1000 tokens against the live proven root.
        token.mint(funderA, 1_000 ether);
        vm.startPrank(funderA);
        token.approve(address(dist), 1_000 ether);
        uint256 honest = dist.distribute(address(token), 1_000 ether, bytes32(0));
        vm.stopPrank();
        assertEq(token.balanceOf(address(dist)), 1_000 ether);

        // The distributor owner re-points the snapshot. `setMerkleSnapshot` has no restriction:
        // not "no live distributions", not "same instance", nothing.
        PashovInvSnapshot evil = new PashovInvSnapshot();
        // one leaf: (attacker, 1e21), and a recorded totalValue of 1.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(attacker, uint256(1_000 ether)))));
        evil.set(leaf, 1); // single-leaf tree => root == leaf
        vm.prank(owner);
        dist.setMerkleSnapshot(address(evil));

        // Round 1: the attacker funds ONE wei.
        token.mint(attacker, 1);
        vm.startPrank(attacker);
        token.approve(address(dist), 1);
        uint256 evilRound = dist.distribute(address(token), 1, bytes32(0));
        vm.stopPrank();

        // Claim: mulDiv(1 - 0, 1e21, 1) proposes 1e21, but the round cap is one wei.
        bytes32[] memory emptyProof = new bytes32[](0);
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, 1_000 ether, uint256(1))
        );
        dist.claim(evilRound, attacker, 1_000 ether, emptyProof);

        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(address(dist)), 1_000 ether + 1, "honest round remains backed");

        // Round 0's books and the shared balance remain consistent.
        IMerkleFundDistributor.DistributionState memory d0 = dist.getDistribution(honest);
        assertEq(d0.amountFunded - d0.feeAmount - d0.amountDistributed, 1_000 ether);
        assertGe(token.balanceOf(address(dist)), d0.amountFunded - d0.feeAmount - d0.amountDistributed);
    }

    /*//////////////////////////////////////////////////////////////
      INVARIANT BROKEN #2 — pausing across a claim deadline silently
      converts every unclaimed entitlement into a refund to the
      funder. `claim` is `whenNotPaused` and closes forever at the
      deadline; there is no way to extend it.
    //////////////////////////////////////////////////////////////*/
    function test_PauseAcrossTheDeadlineTurnsClaimantsIntoASweep() public {
        // A tree with one claimant worth the whole round.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(attacker, uint256(1_000)))));
        snap.set(leaf, 1_000);

        token.mint(funderA, 100 ether);
        vm.startPrank(funderA);
        token.approve(address(dist), 100 ether);
        uint256 round = dist.distribute(address(token), 100 ether, bytes32(0), uint64(block.timestamp + 1 days));
        vm.stopPrank();

        // Incident response: pause.
        vm.prank(owner);
        dist.pause();

        // The deadline passes while paused.
        vm.warp(block.timestamp + 2 days);

        vm.prank(owner);
        dist.unpause();

        bytes32[] memory emptyProof = new bytes32[](0);
        vm.expectRevert(IMerkleFundDistributor.ClaimWindowClosed.selector);
        dist.claim(round, attacker, 1_000, emptyProof);

        // ...and the whole round goes back to the funder instead.
        uint256 swept = dist.sweep(round);
        assertEq(swept, 100 ether);
        assertEq(token.balanceOf(funderA), 100 ether);
        assertEq(token.balanceOf(attacker), 0, "entitled claimant got nothing");
    }
}
