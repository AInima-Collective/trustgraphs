// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {ParamsCodec} from "src/params/ParamsCodec.sol";

/// @title TrustgraphsGoldenVectors
/// @notice Cross-language lock (Risk R2) for the `trust-graph` (root-producer) program: independently
///         recompute in Solidity every frozen byte format that `pagerank-core` produces (via
///         `cargo run --example export_golden`) and assert equality. If the guest's Rust encoding and
///         the on-chain Solidity encoding ever diverge, this test fails — before a "valid" proof that
///         never verifies reaches anyone.
/// @dev    The `trust-graph` and `signer` programs share the same golden feed
///         (`tests/golden/trust-graph.json`); the `.signer` section is asserted in
///         SignerGoldenVectors.t.sol.
contract TrustgraphsGoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("tests/golden/trust-graph.json");
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
        bytes32 anchorAcc = json.readBytes32(".journal.anchorAcc");
        uint64 anchorCount = uint64(json.readUint(".journal.anchorCount"));
        bytes32 paramsHash = json.readBytes32(".journal.paramsHash");
        bytes32 outputRoot = json.readBytes32(".journal.outputRoot");
        bytes32 ipfsHash = json.readBytes32(".journal.ipfsHash");
        bytes32 cidDigest = json.readBytes32(".journal.cidDigest");
        uint256 totalValue = json.readUint(".journal.totalValue");
        bytes32 skippedDigest = json.readBytes32(".journal.skippedDigest");
        address recipient = json.readAddress(".journal.recipient");
        bytes32 instanceDomain = json.readBytes32(".journal.instanceDomain");

        bytes memory expectedEncoded = json.readBytes(".journal.encoded");
        bytes32 expectedDigest = json.readBytes32(".journal.digest");

        // Journal v3 (two-lane + the two bindings), field order FROZEN — must match
        // MerkleSnapshot.submitProof.
        bytes memory encoded = abi.encode(
            acc,
            leafCount,
            anchorAcc,
            anchorCount,
            paramsHash,
            outputRoot,
            ipfsHash,
            cidDigest,
            totalValue,
            skippedDigest,
            recipient,
            instanceDomain
        );
        assertEq(keccak256(encoded), keccak256(expectedEncoded), "journal encoding mismatch");
        assertEq(keccak256(encoded), expectedDigest, "journal digest mismatch");
    }

    /// Journal-v3 domain separator: keccak256(abi.encode(address snapshot, uint256 chainId)) —
    /// must match `zk_core::journal::instance_domain` and the rebuild inside
    /// `MerkleSnapshot.submitProof` (which substitutes `address(this)` and `block.chainid`).
    function test_InstanceDomain() public view {
        address snapshot = json.readAddress(".instanceDomain.snapshot");
        uint256 chainId = json.readUint(".instanceDomain.chainId");
        bytes32 expected = json.readBytes32(".instanceDomain.domain");

        assertEq(keccak256(abi.encode(snapshot, chainId)), expected, "instanceDomain mismatch");
        // ...and it is the value the journal vector commits, so the two cannot drift apart.
        assertEq(expected, json.readBytes32(".journal.instanceDomain"), "journal domain mismatch");
    }

    /// Anchor-log leaf: keccak256(abi.encode(bytes32, uint8, bytes32, uint64, bytes32, uint256)) —
    /// must match AnchorRegistry.anchor and zk_core::anchor::anchor_leaf. The uint64 `count` word
    /// is the head's owner-signed monotonic position (H-5).
    function test_AnchorLeaf() public view {
        bytes32 nodeId = json.readBytes32(".anchor.leaf.nodeId");
        uint8 envelopeKind = uint8(json.readUint(".anchor.leaf.envelopeKind"));
        bytes32 head = json.readBytes32(".anchor.leaf.head");
        uint64 count = uint64(json.readUint(".anchor.leaf.count"));
        bytes32 dataCommitment = json.readBytes32(".anchor.leaf.dataCommitment");
        uint256 ts = json.readUint(".anchor.leaf.blockTimestamp");
        bytes32 expected = json.readBytes32(".anchor.leaf.leaf");

        bytes32 leaf = keccak256(abi.encode(nodeId, envelopeKind, head, count, dataCommitment, ts));
        assertEq(leaf, expected, "anchor leaf mismatch");
    }

    /// Skip entry leaf + skippedDigest fold: leaf = keccak256(abi.encode(bytes32, uint8, uint64));
    /// digest = fold(0, leaf) for a single-entry set (zk_core::anchor::skipped_digest).
    function test_SkipLeafAndSkippedDigest() public view {
        bytes32 nodeId = json.readBytes32(".anchor.skip.nodeId");
        uint8 reason = uint8(json.readUint(".anchor.skip.reason"));
        uint64 epochObserved = uint64(json.readUint(".anchor.skip.epochObserved"));
        bytes32 expectedLeaf = json.readBytes32(".anchor.skip.skipLeaf");
        bytes32 expectedDigest = json.readBytes32(".anchor.skip.skippedDigest");

        bytes32 leaf = keccak256(abi.encode(nodeId, reason, epochObserved));
        assertEq(leaf, expectedLeaf, "skip leaf mismatch");
        assertEq(keccak256(abi.encode(bytes32(0), leaf)), expectedDigest, "skippedDigest mismatch");
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

    /// Non-empty lane-2 domain sets hash the packed separators in order. Empty sets use the
    /// explicit zero sentinel, so this canonical vector must exercise the other branch.
    function test_DomainSetHash() public view {
        bytes32[] memory separators = json.readBytes32Array(".params.envelope0DomainSeparators");
        assertGt(separators.length, 0, "fixture must pin the non-empty domain-set branch");
        assertEq(keccak256(abi.encodePacked(separators)), json.readBytes32(".params.domainSetHash"));
    }

    /// paramsHash: `ParamsCodec.hash` (used by DeployNetwork and by TrustgraphsFactory) must
    /// reproduce the golden vector, locking the on-chain 17-field encoding to
    /// pagerank-core::encode::params_hash.
    function test_ParamsHashEncoding() public view {
        assertEq(ParamsCodec.hash(_goldenParams()), json.readBytes32(".params.paramsHash"), "paramsHash mismatch");
    }

    /// Domain separation (INSTANCE_FACTORY §6.1, params-schema v2): two instances that are
    /// byte-identical apart from their accumulator address — or their chain id — MUST hash to
    /// different `paramsHash`es, so a proof produced for one cannot be replayed onto the other.
    /// The unit-level half of the GOAL's replay-separation criterion; the real-stack half lives in
    /// `test/integration/FactoryReplaySeparation.t.sol`.
    function test_ParamsHashDomainSeparatesInstances() public view {
        ParamsCodec.Params memory a = _goldenParams();

        ParamsCodec.Params memory b = _goldenParams();
        b.accumulator = address(uint160(a.accumulator) + 1);
        assertTrue(
            ParamsCodec.hash(a) != ParamsCodec.hash(b), "clones on different accumulators must not share a paramsHash"
        );

        ParamsCodec.Params memory c = _goldenParams();
        c.chainId = a.chainId + 1;
        assertTrue(
            ParamsCodec.hash(a) != ParamsCodec.hash(c),
            "the same instance mirrored on another chain must not share a paramsHash"
        );
    }

    /// The golden params struct, read from the vector file.
    function _goldenParams() internal view returns (ParamsCodec.Params memory) {
        return ParamsCodec.Params({
            dampingFp: json.readUint(".params.dampingFp"),
            toleranceFp: json.readUint(".params.toleranceFp"),
            maxIterations: uint32(json.readUint(".params.maxIterations")),
            minWeightFp: json.readUint(".params.minWeightFp"),
            maxWeightFp: json.readUint(".params.maxWeightFp"),
            trustShareFp: json.readUint(".params.trustShareFp"),
            trustDecayFp: json.readUint(".params.trustDecayFp"),
            trustedSeeds: json.readAddressArray(".params.sortedSeeds"),
            totalPool: json.readUint(".params.totalPool"),
            precisionScale: json.readUint(".params.precisionScale"),
            schemaUid: json.readBytes32(".params.schemaUid"),
            weightFieldIndex: uint32(json.readUint(".params.weightFieldIndex")),
            envelope0DomainSeparators: json.readBytes32Array(".params.envelope0DomainSeparators"),
            lane2MaxHeadAge: uint64(json.readUint(".params.lane2MaxHeadAge")),
            accumulator: json.readAddress(".params.accumulator"),
            chainId: uint64(json.readUint(".params.chainId"))
        });
    }
}
