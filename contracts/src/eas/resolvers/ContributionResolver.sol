// SPDX-License-Identifier: MIT

pragma solidity 0.8.27;

import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {AttestationAttested, AttestationRevoked} from "../../interfaces/IIndexedEvents.sol";
import {AttestationAccumulator} from "../AttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";

/// @title ContributionResolver
/// @notice The contributions program's resolver + accumulator (research/operations/contributions/interfaces.md):
///         one resolver serving all three contribution schemas (claim / response / valuation),
///         folding every attestation and revocation into a single chained-hash accumulator with the
///         schema discriminated in the leaf's `kind` byte:
///
///             kind = schemaIndex * 2 + isRevoke   (INTERFACES.md §2)
///
///         schemaIndex 0 = claim, 1 = response, 2 = valuation. The leaf ABI is identical to the
///         trust accumulator's (`AttestationAccumulator._fold`); only the `kind` domain is new, and
///         it is per-accumulator-instance, so nothing existing changes.
///
///         Unlike the open-vouching `EASIndexerResolver` (which tolerates garbage schemas because
///         every edge is just another vouch), the kind tag here carries semantics, so it must be
///         trustworthy: anyone can register a garbage schema pointing at any resolver. This
///         resolver therefore holds an allowlist of exactly three schema UIDs, set once
///         post-registration (`setSchemas`), and REVERTS attestations from any other schema — and
///         all attestations before the allowlist is set.
/// @dev Also implements `IAnchorRegistry` by aliasing its own accumulator: the contributions
///      `MerkleSnapshot` reads this contract as its lane-2 `anchorRegistry`, so `trigger()`
///      freezes the contribution log as the journal's `(anchorAcc, anchorCount)` slot (slot B)
///      while lane 1 (slot A) carries the trust accumulator via `TrustAccumulatorMirror`
///      (INTERFACES.md §4). One log, two read surfaces — no second fold.
contract ContributionResolver is SchemaResolver, AttestationAccumulator, IAnchorRegistry {
    /// @notice The only address that may call `setSchemas` (one shot; see `schemasSet`).
    address public immutable schemaAdmin;

    /// @notice Whether the schema allowlist has been set (it can only ever be set once).
    bool public schemasSet;

    /// @notice Schema UID of `contribution.claim` (schemaIndex 0; kinds 0/1).
    bytes32 public claimSchemaUid;

    /// @notice Schema UID of `contribution.response` (schemaIndex 1; kinds 2/3).
    bytes32 public responseSchemaUid;

    /// @notice Schema UID of `contribution.valuation` (schemaIndex 2; kinds 4/5).
    bytes32 public valuationSchemaUid;

    /// @notice Emitted when the one-shot schema allowlist is set.
    event SchemasSet(bytes32 claimSchemaUid, bytes32 responseSchemaUid, bytes32 valuationSchemaUid);

    /// @notice `setSchemas` caller is not the designated schema admin.
    error NotSchemaAdmin();

    /// @notice The schema allowlist has already been set; it is immutable thereafter.
    error SchemasAlreadySet();

    /// @notice Attestation received before the schema allowlist was set.
    error SchemasNotSet();

    /// @notice A schema UID in the allowlist must be nonzero.
    error ZeroSchemaUid();

    /// @notice The three allowlisted schema UIDs must be distinct.
    error DuplicateSchemaUid();

    /// @notice Attestation from a schema outside the allowlist.
    error UnknownSchema(bytes32 schemaUid);

    /// @notice Creates a new ContributionResolver instance.
    /// @param eas The EAS contract instance.
    /// @param _schemaAdmin The address allowed to set the schema allowlist once (the deployer in
    ///        practice: schema UIDs depend on this resolver's address, so they cannot be known at
    ///        construction — registration must happen after deployment).
    constructor(IEAS eas, address _schemaAdmin) SchemaResolver(eas) {
        if (_schemaAdmin == address(0)) {
            revert NotSchemaAdmin();
        }
        schemaAdmin = _schemaAdmin;
    }

    /// @notice Set the schema allowlist. Callable exactly once, only by `schemaAdmin`. Until this
    ///         is called every attestation reverts, so no edge with an untrusted kind tag can ever
    ///         enter the accumulator.
    /// @param claimUid The registered `contribution.claim` schema UID.
    /// @param responseUid The registered `contribution.response` schema UID.
    /// @param valuationUid The registered `contribution.valuation` schema UID.
    function setSchemas(bytes32 claimUid, bytes32 responseUid, bytes32 valuationUid) external {
        if (msg.sender != schemaAdmin) {
            revert NotSchemaAdmin();
        }
        if (schemasSet) {
            revert SchemasAlreadySet();
        }
        if (claimUid == bytes32(0) || responseUid == bytes32(0) || valuationUid == bytes32(0)) {
            revert ZeroSchemaUid();
        }
        if (claimUid == responseUid || claimUid == valuationUid || responseUid == valuationUid) {
            revert DuplicateSchemaUid();
        }

        schemasSet = true;
        claimSchemaUid = claimUid;
        responseSchemaUid = responseUid;
        valuationSchemaUid = valuationUid;

        emit SchemasSet(claimUid, responseUid, valuationUid);
    }

    /// @notice Indexes the attestation and folds it with `kind = schemaIndex * 2`.
    /// @param attestation The new attestation.
    /// @return Whether the attestation is valid and was successfully indexed.
    function onAttest(
        Attestation calldata attestation,
        uint256 /*value*/
    )
        internal
        override
        returns (bool)
    {
        uint8 schemaIndex = _schemaIndex(attestation.schema);

        // Emitted so off-chain indexers can consume attestation events generically (same events as
        // EASIndexerResolver, so Ponder's existing handlers apply).
        emit IEAS.Attested(attestation.recipient, attestation.attester, attestation.uid, attestation.schema);
        emit AttestationAttested(address(_eas), attestation.uid);

        // Fold with the schema-tagged kind. `recipient` is folded as EAS delivers it; the guest
        // does not consume it in v1 (attribution comes from the claim payload's `contributors`).
        _fold(
            schemaIndex * 2, attestation.attester, attestation.recipient, attestation.uid, keccak256(attestation.data)
        );

        return true;
    }

    /// @notice Handles revocation and folds it with `kind = schemaIndex * 2 + 1`.
    /// @return Whether the attestation can be revoked.
    function onRevoke(
        Attestation calldata attestation,
        uint256 /*value*/
    )
        internal
        override
        returns (bool)
    {
        uint8 schemaIndex = _schemaIndex(attestation.schema);

        // Emit the attestation revoked event for off-chain indexers
        emit AttestationRevoked(address(_eas), attestation.uid);

        // Fold the revocation into the chained-hash accumulator.
        _fold(
            schemaIndex * 2 + 1,
            attestation.attester,
            attestation.recipient,
            attestation.uid,
            keccak256(attestation.data)
        );

        return true;
    }

    /*///////////////////////////////////////////////////////////////
                    IAnchorRegistry (journal slot B)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnchorRegistry
    /// @dev Alias of `acc`: the contribution accumulator IS the contributions instance's lane-2
    ///      log, read by `MerkleSnapshot.trigger()` at each epoch boundary.
    function anchorAcc() external view returns (bytes32) {
        return acc;
    }

    /// @inheritdoc IAnchorRegistry
    /// @dev Alias of `leafCount` (see `anchorAcc`).
    function anchorCount() external view returns (uint64) {
        return leafCount;
    }

    /// @notice Map a schema UID to its allowlist index, reverting for anything not allowlisted.
    /// @dev The revert (rather than a tolerant skip) is what makes the folded kind tag
    ///      trustworthy: no attestation from an unknown schema can reach `_fold`.
    function _schemaIndex(bytes32 schemaUid) internal view returns (uint8) {
        if (!schemasSet) {
            revert SchemasNotSet();
        }
        if (schemaUid == claimSchemaUid) {
            return 0;
        }
        if (schemaUid == responseSchemaUid) {
            return 1;
        }
        if (schemaUid == valuationSchemaUid) {
            return 2;
        }
        revert UnknownSchema(schemaUid);
    }
}
