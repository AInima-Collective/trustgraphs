// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {ContributionResolver} from "src/eas/resolvers/ContributionResolver.sol";
import {TrustAccumulatorMirror} from "src/merkle/TrustAccumulatorMirror.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";

/// @title ContributionsInstanceTest
/// @notice The full contributions wiring on a real local EAS: trust vouches feed the live
///         `EASIndexerResolver`, contributions feed the `ContributionResolver`, and ONE contrib
///         `MerkleSnapshot.trigger()` freezes both accumulators at the same block — slot A
///         `(acc, leafCount)` = trust via `TrustAccumulatorMirror`, slot B
///         `(anchorAcc, anchorCount)` = contributions via the resolver's IAnchorRegistry aliases
///         (docs/build/contributions/interfaces.md §4). Includes the quiet-trust-lane liveness property
///         and the journal slot binding through `submitProof`.
contract ContributionsInstanceTest is Test {
    string constant VOUCH_SCHEMA = "string comment,uint256 confidence";
    string constant CLAIM_SCHEMA = "string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares";
    string constant RESPONSE_SCHEMA = "bytes32 claimUID,uint8 response";
    string constant VALUATION_SCHEMA = "bytes32 claimUID,uint8 score";

    SchemaRegistry schemaRegistry;
    EAS eas;

    // Trust lane (slot A)
    EASIndexerResolver trustResolver;
    bytes32 vouchUid;
    TrustAccumulatorMirror mirror;

    // Contribution lane (slot B)
    ContributionResolver contribResolver;
    bytes32 claimUid;
    bytes32 responseUid;
    bytes32 valuationUid;

    MockZkVerifier verifier;
    MerkleSnapshot snapshot;

    bytes32 constant PARAMS_HASH = keccak256("contributions-params-dev");
    uint64 constant EPOCH_LENGTH = 10;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    // sample proof outputs
    bytes32 constant ROOT = bytes32(uint256(0xC0FFEE));
    bytes32 constant IPFS = bytes32(uint256(0x1F5));
    string constant CID = "bafkreiexamplecontributionscid";
    uint256 constant TOTAL = 5_000e6;
    address constant RECIPIENT = address(0xBE);

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));

        trustResolver = new EASIndexerResolver(IEAS(address(eas)));
        vouchUid = schemaRegistry.register(VOUCH_SCHEMA, trustResolver, true);
        trustResolver.bindSchema(vouchUid);

        contribResolver = new ContributionResolver(IEAS(address(eas)), address(this));
        claimUid = schemaRegistry.register(CLAIM_SCHEMA, contribResolver, true);
        responseUid = schemaRegistry.register(RESPONSE_SCHEMA, contribResolver, true);
        valuationUid = schemaRegistry.register(VALUATION_SCHEMA, contribResolver, true);
        contribResolver.setSchemas(claimUid, responseUid, valuationUid);

        mirror = new TrustAccumulatorMirror(IAttestationAccumulator(address(trustResolver)));
        verifier = new MockZkVerifier();
        snapshot = new MerkleSnapshot(
            verifier, PARAMS_HASH, IAttestationAccumulator(address(mirror)), address(this), address(this)
        );
        snapshot.setAnchorRegistry(IAnchorRegistry(address(contribResolver)));
        snapshot.setEpochLength(EPOCH_LENGTH);
        mirror.bindSnapshot(address(snapshot));

        // Past the first epoch boundary so the initial trigger is allowed.
        vm.roll(100);
    }

    function _attest(address attester, bytes32 schemaUid, bytes memory data) internal returns (bytes32 uid) {
        vm.prank(attester);
        return eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: attester == alice ? bob : alice,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: data,
                    value: 0
                })
            })
        );
    }

    function _vouch(address attester) internal {
        _attest(attester, vouchUid, abi.encode("gm", uint256(80)));
    }

    function _claim(address attester) internal returns (bytes32 uid) {
        address[] memory contributors = new address[](1);
        contributors[0] = attester;
        uint32[] memory shares = new uint32[](1);
        shares[0] = 1;
        return _attest(attester, claimUid, abi.encode("Did a thing", keccak256("c"), "ipfs://x", contributors, shares));
    }

    function _value(address attester, bytes32 claimAttUid, uint8 score) internal {
        _attest(attester, valuationUid, abi.encode(claimAttUid, score));
    }

    /// One trigger freezes BOTH accumulators at the same block: the mirror checkpoint carries the
    /// trust `(acc, leafCount)`, `anchorCheckpoints[id]` carries the contrib `(acc, leafCount)`.
    function test_TriggerFreezesBothLanesAtOneBlock() public {
        _vouch(alice);
        bytes32 c = _claim(bob);
        _value(alice, c, 90);

        uint256 id = snapshot.trigger();
        assertEq(id, 0);

        IAttestationAccumulator.Checkpoint memory trustCp = mirror.getCheckpoint(id);
        assertEq(trustCp.acc, trustResolver.acc(), "slot A must freeze the trust acc");
        assertEq(trustCp.leafCount, trustResolver.leafCount());
        assertEq(trustCp.leafCount, 1);
        assertEq(trustCp.blockNumber, uint64(block.number), "both lanes freeze at the trigger block");

        (bytes32 anchorAcc, uint64 anchorCount) = snapshot.anchorCheckpoints(id);
        assertEq(anchorAcc, contribResolver.acc(), "slot B must freeze the contrib acc");
        assertEq(anchorCount, contribResolver.leafCount());
        assertEq(anchorCount, 2);

        // The trust instance's own checkpoint history is untouched by the contrib trigger.
        assertEq(trustResolver.checkpointCount(), 0);
    }

    /// Liveness: a second round with ONLY contribution activity (quiet vouch graph) must trigger
    /// cleanly — the mirror never reverts `NoNewInputs`.
    function test_SecondTriggerWithQuietTrustLane() public {
        _vouch(alice);
        bytes32 c = _claim(bob);
        snapshot.trigger();

        // Next epoch: nobody vouched; one new valuation arrived.
        vm.roll(block.number + EPOCH_LENGTH);
        _value(alice, c, 75);

        uint256 id = snapshot.trigger();
        assertEq(id, 1);

        IAttestationAccumulator.Checkpoint memory cp0 = mirror.getCheckpoint(0);
        IAttestationAccumulator.Checkpoint memory cp1 = mirror.getCheckpoint(1);
        assertEq(cp1.acc, cp0.acc, "quiet trust lane re-freezes the same acc");
        assertEq(cp1.leafCount, cp0.leafCount);

        (, uint64 anchorCount0) = snapshot.anchorCheckpoints(0);
        (, uint64 anchorCount1) = snapshot.anchorCheckpoints(1);
        assertEq(anchorCount0, 1);
        assertEq(anchorCount1, 2, "the new valuation must be inside the second freeze");
    }

    /// The contract-fixed epoch schedule still gates triggers (spam is bounded here, not at the
    /// mirror).
    function test_TriggerRespectsEpochLength() public {
        _vouch(alice);
        snapshot.trigger();

        _claim(bob);
        vm.expectRevert(
            abi.encodeWithSelector(MerkleSnapshot.EpochNotElapsed.selector, snapshot.lastTriggerBlock(), EPOCH_LENGTH)
        );
        snapshot.trigger();

        vm.roll(block.number + EPOCH_LENGTH);
        assertEq(snapshot.trigger(), 1);
    }

    function _journalDigest(bytes32 slotAAcc, uint64 slotACount, bytes32 slotBAcc, uint64 slotBCount)
        internal
        view
        returns (bytes32)
    {
        // Journal v3, field order frozen: slot A (acc, leafCount) then slot B
        // (anchorAcc, anchorCount) — INTERFACES.md §4 — then the two v3 bindings.
        return keccak256(
            abi.encode(
                slotAAcc,
                slotACount,
                slotBAcc,
                slotBCount,
                PARAMS_HASH,
                ROOT,
                IPFS,
                keccak256(bytes(CID)),
                TOTAL,
                bytes32(0),
                RECIPIENT,
                snapshot.instanceDomain()
            )
        );
    }

    /// submitProof binds slot A to the TRUST accumulator and slot B to the CONTRIBUTION
    /// accumulator — the digest is rebuilt by hand here and pinned in the mock verifier.
    function test_SubmitProofSlotBinding() public {
        _vouch(alice);
        _vouch(bob);
        bytes32 c = _claim(bob);
        _value(alice, c, 60);

        uint256 id = snapshot.trigger();
        uint64 freezeBlock = uint64(block.number);

        bytes32 trustAcc = trustResolver.acc();
        bytes32 contribAcc = contribResolver.acc();
        assertTrue(trustAcc != contribAcc, "distinct lane states or the binding test is vacuous");

        verifier.setExpectedDigest(_journalDigest(trustAcc, 2, contribAcc, 2));
        snapshot.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");

        IMerkleSnapshot.MerkleState memory s = snapshot.getLatestState();
        assertEq(s.root, ROOT);
        assertEq(s.blockNumber, freezeBlock, "state files at the input-freeze block");
        assertEq(s.totalValue, TOTAL);
    }

    /// A journal with the lanes SWAPPED (trust acc in slot B, contrib acc in slot A) must not
    /// verify: the slot assignment is part of the proven statement.
    function test_SubmitProofSwappedSlotsRejected() public {
        _vouch(alice);
        bytes32 c = _claim(bob);
        _value(alice, c, 60);

        uint256 id = snapshot.trigger();

        verifier.setExpectedDigest(_journalDigest(contribResolver.acc(), 2, trustResolver.acc(), 1));
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        snapshot.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), RECIPIENT, hex"");
    }
}
