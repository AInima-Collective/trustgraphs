// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {ContributionsParamsCodec} from "contracts/params/ContributionsParamsCodec.sol";

/// @title ContributionsGoldenVectors
/// @notice Cross-language lock for the `contributions` program's frozen interface
///         (docs/contributions/INTERFACES.md): independently recompute in Solidity every byte
///         format that `contributions-core` exports (via
///         `cargo run -p contributions-core --example export_golden`) and assert equality.
///         The 21-word `paramsHash`, the seed-set root, the fold `kind` tagging, and the
///         contribution accumulator leaf/fold are all locked here.
contract ContributionsGoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("test/golden/contributions.json");
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
        assertEq(
            ContributionsParamsCodec.hash(p), json.readBytes32(".params.paramsHash"), "paramsHash mismatch"
        );
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
        assertEq(
            keccak256(json.readBytes(".leaf.data")),
            json.readBytes32(".leaf.dataHash"),
            "dataHash mismatch"
        );
    }
}
