// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {ParamsCodec} from "contracts/params/ParamsCodec.sol";

/// @title TrustGraphGoldenVectors
/// @notice Cross-language lock (Risk R2) for the `trust-graph` (root-producer) program: independently
///         recompute in Solidity every frozen byte format that `pagerank-core` produces (via
///         `cargo run --example export_golden`) and assert equality. If the guest's Rust encoding and
///         the on-chain Solidity encoding ever diverge, this test fails — before a "valid" proof that
///         never verifies reaches anyone.
/// @dev    The `trust-graph` and `signer` programs share the same golden feed
///         (`test/golden/trust-graph.json`); the `.signer` section is asserted in
///         SignerGoldenVectors.t.sol.
contract TrustGraphGoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("test/golden/trust-graph.json");
    }

    /// Accumulator edge leaf: keccak256(abi.encode(uint8, address, address, bytes32, uint256, bytes32)).
    function test_AccumulatorEdgeLeaf() public view {
        uint8 kind = uint8(json.readUint(".accumulator.edge0.kind"));
        address attester = json.readAddress(".accumulator.edge0.attester");
        address recipient = json.readAddress(".accumulator.edge0.recipient");
        bytes32 uid = json.readBytes32(".accumulator.edge0.uid");
        uint256 ts = json.readUint(".accumulator.edge0.blockTimestamp");
        bytes32 dataHash = json.readBytes32(".accumulator.edge0.dataHash");
        bytes32 expected = json.readBytes32(".accumulator.edge0.leaf");

        bytes32 leaf = keccak256(abi.encode(kind, attester, recipient, uid, ts, dataHash));
        assertEq(leaf, expected, "edge leaf mismatch");
    }

    /// Journal: abi.encode(bytes32, uint64, bytes32, bytes32, bytes32, bytes32, uint256) and its keccak.
    function test_JournalEncodingAndDigest() public view {
        bytes32 acc = json.readBytes32(".journal.acc");
        uint64 leafCount = uint64(json.readUint(".journal.leafCount"));
        bytes32 paramsHash = json.readBytes32(".journal.paramsHash");
        bytes32 outputRoot = json.readBytes32(".journal.outputRoot");
        bytes32 ipfsHash = json.readBytes32(".journal.ipfsHash");
        bytes32 cidDigest = json.readBytes32(".journal.cidDigest");
        uint256 totalValue = json.readUint(".journal.totalValue");

        bytes memory expectedEncoded = json.readBytes(".journal.encoded");
        bytes32 expectedDigest = json.readBytes32(".journal.digest");

        bytes memory encoded = abi.encode(
            acc, leafCount, paramsHash, outputRoot, ipfsHash, cidDigest, totalValue
        );
        assertEq(keccak256(encoded), keccak256(expectedEncoded), "journal encoding mismatch");
        assertEq(keccak256(encoded), expectedDigest, "journal digest mismatch");
    }

    /// Output leaf: keccak256(bytes.concat(keccak256(abi.encode(address, uint256)))) — matches
    /// MerkleSnapshot.sol:129 so existing consumers' proofs verify unchanged.
    function test_OutputLeaf() public view {
        address account = json.readAddress(".output.sampleAccount");
        uint256 value = json.readUint(".output.sampleValue");
        bytes32 expected = json.readBytes32(".output.sampleLeaf");

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, value))));
        assertEq(leaf, expected, "output leaf mismatch");
    }

    /// The guest-built OZ standard tree verifies against the on-chain MerkleProof (commutative).
    function test_MerkleProofVerifies() public view {
        bytes32 root = json.readBytes32(".output.root");
        bytes32 leaf = json.readBytes32(".output.sampleLeaf");
        bytes32[] memory proof = json.readBytes32Array(".output.sampleProof");
        assertTrue(MerkleProof.verify(proof, root, leaf), "guest proof must verify on-chain");
    }

    /// CID digest binding: keccak256(bytes(cid)).
    function test_CidDigest() public view {
        string memory cid = json.readString(".cid.cid");
        bytes32 expected = json.readBytes32(".cid.cidDigest");
        assertEq(keccak256(bytes(cid)), expected, "cid digest mismatch");
    }

    /// ipfsHash binding: sha256(canonical blob) (Solidity sha256 precompile).
    function test_IpfsHashIsSha256OfBlob() public view {
        bytes memory blob = json.readBytes(".cid.blobHex");
        bytes32 expected = json.readBytes32(".cid.ipfsHash");
        assertEq(sha256(blob), expected, "ipfsHash must be sha256(blob)");
    }

    /// seedSetRoot: OZ standard tree over sorted seed leaves = keccak256(abi.encode(address)).
    /// Exercised through `ParamsCodec.seedSetRoot` — the same code the deploy uses — so the on-chain
    /// encoder is locked to the golden vector (and thus to pagerank-core), not just this test.
    function test_SeedSetRoot() public view {
        assertEq(
            ParamsCodec.seedSetRoot(json.readAddressArray(".params.sortedSeeds")),
            json.readBytes32(".params.seedSetRoot"),
            "seedSetRoot mismatch"
        );
    }

    /// paramsHash: `ParamsCodec.hash` (used by DeployNetwork) must reproduce the golden vector,
    /// locking the on-chain 13-field encoding to pagerank-core::encode::params_hash.
    function test_ParamsHashEncoding() public view {
        ParamsCodec.Params memory p = ParamsCodec.Params({
            dampingFp: json.readUint(".params.dampingFp"),
            toleranceFp: json.readUint(".params.toleranceFp"),
            maxIterations: uint32(json.readUint(".params.maxIterations")),
            minWeightFp: json.readUint(".params.minWeightFp"),
            maxWeightFp: json.readUint(".params.maxWeightFp"),
            trustMultiplierFp: json.readUint(".params.trustMultiplierFp"),
            trustShareFp: json.readUint(".params.trustShareFp"),
            trustDecayFp: json.readUint(".params.trustDecayFp"),
            trustedSeeds: json.readAddressArray(".params.sortedSeeds"),
            totalPool: json.readUint(".params.totalPool"),
            precisionScale: json.readUint(".params.precisionScale"),
            schemaUid: json.readBytes32(".params.schemaUid"),
            weightFieldIndex: uint32(json.readUint(".params.weightFieldIndex"))
        });
        assertEq(ParamsCodec.hash(p), json.readBytes32(".params.paramsHash"), "paramsHash mismatch");
    }
}
