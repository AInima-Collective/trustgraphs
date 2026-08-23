// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";

/// @notice Canonical two-source policy fixtures shared by direct composition contract tests.
library CompositionPolicyTestLib {
    uint64 internal constant SCALE = 1e18;

    function sourceProgram() internal pure returns (bytes32) {
        return keccak256("trust-graph-weighted");
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
        p.admittedProgramId = sourceProgram();
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
        encoded = bytes.concat(encoded, _record(bytes32(uint256(1)), firstSnapshot, firstWeight, maxAge));
        encoded = bytes.concat(encoded, _record(bytes32(uint256(2)), secondSnapshot, secondWeight, maxAge));
    }

    function policyRoot(address firstSnapshot, address secondSnapshot, uint64 maxAge, bool rotated)
        internal
        pure
        returns (bytes32)
    {
        uint64 firstWeight = rotated ? uint64(4e17) : SCALE / 2;
        uint64 secondWeight = rotated ? uint64(6e17) : SCALE / 2;
        bytes32 first = keccak256(
            abi.encode(bytes32(uint256(1)), firstSnapshot, family(), sourceProgram(), firstWeight, maxAge, uint8(1))
        );
        bytes32 second = keccak256(
            abi.encode(bytes32(uint256(2)), secondSnapshot, family(), sourceProgram(), secondWeight, maxAge, uint8(1))
        );
        return first < second ? keccak256(bytes.concat(first, second)) : keccak256(bytes.concat(second, first));
    }

    function _record(bytes32 sourceId, address snapshot, uint64 weight, uint64 maxAge)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(sourceId, snapshot, family(), sourceProgram(), weight, maxAge, uint8(1));
    }
}
