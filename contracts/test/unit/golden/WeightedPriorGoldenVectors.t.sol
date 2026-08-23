// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";

contract WeightedPriorParamsCodecHarness {
    function hash(WeightedPriorParamsCodec.Params calldata params) external pure returns (bytes32) {
        WeightedPriorParamsCodec.Params memory copy = params;
        return WeightedPriorParamsCodec.hash(copy);
    }
}

/// @notice Independent Solidity lock for `trust-graph-weighted` V1. This test deliberately does
/// not depend on a factory/controller: it locks the codec directly against the core/guest bytes.
contract WeightedPriorGoldenVectorsTest is Test {
    using stdJson for string;

    string internal json;
    WeightedPriorParamsCodecHarness internal codec;

    function setUp() public {
        json = vm.readFile("tests/golden/weighted-prior.json");
        codec = new WeightedPriorParamsCodecHarness();
    }

    function test_TgwpManifestHeaderAndSha256() public view {
        bytes memory manifest = json.readBytes(".prior.manifest");
        assertEq(manifest.length, 18 + 3 * 28, "manifest length");
        assertEq(bytes4(uint32(_readUint(manifest, 0, 4))), bytes4("TGWP"), "manifest magic");
        assertEq(_readUint(manifest, 4, 2), 1, "manifest version");
        assertEq(_readUint(manifest, 6, 8), 10, "manifest chain");
        assertEq(_readUint(manifest, 14, 4), 3, "manifest count");
        assertEq(sha256(manifest), json.readBytes32(".prior.manifestSha256"), "manifest sha256");

        uint256 sum;
        address previous;
        for (uint256 i; i < 3; ++i) {
            uint256 offset = 18 + i * 28;
            address account = address(uint160(_readUint(manifest, offset, 20)));
            uint64 weight = uint64(_readUint(manifest, offset + 20, 8));
            assertTrue(account > previous, "manifest address order");
            assertGt(weight, 0, "manifest positive weight");
            previous = account;
            sum += weight;
        }
        assertEq(sum, 1e18, "manifest normalized sum");
    }

    function test_PriorLeavesAndPromotedOddRoot() public view {
        bytes32[] memory leaves = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            string memory base = string.concat(".prior.entries[", vm.toString(i), "]");
            leaves[i] = keccak256(
                abi.encode(
                    json.readAddress(string.concat(base, ".account")), json.readUint(string.concat(base, ".weight"))
                )
            );
            assertEq(leaves[i], json.readBytes32(string.concat(base, ".leaf")), "prior leaf");
        }
        bytes32 root = _hashPair(_hashPair(leaves[0], leaves[1]), leaves[2]);
        assertEq(root, json.readBytes32(".prior.root"), "prior root");
    }

    function test_HamiltonAndNormalizationTiesUseAddressOrder() public view {
        address previous;
        uint256 normalizedSum;
        uint256 apportionedSum;
        for (uint256 i; i < 3; ++i) {
            address account = json.readAddress(string.concat(".ties.accounts[", vm.toString(i), "]"));
            uint256 normalized = json.readUint(string.concat(".ties.normalizedWeights[", vm.toString(i), "]"));
            uint256 apportioned = json.readUint(string.concat(".ties.apportionValues[", vm.toString(i), "]"));
            assertTrue(account > previous, "tie account order");
            assertEq(normalized, i == 0 ? 333_333_333_333_333_334 : 333_333_333_333_333_333);
            assertEq(apportioned, i < 2 ? 1 : 0, "lower address wins equal remainder");
            previous = account;
            normalizedSum += normalized;
            apportionedSum += apportioned;
        }
        assertEq(normalizedSum, 1e18, "tie normalization mass");
        assertEq(apportionedSum, json.readUint(".ties.apportionBudget"), "tie budget mass");
        assertEq(json.readUint(".ties.apportionDenominator"), 3, "tie denominator");
    }

    function test_WeightedParamsEncodingAndHash() public view {
        bytes memory encoded = abi.encode(
            uint32(json.readUint(".params.version")),
            uint64(json.readUint(".params.dampingFp")),
            uint64(json.readUint(".params.toleranceFp")),
            uint32(json.readUint(".params.maxIterations")),
            uint64(json.readUint(".params.minWeight")),
            uint64(json.readUint(".params.maxWeight")),
            json.readBytes32(".params.priorRoot"),
            uint32(json.readUint(".params.priorCount")),
            json.readBytes32(".params.manifestSha256"),
            json.readBytes32(".params.schemaUid"),
            uint32(json.readUint(".params.weightFieldIndex")),
            json.readAddress(".params.accumulator"),
            uint64(json.readUint(".params.chainId"))
        );
        assertEq(keccak256(encoded), keccak256(json.readBytes(".params.encoded")), "params bytes");
        assertEq(keccak256(encoded), json.readBytes32(".params.paramsHash"), "params hash");
    }

    function test_WeightedParamsCodecHash() public view {
        assertEq(codec.hash(_params()), json.readBytes32(".params.paramsHash"), "codec hash");
    }

    function test_AccumulatorEdgeLeaf() public view {
        bytes32 leaf = keccak256(
            abi.encode(
                uint8(json.readUint(".accumulator.edge0.kind")),
                json.readAddress(".accumulator.edge0.attester"),
                json.readAddress(".accumulator.edge0.recipient"),
                json.readBytes32(".accumulator.edge0.uid"),
                json.readUint(".accumulator.edge0.blockTimestamp"),
                json.readBytes32(".accumulator.edge0.dataHash")
            )
        );
        assertEq(leaf, json.readBytes32(".accumulator.edge0.leaf"), "edge leaf");
    }

    function test_OutputLeafAndProof() public view {
        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(abi.encode(json.readAddress(".output.sampleAccount"), json.readUint(".output.sampleValue")))
            )
        );
        assertEq(leaf, json.readBytes32(".output.sampleLeaf"), "output leaf");
        assertTrue(
            MerkleProof.verify(json.readBytes32Array(".output.sampleProof"), json.readBytes32(".output.root"), leaf),
            "output proof"
        );
    }

    function test_CidAndJournalBindings() public view {
        bytes memory blob = json.readBytes(".cid.blobHex");
        assertEq(sha256(blob), json.readBytes32(".cid.ipfsHash"), "blob sha256");
        assertEq(keccak256(bytes(json.readString(".cid.cid"))), json.readBytes32(".cid.cidDigest"), "cid digest");

        bytes memory encoded = abi.encode(
            json.readBytes32(".journal.acc"),
            uint64(json.readUint(".journal.leafCount")),
            json.readBytes32(".journal.anchorAcc"),
            uint64(json.readUint(".journal.anchorCount")),
            json.readBytes32(".journal.paramsHash"),
            json.readBytes32(".journal.outputRoot"),
            json.readBytes32(".journal.ipfsHash"),
            json.readBytes32(".journal.cidDigest"),
            json.readUint(".journal.totalValue"),
            json.readBytes32(".journal.skippedDigest"),
            json.readAddress(".journal.recipient"),
            json.readBytes32(".journal.instanceDomain")
        );
        assertEq(keccak256(encoded), keccak256(json.readBytes(".journal.encoded")), "journal bytes");
        assertEq(keccak256(encoded), json.readBytes32(".journal.digest"), "journal digest");
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(bytes.concat(a, b)) : keccak256(bytes.concat(b, a));
    }

    function _params() private view returns (WeightedPriorParamsCodec.Params memory p) {
        p.version = uint32(json.readUint(".params.version"));
        p.dampingFp = uint64(json.readUint(".params.dampingFp"));
        p.toleranceFp = uint64(json.readUint(".params.toleranceFp"));
        p.maxIterations = uint32(json.readUint(".params.maxIterations"));
        p.minWeight = uint64(json.readUint(".params.minWeight"));
        p.maxWeight = uint64(json.readUint(".params.maxWeight"));
        p.priorRoot = json.readBytes32(".params.priorRoot");
        p.priorCount = uint32(json.readUint(".params.priorCount"));
        p.manifestSha256 = json.readBytes32(".params.manifestSha256");
        p.schemaUid = json.readBytes32(".params.schemaUid");
        p.weightFieldIndex = uint32(json.readUint(".params.weightFieldIndex"));
        p.accumulator = json.readAddress(".params.accumulator");
        p.chainId = uint64(json.readUint(".params.chainId"));
    }

    function _readUint(bytes memory data, uint256 offset, uint256 length) private pure returns (uint256 value) {
        for (uint256 i; i < length; ++i) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }
}
