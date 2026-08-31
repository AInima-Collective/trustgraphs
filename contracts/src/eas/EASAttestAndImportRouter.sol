// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {
    IEAS,
    DelegatedAttestationRequest,
    MultiDelegatedAttestationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

import {OnchainAttestationImporter} from "src/eas/OnchainAttestationImporter.sol";

/// @title EASAttestAndImportRouter
/// @notice Atomically creates delegated EAS attestations and imports their returned UIDs.
/// @dev A plain `EAS.attest` call from a router would record this contract as the attester. EAS's
///      delegated entry points preserve the signer's identity while allowing this contract to
///      receive the UID and close the importer gap in the same transaction. Every dependency and
///      accepted schema is immutable; the router has no owner, approvals, or retained value.
contract EASAttestAndImportRouter {
    IEAS public immutable EAS;
    OnchainAttestationImporter public immutable IMPORTER;
    bytes32 public immutable SCHEMA_UID;

    event AttestedAndImported(bytes32 indexed uid, address indexed attester, address indexed recipient);
    event AttestedBatchAndImported(address indexed attester, uint256 count);

    error ZeroEAS();
    error ZeroImporter();
    error ZeroSchemaUid();
    error MismatchedImporter();
    error ForeignSchema(bytes32 supplied, bytes32 expected);
    error EmptyBatch();

    constructor(IEAS eas, OnchainAttestationImporter importer, bytes32 schemaUid) {
        if (address(eas) == address(0)) revert ZeroEAS();
        if (address(importer) == address(0)) revert ZeroImporter();
        if (schemaUid == bytes32(0)) revert ZeroSchemaUid();
        if (address(importer.EAS()) != address(eas) || importer.schemaUid() != schemaUid) {
            revert MismatchedImporter();
        }
        EAS = eas;
        IMPORTER = importer;
        SCHEMA_UID = schemaUid;
    }

    /// @notice Create one signer-authenticated attestation and import it atomically.
    /// @param request The standard EAS delegated request signed over EAS's own EIP-712 domain.
    function attestAndImport(DelegatedAttestationRequest calldata request) external payable returns (bytes32 uid) {
        _requireSchema(request.schema);
        uid = EAS.attestByDelegation{value: msg.value}(request);

        bytes32[] memory uids = new bytes32[](1);
        uids[0] = uid;
        IMPORTER.importAttestations(uids);
        emit AttestedAndImported(uid, request.attester, request.data.recipient);
    }

    /// @notice Create a schema-grouped delegated EAS batch and import every returned UID atomically.
    /// @dev This lane accepts one schema, so every group must name the same immutable UID. EAS still
    ///      receives the standard grouped shape and enforces its increasing signer nonces.
    function multiAttestAndImport(MultiDelegatedAttestationRequest[] calldata requests)
        external
        payable
        returns (bytes32[] memory uids)
    {
        uint256 requestCount = requests.length;
        if (requestCount == 0) revert EmptyBatch();
        for (uint256 i; i < requestCount; ++i) {
            _requireSchema(requests[i].schema);
        }

        uids = EAS.multiAttestByDelegation{value: msg.value}(requests);
        IMPORTER.importAttestations(uids);

        // One imported lane has one schema, but EAS's grouped API can still contain several
        // groups. Emit one compact discovery marker per group rather than duplicating every UID;
        // the importer emits the authoritative UID-level records.
        for (uint256 i; i < requestCount; ++i) {
            emit AttestedBatchAndImported(requests[i].attester, requests[i].data.length);
        }
    }

    function _requireSchema(bytes32 supplied) private view {
        bytes32 expected = SCHEMA_UID;
        if (supplied != expected) revert ForeignSchema(supplied, expected);
    }
}
