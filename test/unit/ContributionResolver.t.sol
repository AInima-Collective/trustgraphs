// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {ContributionResolver} from "contracts/eas/resolvers/ContributionResolver.sol";
import {AttestationAttested, AttestationRevoked} from "../../src/interfaces/IIndexedEvents.sol";

/// @title ContributionResolverTest
/// @notice The contributions resolver against a REAL local EAS deployment: fold parity with the
///         frozen leaf ABI + kind tagging (docs/build/contributions/interfaces.md §2, locked to
///         test/golden/contributions.json), the one-shot schema allowlist, and the
///         IAnchorRegistry aliases the contrib MerkleSnapshot reads as journal slot B.
contract ContributionResolverTest is Test {
    using stdJson for string;

    // The IF §1 schema strings (canonical comma-no-space registered form).
    string constant CLAIM_SCHEMA = "string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares";
    string constant RESPONSE_SCHEMA = "bytes32 claimUID,uint8 response";
    string constant VALUATION_SCHEMA = "bytes32 claimUID,uint8 score";

    SchemaRegistry public schemaRegistry;
    EAS public eas;
    ContributionResolver public resolver;

    bytes32 public claimUid;
    bytes32 public responseUid;
    bytes32 public valuationUid;

    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public carol = address(0xCA401);

    string goldenJson;

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        resolver = new ContributionResolver(IEAS(address(eas)), address(this));

        claimUid = schemaRegistry.register(CLAIM_SCHEMA, resolver, true);
        responseUid = schemaRegistry.register(RESPONSE_SCHEMA, resolver, true);
        valuationUid = schemaRegistry.register(VALUATION_SCHEMA, resolver, true);
        resolver.setSchemas(claimUid, responseUid, valuationUid);

        goldenJson = vm.readFile("test/golden/contributions.json");
    }

    /*///////////////////////////////////////////////////////////////
                        HELPERS (the IF leaf ABI)
    //////////////////////////////////////////////////////////////*/

    /// The frozen accumulator leaf (INTERFACES.md §2) — locked to the golden vectors by
    /// test_GoldenLeafFamilyParity, then used to hand-fold expectations for real attestations.
    function _leaf(
        uint8 kind,
        address attester,
        address recipient,
        bytes32 uid,
        uint256 blockTimestamp,
        bytes32 dataHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, attester, recipient, uid, blockTimestamp, dataHash));
    }

    /// The zk-core fold: acc' = keccak256(abi.encode(acc, leaf)).
    function _foldAcc(bytes32 prevAcc, bytes32 leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(prevAcc, leaf));
    }

    function _attest(address attester, bytes32 schemaUid, bytes memory data) internal returns (bytes32 uid) {
        vm.prank(attester);
        return eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: address(0),
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: data,
                    value: 0
                })
            })
        );
    }

    function _revoke(address attester, bytes32 schemaUid, bytes32 uid) internal {
        vm.prank(attester);
        eas.revoke(RevocationRequest({schema: schemaUid, data: RevocationRequestData({uid: uid, value: 0})}));
    }

    function _claimData() internal view returns (bytes memory) {
        address[] memory contributors = new address[](2);
        contributors[0] = alice;
        contributors[1] = bob;
        uint32[] memory shares = new uint32[](2);
        shares[0] = 70;
        shares[1] = 30;
        return abi.encode("Built the thing", keccak256("content"), "ipfs://claim", contributors, shares);
    }

    /*///////////////////////////////////////////////////////////////
                        FOLD PARITY (golden-locked)
    //////////////////////////////////////////////////////////////*/

    /// Lock this test's hand-fold helpers to the golden `leaf` family (kind 4 leaf + fold vector):
    /// every fold-parity expectation below is computed with the exact same functions.
    function test_GoldenLeafFamilyParity() public view {
        bytes32 leaf = _leaf(
            uint8(goldenJson.readUint(".leaf.kind")),
            goldenJson.readAddress(".leaf.attester"),
            goldenJson.readAddress(".leaf.recipient"),
            goldenJson.readBytes32(".leaf.uid"),
            goldenJson.readUint(".leaf.blockTimestamp"),
            goldenJson.readBytes32(".leaf.dataHash")
        );
        assertEq(leaf, goldenJson.readBytes32(".leaf.leaf"), "golden leaf mismatch");
        assertEq(
            _foldAcc(goldenJson.readBytes32(".leaf.prevAcc"), leaf),
            goldenJson.readBytes32(".leaf.foldedAcc"),
            "golden fold mismatch"
        );
        assertEq(
            keccak256(goldenJson.readBytes(".leaf.data")),
            goldenJson.readBytes32(".leaf.dataHash"),
            "golden dataHash mismatch"
        );
    }

    /// Drive one real attestation per schema through EAS and assert the resolver's `acc` equals
    /// the hand-folded expectation with kinds 0 / 2 / 4 (= schemaIndex * 2).
    function test_FoldParity_AttestAllThreeSchemas() public {
        bytes32 expectedAcc = bytes32(0);

        bytes memory claimData = _claimData();
        bytes32 claimAttUid = _attest(alice, claimUid, claimData);
        expectedAcc =
            _foldAcc(expectedAcc, _leaf(0, alice, address(0), claimAttUid, block.timestamp, keccak256(claimData)));

        bytes memory responseData = abi.encode(claimAttUid, uint8(1));
        bytes32 responseAttUid = _attest(bob, responseUid, responseData);
        expectedAcc =
            _foldAcc(expectedAcc, _leaf(2, bob, address(0), responseAttUid, block.timestamp, keccak256(responseData)));

        // The golden vector's valuation payload (claimUID 0x66…66, score 80), so this attestation's
        // dataHash is byte-identical to the golden `.leaf.dataHash`.
        bytes memory valuationData = goldenJson.readBytes(".leaf.data");
        assertEq(keccak256(valuationData), goldenJson.readBytes32(".leaf.dataHash"), "vector payload drifted");
        bytes32 valuationAttUid = _attest(carol, valuationUid, valuationData);
        expectedAcc = _foldAcc(
            expectedAcc, _leaf(4, carol, address(0), valuationAttUid, block.timestamp, keccak256(valuationData))
        );

        assertEq(resolver.acc(), expectedAcc, "acc mismatch after three folds");
        assertEq(resolver.leafCount(), 3);
    }

    /// Revoking each schema folds kinds 1 / 3 / 5 (= schemaIndex * 2 + 1).
    function test_RevocationFolds_Kinds135() public {
        bytes memory claimData = _claimData();
        bytes memory responseData;
        bytes memory valuationData;

        bytes32 expectedAcc = bytes32(0);
        bytes32 claimAttUid = _attest(alice, claimUid, claimData);
        expectedAcc =
            _foldAcc(expectedAcc, _leaf(0, alice, address(0), claimAttUid, block.timestamp, keccak256(claimData)));
        responseData = abi.encode(claimAttUid, uint8(2));
        bytes32 responseAttUid = _attest(bob, responseUid, responseData);
        expectedAcc =
            _foldAcc(expectedAcc, _leaf(2, bob, address(0), responseAttUid, block.timestamp, keccak256(responseData)));
        valuationData = abi.encode(claimAttUid, uint8(95));
        bytes32 valuationAttUid = _attest(carol, valuationUid, valuationData);
        expectedAcc = _foldAcc(
            expectedAcc, _leaf(4, carol, address(0), valuationAttUid, block.timestamp, keccak256(valuationData))
        );

        // Revocations fold at the revocation block time (warp to make it distinct).
        vm.warp(block.timestamp + 1000);

        _revoke(alice, claimUid, claimAttUid);
        expectedAcc =
            _foldAcc(expectedAcc, _leaf(1, alice, address(0), claimAttUid, block.timestamp, keccak256(claimData)));
        _revoke(bob, responseUid, responseAttUid);
        expectedAcc =
            _foldAcc(expectedAcc, _leaf(3, bob, address(0), responseAttUid, block.timestamp, keccak256(responseData)));
        _revoke(carol, valuationUid, valuationAttUid);
        expectedAcc = _foldAcc(
            expectedAcc, _leaf(5, carol, address(0), valuationAttUid, block.timestamp, keccak256(valuationData))
        );

        assertEq(resolver.acc(), expectedAcc, "acc mismatch after revocation folds");
        assertEq(resolver.leafCount(), 6);
    }

    /*///////////////////////////////////////////////////////////////
                        SCHEMA ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    /// A garbage schema registered by anyone, pointing at the resolver, must revert on attest —
    /// this is what keeps the folded kind tag trustworthy.
    function test_GarbageSchemaAttestationReverts() public {
        bytes32 garbageUid = schemaRegistry.register("uint256 value", resolver, true);
        vm.expectRevert(abi.encodeWithSelector(ContributionResolver.UnknownSchema.selector, garbageUid));
        _attest(alice, garbageUid, abi.encode(uint256(42)));
        assertEq(resolver.leafCount(), 0, "nothing may fold from an unknown schema");
    }

    /// Before setSchemas, every attestation reverts (no edge with an unset allowlist).
    function test_AttestBeforeSetSchemasReverts() public {
        ContributionResolver fresh = new ContributionResolver(IEAS(address(eas)), address(this));
        bytes32 uid = schemaRegistry.register(RESPONSE_SCHEMA, fresh, true);
        vm.expectRevert(ContributionResolver.SchemasNotSet.selector);
        _attest(alice, uid, abi.encode(bytes32(uint256(1)), uint8(1)));
    }

    function test_SetSchemasTwiceReverts() public {
        vm.expectRevert(ContributionResolver.SchemasAlreadySet.selector);
        resolver.setSchemas(claimUid, responseUid, valuationUid);
    }

    function test_SetSchemasOnlyAdmin() public {
        ContributionResolver fresh = new ContributionResolver(IEAS(address(eas)), address(this));
        vm.prank(alice);
        vm.expectRevert(ContributionResolver.NotSchemaAdmin.selector);
        fresh.setSchemas(claimUid, responseUid, valuationUid);
    }

    function test_SetSchemasZeroUidReverts() public {
        ContributionResolver fresh = new ContributionResolver(IEAS(address(eas)), address(this));
        vm.expectRevert(ContributionResolver.ZeroSchemaUid.selector);
        fresh.setSchemas(bytes32(0), responseUid, valuationUid);
        vm.expectRevert(ContributionResolver.ZeroSchemaUid.selector);
        fresh.setSchemas(claimUid, bytes32(0), valuationUid);
        vm.expectRevert(ContributionResolver.ZeroSchemaUid.selector);
        fresh.setSchemas(claimUid, responseUid, bytes32(0));
    }

    function test_SetSchemasDuplicateUidReverts() public {
        ContributionResolver fresh = new ContributionResolver(IEAS(address(eas)), address(this));
        vm.expectRevert(ContributionResolver.DuplicateSchemaUid.selector);
        fresh.setSchemas(claimUid, claimUid, valuationUid);
    }

    function test_ConstructorZeroAdminReverts() public {
        vm.expectRevert(ContributionResolver.NotSchemaAdmin.selector);
        new ContributionResolver(IEAS(address(eas)), address(0));
    }

    /*///////////////////////////////////////////////////////////////
                    ANCHOR ALIASES + INDEXER EVENTS
    //////////////////////////////////////////////////////////////*/

    /// The IAnchorRegistry surface (journal slot B) is a pure alias of the accumulator.
    function test_AnchorRegistryAliasesAccumulator() public {
        assertEq(resolver.anchorAcc(), bytes32(0));
        assertEq(resolver.anchorCount(), 0);

        _attest(alice, claimUid, _claimData());
        _attest(carol, valuationUid, abi.encode(bytes32(uint256(1)), uint8(50)));

        assertEq(resolver.anchorAcc(), resolver.acc(), "anchorAcc must alias acc");
        assertEq(resolver.anchorCount(), resolver.leafCount(), "anchorCount must alias leafCount");
        assertEq(resolver.anchorCount(), 2);
    }

    /// Same indexer events as EASIndexerResolver, so Ponder consumes this resolver generically.
    function test_IndexerEventsEmitted() public {
        vm.expectEmit(false, false, false, false);
        emit AttestationAttested(address(eas), bytes32(0));
        bytes32 uid = _attest(alice, claimUid, _claimData());

        vm.expectEmit(true, true, false, true);
        emit AttestationRevoked(address(eas), uid);
        _revoke(alice, claimUid, uid);
    }
}
