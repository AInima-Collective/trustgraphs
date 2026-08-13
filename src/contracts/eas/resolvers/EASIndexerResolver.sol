// SPDX-License-Identifier: MIT

pragma solidity 0.8.27;

import {IEAS, Attestation} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import {AttestationAttested, AttestationRevoked} from "../../../interfaces/IIndexedEvents.sol";
import {AttestationAccumulator} from "../AttestationAccumulator.sol";

/// @title EASIndexerResolver
/// @notice A schema resolver that automatically indexes attestations upon creation and folds every
///         edge into a chained-hash accumulator, so the chain holds a trustless commitment to
///         exactly which edges existed at snapshot time (see AttestationAccumulator).
/// @dev This is the single-schema resolver that feeds Trust-Aware PageRank, and therefore the sole
///      accumulator (ZK_ARCHITECTURE.md §3.2). Alternate resolvers do NOT inherit the accumulator.
///
///      SINGLE-SCHEMA IS ENFORCED, not assumed. The EAS binding is one-way: a schema names its
///      resolver, a resolver does not name its schema, so without `bindSchema` this contract folds
///      *every* attestation EAS routes to it. Anyone could register a second schema pointing at a
///      live instance's resolver, attest against it, and land an edge in that instance's `acc` —
///      which permanently breaks proving, because the guest must re-fold every leaf while
///      `input-exporter` only ever collects candidates for the instance's own `schema_uid`. The
///      chained accumulator carries the poison into every later checkpoint, so recovery means a new
///      resolver and the loss of all vouch history. One attestation, any stranger, unrecoverable.
///
///      A permissionless factory turns that from "one resolver we control" into "one per
///      community", so the binding is enforced here rather than left as a deployment convention.
contract EASIndexerResolver is SchemaResolver, AttestationAccumulator {
    /// @notice The one schema this resolver accepts. Zero until bound.
    bytes32 public boundSchema;

    /// @notice Emitted once, when the resolver is bound to its schema.
    event SchemaBound(bytes32 indexed schemaUid);

    /// @notice `bindSchema` was called a second time, or with the zero UID.
    error SchemaAlreadyBound();
    /// @notice An attestation arrived for a schema this resolver is not the accumulator for.
    error ForeignSchema(bytes32 schemaUid, bytes32 expected);

    /// @notice Creates a new EASIndexerResolver instance.
    /// @param eas The EAS contract instance.
    constructor(IEAS eas) SchemaResolver(eas) {}

    /// @notice Bind this resolver to its vouching schema. Callable exactly once, by anyone.
    /// @dev Permissionless and one-shot on purpose. The schema UID commits to this resolver's own
    ///      address (`keccak256(schema, resolver, revocable)`), so the caller cannot choose a UID
    ///      that belongs to anyone else's instance — there is nothing here worth gating, and an
    ///      owner would be one more thing to lose. Until it is bound the resolver accepts
    ///      everything, exactly as before, so the deployment sequence
    ///      (deploy resolver → register schema → bind) is unchanged apart from the last step.
    ///      `TrustgraphsFactory` does all three in one transaction, leaving no unbound window.
    function bindSchema(bytes32 schemaUid) external {
        if (boundSchema != bytes32(0) || schemaUid == bytes32(0)) revert SchemaAlreadyBound();
        boundSchema = schemaUid;
        emit SchemaBound(schemaUid);
    }

    /// @dev Reverts unless the attestation belongs to the bound schema. A revert here makes the
    ///      EAS call fail, so the foreign edge is never folded — the fold is the thing that has to
    ///      be protected, since `acc` is a chained hash with no way to remove an entry.
    function _requireBoundSchema(bytes32 schemaUid) private view {
        bytes32 bound = boundSchema;
        if (bound != bytes32(0) && schemaUid != bound) revert ForeignSchema(schemaUid, bound);
    }

    /// @notice Indexes the attestation upon creation and folds it into the accumulator.
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
        _requireBoundSchema(attestation.schema);

        // Emitted so off-chain indexers can consume attestation events generically.
        emit IEAS.Attested(attestation.recipient, attestation.attester, attestation.uid, attestation.schema);

        // Emit the attestation indexed event for off-chain indexers
        emit AttestationAttested(address(_eas), attestation.uid);

        // Fold the edge into the chained-hash accumulator (kind 0 = attest).
        _fold(0, attestation.attester, attestation.recipient, attestation.uid, keccak256(attestation.data));

        return true;
    }

    /// @notice Handles attestation revocation and folds the revocation into the accumulator.
    /// @return Whether the attestation can be revoked.
    function onRevoke(
        Attestation calldata attestation,
        uint256 /*value*/
    )
        internal
        override
        returns (bool)
    {
        _requireBoundSchema(attestation.schema);

        // Emit the attestation revoked event for off-chain indexers
        emit AttestationRevoked(address(_eas), attestation.uid);

        // Fold the revocation into the chained-hash accumulator (kind 1 = revoke).
        _fold(1, attestation.attester, attestation.recipient, attestation.uid, keccak256(attestation.data));

        return true;
    }
}
