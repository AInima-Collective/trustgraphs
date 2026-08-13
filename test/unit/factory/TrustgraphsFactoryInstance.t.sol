// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "contracts/factory/TrustgraphsParamsController.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";

/// @title TrustgraphsFactoryInstanceTest
/// @notice The half of M1 that a deployment check cannot fake: an instance minted by one transaction
///         is a WORKING instance. Members attest against its schema, its resolver folds the edge, its
///         snapshot checkpoints on its own epoch schedule, and a proof over that checkpoint writes a
///         root — through the real EAS, not a mock. Plus the factory-level half of the
///         domain-separation criterion.
contract TrustgraphsFactoryInstanceTest is TrustgraphsFactoryBase {
    address internal member = address(0x11);
    address internal peer = address(0x22);

    // Sample proof outputs, as in MerkleSnapshot.t.sol.
    bytes32 internal constant ROOT = bytes32(uint256(0xC0FFEE));
    bytes32 internal constant IPFS = bytes32(uint256(0x1F5));
    string internal constant CID = "bafkreiexamplecidstring";
    uint256 internal constant TOTAL = 1_000_000 ether;
    address internal constant RECIPIENT = address(0xBE);

    /*//////////////////////////////////////////////////////////////
                      THE INSTANCE ACTUALLY WORKS
    //////////////////////////////////////////////////////////////*/

    /// A member vouches against the schema the factory registered, and the instance's OWN resolver
    /// folds that edge into its OWN accumulator. This is the wiring claim: the schema UID binds the
    /// resolver, so an attestation needs no post-creation configuration to be counted.
    function test_MembersCanVouchAndTheResolverFolds() public {
        Created memory c = _create(_args("live"));
        IAttestationAccumulator acc = IAttestationAccumulator(c.resolver);

        assertEq(acc.leafCount(), 0, "a fresh instance has folded nothing");
        assertEq(acc.acc(), bytes32(0));

        bytes32 uid = _vouch(c.schemaUid, member, peer, "solid contributor", 80);

        assertEq(acc.leafCount(), 1, "the vouch must be folded");
        assertTrue(acc.acc() != bytes32(0), "accumulator must advance");
        assertTrue(uid != bytes32(0));

        // The fold encoding is the frozen one (golden-locked): reproduce it by hand.
        bytes32 leaf = _edgeLeaf(uid, abi.encode("solid contributor", uint256(80)));
        assertEq(acc.acc(), keccak256(abi.encode(bytes32(0), leaf)), "chained fold mismatch");
    }

    /// Revocation is folded too (kind 1), so a withdrawn vouch is visible to the guest rather than
    /// silently dropped — the schema is registered `revocable: true` for exactly this reason.
    function test_RevocationIsFolded() public {
        Created memory c = _create(_args("live"));
        IAttestationAccumulator acc = IAttestationAccumulator(c.resolver);

        bytes32 uid = _vouch(c.schemaUid, member, peer, "hm", 50);
        assertEq(acc.leafCount(), 1);

        vm.prank(member);
        eas.revoke(RevocationRequest({schema: c.schemaUid, data: RevocationRequestData({uid: uid, value: 0})}));
        assertEq(acc.leafCount(), 2, "revocation folds a second edge");
    }

    /// The epoch schedule the factory set is LIVE from block zero: `trigger()` is refused before the
    /// contract-fixed boundary, so epoch boundaries are never prover-chosen even on a brand-new
    /// instance.
    function test_TriggerIsRefusedBeforeTheEpochBoundary() public {
        Created memory c = _create(_args("scheduled"));
        _vouch(c.schemaUid, member, peer, "early", 10);

        vm.roll(uint256(EPOCH_FLOOR) - 1);
        vm.expectRevert(abi.encodeWithSelector(MerkleSnapshot.EpochNotElapsed.selector, uint64(0), EPOCH_FLOOR));
        MerkleSnapshot(c.snapshot).trigger();
    }

    /// Past the boundary the instance checkpoints itself: the snapshot freezes ITS resolver's
    /// accumulator, which is what turns a prover-chosen input set into a chain-pinned one.
    function test_TriggerCheckpointsTheInstancesOwnAccumulator() public {
        Created memory c = _create(_args("checkpointed"));
        _vouch(c.schemaUid, member, peer, "counted", 90);

        vm.roll(uint256(EPOCH_FLOOR) + 1);
        uint256 checkpointId = MerkleSnapshot(c.snapshot).trigger();

        IAttestationAccumulator acc = IAttestationAccumulator(c.resolver);
        assertEq(checkpointId, 0, "first checkpoint");
        assertEq(acc.checkpointCount(), 1);

        IAttestationAccumulator.Checkpoint memory cp = acc.getCheckpoint(0);
        assertEq(cp.acc, acc.acc(), "checkpoint freezes the live accumulator");
        assertEq(cp.leafCount, 1);
        assertEq(cp.blockNumber, uint64(block.number));
    }

    /// End to end on one instance: vouch, checkpoint, prove, and the root lands filed at the
    /// checkpoint's input-freeze block. The journal binds THIS instance's `paramsHash` — the value
    /// the factory computed — so nothing about the created set is left unproven.
    function test_ProvenRootLandsOnAFactoryMintedInstance() public {
        Created memory c = _create(_args("proven"));
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);

        _vouch(c.schemaUid, member, peer, "counted", 90);
        vm.roll(uint256(EPOCH_FLOOR) + 1);
        snapshot.trigger();

        verifier.setExpectedDigest(_journalDigest(c, 0));
        snapshot.submitProof(0, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");

        assertEq(snapshot.getLatestState().root, ROOT);
        assertEq(snapshot.getLatestState().blockNumber, block.number, "filed at the freeze block");
        assertTrue(snapshot.hasAppliedCheckpoint());
    }

    /// A frozen checkpoint keeps its old meaning across a complete tuple rotation; the next
    /// checkpoint pins the new version and proves without any retroactive mutation.
    function test_ParameterRotationPreservesOldCheckpointAndPinsTheNext() public {
        Created memory c = _create(_args("rotating"));
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);

        _vouch(c.schemaUid, member, peer, "version one", 90);
        vm.roll(uint256(EPOCH_FLOOR) + 1);
        snapshot.trigger();
        bytes32 versionOneHash = snapshot.checkpointParamsHash(0);

        ParamsCodec.Params memory next = controller.getCurrentParams();
        next.dampingFp -= 1;
        next.trustedSeeds = new address[](2);
        next.trustedSeeds[0] = address(0xCAFE);
        next.trustedSeeds[1] = address(0xBEEF);
        bytes32 versionTwoHash = ParamsCodec.hash(next);

        vm.prank(c.admin);
        controller.updateParams(next, "ipfs://rotation-evidence");
        assertEq(controller.version(), 2);
        assertEq(controller.currentParamsHash(), versionTwoHash);
        assertEq(snapshot.paramsHash(), versionTwoHash);
        assertEq(registry.getInstance(c.instanceId).paramsHash, versionTwoHash);
        assertEq(snapshot.checkpointParamsHash(0), versionOneHash, "frozen checkpoint must not change");

        IAttestationAccumulator.Checkpoint memory oldCheckpoint = IAttestationAccumulator(c.resolver).getCheckpoint(0);
        verifier.setExpectedDigest(_digest(c.snapshot, oldCheckpoint.acc, oldCheckpoint.leafCount, versionOneHash));
        snapshot.submitProof(0, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");

        _vouch(c.schemaUid, peer, member, "version two", 70);
        vm.roll(block.number + EPOCH_FLOOR);
        uint256 nextCheckpointId = snapshot.trigger();
        assertEq(nextCheckpointId, 1);
        assertEq(snapshot.checkpointParamsHash(1), versionTwoHash);

        IAttestationAccumulator.Checkpoint memory newCheckpoint = IAttestationAccumulator(c.resolver).getCheckpoint(1);
        verifier.setExpectedDigest(_digest(c.snapshot, newCheckpoint.acc, newCheckpoint.leafCount, versionTwoHash));
        snapshot.submitProof(1, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");
        assertEq(snapshot.lastAppliedCheckpoint(), 1);
    }

    /// The optional distributor is a working consumer of the instance's root, not a loose contract:
    /// it reads this snapshot, and only the admin can govern it.
    function test_DistributorIsWiredAndAdminOwned() public {
        TrustgraphsFactory.CreateArgs memory args = _args("funded");
        args.withDistributor = true;
        args.admin = member;
        Created memory c = _create(args);

        MerkleFundDistributor dist = MerkleFundDistributor(payable(c.distributor));
        assertEq(dist.merkleSnapshot(), c.snapshot, "reads this instance's root");
        assertEq(dist.owner(), member);
        assertEq(dist.feeRecipient(), member, "a fee, if ever enabled, cannot route to a stranger");
        assertEq(dist.feePercentage(), 0, "no fee by default");
        assertFalse(dist.allowlistEnabled(), "anyone may fund a round by default");

        // M-7: raising the fee from zero is an INCREASE, so it schedules and waits out the delay
        // before applying — the admin cannot front-run a funder's round.
        vm.prank(member);
        dist.setFeePercentage(1e15);
        assertEq(dist.feePercentage(), 0, "increase must not be immediate");
        vm.warp(block.timestamp + dist.FEE_INCREASE_DELAY());
        dist.applyFeePercentageIncrease();
        assertEq(dist.feePercentage(), 1e15);
    }

    /*//////////////////////////////////////////////////////////////
                 DOMAIN SEPARATION AT THE FACTORY LEVEL
    //////////////////////////////////////////////////////////////*/

    /// GOAL criterion 4, factory half: two instances created from IDENTICAL `CreateArgs` params
    /// (differing only in salt) must not share a `paramsHash`. The params schema's v2 fields —
    /// accumulator and chainId — are what make clones distinguishable; without them these two
    /// structs would be byte-identical and their hashes equal.
    function test_IdenticalParamsProduceDifferentInstanceHashes() public {
        TrustgraphsFactory.CreateArgs memory args = _args("clone");
        Created memory a = _create(args);

        args.salt = bytes32(uint256(1));
        Created memory b = _create(args);

        // The two structs agree on every governance field the creator chose...
        assertEq(a.evt.params.dampingFp, b.evt.params.dampingFp);
        assertEq(a.evt.params.totalPool, b.evt.params.totalPool);
        assertEq(a.evt.params.chainId, b.evt.params.chainId, "same chain");
        // ...and differ exactly in the identity fields the factory derived.
        assertTrue(a.evt.params.accumulator != b.evt.params.accumulator, "distinct accumulators");
        assertTrue(a.evt.params.schemaUid != b.evt.params.schemaUid, "distinct schemas");

        bytes32 hashA = MerkleSnapshot(a.snapshot).paramsHash();
        bytes32 hashB = MerkleSnapshot(b.snapshot).paramsHash();
        assertTrue(hashA != hashB, "clones must not share a paramsHash");
        assertEq(hashA, ParamsCodec.hash(a.evt.params));
        assertEq(hashB, ParamsCodec.hash(b.evt.params));
        assertTrue(
            registry.getInstance(a.instanceId).paramsHash != registry.getInstance(b.instanceId).paramsHash,
            "the directory must not list two instances under one hash"
        );
    }

    /// Replay separation, as far as a mock verifier can honestly carry it. `MockZkVerifier` does no
    /// cryptography: it compares the journal digest the SNAPSHOT computed against a digest we pin.
    /// So this does not prove anything about SP1 — what it does prove is the property the ZK layer
    /// then rests on: instance B computes a DIFFERENT journal digest for the same claimed outputs,
    /// because its `paramsHash` (and its own checkpointed inputs) enter that digest. A proof whose
    /// public journal was accepted by A therefore cannot satisfy B's verification call.
    function test_AProofBoundToOneInstanceDoesNotSatisfyAnother() public {
        TrustgraphsFactory.CreateArgs memory args = _args("clone");
        Created memory a = _create(args);
        args.salt = bytes32(uint256(1));
        Created memory b = _create(args);

        _vouch(a.schemaUid, member, peer, "same words", 70);
        _vouch(b.schemaUid, member, peer, "same words", 70);

        vm.roll(uint256(EPOCH_FLOOR) + 1);
        MerkleSnapshot(a.snapshot).trigger();
        MerkleSnapshot(b.snapshot).trigger();

        // A's proof is valid on A.
        bytes32 digestA = _journalDigest(a, 0);
        verifier.setExpectedDigest(digestA);
        MerkleSnapshot(a.snapshot).submitProof(0, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");

        // Replayed verbatim onto B, the same journal is refused.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        MerkleSnapshot(b.snapshot).submitProof(0, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");

        // Isolating the paramsHash leg: even a journal built over B's OWN checkpointed inputs is
        // refused if it commits to A's params, which is exactly the clone-cross-feed attempt.
        IAttestationAccumulator.Checkpoint memory cpB = IAttestationAccumulator(b.resolver).getCheckpoint(0);
        // A's params, B's inputs.
        verifier.setExpectedDigest(_digest(b.snapshot, cpB.acc, cpB.leafCount, MerkleSnapshot(a.snapshot).paramsHash()));
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        MerkleSnapshot(b.snapshot).submitProof(0, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");

        // And B's own journal, with B's own params, is accepted — so the rejection above was the
        // domain separation doing its job, not a broken instance.
        verifier.setExpectedDigest(_journalDigest(b, 0));
        MerkleSnapshot(b.snapshot).submitProof(0, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");
        assertEq(MerkleSnapshot(b.snapshot).getLatestState().root, ROOT);
    }

    /// Instances are isolated in the other direction too: an attestation against A's schema never
    /// reaches B's accumulator, so one community's vouches cannot inflate another's scores.
    function test_OneInstancesVouchesNeverTouchAnother() public {
        Created memory a = _create(_args("alpha"));
        Created memory b = _create(_args("beta"));

        _vouch(a.schemaUid, member, peer, "for alpha only", 100);

        assertEq(IAttestationAccumulator(a.resolver).leafCount(), 1);
        assertEq(IAttestationAccumulator(b.resolver).leafCount(), 0, "beta must be untouched");
        assertEq(IAttestationAccumulator(b.resolver).acc(), bytes32(0));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A vouch in the canonical schema: `string comment, uint256 confidence`.
    function _vouch(bytes32 schemaUid, address attester, address recipient, string memory comment, uint256 confidence)
        internal
        returns (bytes32 uid)
    {
        vm.prank(attester);
        uid = eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode(comment, confidence),
                    value: 0
                })
            })
        );
    }

    /// @dev The frozen lane-1 edge leaf (kind 0 = attest), as `AttestationAccumulator._fold` builds it.
    function _edgeLeaf(bytes32 uid, bytes memory data) internal view returns (bytes32) {
        return keccak256(abi.encode(uint8(0), member, peer, uid, block.timestamp, keccak256(data)));
    }

    /// @dev Journal v2 for a lane-1-only instance, over its own checkpoint and its own paramsHash.
    function _journalDigest(Created memory c, uint256 checkpointId) internal view returns (bytes32) {
        IAttestationAccumulator.Checkpoint memory cp = IAttestationAccumulator(c.resolver).getCheckpoint(checkpointId);
        return _digest(c.snapshot, cp.acc, cp.leafCount, MerkleSnapshot(c.snapshot).paramsHash());
    }

    /// @dev Journal v3, field order FROZEN (`MerkleSnapshot.submitProof`): lane-2 is the zero
    ///      accumulator on every v1 factory instance, and the last two words are the v3 bindings.
    function _digest(address snapshot, bytes32 inputAcc, uint64 leafCount, bytes32 paramsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                inputAcc,
                leafCount,
                bytes32(0),
                uint64(0),
                paramsHash,
                ROOT,
                IPFS,
                keccak256(bytes(CID)),
                TOTAL,
                bytes32(0),
                RECIPIENT,
                MerkleSnapshot(snapshot).instanceDomain()
            )
        );
    }
}
