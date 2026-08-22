// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {TestAccumulator} from "../mocks/TestAccumulator.sol";
import {MockSnapshotView} from "../mocks/MockSnapshotView.sol";
import {AttestationAccumulator} from "contracts/eas/AttestationAccumulator.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

contract AccumulatorCheckpointTest is Test {
    TestAccumulator acc;
    MockSnapshotView snapshot;

    function setUp() public {
        acc = new TestAccumulator();
        // Only the bound snapshot may mint (issue #10), so every checkpoint below is minted as it.
        snapshot = new MockSnapshotView(address(acc));
        acc.bindSnapshot(address(snapshot));
    }

    /// Mint as the bound snapshot, the way `MerkleSnapshot.trigger()` does.
    function _checkpoint() internal returns (uint256) {
        vm.prank(address(snapshot));
        return acc.checkpoint();
    }

    function _fold(uint8 kind, uint8 a, uint8 b, uint8 uid) internal {
        acc.fold(
            kind,
            address(uint160(a)),
            address(uint160(b)),
            bytes32(uint256(uid)),
            keccak256(abi.encodePacked("data", uid))
        );
    }

    function test_AccStartsZero() public view {
        assertEq(acc.acc(), bytes32(0));
        assertEq(acc.leafCount(), 0);
    }

    function test_FoldAdvancesAccAndCount() public {
        bytes32 before = acc.acc();
        _fold(0, 1, 2, 1);
        assertTrue(acc.acc() != before, "acc must change");
        assertEq(acc.leafCount(), 1);
        _fold(0, 2, 3, 2);
        assertEq(acc.leafCount(), 2);
    }

    function test_ChainedFoldMatchesManual() public {
        _fold(0, 1, 2, 1);
        // Reproduce the leaf + fold by hand.
        bytes32 dataHash = keccak256(abi.encodePacked("data", uint8(1)));
        bytes32 leaf = keccak256(
            abi.encode(
                uint8(0), address(uint160(1)), address(uint160(2)), bytes32(uint256(1)), block.timestamp, dataHash
            )
        );
        bytes32 expected = keccak256(abi.encode(bytes32(0), leaf));
        assertEq(acc.acc(), expected);
    }

    function test_FirstEmptyCheckpointAllowed() public {
        uint256 id = _checkpoint();
        assertEq(id, 0);
        IAttestationAccumulator.Checkpoint memory c = acc.getCheckpoint(0);
        assertEq(c.leafCount, 0);
        assertEq(c.acc, bytes32(0));
    }

    /// Freshness is a two-lane decision made by MerkleSnapshot.trigger(). The bound accumulator
    /// must record an unchanged lane when the other lane moved.
    function test_BoundSnapshotCanCheckpointAQuietLane() public {
        _fold(0, 1, 2, 1);
        uint256 first = _checkpoint();
        uint256 second = _checkpoint();
        assertEq(first, 0);
        assertEq(second, 1);
        assertEq(acc.getCheckpoint(second).acc, acc.getCheckpoint(first).acc);
        assertEq(acc.getCheckpoint(second).leafCount, acc.getCheckpoint(first).leafCount);
    }

    function test_CheckpointAfterNewFold() public {
        _fold(0, 1, 2, 1);
        _checkpoint();
        _fold(0, 2, 3, 2);
        uint256 id = _checkpoint();
        assertEq(id, 1);
        assertEq(acc.checkpointCount(), 2);
        assertEq(acc.getCheckpoint(1).leafCount, 2);
    }

    function test_CheckpointRecordsBlockNumber() public {
        _fold(0, 1, 2, 1);
        vm.roll(4242);
        _checkpoint();
        assertEq(acc.getCheckpoint(0).blockNumber, 4242);
    }

    /*///////////////////////////////////////////////////////////////
                BOUNDARY INTEGRITY (issue #10)
    //////////////////////////////////////////////////////////////*/

    /// A stranger cannot mint a checkpoint. Before the binding this was open to anyone, which made
    /// `MerkleSnapshot`'s epoch gate advisory and let a prover choose the boundary.
    function test_StrangerCannotMintACheckpoint() public {
        _fold(0, 1, 2, 1);
        vm.prank(address(0xBAD));
        vm.expectRevert(AttestationAccumulator.NotSnapshot.selector);
        acc.checkpoint();
        assertEq(acc.checkpointCount(), 0, "no checkpoint was minted");
    }

    /// Not even the deployer/binder may mint — the binding names one address, and it is the
    /// snapshot, not whoever wired it up.
    function test_BinderCannotMintEither() public {
        _fold(0, 1, 2, 1);
        vm.expectRevert(AttestationAccumulator.NotSnapshot.selector);
        acc.checkpoint();
    }

    /// An unbound accumulator mints nothing at all, so there is no window between deployment and
    /// binding in which a prover-chosen boundary could be slipped in.
    function test_UnboundAccumulatorMintsNothing() public {
        TestAccumulator fresh = new TestAccumulator();
        vm.expectRevert(AttestationAccumulator.NotSnapshot.selector);
        fresh.checkpoint();
    }

    function test_BindSnapshotIsOneShotAndBinderOnly() public {
        TestAccumulator fresh = new TestAccumulator();
        MockSnapshotView s1 = new MockSnapshotView(address(fresh));

        vm.prank(address(0xBAD));
        vm.expectRevert(AttestationAccumulator.NotBinder.selector);
        fresh.bindSnapshot(address(s1));

        vm.expectRevert(AttestationAccumulator.ZeroSnapshot.selector);
        fresh.bindSnapshot(address(0));

        fresh.bindSnapshot(address(s1));
        assertEq(fresh.snapshot(), address(s1));

        vm.expectRevert(AttestationAccumulator.AlreadyBound.selector);
        fresh.bindSnapshot(address(s1));
    }

    /// The read-back turns the one irreversible mistake available here — binding the wrong
    /// address — into a revert.
    function test_BindRejectsASnapshotThatReadsAnotherAccumulator() public {
        TestAccumulator fresh = new TestAccumulator();
        TestAccumulator other = new TestAccumulator();
        MockSnapshotView foreign = new MockSnapshotView(address(other));

        vm.expectRevert(
            abi.encodeWithSelector(AttestationAccumulator.SnapshotReadsAnotherAccumulator.selector, address(other))
        );
        fresh.bindSnapshot(address(foreign));
    }
}
