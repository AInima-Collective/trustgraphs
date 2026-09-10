// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {TrustAccumulatorMirror} from "src/merkle/TrustAccumulatorMirror.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {TestAccumulator} from "../mocks/TestAccumulator.sol";
import {MockSnapshotView} from "../mocks/MockSnapshotView.sol";

/// @title TrustAccumulatorMirrorTest
/// @notice The contributions slot-A seam: the mirror freezes the TRUST accumulator's live
///         `(acc, leafCount)` into its OWN checkpoint array — never pushing into the trust
///         accumulator and never rejecting a quiet lane. Freshness is checked across both lanes
///         by `MerkleSnapshot.trigger()`, not independently by either accumulator.
contract TrustAccumulatorMirrorTest is Test {
    TestAccumulator trust;
    TrustAccumulatorMirror mirror;
    MockSnapshotView trustSnapshot;

    function setUp() public {
        trust = new TestAccumulator();
        // The trust accumulator has its own bound snapshot (its own instance's), which is exactly
        // why the contributions instance reads it through a mirror instead of pushing into it.
        trustSnapshot = new MockSnapshotView(address(trust));
        trust.bindSnapshot(address(trustSnapshot));
        mirror = new TrustAccumulatorMirror(trust);
        // This test doubles as the bound snapshot (in production: the contributions
        // MerkleSnapshot, whose trigger() is then the only checkpoint mint —
        // research/audits/2026-07-M6.md finding M6-1).
        mirror.bindSnapshot(address(this));
    }

    function _foldOne(uint256 salt) internal {
        trust.fold(0, address(uint160(0x1000 + salt)), address(0xBEEF), bytes32(salt), keccak256(abi.encode(salt)));
    }

    function test_ConstructorZeroAddressReverts() public {
        vm.expectRevert(TrustAccumulatorMirror.ZeroAddress.selector);
        new TrustAccumulatorMirror(IAttestationAccumulator(address(0)));
    }

    function test_LivePassThroughViews() public {
        assertEq(mirror.acc(), bytes32(0));
        assertEq(mirror.leafCount(), 0);

        _foldOne(1);
        _foldOne(2);

        assertEq(mirror.acc(), trust.acc(), "acc must pass through live");
        assertEq(mirror.leafCount(), trust.leafCount(), "leafCount must pass through live");
        assertEq(mirror.leafCount(), 2);
    }

    function test_CheckpointFreezesLiveTrustState() public {
        _foldOne(1);
        vm.roll(77);

        vm.expectEmit(true, false, false, true);
        emit IAttestationAccumulator.InputsCheckpointed(0, trust.acc(), 1, 77);
        uint256 id = mirror.checkpoint();

        assertEq(id, 0);
        assertEq(mirror.checkpointCount(), 1);
        IAttestationAccumulator.Checkpoint memory c = mirror.getCheckpoint(0);
        assertEq(c.acc, trust.acc());
        assertEq(c.leafCount, 1);
        assertEq(c.blockNumber, 77);
    }

    /// The whole point of the mirror: a quiet vouch graph must not wedge round triggers.
    function test_QuietLaneCheckpointDoesNotWedge() public {
        _foldOne(1);
        uint256 first = mirror.checkpoint();

        // No new trust inputs at all — the mirror still checkpoints.
        vm.roll(block.number + 10);
        uint256 second = mirror.checkpoint();

        assertEq(first, 0);
        assertEq(second, 1);
        IAttestationAccumulator.Checkpoint memory a = mirror.getCheckpoint(0);
        IAttestationAccumulator.Checkpoint memory b = mirror.getCheckpoint(1);
        assertEq(a.acc, b.acc, "unchanged lane freezes the same acc");
        assertEq(a.leafCount, b.leafCount);

        // The wrapped accumulator now follows the same rule. A strict lane-2 append may justify a
        // new snapshot while lane 1 is byte-identical, so only the snapshot can decide whether the
        // combined input moved.
        vm.prank(address(trustSnapshot));
        uint256 trustFirst = trust.checkpoint();
        vm.prank(address(trustSnapshot));
        uint256 trustSecond = trust.checkpoint();
        assertEq(trustFirst, 0);
        assertEq(trustSecond, 1);
    }

    /// Mirror checkpoints are local: the trust accumulator's own checkpoint history is untouched.
    function test_CheckpointNeverTouchesTrustAccumulator() public {
        _foldOne(1);
        mirror.checkpoint();
        mirror.checkpoint();

        assertEq(mirror.checkpointCount(), 2);
        assertEq(trust.checkpointCount(), 0, "the trust accumulator must never gain checkpoints");
        assertEq(trust.leafCount(), 1, "mirroring must not fold");
    }

    /// research/audits/2026-07-M6.md M6-1 regression: only the bound snapshot may mint checkpoints — a directly-minted id
    /// would leave the snapshot's lane-2 freeze at (0,0) and admit a contributions-blind proof.
    function test_CheckpointOnlyFromBoundSnapshot() public {
        _foldOne(1);
        vm.prank(address(0xA77ac)); // anyone else
        vm.expectRevert(TrustAccumulatorMirror.NotSnapshot.selector);
        mirror.checkpoint();

        // Pre-bind, nobody can checkpoint (not even the binder).
        TrustAccumulatorMirror unbound = new TrustAccumulatorMirror(trust);
        vm.expectRevert(TrustAccumulatorMirror.NotSnapshot.selector);
        unbound.checkpoint();
    }

    function test_BindSnapshotIsOneShotAndBinderOnly() public {
        TrustAccumulatorMirror fresh = new TrustAccumulatorMirror(trust);
        vm.prank(address(0xBAD));
        vm.expectRevert(TrustAccumulatorMirror.NotBinder.selector);
        fresh.bindSnapshot(address(0xBAD));

        vm.expectRevert(TrustAccumulatorMirror.ZeroAddress.selector);
        fresh.bindSnapshot(address(0));

        fresh.bindSnapshot(address(this));
        assertEq(fresh.snapshot(), address(this));
        vm.expectRevert(TrustAccumulatorMirror.AlreadyBound.selector);
        fresh.bindSnapshot(address(0x1234));
    }

    function test_CheckpointCapturesSubsequentGrowth() public {
        _foldOne(1);
        mirror.checkpoint();
        bytes32 accAtFirst = mirror.getCheckpoint(0).acc;

        _foldOne(2);
        _foldOne(3);
        mirror.checkpoint();

        IAttestationAccumulator.Checkpoint memory b = mirror.getCheckpoint(1);
        assertEq(b.leafCount, 3);
        assertEq(b.acc, trust.acc());
        assertTrue(b.acc != accAtFirst, "growth must move the frozen acc");
    }
}
