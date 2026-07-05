// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title GoldenVectors
/// @notice Cross-language lock (Risk R2): independently recompute in Solidity every frozen byte
///         format that `pagerank-core` produces (via `cargo run --example export_golden`) and
///         assert equality. If the guest's Rust encoding and the on-chain Solidity encoding ever
///         diverge, this test fails — before a "valid" proof that never verifies reaches anyone.
contract GoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("test/golden/vectors.json");
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
    function test_SeedSetRoot() public view {
        address[] memory seeds = json.readAddressArray(".params.sortedSeeds");
        bytes32[] memory leaves = new bytes32[](seeds.length);
        for (uint256 i = 0; i < seeds.length; i++) {
            leaves[i] = keccak256(abi.encode(seeds[i]));
        }
        assertEq(_ozRoot(leaves), json.readBytes32(".params.seedSetRoot"), "seedSetRoot mismatch");
    }

    /// paramsHash: the 13-field abi.encode is recomputed independently in Solidity (locks field
    /// order + types against pagerank-core::encode::params_hash).
    function test_ParamsHashEncoding() public view {
        bytes memory encoded = abi.encode(
            json.readUint(".params.dampingFp"),
            json.readUint(".params.toleranceFp"),
            uint32(json.readUint(".params.maxIterations")),
            json.readUint(".params.minWeightFp"),
            json.readUint(".params.maxWeightFp"),
            json.readUint(".params.trustMultiplierFp"),
            json.readUint(".params.trustShareFp"),
            json.readUint(".params.trustDecayFp"),
            json.readBytes32(".params.seedSetRoot"),
            json.readUint(".params.totalPool"),
            json.readUint(".params.precisionScale"),
            json.readBytes32(".params.schemaUid"),
            uint32(json.readUint(".params.weightFieldIndex"))
        );
        assertEq(keccak256(encoded), json.readBytes32(".params.paramsHash"), "paramsHash mismatch");
    }

    /// Minimal OpenZeppelin StandardMerkleTree root (sorted leaves, commutative parent hashing).
    function _ozRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        // insertion sort (small n)
        for (uint256 i = 1; i < n; i++) {
            bytes32 key = leaves[i];
            uint256 j = i;
            while (j > 0 && leaves[j - 1] > key) {
                leaves[j] = leaves[j - 1];
                j--;
            }
            leaves[j] = key;
        }
        if (n == 1) return leaves[0];
        uint256 size = 2 * n - 1;
        bytes32[] memory tree = new bytes32[](size);
        for (uint256 i = 0; i < n; i++) {
            tree[size - 1 - i] = leaves[i];
        }
        for (uint256 i = n - 1; i > 0; i--) {
            uint256 idx = i - 1;
            bytes32 a = tree[2 * idx + 1];
            bytes32 b = tree[2 * idx + 2];
            tree[idx] = a <= b
                ? keccak256(abi.encode(a, b))
                : keccak256(abi.encode(b, a));
        }
        return tree[0];
    }
}
