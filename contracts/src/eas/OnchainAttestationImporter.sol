// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

import {AttestationAttested, AttestationRevoked} from "interfaces/IIndexedEvents.sol";
import {AttestationAccumulator} from "src/eas/AttestationAccumulator.sol";

/// @title OnchainAttestationImporter
/// @notice Permissionlessly folds attestations from one existing on-chain EAS schema into a
///         Trustgraphs-compatible accumulator.
/// @dev Callers select which UIDs to process and when, but never supply an edge field. The contract
///      reads the complete record from immutable EAS storage and folds its original attestation,
///      revocation, or expiration timestamp. This preserves the guest's reconciliation order even
///      when historical UIDs are imported in an adversarial order.
///
///      Processing is idempotent per operation. A resumable backfill can retry an overlapping batch
///      without reverting or appending duplicate leaves. Invalid, missing, or foreign-schema UIDs do
///      revert the whole batch: silently accepting one would make a claimed backfill look complete
///      when it was not. Zero-recipient records are the one intentional non-leaf outcome; they are
///      permanently marked processed and surfaced through `ImportSkipped`.
///
///      This accumulator authenticates every INCLUDED record, but cannot prove that callers selected
///      every record in the schema. Checkpoint coverage therefore depends on external backfill/sweep
///      policy; the on-chain soundness claim is exactly the processed leaf set.
contract OnchainAttestationImporter is AttestationAccumulator {
    /// @notice The operation whose retry was skipped or whose zero-recipient record was ignored.
    enum ImportKind {
        Attestation,
        Revocation,
        Expiration
    }

    /// @notice Why one requested UID produced no new accumulator leaf.
    enum SkipReason {
        AlreadyProcessed,
        ZeroRecipient
    }

    /// @notice The immutable EAS storage contract from which every imported field is read.
    IEAS public immutable EAS;

    /// @notice The only EAS schema this accumulator accepts.
    /// @dev Unlike a resolver-created schema, this UID is known before importer deployment, so a
    ///      constructor immutable avoids the front-running window of a post-deploy one-shot setter.
    bytes32 public immutable schemaUid;

    /// @notice Whether the attestation operation for a UID has been handled (folded or zero-skipped).
    mapping(bytes32 uid => bool processed) public attestationsProcessed;

    /// @notice Whether the explicit EAS revocation operation for a UID has been handled.
    mapping(bytes32 uid => bool processed) public revocationsProcessed;

    /// @notice Whether the time-based expiration operation for a UID has been handled.
    /// @dev Kept separate from `revocationsProcessed`: both fold kind 1, but suppressing one with the
    ///      other would let caller order choose which authenticated timestamp enters the log.
    mapping(bytes32 uid => bool processed) public expirationsProcessed;

    /// @notice Whether the attestation was deliberately processed without a leaf due to no recipient.
    mapping(bytes32 uid => bool skippedZeroRecipient) public zeroRecipientSkipped;

    /// @notice A stored EAS attestation was folded with its original creation timestamp.
    event AttestationImported(bytes32 indexed uid, uint64 timestamp);

    /// @notice A stored EAS revocation was folded with its original revocation timestamp.
    event RevocationImported(bytes32 indexed uid, uint64 timestamp);

    /// @notice An elapsed EAS expiration was represented by a revoke leaf at `expirationTime`.
    /// @dev This is intentionally distinct from `AttestationRevoked`: EAS storage's
    ///      `revocationTime` may be zero or different, so an indexer must not mistake one for the
    ///      other when reconstructing the leaf preimage.
    event ExpirationImported(address indexed eas, bytes32 indexed uid, uint64 timestamp);

    /// @notice A requested operation was an idempotent retry or an intentional zero-recipient skip.
    event ImportSkipped(bytes32 indexed uid, ImportKind indexed kind, SkipReason reason);

    error ZeroEAS();
    error ZeroSchemaUid();
    error AttestationNotFound(bytes32 uid);
    error ForeignSchema(bytes32 uid, bytes32 found, bytes32 expected);
    error AttestationNotProcessed(bytes32 uid);
    error AttestationNotRevoked(bytes32 uid);
    error AttestationDoesNotExpire(bytes32 uid);
    error ExpirationNotReached(bytes32 uid, uint64 expirationTime, uint256 currentTime);

    /// @param eas The canonical EAS contract that stores the source attestations.
    /// @param importedSchemaUid The one existing schema whose records this instance accepts.
    constructor(IEAS eas, bytes32 importedSchemaUid) {
        if (address(eas) == address(0)) revert ZeroEAS();
        if (importedSchemaUid == bytes32(0)) revert ZeroSchemaUid();
        EAS = eas;
        schemaUid = importedSchemaUid;
    }

    /// @notice Import stored attestations, folding one kind-0 leaf per nonzero recipient.
    /// @return folded Number of new accumulator leaves appended.
    /// @return skipped Number of already-processed or zero-recipient UIDs skipped.
    function importAttestations(bytes32[] calldata uids) external returns (uint256 folded, uint256 skipped) {
        uint256 length = uids.length;
        for (uint256 i; i < length; ++i) {
            bytes32 uid = uids[i];
            if (attestationsProcessed[uid]) {
                emit ImportSkipped(uid, ImportKind.Attestation, SkipReason.AlreadyProcessed);
                ++skipped;
                continue;
            }

            Attestation memory attestation = _load(uid);
            attestationsProcessed[uid] = true;

            if (attestation.recipient == address(0)) {
                zeroRecipientSkipped[uid] = true;
                emit ImportSkipped(uid, ImportKind.Attestation, SkipReason.ZeroRecipient);
                ++skipped;
                continue;
            }

            // Match the native resolver's discovery surface for ordinary attest leaves.
            emit IEAS.Attested(attestation.recipient, attestation.attester, attestation.uid, attestation.schema);
            emit AttestationAttested(address(EAS), uid);
            _foldAt(0, attestation.attester, attestation.recipient, uid, attestation.time, keccak256(attestation.data));
            emit AttestationImported(uid, attestation.time);
            ++folded;
        }
    }

    /// @notice Import explicit EAS revocations for attestations already processed by this importer.
    /// @dev Already-revoked historical attestations remain importable: first import the attestation,
    ///      then call this function. EAS storage supplies the original nonzero revocation timestamp.
    /// @return folded Number of new accumulator leaves appended.
    /// @return skipped Number of already-processed or zero-recipient UIDs skipped.
    function importRevocations(bytes32[] calldata uids) external returns (uint256 folded, uint256 skipped) {
        uint256 length = uids.length;
        for (uint256 i; i < length; ++i) {
            bytes32 uid = uids[i];
            if (revocationsProcessed[uid]) {
                emit ImportSkipped(uid, ImportKind.Revocation, SkipReason.AlreadyProcessed);
                ++skipped;
                continue;
            }

            Attestation memory attestation = _load(uid);
            if (!attestationsProcessed[uid]) revert AttestationNotProcessed(uid);
            if (attestation.revocationTime == 0) revert AttestationNotRevoked(uid);
            revocationsProcessed[uid] = true;

            if (attestation.recipient == address(0)) {
                emit ImportSkipped(uid, ImportKind.Revocation, SkipReason.ZeroRecipient);
                ++skipped;
                continue;
            }

            emit AttestationRevoked(address(EAS), uid);
            _foldAt(
                1,
                attestation.attester,
                attestation.recipient,
                uid,
                attestation.revocationTime,
                keccak256(attestation.data)
            );
            emit RevocationImported(uid, attestation.revocationTime);
            ++folded;
        }
    }

    /// @notice Fold elapsed EAS expirations as kind-1 leaves at their authenticated expiration time.
    /// @dev Time passing cannot append a leaf by itself. This permissionless operation makes expiry
    ///      explicit without conflating it with EAS's independently stored `revocationTime`.
    /// @return folded Number of new accumulator leaves appended.
    /// @return skipped Number of already-processed or zero-recipient UIDs skipped.
    function importExpirations(bytes32[] calldata uids) external returns (uint256 folded, uint256 skipped) {
        uint256 length = uids.length;
        for (uint256 i; i < length; ++i) {
            bytes32 uid = uids[i];
            if (expirationsProcessed[uid]) {
                emit ImportSkipped(uid, ImportKind.Expiration, SkipReason.AlreadyProcessed);
                ++skipped;
                continue;
            }

            Attestation memory attestation = _load(uid);
            if (!attestationsProcessed[uid]) revert AttestationNotProcessed(uid);
            uint64 expirationTime = attestation.expirationTime;
            if (expirationTime == 0) revert AttestationDoesNotExpire(uid);
            // Timestamp comparison is the intended EAS expiration boundary. A block producer can
            // move it only within the chain's normal timestamp tolerance; the folded value remains
            // the immutable EAS expirationTime, never the block timestamp.
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < expirationTime) {
                revert ExpirationNotReached(uid, expirationTime, block.timestamp);
            }
            expirationsProcessed[uid] = true;

            if (attestation.recipient == address(0)) {
                emit ImportSkipped(uid, ImportKind.Expiration, SkipReason.ZeroRecipient);
                ++skipped;
                continue;
            }

            _foldAt(1, attestation.attester, attestation.recipient, uid, expirationTime, keccak256(attestation.data));
            emit ExpirationImported(address(EAS), uid, expirationTime);
            ++folded;
        }
    }

    /// @dev Read and authenticate one source record. EAS returns an all-zero struct for an unknown
    ///      UID, so checking the stored UID before the schema distinguishes absence from a foreign
    ///      record. The external call is `STATICCALL`; no source contract can re-enter these writes.
    function _load(bytes32 uid) private view returns (Attestation memory attestation) {
        attestation = EAS.getAttestation(uid);
        if (uid == bytes32(0) || attestation.uid != uid) revert AttestationNotFound(uid);
        if (attestation.schema != schemaUid) {
            revert ForeignSchema(uid, attestation.schema, schemaUid);
        }
    }
}
