// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";

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
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {
    Attestation,
    EMPTY_UID,
    NO_EXPIRATION_TIME
} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {AttestationAccumulator} from "src/eas/AttestationAccumulator.sol";
import {OnchainAttestationImporter} from "src/eas/OnchainAttestationImporter.sol";
import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockSnapshotView} from "test/mocks/MockSnapshotView.sol";

contract OnchainAttestationImporterTest is Test {
    event ImportSkipped(
        bytes32 indexed uid,
        OnchainAttestationImporter.ImportKind indexed kind,
        OnchainAttestationImporter.SkipReason reason
    );

    event ExpirationImported(address indexed eas, bytes32 indexed uid, uint64 timestamp);

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    OnchainAttestationImporter internal importer;

    bytes32 internal schemaUid;
    address internal attester = address(0xA11CE);
    address internal recipient = address(0xB0B);

    function setUp() public {
        vm.warp(10);
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        schemaUid = schemaRegistry.register("string comment,uint256 confidence", ISchemaResolver(address(0)), true);
        importer = new OnchainAttestationImporter(IEAS(address(eas)), schemaUid);
    }

    function _attest(bytes32 schema, address from, address to, uint64 expirationTime, bytes memory data)
        internal
        returns (bytes32 uid)
    {
        vm.prank(from);
        return eas.attest(
            AttestationRequest({
                schema: schema,
                data: AttestationRequestData({
                    recipient: to,
                    expirationTime: expirationTime,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: data,
                    value: 0
                })
            })
        );
    }

    function _revoke(bytes32 schema, address from, bytes32 uid) internal {
        vm.prank(from);
        eas.revoke(RevocationRequest({schema: schema, data: RevocationRequestData({uid: uid, value: 0})}));
    }

    function _one(bytes32 uid) internal pure returns (bytes32[] memory uids) {
        uids = new bytes32[](1);
        uids[0] = uid;
    }

    function _leaf(Attestation memory attestation, uint8 kind, uint256 timestamp) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                kind,
                attestation.attester,
                attestation.recipient,
                attestation.uid,
                timestamp,
                keccak256(attestation.data)
            )
        );
    }

    function _append(bytes32 current, bytes32 leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(current, leaf));
    }

    function test_ConstructorRejectsZeroDependencies() public {
        vm.expectRevert(OnchainAttestationImporter.ZeroEAS.selector);
        new OnchainAttestationImporter(IEAS(address(0)), schemaUid);

        vm.expectRevert(OnchainAttestationImporter.ZeroSchemaUid.selector);
        new OnchainAttestationImporter(IEAS(address(eas)), bytes32(0));
    }

    function test_ImportedLeafIsByteIdenticalToNativeResolverLeaf() public {
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 nativeSchema =
            schemaRegistry.register("bytes32 context,uint256 confidence", ISchemaResolver(address(resolver)), true);
        resolver.bindSchema(nativeSchema);
        OnchainAttestationImporter nativeImporter = new OnchainAttestationImporter(IEAS(address(eas)), nativeSchema);

        vm.warp(1_234);
        bytes32 uid = _attest(nativeSchema, attester, recipient, NO_EXPIRATION_TIME, abi.encode(bytes32("same"), 73));
        assertEq(resolver.leafCount(), 1);

        vm.warp(9_999);
        (uint256 folded, uint256 skipped) = nativeImporter.importAttestations(_one(uid));
        assertEq(folded, 1);
        assertEq(skipped, 0);
        assertEq(nativeImporter.leafCount(), 1);
        assertEq(nativeImporter.acc(), resolver.acc(), "explicit-time leaf drifted from native ABI");
    }

    function test_ReverseImportOrderStillCommitsOriginalTimestamps() public {
        bytes memory oldData = abi.encode("old", uint256(10));
        bytes memory newData = abi.encode("new", uint256(90));

        vm.warp(100);
        bytes32 oldUid = _attest(schemaUid, attester, recipient, 0, oldData);
        vm.warp(200);
        bytes32 newUid = _attest(schemaUid, attester, recipient, 0, newData);

        bytes32[] memory reverse = new bytes32[](2);
        reverse[0] = newUid;
        reverse[1] = oldUid;
        vm.warp(10_000);
        importer.importAttestations(reverse);

        Attestation memory newer = eas.getAttestation(newUid);
        Attestation memory older = eas.getAttestation(oldUid);
        bytes32 expected = _append(bytes32(0), _leaf(newer, 0, 200));
        expected = _append(expected, _leaf(older, 0, 100));
        assertEq(importer.acc(), expected);
        assertEq(importer.leafCount(), 2);

        bytes32 importTimeLeaf = _leaf(newer, 0, 10_000);
        assertNotEq(importTimeLeaf, _leaf(newer, 0, 200), "test must distinguish import time");
    }

    function test_DuplicateBatchAndRetryAreIdempotentAndLegible() public {
        vm.warp(100);
        bytes32 uid = _attest(schemaUid, attester, recipient, 0, abi.encode("once", uint256(50)));

        bytes32[] memory duplicateBatch = new bytes32[](2);
        duplicateBatch[0] = uid;
        duplicateBatch[1] = uid;
        vm.expectEmit(true, true, false, true, address(importer));
        emit ImportSkipped(
            uid,
            OnchainAttestationImporter.ImportKind.Attestation,
            OnchainAttestationImporter.SkipReason.AlreadyProcessed
        );
        (uint256 folded, uint256 skipped) = importer.importAttestations(duplicateBatch);
        assertEq(folded, 1);
        assertEq(skipped, 1);
        bytes32 firstAcc = importer.acc();

        vm.expectEmit(true, true, false, true, address(importer));
        emit ImportSkipped(
            uid,
            OnchainAttestationImporter.ImportKind.Attestation,
            OnchainAttestationImporter.SkipReason.AlreadyProcessed
        );
        (folded, skipped) = importer.importAttestations(_one(uid));
        assertEq(folded, 0);
        assertEq(skipped, 1);
        assertEq(importer.acc(), firstAcc);
        assertEq(importer.leafCount(), 1);
    }

    function test_AlreadyRevokedAttestationBackfillsBothHistoricalTimes() public {
        vm.warp(100);
        bytes32 uid = _attest(schemaUid, attester, recipient, 0, abi.encode("revoked", uint256(25)));
        vm.warp(150);
        _revoke(schemaUid, attester, uid);

        vm.warp(1_000);
        vm.expectRevert(abi.encodeWithSelector(OnchainAttestationImporter.AttestationNotProcessed.selector, uid));
        importer.importRevocations(_one(uid));

        importer.importAttestations(_one(uid));
        importer.importRevocations(_one(uid));

        Attestation memory attestation = eas.getAttestation(uid);
        bytes32 expected = _append(bytes32(0), _leaf(attestation, 0, 100));
        expected = _append(expected, _leaf(attestation, 1, 150));
        assertEq(importer.acc(), expected);
        assertEq(importer.leafCount(), 2);
        assertTrue(importer.attestationsProcessed(uid));
        assertTrue(importer.revocationsProcessed(uid));
    }

    function test_ZeroRecipientIsPermanentlyProcessedWithoutAGraphLeaf() public {
        vm.warp(100);
        bytes32 uid = _attest(schemaUid, attester, address(0), 0, abi.encode("profile only"));

        vm.expectEmit(true, true, false, true, address(importer));
        emit ImportSkipped(
            uid, OnchainAttestationImporter.ImportKind.Attestation, OnchainAttestationImporter.SkipReason.ZeroRecipient
        );
        (uint256 folded, uint256 skipped) = importer.importAttestations(_one(uid));
        assertEq(folded, 0);
        assertEq(skipped, 1);
        assertTrue(importer.attestationsProcessed(uid));
        assertTrue(importer.zeroRecipientSkipped(uid));
        assertEq(importer.leafCount(), 0);
        assertEq(importer.acc(), bytes32(0));

        vm.warp(120);
        _revoke(schemaUid, attester, uid);
        vm.expectEmit(true, true, false, true, address(importer));
        emit ImportSkipped(
            uid, OnchainAttestationImporter.ImportKind.Revocation, OnchainAttestationImporter.SkipReason.ZeroRecipient
        );
        (folded, skipped) = importer.importRevocations(_one(uid));
        assertEq(folded, 0);
        assertEq(skipped, 1);
        assertTrue(importer.revocationsProcessed(uid));
        assertEq(importer.leafCount(), 0);
    }

    function test_ForeignOrMissingUidRevertsAtomically() public {
        vm.warp(100);
        bytes32 validUid = _attest(schemaUid, attester, recipient, 0, abi.encode("valid"));
        bytes32 foreignSchema = schemaRegistry.register("bytes32 unrelated", ISchemaResolver(address(0)), true);
        bytes32 foreignUid = _attest(foreignSchema, attester, recipient, 0, abi.encode(bytes32("x")));

        bytes32[] memory mixed = new bytes32[](2);
        mixed[0] = validUid;
        mixed[1] = foreignUid;
        vm.expectRevert(
            abi.encodeWithSelector(
                OnchainAttestationImporter.ForeignSchema.selector, foreignUid, foreignSchema, schemaUid
            )
        );
        importer.importAttestations(mixed);
        assertFalse(importer.attestationsProcessed(validUid), "reverted batch partially committed");
        assertEq(importer.leafCount(), 0);

        vm.expectRevert(abi.encodeWithSelector(OnchainAttestationImporter.AttestationNotFound.selector, bytes32(0)));
        importer.importAttestations(_one(bytes32(0)));

        bytes32 missing = keccak256("missing");
        vm.expectRevert(abi.encodeWithSelector(OnchainAttestationImporter.AttestationNotFound.selector, missing));
        importer.importAttestations(_one(missing));
    }

    function test_ExpirationRequiresMaturityAndDoesNotSuppressExplicitRevocation() public {
        vm.warp(100);
        uint64 expirationTime = 150;
        bytes32 uid = _attest(schemaUid, attester, recipient, expirationTime, abi.encode("temporary", uint256(40)));
        importer.importAttestations(_one(uid));

        vm.warp(149);
        vm.expectRevert(
            abi.encodeWithSelector(
                OnchainAttestationImporter.ExpirationNotReached.selector, uid, expirationTime, uint256(149)
            )
        );
        importer.importExpirations(_one(uid));

        vm.warp(expirationTime);
        vm.expectEmit(true, true, false, true, address(importer));
        emit ExpirationImported(address(eas), uid, expirationTime);
        (uint256 folded, uint256 skipped) = importer.importExpirations(_one(uid));
        assertEq(folded, 1);
        assertEq(skipped, 0);
        assertTrue(importer.expirationsProcessed(uid));

        vm.warp(175);
        _revoke(schemaUid, attester, uid);
        importer.importRevocations(_one(uid));
        assertTrue(importer.revocationsProcessed(uid));
        assertEq(importer.leafCount(), 3, "attest, expiration and explicit revoke are distinct facts");

        Attestation memory attestation = eas.getAttestation(uid);
        bytes32 expected = _append(bytes32(0), _leaf(attestation, 0, 100));
        expected = _append(expected, _leaf(attestation, 1, expirationTime));
        expected = _append(expected, _leaf(attestation, 1, 175));
        assertEq(importer.acc(), expected);

        (folded, skipped) = importer.importExpirations(_one(uid));
        assertEq(folded, 0);
        assertEq(skipped, 1);
        assertEq(importer.leafCount(), 3);
    }

    function test_NonExpiringAttestationCannotImportExpiration() public {
        vm.warp(100);
        bytes32 uid = _attest(schemaUid, attester, recipient, 0, abi.encode("forever"));
        importer.importAttestations(_one(uid));

        vm.expectRevert(abi.encodeWithSelector(OnchainAttestationImporter.AttestationDoesNotExpire.selector, uid));
        importer.importExpirations(_one(uid));
    }

    function test_ImporterUsesTheStandardSnapshotBindingAndCheckpointSurface() public {
        vm.warp(100);
        bytes32 uid = _attest(schemaUid, attester, recipient, 0, abi.encode("checkpoint"));
        importer.importAttestations(_one(uid));

        vm.expectRevert(AttestationAccumulator.NotSnapshot.selector);
        importer.checkpoint();

        MockSnapshotView snapshot = new MockSnapshotView(address(importer));
        importer.bindSnapshot(address(snapshot));
        vm.roll(4242);
        uint256 id = snapshot.mint(address(importer));

        assertEq(id, 0);
        assertEq(importer.snapshot(), address(snapshot));
        assertEq(importer.checkpointCount(), 1);
        IAttestationAccumulator.Checkpoint memory checkpoint = importer.getCheckpoint(id);
        assertEq(checkpoint.acc, importer.acc());
        assertEq(checkpoint.leafCount, 1);
        assertEq(checkpoint.blockNumber, 4242);
    }
}
