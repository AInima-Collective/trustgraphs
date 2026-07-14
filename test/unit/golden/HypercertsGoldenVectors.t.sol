// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {HypercertsParamsCodec} from "contracts/params/HypercertsParamsCodec.sol";

/// @title HypercertsGoldenVectors
/// @notice Cross-language lock for the `hypercerts` (AT-proto graph) program: independently
///         recompute in Solidity every frozen byte format that `hypercerts-core` produces (via
///         `cargo run -p hypercerts-core --example export_golden`) and assert equality. Node
///         identity, the 17-word `paramsHash`, the unified `node_output_leaf`, the journal-v2
///         encoding/digest, and the `skippedDigest` preimage fold are all locked here.
contract HypercertsGoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("test/golden/hypercerts.json");
    }

    /// didNodeId: keccak256(bytes(did)) — mirrors `semantics::did_node_id`.
    function test_DidNodeId() public view {
        assertEq(
            HypercertsParamsCodec.didNodeId(json.readString(".nodeIds.a.did")),
            json.readBytes32(".nodeIds.a.didNodeId"),
            "didNodeId(a) mismatch"
        );
        assertEq(
            HypercertsParamsCodec.didNodeId(json.readString(".nodeIds.b.did")),
            json.readBytes32(".nodeIds.b.didNodeId"),
            "didNodeId(b) mismatch"
        );
    }

    /// artifactNodeId: keccak256(bytes("at://did/coll/rkey")) — mirrors `semantics::artifact_node_id`.
    function test_ArtifactNodeId() public view {
        assertEq(
            keccak256(bytes(json.readString(".nodeIds.artifact.uri"))),
            json.readBytes32(".nodeIds.artifact.artifactNodeId"),
            "artifactNodeId mismatch"
        );
    }

    /// node_output_leaf: keccak256(bytes.concat(keccak256(abi.encode(bytes32 nodeId, uint256 value)))).
    function test_NodeOutputLeaf() public view {
        bytes32 nodeId = json.readBytes32(".outputLeaf.nodeId");
        uint256 value = json.readUint(".outputLeaf.value");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(nodeId, value))));
        assertEq(leaf, json.readBytes32(".outputLeaf.leaf"), "node output leaf mismatch");
    }

    /// seedSetRoot: OZ standard tree over sorted seed nodeIds, leaf = keccak256(nodeId). Exercised
    /// through the same `HypercertsParamsCodec.seedSetRoot` a deploy would use.
    function test_SeedSetRoot() public view {
        assertEq(
            HypercertsParamsCodec.seedSetRoot(json.readStringArray(".params.trustedSeedDids")),
            json.readBytes32(".params.seedSetRoot"),
            "seedSetRoot mismatch"
        );
    }

    /// paramsHash: the 17-field tuple via `HypercertsParamsCodec.hash`, locking the on-chain encoder
    /// to `hypercerts_core::compute::params_hash`.
    function test_ParamsHashEncoding() public view {
        HypercertsParamsCodec.Params memory p = HypercertsParamsCodec.Params({
            dampingFp: json.readUint(".params.dampingFp"),
            toleranceFp: json.readUint(".params.toleranceFp"),
            maxIterations: uint32(json.readUint(".params.maxIterations")),
            trustMultiplierFp: json.readUint(".params.trustMultiplierFp"),
            trustShareFp: json.readUint(".params.trustShareFp"),
            trustDecayFp: json.readUint(".params.trustDecayFp"),
            precisionScale: json.readUint(".params.precisionScale"),
            totalPool: json.readUint(".params.totalPool"),
            trustedSeedDids: json.readStringArray(".params.trustedSeedDids"),
            wFollowFp: json.readUint(".params.wFollowFp"),
            wBadgeFp: json.readUint(".params.wBadgeFp"),
            wEvalFp: json.readUint(".params.wEvalFp"),
            wAttribFp: json.readUint(".params.wAttribFp"),
            ackBoostFp: json.readUint(".params.ackBoostFp"),
            unackedAttribFp: json.readUint(".params.unackedAttribFp"),
            pdsAttestedWeightFp: json.readUint(".params.pdsAttestedWeightFp"),
            lane2MaxHeadAge: uint64(json.readUint(".params.lane2MaxHeadAge"))
        });
        assertEq(HypercertsParamsCodec.hash(p), json.readBytes32(".params.paramsHash"), "paramsHash mismatch");
    }

    /// Journal v2 (two-lane, lane 1 empty for hypercerts): abi.encode of the 10 fields and its keccak.
    function test_JournalEncodingAndDigest() public view {
        bytes32 acc = json.readBytes32(".journal.acc");
        uint64 leafCount = uint64(json.readUint(".journal.leafCount"));
        bytes32 anchorAcc = json.readBytes32(".journal.anchorAcc");
        uint64 anchorCount = uint64(json.readUint(".journal.anchorCount"));
        bytes32 paramsHash = json.readBytes32(".journal.paramsHash");
        bytes32 outputRoot = json.readBytes32(".journal.outputRoot");
        bytes32 ipfsHash = json.readBytes32(".journal.ipfsHash");
        bytes32 cidDigest = json.readBytes32(".journal.cidDigest");
        uint256 totalValue = json.readUint(".journal.totalValue");
        bytes32 skippedDigest = json.readBytes32(".journal.skippedDigest");

        bytes memory expectedEncoded = json.readBytes(".journal.encoded");
        bytes32 expectedDigest = json.readBytes32(".journal.digest");

        bytes memory encoded = abi.encode(
            acc, leafCount, anchorAcc, anchorCount, paramsHash, outputRoot, ipfsHash, cidDigest,
            totalValue, skippedDigest
        );
        assertEq(keccak256(encoded), keccak256(expectedEncoded), "journal encoding mismatch");
        assertEq(keccak256(encoded), expectedDigest, "journal digest mismatch");
        // The paramsHash embedded in the journal is the same one the codec recomputes.
        assertEq(paramsHash, json.readBytes32(".params.paramsHash"), "journal paramsHash mismatch");
    }

    /// skippedDigest preimage: each entry's leaf = keccak256(abi.encode(bytes32, uint8, uint64)), and
    /// the chained fold (acc_0 = 0) over the canonically-sorted entries reproduces the journal digest.
    function test_SkippedDigestPreimage() public view {
        uint256 count = json.readUint(".skipped.count");
        bytes32 acc = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            string memory base = string.concat(".skipped.entries[", vm.toString(i), "]");
            bytes32 nodeId = json.readBytes32(string.concat(base, ".nodeId"));
            uint8 reason = uint8(json.readUint(string.concat(base, ".reason")));
            uint64 epoch = uint64(json.readUint(string.concat(base, ".epochObserved")));
            bytes32 leaf = keccak256(abi.encode(nodeId, reason, epoch));
            assertEq(leaf, json.readBytes32(string.concat(base, ".skipLeaf")), "skip leaf mismatch");
            acc = keccak256(abi.encode(acc, leaf));
        }
        assertEq(acc, json.readBytes32(".skipped.skippedDigest"), "skippedDigest fold mismatch");
        assertEq(acc, json.readBytes32(".journal.skippedDigest"), "journal skippedDigest mismatch");
    }
}
