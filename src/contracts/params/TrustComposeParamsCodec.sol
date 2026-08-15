// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title TrustComposeParamsCodec
/// @notice Encoder for the frozen `trust-compose` V1 parameter commitment.
/// @dev Field order and widths mirror `composition_core::codec::params_hash` exactly.
library TrustComposeParamsCodec {
    uint32 internal constant PARAMS_VERSION = 1;

    struct Params {
        uint32 version;
        bytes32 programId;
        bytes32 scopeHash;
        bytes32 identityDomain;
        bytes32 outputKind;
        bytes32 outputDomain;
        bytes32 admittedProgramId;
        uint64 weightScale;
        uint128 outputPool;
        bytes32 sourcePolicyRoot;
        uint8 sourceCount;
        bytes32 policyManifestSha256;
        uint8 maxSources;
        uint32 maxEntriesPerSource;
        uint32 maxAggregateEntries;
        uint32 maxUnionAccounts;
        uint32 maxAggregateBlobBytes;
        uint64 maxSourceAgeBlocks;
        address accumulator;
        uint64 chainId;
    }

    function hash(Params memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                p.version,
                p.programId,
                p.scopeHash,
                p.identityDomain,
                p.outputKind,
                p.outputDomain,
                p.admittedProgramId,
                p.weightScale,
                p.outputPool,
                p.sourcePolicyRoot,
                p.sourceCount,
                p.policyManifestSha256,
                p.maxSources,
                p.maxEntriesPerSource,
                p.maxAggregateEntries,
                p.maxUnionAccounts,
                p.maxAggregateBlobBytes,
                p.maxSourceAgeBlocks,
                p.accumulator,
                p.chainId
            )
        );
    }
}
