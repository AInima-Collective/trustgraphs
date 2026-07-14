// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockAnchorRegistry} from "../mocks/MockAnchorRegistry.sol";
import {MockHook} from "../mocks/MockHook.sol";

contract MerkleSnapshotTest is Test {
    MerkleSnapshot ms;
    MockZkVerifier verifier;
    MockAccumulator accer;

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    bytes32 paramsHash = keccak256("params-v1");

    // sample proof outputs
    bytes32 constant ROOT = bytes32(uint256(0xC0FFEE));
    bytes32 constant IPFS = bytes32(uint256(0x1F5));
    string constant CID = "bafkreiexamplecidstring";
    uint256 constant TOTAL = 1_000_000 ether;

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        ms = new MerkleSnapshot(verifier, paramsHash, accer, constitutional, operational);
    }

    function _expectDigest(bytes32 acc, uint64 leafCount) internal {
        // Journal v2: lane-2 fields are the zero accumulator on this lane-1-only instance.
        bytes32 digest = keccak256(
            abi.encode(
                acc, leafCount, bytes32(0), uint64(0), paramsHash, ROOT, IPFS, keccak256(bytes(CID)), TOTAL, bytes32(0)
            )
        );
        verifier.setExpectedDigest(digest);
    }

    function _submit(uint256 checkpointId) internal {
        ms.submitProof(checkpointId, ROOT, IPFS, CID, TOTAL, bytes32(0), hex"");
    }

    function test_TriggerCreatesCheckpoint() public {
        accer.setState(bytes32(uint256(1)), 3);
        uint256 id = ms.trigger();
        assertEq(id, 0);
        assertEq(accer.checkpointCount(), 1);
    }

    function test_SubmitProofHappyPath() public {
        bytes32 acc = bytes32(uint256(0xABCD));
        accer.pushCheckpoint(acc, 5, 42);
        _expectDigest(acc, 5);

        _submit(0);

        IMerkleSnapshot.MerkleState memory s = ms.getLatestState();
        assertEq(s.root, ROOT);
        assertEq(s.blockNumber, 42, "must file at the checkpoint freeze block");
        assertEq(s.totalValue, TOTAL);
        assertEq(ms.lastAppliedCheckpoint(), 0);
        assertTrue(ms.hasAppliedCheckpoint());
    }

    function test_SubmitProofRevertsOnInvalidProof() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        verifier.setAccept(false);
        vm.expectRevert(bytes("MockZkVerifier: rejected"));
        _submit(0);
    }

    function test_SubmitProofBindsWrongJournalReverts() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        // Expect a digest for the WRONG leafCount; the contract's real digest won't match.
        _expectDigest(bytes32(uint256(1)), 999);
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        _submit(0);
    }

    function test_StaleCheckpointRejected() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10); // id 0
        accer.pushCheckpoint(bytes32(uint256(2)), 2, 20); // id 1
        _submit(1); // apply newer first
        // Applying an older one now is stale.
        vm.expectRevert(abi.encodeWithSelector(IMerkleSnapshot.StaleCheckpoint.selector, uint256(0), uint256(1)));
        _submit(0);
        // Re-applying the same is also stale.
        vm.expectRevert(abi.encodeWithSelector(IMerkleSnapshot.StaleCheckpoint.selector, uint256(1), uint256(1)));
        _submit(1);
    }

    function test_MonotonicIncreasingAllowed() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        accer.pushCheckpoint(bytes32(uint256(2)), 2, 20);
        _submit(0);
        _submit(1);
        assertEq(ms.lastAppliedCheckpoint(), 1);
    }

    function test_FreezeBlockFilingKeepsBlocksAscending() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 42);
        accer.pushCheckpoint(bytes32(uint256(2)), 2, 100);
        _submit(0);
        _submit(1);
        assertEq(ms.getStateCount(), 2);
        // binary search by block still works
        assertEq(ms.getStateAtBlock(42).blockNumber, 42);
        assertEq(ms.getStateAtBlock(100).blockNumber, 100);
        assertEq(ms.getStateAtBlock(70).blockNumber, 42, "at-or-before lookup");
    }

    function test_EmptyCheckpointProvable() public {
        accer.pushCheckpoint(bytes32(0), 0, 7);
        bytes32 digest = keccak256(
            abi.encode(
                bytes32(0),
                uint64(0),
                bytes32(0),
                uint64(0),
                paramsHash,
                bytes32(0),
                bytes32(0),
                keccak256(bytes("")),
                uint256(0),
                bytes32(0)
            )
        );
        verifier.setExpectedDigest(digest);
        ms.submitProof(0, bytes32(0), bytes32(0), "", 0, bytes32(0), hex"");
        assertEq(ms.getLatestState().blockNumber, 7);
    }

    function test_HooksFireOnSubmit() public {
        MockHook hook = new MockHook();
        vm.prank(constitutional);
        ms.addHook(hook);

        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        _submit(0);
        assertEq(hook.calls(), 1);
        assertEq(hook.lastRoot(), ROOT);
    }

    function test_OnlyConstitutionalCanSetVerifier() public {
        vm.expectRevert();
        vm.prank(operational);
        ms.setZkVerifier(verifier);

        vm.prank(constitutional);
        ms.setZkVerifier(verifier); // ok
    }

    function test_OnlyOperationalCanSetParams() public {
        vm.expectRevert();
        vm.prank(address(0xdead));
        ms.setParamsHash(bytes32(uint256(9)));

        vm.prank(operational);
        ms.setParamsHash(bytes32(uint256(9)));
        assertEq(ms.paramsHash(), bytes32(uint256(9)));
    }

    function test_ConstructorRejectsZeroVerifierOrAccumulator() public {
        vm.expectRevert(IMerkleSnapshot.ZeroAddress.selector);
        new MerkleSnapshot(MockZkVerifier(address(0)), paramsHash, accer, constitutional, operational);

        vm.expectRevert(IMerkleSnapshot.ZeroAddress.selector);
        new MerkleSnapshot(verifier, paramsHash, MockAccumulator(address(0)), constitutional, operational);
    }

    function test_SetZeroVerifierReverts() public {
        vm.prank(constitutional);
        vm.expectRevert(IMerkleSnapshot.ZeroAddress.selector);
        ms.setZkVerifier(MockZkVerifier(address(0)));
    }

    function test_ConstitutionalAdminsOperationalRole() public {
        bytes32 cRole = ms.CONSTITUTIONAL_ROLE();
        bytes32 oRole = ms.OPERATIONAL_ROLE();

        // operational cannot grant itself constitutional
        vm.prank(operational);
        vm.expectRevert();
        ms.grantRole(cRole, operational);

        // constitutional can rotate the operational role (e.g. to the gov module)
        vm.prank(constitutional);
        ms.grantRole(oRole, address(0xF00D));
        assertTrue(ms.hasRole(oRole, address(0xF00D)));
    }

    /*///////////////////////////////////////////////////////////////
                    JOURNAL v2 — EPOCH SCHEDULE
    //////////////////////////////////////////////////////////////*/

    /// epochLength = 0 keeps the current free-trigger behavior; lastTriggerBlock still advances.
    function test_EpochLengthZeroFreeTrigger() public {
        assertEq(ms.epochLength(), 0);
        vm.roll(30);
        uint256 id0 = ms.trigger();
        uint256 id1 = ms.trigger(); // no schedule ⇒ back-to-back allowed
        assertEq(id1, id0 + 1);
        assertEq(ms.lastTriggerBlock(), 30, "lastTriggerBlock advances even when unscheduled");
    }

    /// With a schedule set, trigger() reverts before the contract-fixed boundary and fires after it.
    function test_EpochScheduleGatesTrigger() public {
        vm.prank(constitutional);
        ms.setEpochLength(50);

        // lastTriggerBlock starts at 0; before block 50 the boundary hasn't elapsed.
        vm.roll(10);
        vm.expectRevert(abi.encodeWithSelector(MerkleSnapshot.EpochNotElapsed.selector, uint64(0), uint64(50)));
        ms.trigger();

        // At the boundary it fires and records the trigger block.
        vm.roll(50);
        ms.trigger();
        assertEq(ms.lastTriggerBlock(), 50);

        // Before the next boundary (50 + 50 = 100) it reverts again.
        vm.roll(99);
        vm.expectRevert(abi.encodeWithSelector(MerkleSnapshot.EpochNotElapsed.selector, uint64(50), uint64(50)));
        ms.trigger();

        // Past the next boundary it fires.
        vm.roll(100);
        ms.trigger();
        assertEq(ms.lastTriggerBlock(), 100);
    }

    /*///////////////////////////////////////////////////////////////
                JOURNAL v2 — TWO-LANE CHECKPOINT + DIGEST
    //////////////////////////////////////////////////////////////*/

    /// Without an anchor registry, a trigger checkpoints the lane-2 accumulator as zeros.
    function test_NoAnchorRegistryCheckpointsZeros() public {
        accer.setState(bytes32(uint256(1)), 3);
        uint256 id = ms.trigger();
        (bytes32 aAcc, uint64 aCount) = ms.anchorCheckpoints(id);
        assertEq(aAcc, bytes32(0));
        assertEq(aCount, 0);
    }

    /// With an anchor registry set, trigger() freezes its (anchorAcc, anchorCount) per checkpoint, and
    /// submitProof binds both lanes plus the skippedDigest into the journal digest.
    function test_TwoLaneCheckpointAndDigestBinding() public {
        MockAnchorRegistry areg = new MockAnchorRegistry();
        vm.prank(constitutional);
        ms.setAnchorRegistry(areg);

        bytes32 laneAcc = bytes32(uint256(0xABCD));
        bytes32 anchorAcc = bytes32(uint256(0xBEEF));
        accer.setState(laneAcc, 5);
        areg.setState(anchorAcc, 9);

        vm.roll(77);
        uint256 id = ms.trigger();

        // Lane-2 snapshot stored at the same id as lane-1.
        (bytes32 storedAcc, uint64 storedCount) = ms.anchorCheckpoints(id);
        assertEq(storedAcc, anchorAcc);
        assertEq(storedCount, 9);

        // The digest must bind both lanes AND the skippedDigest (journal v2, field order frozen).
        bytes32 skipped = keccak256("skip-set");
        bytes32 digest = keccak256(
            abi.encode(
                laneAcc, uint64(5), anchorAcc, uint64(9), paramsHash, ROOT, IPFS, keccak256(bytes(CID)), TOTAL, skipped
            )
        );
        verifier.setExpectedDigest(digest);
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, skipped, hex"");

        IMerkleSnapshot.MerkleState memory s = ms.getLatestState();
        assertEq(s.root, ROOT);
        assertEq(s.blockNumber, 77, "files at the checkpoint's freeze block");
    }

    /// A proof whose skippedDigest differs from the guest's committed value fails the digest bind.
    function test_WrongSkippedDigestReverts() public {
        MockAnchorRegistry areg = new MockAnchorRegistry();
        vm.prank(constitutional);
        ms.setAnchorRegistry(areg);
        accer.setState(bytes32(uint256(1)), 1);
        areg.setState(bytes32(uint256(2)), 1);
        uint256 id = ms.trigger();

        // Verifier expects a digest computed with skipped = A ...
        bytes32 skippedA = keccak256("A");
        bytes32 digestA = keccak256(
            abi.encode(
                bytes32(uint256(1)),
                uint64(1),
                bytes32(uint256(2)),
                uint64(1),
                paramsHash,
                ROOT,
                IPFS,
                keccak256(bytes(CID)),
                TOTAL,
                skippedA
            )
        );
        verifier.setExpectedDigest(digestA);
        // ... but the prover submits skipped = B, so the contract's digest won't match.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, keccak256("B"), hex"");
    }

    /// A proof that assumes the wrong lane-2 anchorAcc (not the checkpointed one) fails the digest bind,
    /// proving the contract binds the CHECKPOINTED anchorAcc, not a prover-supplied value.
    function test_WrongAnchorAccInCheckpointReverts() public {
        MockAnchorRegistry areg = new MockAnchorRegistry();
        vm.prank(constitutional);
        ms.setAnchorRegistry(areg);
        accer.setState(bytes32(uint256(1)), 1);
        bytes32 realAnchorAcc = bytes32(uint256(0xBEEF));
        areg.setState(realAnchorAcc, 3);
        uint256 id = ms.trigger();

        // Verifier expects a digest computed with a BOGUS anchorAcc.
        bytes32 skipped = bytes32(0);
        bytes32 bogusDigest = keccak256(
            abi.encode(
                bytes32(uint256(1)),
                uint64(1),
                bytes32(uint256(0xDEAD)),
                uint64(3),
                paramsHash,
                ROOT,
                IPFS,
                keccak256(bytes(CID)),
                TOTAL,
                skipped
            )
        );
        verifier.setExpectedDigest(bogusDigest);
        // The contract computes the digest with the checkpointed realAnchorAcc, so it mismatches.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, skipped, hex"");
    }

    /*///////////////////////////////////////////////////////////////
                JOURNAL v2 — SETTER ROLE GATING
    //////////////////////////////////////////////////////////////*/

    function test_OnlyConstitutionalCanSetAnchorRegistry() public {
        MockAnchorRegistry areg = new MockAnchorRegistry();

        vm.prank(operational);
        vm.expectRevert();
        ms.setAnchorRegistry(areg);

        vm.prank(constitutional);
        ms.setAnchorRegistry(areg); // ok
        assertEq(address(ms.anchorRegistry()), address(areg));
    }

    function test_OnlyConstitutionalCanSetEpochLength() public {
        vm.prank(operational);
        vm.expectRevert();
        ms.setEpochLength(10);

        vm.prank(constitutional);
        ms.setEpochLength(10); // ok
        assertEq(ms.epochLength(), 10);
    }
}
