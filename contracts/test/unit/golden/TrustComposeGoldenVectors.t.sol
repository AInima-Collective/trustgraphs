// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";

contract TrustComposeParamsCodecHarness {
    function hash(TrustComposeParamsCodec.Params calldata params) external pure returns (bytes32) {
        TrustComposeParamsCodec.Params memory copy = params;
        return TrustComposeParamsCodec.hash(copy);
    }
}

/// @notice Independent Solidity byte lock for `trust-compose` params, capture, output, journal,
///         and the closed source compatibility class.
contract TrustComposeGoldenVectorsTest is Test {
    using stdJson for string;

    string internal json;
    TrustComposeParamsCodecHarness internal codec;

    function setUp() public {
        json = vm.readFile("tests/golden/trust-compose.json");
        codec = new TrustComposeParamsCodecHarness();
    }

    function _uintString(string memory path) internal view returns (uint256) {
        return vm.parseUint(json.readString(path));
    }

    function test_CompatibilityClassAndAdmittedPairs() public view {
        assertEq(
            TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS, json.readBytes32(".constants.sourceCompatibilityClass")
        );
        assertEq(TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS, TrustComposeValidator.sourceCompatibilityClass());
        assertEq(
            TrustComposeValidator.admittedSourceOutputDomain(TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID),
            json.readBytes32(".constants.admittedPairs[0].sourceOutputDomain")
        );
        assertEq(
            TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID, json.readBytes32(".constants.admittedPairs[0].programId")
        );
        assertEq(
            TrustComposeValidator.admittedSourceOutputDomain(TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID),
            json.readBytes32(".constants.admittedPairs[1].sourceOutputDomain")
        );
        assertEq(
            TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
            json.readBytes32(".constants.admittedPairs[1].programId")
        );
        // Nothing else is admitted — not the composition program, not an unknown program.
        assertEq(TrustComposeValidator.admittedSourceOutputDomain(keccak256("trust-compose")), bytes32(0));
        assertEq(TrustComposeValidator.admittedSourceOutputDomain(keccak256("contributions")), bytes32(0));
    }

    function test_PolicyManifestLeavesRootAndDigest() public view {
        bytes memory manifest = json.readBytes(".policyManifest.encoded");
        assertEq(manifest.length, 15 + 2 * 165);
        assertEq(bytes4(uint32(_readUint(manifest, 0, 4))), bytes4("TGCP"));
        assertEq(_readUint(manifest, 4, 2), 1);
        assertEq(_readUint(manifest, 6, 8), 10);
        assertEq(_readUint(manifest, 14, 1), 2);
        assertEq(sha256(manifest), json.readBytes32(".policyManifest.sha256"));

        bytes32[] memory leaves = new bytes32[](2);
        for (uint256 i; i < 2; ++i) {
            uint256 offset = 15 + i * 165;
            leaves[i] = keccak256(
                abi.encode(
                    bytes32(_readUint(manifest, offset, 32)),
                    address(uint160(_readUint(manifest, offset + 32, 20))),
                    bytes32(_readUint(manifest, offset + 52, 32)),
                    bytes32(_readUint(manifest, offset + 84, 32)),
                    bytes32(_readUint(manifest, offset + 116, 32)),
                    uint64(_readUint(manifest, offset + 148, 8)),
                    uint64(_readUint(manifest, offset + 156, 8)),
                    uint8(_readUint(manifest, offset + 164, 1))
                )
            );
            assertEq(leaves[i], json.readBytes32(string.concat(".policyManifest.leaves[", vm.toString(i), "]")));
        }
        assertEq(_hashPair(leaves[0], leaves[1]), json.readBytes32(".policyManifest.root"));
    }

    function test_CapturedManifestCarriesRealProgramsAndDomains() public view {
        bytes memory manifest = json.readBytes(".capture.manifest");
        assertEq(manifest.length, 23 + 2 * 293);
        assertEq(bytes4(uint32(_readUint(manifest, 0, 4))), bytes4("TGCM"));
        assertEq(_readUint(manifest, 4, 2), 1);
        assertEq(_readUint(manifest, 6, 8), 10);
        assertEq(_readUint(manifest, 14, 8), 1_000_000);
        assertEq(_readUint(manifest, 22, 1), 2);
        assertEq(sha256(manifest), json.readBytes32(".capture.manifestSha256"));

        // Record 0 is the standard source; record 1 the weighted source. Each carries its real
        // program and its real output domain, never the class and never each other's identity.
        assertEq(bytes32(_readUint(manifest, 23 + 84, 32)), TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID);
        assertEq(bytes32(_readUint(manifest, 23 + 116, 32)), TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN);
        assertEq(
            bytes32(_readUint(manifest, 23 + 293 + 84, 32)), TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID
        );
        assertEq(
            bytes32(_readUint(manifest, 23 + 293 + 116, 32)), TrustComposeValidator.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN
        );
    }

    function test_ParamsEncodingAndHash() public view {
        bytes memory encoded = abi.encode(
            uint32(json.readUint(".params.version")),
            json.readBytes32(".params.programId"),
            json.readBytes32(".params.scopeHash"),
            json.readBytes32(".params.identityDomain"),
            json.readBytes32(".params.outputKind"),
            json.readBytes32(".params.outputDomain"),
            json.readBytes32(".params.sourceCompatibilityClass"),
            uint64(_uintString(".params.weightScale")),
            uint128(_uintString(".params.outputPool")),
            json.readBytes32(".params.sourcePolicyRoot"),
            uint8(json.readUint(".params.sourceCount")),
            json.readBytes32(".params.policyManifestSha256"),
            uint8(json.readUint(".params.maxSources")),
            uint32(json.readUint(".params.maxEntriesPerSource")),
            uint32(json.readUint(".params.maxAggregateEntries")),
            uint32(json.readUint(".params.maxUnionAccounts")),
            uint32(json.readUint(".params.maxAggregateBlobBytes")),
            uint64(_uintString(".params.maxSourceAgeBlocks")),
            json.readAddress(".params.accumulator"),
            uint64(_uintString(".params.chainId"))
        );
        assertEq(keccak256(encoded), keccak256(json.readBytes(".params.encoded")));
        assertEq(keccak256(encoded), json.readBytes32(".params.paramsHash"));
    }

    function test_ParamsCodecHash() public view {
        assertEq(codec.hash(_params()), json.readBytes32(".params.paramsHash"));
    }

    function test_OutputLeafProofBlobAndCid() public view {
        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(abi.encode(json.readAddress(".output.sampleAccount"), _uintString(".output.sampleValue")))
            )
        );
        assertEq(leaf, json.readBytes32(".output.sampleLeaf"));
        assertTrue(
            MerkleProof.verify(json.readBytes32Array(".output.sampleProof"), json.readBytes32(".output.root"), leaf)
        );
        bytes memory blob = bytes(json.readString(".output.blob"));
        assertEq(sha256(blob), json.readBytes32(".output.blobSha256"));
        assertEq(keccak256(bytes(json.readString(".output.cid"))), json.readBytes32(".output.cidDigest"));
    }

    function test_CommonJournalEncodingAndDigest() public view {
        bytes memory encoded = abi.encode(
            json.readBytes32(".journal.acc"),
            uint64(_uintString(".journal.leafCount")),
            json.readBytes32(".journal.anchorAcc"),
            uint64(_uintString(".journal.anchorCount")),
            json.readBytes32(".journal.paramsHash"),
            json.readBytes32(".journal.outputRoot"),
            json.readBytes32(".journal.ipfsHash"),
            json.readBytes32(".journal.cidDigest"),
            _uintString(".journal.totalValue"),
            json.readBytes32(".journal.skippedDigest"),
            json.readAddress(".journal.recipient"),
            json.readBytes32(".journal.instanceDomain")
        );
        assertEq(keccak256(encoded), keccak256(json.readBytes(".journal.encoded")));
        assertEq(keccak256(encoded), json.readBytes32(".journal.digest"));
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return left < right ? keccak256(bytes.concat(left, right)) : keccak256(bytes.concat(right, left));
    }

    function _params() private view returns (TrustComposeParamsCodec.Params memory p) {
        p.version = uint32(json.readUint(".params.version"));
        p.programId = json.readBytes32(".params.programId");
        p.scopeHash = json.readBytes32(".params.scopeHash");
        p.identityDomain = json.readBytes32(".params.identityDomain");
        p.outputKind = json.readBytes32(".params.outputKind");
        p.outputDomain = json.readBytes32(".params.outputDomain");
        p.sourceCompatibilityClass = json.readBytes32(".params.sourceCompatibilityClass");
        p.weightScale = uint64(_uintString(".params.weightScale"));
        p.outputPool = uint128(_uintString(".params.outputPool"));
        p.sourcePolicyRoot = json.readBytes32(".params.sourcePolicyRoot");
        p.sourceCount = uint8(json.readUint(".params.sourceCount"));
        p.policyManifestSha256 = json.readBytes32(".params.policyManifestSha256");
        p.maxSources = uint8(json.readUint(".params.maxSources"));
        p.maxEntriesPerSource = uint32(json.readUint(".params.maxEntriesPerSource"));
        p.maxAggregateEntries = uint32(json.readUint(".params.maxAggregateEntries"));
        p.maxUnionAccounts = uint32(json.readUint(".params.maxUnionAccounts"));
        p.maxAggregateBlobBytes = uint32(json.readUint(".params.maxAggregateBlobBytes"));
        p.maxSourceAgeBlocks = uint64(_uintString(".params.maxSourceAgeBlocks"));
        p.accumulator = json.readAddress(".params.accumulator");
        p.chainId = uint64(_uintString(".params.chainId"));
    }

    function _readUint(bytes memory data, uint256 offset, uint256 length) private pure returns (uint256 value) {
        for (uint256 i; i < length; ++i) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }
}
