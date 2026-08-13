// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockAnchorRegistry} from "../mocks/MockAnchorRegistry.sol";
import {MockHook, RevertingHook, GasGuzzlerHook} from "../mocks/MockHook.sol";

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
    address constant RECIPIENT = address(0xBE);

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        ms = new MerkleSnapshot(verifier, paramsHash, accer, constitutional, operational);
    }

    /*///////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// Mint a checkpoint the way production does — through `trigger()`, which is the only path
    /// that pins `paramsHash` (and, once the accumulator is bound to its snapshot, the only path
    /// that exists at all). Freeze block = `blockNumber`.
    function _mint(bytes32 acc, uint64 leafCount, uint64 blockNumber) internal returns (uint256 id) {
        accer.setState(acc, leafCount);
        vm.roll(blockNumber);
        id = ms.trigger();
    }

    /// The full journal-v3 digest the contract will compute, for a lane-1-only instance.
    function _digest(bytes32 acc, uint64 leafCount, bytes32 pinned, address recipient) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                acc,
                leafCount,
                bytes32(0),
                uint64(0),
                pinned,
                ROOT,
                IPFS,
                keccak256(bytes(CID)),
                TOTAL,
                bytes32(0),
                recipient,
                ms.instanceDomain()
            )
        );
    }

    function _expectDigest(bytes32 acc, uint64 leafCount) internal {
        verifier.setExpectedDigest(_digest(acc, leafCount, paramsHash, RECIPIENT));
    }

    function _submit(uint256 checkpointId) internal {
        ms.submitProof(checkpointId, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");
    }

    /*///////////////////////////////////////////////////////////////
                                LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function test_TriggerCreatesCheckpoint() public {
        accer.setState(bytes32(uint256(1)), 3);
        uint256 id = ms.trigger();
        assertEq(id, 0);
        assertEq(accer.checkpointCount(), 1);
    }

    function test_SubmitProofHappyPath() public {
        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 id = _mint(acc, 5, 42);
        _expectDigest(acc, 5);

        _submit(id);

        IMerkleSnapshot.MerkleState memory s = ms.getLatestState();
        assertEq(s.root, ROOT);
        assertEq(s.blockNumber, 42, "must file at the checkpoint freeze block");
        assertEq(s.totalValue, TOTAL);
        assertEq(ms.lastAppliedCheckpoint(), 0);
        assertTrue(ms.hasAppliedCheckpoint());
    }

    function test_SubmitProofRevertsOnInvalidProof() public {
        uint256 id = _mint(bytes32(uint256(1)), 1, 10);
        verifier.setAccept(false);
        vm.expectRevert(bytes("MockZkVerifier: rejected"));
        _submit(id);
    }

    function test_SubmitProofBindsWrongJournalReverts() public {
        uint256 id = _mint(bytes32(uint256(1)), 1, 10);
        // Expect a digest for the WRONG leafCount; the contract's real digest won't match.
        _expectDigest(bytes32(uint256(1)), 999);
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        _submit(id);
    }

    function test_StaleCheckpointRejected() public {
        _mint(bytes32(uint256(1)), 1, 10); // id 0
        _mint(bytes32(uint256(2)), 2, 20); // id 1
        _submit(1); // apply newer first
        // Applying an older one now is stale.
        vm.expectRevert(abi.encodeWithSelector(IMerkleSnapshot.StaleCheckpoint.selector, uint256(0), uint256(1)));
        _submit(0);
        // Re-applying the same is also stale.
        vm.expectRevert(abi.encodeWithSelector(IMerkleSnapshot.StaleCheckpoint.selector, uint256(1), uint256(1)));
        _submit(1);
    }

    function test_MonotonicIncreasingAllowed() public {
        _mint(bytes32(uint256(1)), 1, 10);
        _mint(bytes32(uint256(2)), 2, 20);
        _submit(0);
        _submit(1);
        assertEq(ms.lastAppliedCheckpoint(), 1);
    }

    function test_FreezeBlockFilingKeepsBlocksAscending() public {
        _mint(bytes32(uint256(1)), 1, 42);
        _mint(bytes32(uint256(2)), 2, 100);
        _submit(0);
        _submit(1);
        assertEq(ms.getStateCount(), 2);
        // binary search by block still works
        assertEq(ms.getStateAtBlock(42).blockNumber, 42);
        assertEq(ms.getStateAtBlock(100).blockNumber, 100);
        assertEq(ms.getStateAtBlock(70).blockNumber, 42, "at-or-before lookup");
    }

    function test_EmptyCheckpointProvable() public {
        uint256 id = _mint(bytes32(0), 0, 7);
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
                bytes32(0),
                RECIPIENT,
                ms.instanceDomain()
            )
        );
        verifier.setExpectedDigest(digest);
        ms.submitProof(id, bytes32(0), bytes32(0), "", 0, bytes32(0), RECIPIENT, hex"");
        assertEq(ms.getLatestState().blockNumber, 7);
    }

    function test_HooksFireOnSubmit() public {
        MockHook hook = new MockHook();
        vm.prank(constitutional);
        ms.addHook(hook);

        uint256 id = _mint(bytes32(uint256(1)), 1, 10);
        _submit(id);
        assertEq(hook.calls(), 1);
        assertEq(hook.lastRoot(), ROOT);
    }

    /// M-2: a reverting hook must NOT block proof submission — it is caught, HookFailed is emitted,
    /// the root still lands, and any well-behaved sibling hook still fires.
    function test_RevertingHookDoesNotBlockSubmit() public {
        RevertingHook bad = new RevertingHook();
        MockHook good = new MockHook();
        vm.startPrank(constitutional);
        ms.addHook(bad); // index 1
        ms.addHook(good); // index 2
        vm.stopPrank();

        uint256 id = _mint(bytes32(uint256(1)), 1, 10);
        vm.expectEmit(true, true, false, false);
        emit MerkleSnapshot.HookFailed(1, address(bad));
        _submit(id);

        // Root landed despite the reverting hook, and the good hook still ran.
        assertEq(ms.getLatestState().root, ROOT);
        assertEq(good.calls(), 1);
    }

    /// M-2: a gas-guzzling hook is bounded by the stipend and caught, so it cannot grief submission.
    function test_GasGuzzlerHookIsBoundedAndCaught() public {
        GasGuzzlerHook guzzler = new GasGuzzlerHook();
        vm.prank(constitutional);
        ms.addHook(guzzler);

        uint256 id = _mint(bytes32(uint256(1)), 1, 10);
        _submit(id); // must not revert; the stipend caps the guzzler
        assertEq(ms.getLatestState().root, ROOT);
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
                        EPOCH SCHEDULE
    //////////////////////////////////////////////////////////////*/

    /// epochLength = 0 keeps the current free-trigger behavior; lastTriggerBlock still advances.
    function test_EpochLengthZeroFreeTrigger() public {
        assertEq(ms.epochLength(), 0);
        vm.roll(30);
        accer.setState(bytes32(uint256(1)), 1);
        uint256 id0 = ms.trigger();
        // No schedule ⇒ back-to-back allowed, as long as something actually moved. (`trigger()`
        // refuses a checkpoint identical to the last one across both lanes — that is what stops
        // one proof being replayed against an unlimited run of them.)
        accer.setState(bytes32(uint256(2)), 2);
        uint256 id1 = ms.trigger();
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
        accer.setState(bytes32(uint256(1)), 1);
        ms.trigger();
        assertEq(ms.lastTriggerBlock(), 50);

        // Before the next boundary (50 + 50 = 100) it reverts again — on the EPOCH gate, which is
        // what this test is about, so give it fresh inputs to prove it is not the movement check.
        accer.setState(bytes32(uint256(2)), 2);
        vm.roll(99);
        vm.expectRevert(abi.encodeWithSelector(MerkleSnapshot.EpochNotElapsed.selector, uint64(50), uint64(50)));
        ms.trigger();

        // Past the next boundary it fires.
        vm.roll(100);
        ms.trigger();
        assertEq(ms.lastTriggerBlock(), 100);
    }

    /// A checkpoint identical to the last one across BOTH lanes is refused.
    ///
    /// The journal digest does not commit the checkpoint id, so two checkpoints with identical
    /// commitments accept the same proof. `AttestationAccumulator` has always refused this for
    /// lane 1, but `TrustAccumulatorMirror` and `EmptyLaneAccumulator` deliberately do not — on
    /// those, a stranger could mint an unlimited run of identical checkpoints and collect a vault
    /// bounty against each one for a single piece of proving work. Checking both lanes here is
    /// what makes the refusal total, because `trigger()` is the only minter and the only caller
    /// that sees both lanes.
    function test_TriggerRefusesACheckpointNothingMovedIn() public {
        accer.setState(bytes32(uint256(1)), 1);
        ms.trigger();

        vm.roll(50);
        vm.expectRevert(IAttestationAccumulator.NoNewInputs.selector);
        ms.trigger();

        accer.setState(bytes32(uint256(2)), 2);
        ms.trigger();
        assertEq(accer.checkpointCount(), 2);
    }

    /// Lane 2 moving alone is enough — which is the case the mirror's missing guard exists for.
    function test_Lane2MovementAloneJustifiesACheckpoint() public {
        MockAnchorRegistry areg = new MockAnchorRegistry();
        vm.prank(constitutional);
        ms.setAnchorRegistry(areg);

        accer.setState(bytes32(uint256(1)), 1);
        areg.setState(bytes32(uint256(1)), 1);
        ms.trigger();

        // Lane 1 is silent; lane 2 gained an anchor. A contributions round closing while the
        // vouch graph is quiet is exactly this shape.
        areg.setState(bytes32(uint256(2)), 2);
        ms.trigger();
        assertEq(accer.checkpointCount(), 2);
    }

    /*///////////////////////////////////////////////////////////////
                TWO-LANE CHECKPOINT + DIGEST
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

        // The digest must bind both lanes AND the skippedDigest (journal v3, field order frozen).
        bytes32 skipped = keccak256("skip-set");
        bytes32 digest = keccak256(
            abi.encode(
                laneAcc,
                uint64(5),
                anchorAcc,
                uint64(9),
                paramsHash,
                ROOT,
                IPFS,
                keccak256(bytes(CID)),
                TOTAL,
                skipped,
                RECIPIENT,
                ms.instanceDomain()
            )
        );
        verifier.setExpectedDigest(digest);
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, skipped, RECIPIENT, hex"");

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
                skippedA,
                RECIPIENT,
                ms.instanceDomain()
            )
        );
        verifier.setExpectedDigest(digestA);
        // ... but the prover submits skipped = B, so the contract's digest won't match.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, keccak256("B"), RECIPIENT, hex"");
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
                skipped,
                RECIPIENT,
                ms.instanceDomain()
            )
        );
        verifier.setExpectedDigest(bogusDigest);
        // The contract computes the digest with the checkpointed realAnchorAcc, so it mismatches.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, skipped, RECIPIENT, hex"");
    }

    /*///////////////////////////////////////////////////////////////
                JOURNAL v3 — RECIPIENT BINDING
    //////////////////////////////////////////////////////////////*/

    /// The bounty payee is proven, not asserted: a proof produced for recipient A cannot be
    /// resubmitted naming recipient B. This is what makes a copied `submitAndClaim` pay the
    /// original prover (PROOF_SCHEDULER.md §4.3) rather than the copier.
    function test_ProofForRecipientARevertsUnderRecipientB() public {
        address alice = address(0xA11CE);
        address mallory = address(0x4A110);

        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 id = _mint(acc, 5, 42);

        // The guest committed alice as the payee, so the verifier will only accept alice's digest.
        verifier.setExpectedDigest(_digest(acc, 5, paramsHash, alice));

        // Mallory copies the transaction verbatim except for the payee.
        vm.prank(mallory);
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), mallory, hex"");

        // Copying it faithfully still works — and still pays alice. Front-running buys the copier
        // nothing but the gas bill; the vault's split (M3) is what turns that into a refund.
        vm.prank(mallory);
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), alice, hex"");
        assertEq(ms.lastAppliedCheckpoint(), id);
    }

    /// The event separates who paid gas from who is owed the bounty.
    function test_EventCarriesBothProverAndRecipient() public {
        address alice = address(0xA11CE);
        address relayer = address(0x9E1A1);
        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 id = _mint(acc, 5, 42);
        verifier.setExpectedDigest(_digest(acc, 5, paramsHash, alice));

        vm.expectEmit(true, true, true, true);
        emit IMerkleSnapshot.MerkleProofSubmitted(id, ROOT, relayer, alice);
        vm.prank(relayer);
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), alice, hex"");
    }

    /// A zero recipient is legitimate and means "no bounty" — the curated / self-proving path.
    function test_ZeroRecipientIsAValidNoBountyProof() public {
        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 id = _mint(acc, 5, 42);
        verifier.setExpectedDigest(_digest(acc, 5, paramsHash, address(0)));
        ms.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), address(0), hex"");
        assertEq(ms.getLatestState().root, ROOT);
    }

    /*///////////////////////////////////////////////////////////////
                JOURNAL v3 — DOMAIN SEPARATION
    //////////////////////////////////////////////////////////////*/

    /// Two instances identical in EVERY parameter still reject each other's proofs, because the
    /// domain is derived from `address(this)` rather than from anything the params carry. This is
    /// the hypercerts case (issue #9): its params have no instance-unique field at all, modelled
    /// here by giving both snapshots the same `paramsHash` and the same input commitment.
    function test_IdenticalTwinsRejectEachOthersProofs() public {
        MockAccumulator accerB = new MockAccumulator();
        MerkleSnapshot twin = new MerkleSnapshot(verifier, paramsHash, accerB, constitutional, operational);

        assertTrue(ms.instanceDomain() != twin.instanceDomain(), "clones must not share a domain");

        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 idA = _mint(acc, 5, 42);
        accerB.setState(acc, 5);
        uint256 idB = twin.trigger();
        assertEq(idA, idB, "twins agree on everything except who they are");

        // A proof minted for instance A (A's domain in the journal).
        verifier.setExpectedDigest(_digest(acc, 5, paramsHash, RECIPIENT));

        // It lands on A ...
        ms.submitProof(idA, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");
        // ... and is worthless on B.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        twin.submitProof(idB, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");
    }

    /// The same instance on another chain hashes differently — the multi-chain prerequisite.
    function test_InstanceDomainIsChainSpecific() public {
        bytes32 here = ms.instanceDomain();
        vm.chainId(10);
        assertTrue(ms.instanceDomain() != here, "domain must move with block.chainid");
        assertEq(ms.instanceDomain(), keccak256(abi.encode(address(ms), uint256(10))));
    }

    /*///////////////////////////////////////////////////////////////
                CHECKPOINT-PINNED PARAMS
    //////////////////////////////////////////////////////////////*/

    /// trigger() records the params a checkpoint must be proven under, and says so on-chain.
    function test_TriggerPinsParamsHash() public {
        vm.roll(11);
        vm.expectEmit(true, true, true, true);
        emit IMerkleSnapshot.CheckpointParamsPinned(0, paramsHash);
        uint256 id = ms.trigger();
        assertEq(ms.checkpointParamsHash(id), paramsHash);
    }

    /// The whole point: a params rotation between trigger and submit does NOT invalidate the
    /// in-flight proof. `UPGRADE_GOVERNANCE.md` §5.6 asks operators to arrange this by hand today.
    function test_RotationBetweenTriggerAndSubmitDoesNotWasteTheProof() public {
        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 id = _mint(acc, 5, 42);

        // The proof was computed against the OLD params.
        verifier.setExpectedDigest(_digest(acc, 5, paramsHash, RECIPIENT));

        // Governance rotates one block later.
        bytes32 newParams = keccak256("params-v2");
        vm.prank(operational);
        ms.setParamsHash(newParams);
        assertEq(ms.paramsHash(), newParams);

        // The in-flight proof still lands, because the digest is built from the PINNED value.
        _submit(id);
        assertEq(ms.lastAppliedCheckpoint(), id);
    }

    /// ...and the rotation does bind the NEXT checkpoint, so it is a delay, not a bypass.
    function test_RotationBindsTheNextCheckpoint() public {
        _mint(bytes32(uint256(1)), 1, 10);
        bytes32 newParams = keccak256("params-v2");
        vm.prank(operational);
        ms.setParamsHash(newParams);

        bytes32 acc = bytes32(uint256(2));
        uint256 id2 = _mint(acc, 2, 20);
        assertEq(ms.checkpointParamsHash(id2), newParams, "next checkpoint pins the new params");

        // A proof under the OLD params no longer verifies for the new checkpoint.
        verifier.setExpectedDigest(_digest(acc, 2, paramsHash, RECIPIENT));
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        _submit(id2);

        // Under the new params it does.
        verifier.setExpectedDigest(_digest(acc, 2, newParams, RECIPIENT));
        _submit(id2);
    }

    /// A checkpoint minted behind the snapshot's back has no pinned params and cannot be proven.
    /// (With the accumulator bound to its snapshot this is unreachable in production; the revert
    /// is the backstop that keeps "built from the pinned value" total.)
    function test_CheckpointMintedBehindTheSnapshotIsUnprovable() public {
        uint256 id = accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        assertEq(ms.checkpointParamsHash(id), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(IMerkleSnapshot.UnpinnedCheckpoint.selector, id));
        _submit(id);
    }

    /// Zero is the "not pinned" sentinel, so it can never be a real params hash.
    function test_ZeroParamsHashRejected() public {
        vm.expectRevert(IMerkleSnapshot.ZeroParamsHash.selector);
        new MerkleSnapshot(verifier, bytes32(0), accer, constitutional, operational);

        vm.prank(operational);
        vm.expectRevert(IMerkleSnapshot.ZeroParamsHash.selector);
        ms.setParamsHash(bytes32(0));
    }

    /// The verifier is deliberately NOT pinned: rotating it is the SP1-soundness emergency path,
    /// and it MUST invalidate proofs already in flight under the broken key.
    function test_VerifierRotationInvalidatesInFlightProofs() public {
        bytes32 acc = bytes32(uint256(0xABCD));
        uint256 id = _mint(acc, 5, 42);
        verifier.setExpectedDigest(_digest(acc, 5, paramsHash, RECIPIENT));

        MockZkVerifier replacement = new MockZkVerifier();
        replacement.setAccept(false); // the new verifier rejects what the old one accepted
        vm.prank(constitutional);
        ms.setZkVerifier(replacement);

        vm.expectRevert(bytes("MockZkVerifier: rejected"));
        _submit(id);
    }

    /*///////////////////////////////////////////////////////////////
                        SETTER ROLE GATING
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
