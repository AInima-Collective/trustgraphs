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

/// @title AuditM6Poc
/// @notice Adversarial PoCs for the M6 contributions surface. See research/audits/2026-07-M6.md.
contract AuditM6Poc is Test {
    string constant CLAIM_SCHEMA = "string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares";
    string constant RESPONSE_SCHEMA = "bytes32 claimUID,uint8 response";
    string constant VALUATION_SCHEMA = "bytes32 claimUID,uint8 score";

    SchemaRegistry schemaRegistry;
    EAS eas;
    EASIndexerResolver trustResolver;
    TrustAccumulatorMirror mirror;
    ContributionResolver contribResolver;
    bytes32 claimUid;
    bytes32 responseUid;
    bytes32 valuationUid;
    MockZkVerifier verifier;
    MerkleSnapshot snapshot;

    bytes32 constant PARAMS_HASH = keccak256("contributions-params-dev");
    uint64 constant EPOCH_LENGTH = 10;

    address attacker = address(0xBAD);
    address bob = address(0xB0B);

    bytes32 constant HONEST_ROOT = bytes32(uint256(0xC0FFEE));
    bytes32 constant BLIND_ROOT = bytes32(uint256(0xDEAD));

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));

        trustResolver = new EASIndexerResolver(IEAS(address(eas)));
        schemaRegistry.register("string comment,uint256 confidence", trustResolver, true);

        contribResolver = new ContributionResolver(IEAS(address(eas)), address(this));
        claimUid = schemaRegistry.register(CLAIM_SCHEMA, contribResolver, true);
        responseUid = schemaRegistry.register(RESPONSE_SCHEMA, contribResolver, true);
        valuationUid = schemaRegistry.register(VALUATION_SCHEMA, contribResolver, true);
        contribResolver.setSchemas(claimUid, responseUid, valuationUid);

        mirror = new TrustAccumulatorMirror(IAttestationAccumulator(address(trustResolver)));
        verifier = new MockZkVerifier();
        snapshot = new MerkleSnapshot(
            verifier, PARAMS_HASH, IAttestationAccumulator(address(mirror)), address(this), address(this), ""
        );
        snapshot.setAnchorRegistry(IAnchorRegistry(address(contribResolver)));
        snapshot.setEpochLength(EPOCH_LENGTH);
        // The M6-1 fix: bind the mirror so only the snapshot's trigger() may mint checkpoints.
        mirror.bindSnapshot(address(snapshot));
        vm.roll(100);
    }

    /// @dev Fold N contribution-claim leaves into the contribResolver (lane 2).
    function _foldContribution(bytes memory data) internal {
        eas.attest(
            AttestationRequest({
                schema: claimUid,
                data: AttestationRequestData({
                    recipient: bob,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: data,
                    value: 0
                })
            })
        );
    }

    /// @notice M6-1 regression (was HIGH): a directly-created mirror checkpoint would mint a
    ///         lane-1 checkpoint id whose paired lane-2 anchor in MerkleSnapshot is (0,0) — because
    ///         only trigger() populates anchorCheckpoints — letting a prover bind lane-2 (the
    ///         contribution log) to EMPTY even though the live log is non-empty. FIXED: the mirror
    ///         is bound to the snapshot, so only trigger() mints checkpoints (both lanes frozen at
    ///         one id). The attack path now reverts at its first step.
    function test_poc_mirrorSpamCheckpoint_desyncsLane2() public {
        // A real, non-empty contribution log exists.
        _foldContribution(hex"1111");
        _foldContribution(hex"2222");
        assertEq(contribResolver.anchorCount(), 2, "precondition: 2 contributions folded");

        // Honest epoch: trigger() freezes BOTH lanes at the same block.
        uint256 honestId = snapshot.trigger();
        (bytes32 hAnchorAcc, uint64 hAnchorCount) = snapshot.anchorCheckpoints(honestId);
        assertEq(hAnchorCount, 2, "honest trigger binds the real contribution count");
        assertTrue(hAnchorAcc != bytes32(0), "honest trigger binds the real contribution acc");
        snapshot.submitProof(
            honestId, HONEST_ROOT, bytes32(uint256(1)), "cid-honest", 1000, bytes32(0), address(0), hex""
        );

        // More contributions arrive; the live log now has 3 leaves.
        _foldContribution(hex"3333");
        assertEq(contribResolver.anchorCount(), 3, "live contribution log is non-empty (3 leaves)");

        // ATTACK (now defeated): anyone calling the mirror's checkpoint() DIRECTLY reverts —
        // only the bound snapshot's trigger() may mint a checkpoint id, so no unpaired lane-1
        // id can ever exist for a prover to bind an empty lane 2 against.
        vm.prank(attacker);
        vm.expectRevert(TrustAccumulatorMirror.NotSnapshot.selector);
        mirror.checkpoint();

        // The only way to advance the checkpoint id is trigger(), which pairs lane 2 correctly.
        vm.roll(block.number + EPOCH_LENGTH);
        uint256 nextId = snapshot.trigger();
        (bytes32 nAnchorAcc, uint64 nAnchorCount) = snapshot.anchorCheckpoints(nextId);
        assertEq(nAnchorCount, 3, "trigger binds the CURRENT contribution count, never (0,0)");
        assertTrue(nAnchorAcc != bytes32(0), "the contribution acc is bound, not empty");
    }
}
