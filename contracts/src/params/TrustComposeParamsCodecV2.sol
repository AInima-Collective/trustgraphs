// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title TrustComposeParamsCodecV2
/// @notice Encoder for the frozen `trust-compose` V2 parameter commitment.
/// @dev Field order and widths mirror `composition_core_v2::codec::params_hash` exactly. The
///      tuple keeps V1's 20 static words so generic tooling can distinguish versions before
///      selecting a semantic decoder; word 6 is the source compatibility class and must never be
///      exposed under the V1 `admittedProgramId` name after version dispatch.
library TrustComposeParamsCodecV2 {
    uint32 internal constant PARAMS_VERSION = 2;

    struct Params {
        uint32 version;
        bytes32 programId;
        bytes32 scopeHash;
        bytes32 identityDomain;
        bytes32 outputKind;
        bytes32 outputDomain;
        bytes32 sourceCompatibilityClass;
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
                p.sourceCompatibilityClass,
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
