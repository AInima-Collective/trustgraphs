// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";

/// @notice Canonical mixed two-source policy fixtures shared by direct composition contract
///         tests: source 1 is a standard `trust-graph` output and source 2 a
///         `trust-graph-weighted` output.
library CompositionPolicyTestLib {
    uint64 internal constant SCALE = 1e18;

    function standardProgram() internal pure returns (bytes32) {
        return TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID;
    }

    function weightedProgram() internal pure returns (bytes32) {
        return TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID;
    }

    function standardDomain() internal pure returns (bytes32) {
        return TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN;
    }

    function weightedDomain() internal pure returns (bytes32) {
        return TrustComposeValidator.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN;
    }

    function family() internal pure returns (bytes32) {
        return keccak256("weighted-allocation-v1");
    }

    function outputKind() internal pure returns (bytes32) {
        return keccak256("allocation");
    }

    function creationParams(uint64 maxAge) internal pure returns (TrustComposeParamsCodec.Params memory p) {
        p.version = 1;
        p.programId = keccak256("trust-compose");
        p.scopeHash = keccak256("governance-allocation");
        p.identityDomain = keccak256("eip155-address");
        p.outputKind = outputKind();
        p.outputDomain = keccak256("trustgraphs.output.trust-compose-account.v1");
        p.sourceCompatibilityClass = TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS;
        p.weightScale = SCALE;
        p.outputPool = 1_000_000;
        p.maxSources = 8;
        p.maxEntriesPerSource = 4_096;
        p.maxAggregateEntries = 8_192;
        p.maxUnionAccounts = 8_192;
        p.maxAggregateBlobBytes = 1_048_576;
        p.maxSourceAgeBlocks = maxAge;
    }

    function finalParams(
        address accumulator,
        address firstSnapshot,
        address secondSnapshot,
        uint64 maxAge,
        bool rotated
    ) internal view returns (TrustComposeParamsCodec.Params memory p) {
        p = creationParams(maxAge);
        p.sourcePolicyRoot = policyRoot(firstSnapshot, secondSnapshot, maxAge, rotated);
        p.sourceCount = 2;
        p.policyManifestSha256 = sha256(manifest(firstSnapshot, secondSnapshot, maxAge, rotated));
        p.accumulator = accumulator;
        p.chainId = uint64(block.chainid);
    }

    function manifest(address firstSnapshot, address secondSnapshot, uint64 maxAge, bool rotated)
        internal
        view
        returns (bytes memory encoded)
    {
        uint64 firstWeight = rotated ? uint64(4e17) : SCALE / 2;
        uint64 secondWeight = rotated ? uint64(6e17) : SCALE / 2;
        encoded = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        encoded = bytes.concat(
            encoded,
            _record(bytes32(uint256(1)), firstSnapshot, standardProgram(), standardDomain(), firstWeight, maxAge)
        );
        encoded = bytes.concat(
            encoded,
            _record(bytes32(uint256(2)), secondSnapshot, weightedProgram(), weightedDomain(), secondWeight, maxAge)
        );
    }

    function policyRoot(address firstSnapshot, address secondSnapshot, uint64 maxAge, bool rotated)
        internal
        pure
        returns (bytes32)
    {
        uint64 firstWeight = rotated ? uint64(4e17) : SCALE / 2;
        uint64 secondWeight = rotated ? uint64(6e17) : SCALE / 2;
        bytes32 first = keccak256(
            abi.encode(
                bytes32(uint256(1)),
                firstSnapshot,
                family(),
                standardProgram(),
                standardDomain(),
                firstWeight,
                maxAge,
                uint8(1)
            )
        );
        bytes32 second = keccak256(
            abi.encode(
                bytes32(uint256(2)),
                secondSnapshot,
                family(),
                weightedProgram(),
                weightedDomain(),
                secondWeight,
                maxAge,
                uint8(1)
            )
        );
        return first < second ? keccak256(bytes.concat(first, second)) : keccak256(bytes.concat(second, first));
    }

    function _record(
        bytes32 sourceId,
        address snapshot,
        bytes32 programId,
        bytes32 sourceOutputDomain,
        uint64 weight,
        uint64 maxAge
    ) private pure returns (bytes memory) {
        return abi.encodePacked(sourceId, snapshot, family(), programId, sourceOutputDomain, weight, maxAge, uint8(1));
    }
}
