// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {RoundPins} from "test/helpers/RoundPins.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A snapshot stand-in whose `getLatestState` the owner controls.
contract PassAFakeSnapshot {
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
/// `MerkleFundDistributor.claim` computes
///   `claimedAmount = mulDiv(amountFunded - feeAmount, value, totalMerkleValue)`
/// and caps the cumulative spend at `amountFunded - feeAmount`. All distributions of a token share
/// one contract balance, so this regression proves a malicious round cannot pay itself out of
/// OTHER funders' rounds even when its leaf values exceed `totalMerkleValue`.
///
/// The owner reaches that state with one instant, un-timelocked call: `setMerkleSnapshot`.
/// (Fee INCREASES are delayed by `FEE_INCREASE_DELAY`; the snapshot pointer, which is strictly
/// more powerful, is not.)
contract OmegaPassA_DistributorSolvency is Test {
    MerkleFundDistributor internal dist;
    PassAFakeSnapshot internal honest;
    PassAFakeSnapshot internal evil;
    TestUSDC internal token;

    address internal owner = address(this);
    address internal funder = address(0xF00D);
    address internal victim = address(0x1CE);
    address internal attacker = address(0xBAD);

    bytes32 internal honestRoot;
    bytes32 internal evilRoot;

    function setUp() public {
        token = new TestUSDC();
        honest = new PassAFakeSnapshot();
        evil = new PassAFakeSnapshot();

        // Honest round: a two-leaf tree, victim holds all 1_000_000 of the value.
        honestRoot = _leaf(victim, 1_000_000);
        honest.set(honestRoot, 1_000_000);

        // Attacker round: a single-leaf tree claiming 1_000_000 units against totalValue 1.
        evilRoot = _leaf(attacker, 1_000_000);
        evil.set(evilRoot, 1);

        dist = new MerkleFundDistributor(owner, address(honest), owner, 0, false);

        token.mint(funder, 1_000_000);
        vm.prank(funder);
        token.approve(address(dist), type(uint256).max);
        token.mint(attacker, 1);
        vm.prank(attacker);
        token.approve(address(dist), type(uint256).max);
    }

    function _leaf(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function test_H3_OwnerRepointCannotDrainAnotherFundersRound() public {
        // 1. An unrelated funder funds a real round against the proven root.
        RoundPins.Pins memory _pins0 = RoundPins.read(dist, 1_000_000);
        vm.prank(funder);
        uint256 honestIndex = dist.distribute(
            address(token), 1_000_000, honestRoot, _pins0.totalValue, 0, type(uint256).max, _pins0.feeRecipient
        );
        assertEq(token.balanceOf(address(dist)), 1_000_000);

        // 2. The owner re-points the snapshot. No delay, no notice, no event consumers can act on.
        dist.setMerkleSnapshot(address(evil));

        // 3. Anyone (allowlist is off by default in every factory-minted fund) opens a 1-unit
        //    round against the crafted (root, totalValue=1) pair.
        RoundPins.Pins memory _pins1 = RoundPins.read(dist, 1);
        vm.prank(attacker);
        uint256 evilIndex =
            dist.distribute(address(token), 1, evilRoot, _pins1.totalValue, 0, type(uint256).max, _pins1.feeRecipient);

        // 4. One leaf whose `value` exceeds `totalMerkleValue` is rejected at the round boundary.
        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, 1_000_000, 1));
        dist.claim(evilIndex, attacker, 1_000_000, noProof);
        assertEq(token.balanceOf(attacker), 0);

        // 5. The honest round remains fully solvent and claimable.
        assertEq(token.balanceOf(address(dist)), 1_000_001, "both round budgets remain held");
        assertEq(dist.claim(honestIndex, victim, 1_000_000, noProof), 1_000_000);
    }

    /// The bookkeeping cap also keeps the expired-round sweep path live after a rejected overclaim.
    function test_H3_RejectedOverclaimLeavesRoundSweepable() public {
        RoundPins.Pins memory _pins2 = RoundPins.read(dist, 1_000_000);
        vm.prank(funder);
        dist.distribute(
            address(token), 1_000_000, honestRoot, _pins2.totalValue, 0, type(uint256).max, _pins2.feeRecipient
        );
        dist.setMerkleSnapshot(address(evil));
        RoundPins.Pins memory _pins3 = RoundPins.read(dist, 1);
        vm.prank(attacker);
        uint256 evilIndex = dist.distribute(
            address(token),
            1,
            evilRoot,
            _pins3.totalValue,
            uint64(block.timestamp + 1 days),
            type(uint256).max,
            _pins3.feeRecipient
        );

        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(IMerkleFundDistributor.ClaimExceedsRoundBudget.selector, 1_000_000, 1));
        dist.claim(evilIndex, attacker, 1_000_000, noProof);

        MerkleFundDistributor.DistributionState memory d = dist.getDistribution(evilIndex);
        assertEq(d.amountFunded, 1);
        assertEq(d.amountDistributed, 0, "rejected claim changed round accounting");

        vm.warp(block.timestamp + 2 days);
        assertEq(dist.sweep(evilIndex), 1, "the round's own budget remains sweepable");
    }
}
