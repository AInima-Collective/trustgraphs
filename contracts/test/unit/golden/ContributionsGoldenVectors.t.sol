// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";

/// @title ContributionsGoldenVectors
/// @notice Cross-language lock for the `contributions` program's frozen interface
///         (docs/build/contributions/interfaces.md): independently recompute in Solidity every byte
///         format that `contributions-core` exports (via
///         `cargo run -p contributions-core --example export_golden`) and assert equality.
///         The 21-word `paramsHash`, the seed-set root, the fold `kind` tagging, and the
///         contribution accumulator leaf/fold are all locked here.
contract ContributionsGoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("tests/golden/contributions.json");
    }

    /// kind = schemaIndex * 2 + isRevoke (INTERFACES.md §2) — the tag the resolver folds.
    function test_KindTagging() public view {
        for (uint256 i = 0; i < 6; i++) {
            string memory base = string.concat(".kinds[", vm.toString(i), "]");
            uint256 schemaIndex = json.readUint(string.concat(base, ".schemaIndex"));
            bool isRevoke = json.readBool(string.concat(base, ".isRevoke"));
            uint256 k = json.readUint(string.concat(base, ".kind"));
            assertEq(schemaIndex * 2 + (isRevoke ? 1 : 0), k, "kind formula mismatch");
        }
    }

    /// seedSetRoot: OZ standard tree over sorted seed addresses, leaf = keccak256(abi.encode(addr)).
    function test_SeedSetRoot() public view {
        assertEq(
            ContributionsParamsCodec.seedSetRoot(json.readAddressArray(".params.trustedSeeds")),
            json.readBytes32(".params.seedSetRoot"),
            "seedSetRoot mismatch"
        );
    }

    /// paramsHash: the 21-field tuple via `ContributionsParamsCodec.hash`, locking the on-chain
    /// encoder to `contributions_core::params::params_hash`.
    function test_ParamsHashEncoding() public view {
        ContributionsParamsCodec.Params memory p = ContributionsParamsCodec.Params({
            dampingFp: json.readUint(".params.dampingFp"),
            toleranceFp: json.readUint(".params.toleranceFp"),
            maxIterations: uint32(json.readUint(".params.maxIterations")),
            minWeightFp: json.readUint(".params.minWeightFp"),
            maxWeightFp: json.readUint(".params.maxWeightFp"),
            trustMultiplierFp: json.readUint(".params.trustMultiplierFp"),
            trustShareFp: json.readUint(".params.trustShareFp"),
            trustDecayFp: json.readUint(".params.trustDecayFp"),
            trustedSeeds: json.readAddressArray(".params.trustedSeeds"),
            precisionScale: json.readUint(".params.precisionScale"),
            weightFieldIndex: uint32(json.readUint(".params.weightFieldIndex")),
            roundStart: uint64(json.readUint(".params.roundStart")),
            roundEnd: uint64(json.readUint(".params.roundEnd")),
            unacceptedMultFp: json.readUint(".params.unacceptedMultFp"),
            collaboratorMultFp: json.readUint(".params.collaboratorMultFp"),
            minRaterRepFp: json.readUint(".params.minRaterRepFp"),
            evaluatorCarveoutBps: uint32(json.readUint(".params.evaluatorCarveoutBps")),
            totalPool: json.readUint(".params.totalPool"),
            claimSchemaUid: json.readBytes32(".params.claimSchemaUid"),
            responseSchemaUid: json.readBytes32(".params.responseSchemaUid"),
            valuationSchemaUid: json.readBytes32(".params.valuationSchemaUid")
        });
        assertEq(ContributionsParamsCodec.hash(p), json.readBytes32(".params.paramsHash"), "paramsHash mismatch");
    }

    /// The worked-example (M1 compute family) params: the codec reproduces the fixture's
    /// `paramsHash` exactly as committed in its journal.
    function test_ComputeFixtureParamsHash() public view {
        ContributionsParamsCodec.Params memory p = ContributionsParamsCodec.Params({
            dampingFp: json.readUint(".compute.input.params.dampingFp"),
            toleranceFp: json.readUint(".compute.input.params.toleranceFp"),
            maxIterations: uint32(json.readUint(".compute.input.params.maxIterations")),
            minWeightFp: json.readUint(".compute.input.params.minWeightFp"),
            maxWeightFp: json.readUint(".compute.input.params.maxWeightFp"),
            trustMultiplierFp: json.readUint(".compute.input.params.trustMultiplierFp"),
            trustShareFp: json.readUint(".compute.input.params.trustShareFp"),
            trustDecayFp: json.readUint(".compute.input.params.trustDecayFp"),
            trustedSeeds: json.readAddressArray(".compute.input.params.trustedSeeds"),
            precisionScale: json.readUint(".compute.input.params.precisionScale"),
            weightFieldIndex: uint32(json.readUint(".compute.input.params.weightFieldIndex")),
            roundStart: uint64(json.readUint(".compute.input.params.roundStart")),
            roundEnd: uint64(json.readUint(".compute.input.params.roundEnd")),
            unacceptedMultFp: json.readUint(".compute.input.params.unacceptedMultFp"),
            collaboratorMultFp: json.readUint(".compute.input.params.collaboratorMultFp"),
            minRaterRepFp: json.readUint(".compute.input.params.minRaterRepFp"),
            evaluatorCarveoutBps: uint32(json.readUint(".compute.input.params.evaluatorCarveoutBps")),
            totalPool: json.readUint(".compute.input.params.totalPool"),
            claimSchemaUid: json.readBytes32(".compute.input.params.claimSchemaUid"),
            responseSchemaUid: json.readBytes32(".compute.input.params.responseSchemaUid"),
            valuationSchemaUid: json.readBytes32(".compute.input.params.valuationSchemaUid")
        });
        assertEq(
            ContributionsParamsCodec.hash(p),
            json.readBytes32(".compute.journal.paramsHash"),
            "fixture paramsHash mismatch"
        );
    }

    /// Journal v3 reused unmodified (slot A = trust acc, slot B = contribution acc): abi.encode
    /// of the 10 fields reproduces the committed encoding, and its keccak the digest —
    /// exactly what the contrib `MerkleSnapshot.submitProof` binds.
    function test_ComputeJournalEncodingAndDigest() public view {
        bytes memory encoded = abi.encode(
            json.readBytes32(".compute.journal.acc"),
            uint64(json.readUint(".compute.journal.leafCount")),
            json.readBytes32(".compute.journal.anchorAcc"),
            uint64(json.readUint(".compute.journal.anchorCount")),
            json.readBytes32(".compute.journal.paramsHash"),
            json.readBytes32(".compute.journal.outputRoot"),
            json.readBytes32(".compute.journal.ipfsHash"),
            keccak256(bytes(json.readString(".compute.cid"))),
            json.readUint(".compute.journal.totalValue"),
            json.readBytes32(".compute.journal.skippedDigest"),
            json.readAddress(".compute.journal.recipient"),
            json.readBytes32(".compute.journal.instanceDomain")
        );
        assertEq(encoded, json.readBytes(".compute.journal.encoded"), "journal encoding mismatch");
        assertEq(keccak256(encoded), json.readBytes32(".compute.journal.digest"), "journal digest mismatch");
        // cidDigest is the keccak of the CID string (the consumer-facing pointer is bound).
        assertEq(
            keccak256(bytes(json.readString(".compute.cid"))),
            json.readBytes32(".compute.journal.cidDigest"),
            "cidDigest mismatch"
        );
        // The blob string hashes to ipfsHash (sha256) — the canonical blob is bound end to end.
        assertEq(
            sha256(bytes(json.readString(".compute.blob"))),
            json.readBytes32(".compute.journal.ipfsHash"),
            "blob sha256 mismatch"
        );
        // skippedDigest is frozen at zero for the contributions program v1.
        assertEq(json.readBytes32(".compute.journal.skippedDigest"), bytes32(0));
    }

    /// The payouts vector sums exactly to the pool (the money math is audited by construction).
    function test_ComputePayoutsSumToPool() public view {
        uint256 sum;
        // 5 payout accounts in the worked example.
        for (uint256 i = 0; i < 5; i++) {
            sum += json.readUint(string.concat(".compute.payouts[", vm.toString(i), "].value"));
        }
        assertEq(sum, json.readUint(".compute.input.params.totalPool"), "payouts must sum to pool");
        assertEq(sum, json.readUint(".compute.journal.totalValue"), "totalValue mismatch");
    }

    /// The contribution accumulator leaf + fold: identical ABI to `AttestationAccumulator._fold`,
    /// with the new kind domain (here kind 4 = valuation attested).
    function test_AccumulatorLeafAndFold() public view {
        bytes32 leaf = keccak256(
            abi.encode(
                uint8(json.readUint(".leaf.kind")),
                json.readAddress(".leaf.attester"),
                json.readAddress(".leaf.recipient"),
                json.readBytes32(".leaf.uid"),
                json.readUint(".leaf.blockTimestamp"),
                json.readBytes32(".leaf.dataHash")
            )
        );
        assertEq(leaf, json.readBytes32(".leaf.leaf"), "edge leaf mismatch");
        assertEq(
            keccak256(abi.encode(json.readBytes32(".leaf.prevAcc"), leaf)),
            json.readBytes32(".leaf.foldedAcc"),
            "fold mismatch"
        );
        // dataHash is keccak of the raw valuation payload (abi.encode(bytes32 claimUID, uint8 score)).
        assertEq(keccak256(json.readBytes(".leaf.data")), json.readBytes32(".leaf.dataHash"), "dataHash mismatch");
    }
}
