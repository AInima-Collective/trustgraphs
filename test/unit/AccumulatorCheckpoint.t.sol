// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {TestAccumulator} from "../mocks/TestAccumulator.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

contract AccumulatorCheckpointTest is Test {
    TestAccumulator acc;

    function setUp() public {
        acc = new TestAccumulator();
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
            abi.encode(uint8(0), address(uint160(1)), address(uint160(2)), bytes32(uint256(1)), block.timestamp, dataHash)
        );
        bytes32 expected = keccak256(abi.encode(bytes32(0), leaf));
        assertEq(acc.acc(), expected);
    }

    function test_FirstEmptyCheckpointAllowed() public {
        uint256 id = acc.checkpoint();
        assertEq(id, 0);
        IAttestationAccumulator.Checkpoint memory c = acc.getCheckpoint(0);
        assertEq(c.leafCount, 0);
        assertEq(c.acc, bytes32(0));
    }

    function test_CheckpointRequiresNewInputs() public {
        _fold(0, 1, 2, 1);
        acc.checkpoint(); // ok, id 0
        vm.expectRevert(IAttestationAccumulator.NoNewInputs.selector);
        acc.checkpoint(); // no new edges since last
    }

    function test_CheckpointAfterNewFold() public {
        _fold(0, 1, 2, 1);
        acc.checkpoint();
        _fold(0, 2, 3, 2);
        uint256 id = acc.checkpoint();
        assertEq(id, 1);
        assertEq(acc.checkpointCount(), 2);
        assertEq(acc.getCheckpoint(1).leafCount, 2);
    }

    function test_CheckpointRecordsBlockNumber() public {
        _fold(0, 1, 2, 1);
        vm.roll(4242);
        acc.checkpoint();
        assertEq(acc.getCheckpoint(0).blockNumber, 4242);
    }
}
