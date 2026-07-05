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
contract EASIndexerResolver is SchemaResolver, AttestationAccumulator {
    /// @notice Creates a new EASIndexerResolver instance.
    /// @param eas The EAS contract instance.
    constructor(IEAS eas) SchemaResolver(eas) {}

    /// @notice Indexes the attestation upon creation and folds it into the accumulator.
    /// @param attestation The new attestation.
    /// @return Whether the attestation is valid and was successfully indexed.
    function onAttest(Attestation calldata attestation, uint256 /*value*/ ) internal override returns (bool) {
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
    function onRevoke(Attestation calldata attestation, uint256 /*value*/ ) internal override returns (bool) {
        // Emit the attestation revoked event for off-chain indexers
        emit AttestationRevoked(address(_eas), attestation.uid);

        // Fold the revocation into the chained-hash accumulator (kind 1 = revoke).
        _fold(1, attestation.attester, attestation.recipient, attestation.uid, keccak256(attestation.data));

        return true;
    }
}
