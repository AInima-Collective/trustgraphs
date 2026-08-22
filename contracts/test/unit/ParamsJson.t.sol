// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {ParamsJson} from "script/lib/ParamsJson.sol";

/// @title ParamsJsonTest
/// @notice Locks the deploy-time reader: `DeployNetwork` computes `paramsHash` by reading the same
///         `params.json` the prover feeds the guest, so the field names + the 0x-hex-string U256
///         format must stay in sync with `pagerank_core::Params`. Reads the committed template and
///         asserts each field lands where the codec expects it. If someone renames a field or
///         changes the serialization, this fails instead of silently producing a wrong hash.
contract ParamsJsonTest is Test {
    string constant TEMPLATE = "tests/e2e/params.template.json";
    bytes32 constant DUMMY_UID = bytes32(uint256(0xABCD));
    address constant DUMMY_ACC = address(0xACC0);
    uint64 constant DUMMY_CHAIN = 31337;

    function test_ReadsTemplateFields() public view {
        ParamsCodec.Params memory p = ParamsJson.read(TEMPLATE, DUMMY_UID, DUMMY_ACC, DUMMY_CHAIN);

        assertEq(p.dampingFp, 0xbcbce7f1b150000, "dampingFp");
        assertEq(p.maxIterations, 100, "maxIterations");
        assertEq(p.minWeightFp, 0, "minWeightFp");
        assertEq(p.precisionScale, 1e18, "precisionScale (1e18)");
        assertEq(p.weightFieldIndex, 1, "weightFieldIndex");
        assertEq(p.trustedSeeds.length, 2, "seed count");
        assertEq(p.trustedSeeds[0], 0x0101010101010101010101010101010101010101, "seed 0");
        // schema_uid in the file is ignored; the passed-in UID is used. Same for the two
        // params-schema v2 domain separators — the deploy, not the file, is their source of truth.
        assertEq(p.schemaUid, DUMMY_UID, "schemaUid override");
        assertEq(p.accumulator, DUMMY_ACC, "accumulator override");
        assertEq(p.chainId, DUMMY_CHAIN, "chainId override");
    }

    /// The read params hash to a stable, nonzero value, and the UID actually participates (changing
    /// it changes the hash) — i.e. the schema binding is live.
    function test_HashIsLiveAndUidBound() public view {
        bytes32 h1 = ParamsCodec.hash(ParamsJson.read(TEMPLATE, bytes32(uint256(1)), DUMMY_ACC, DUMMY_CHAIN));
        bytes32 h2 = ParamsCodec.hash(ParamsJson.read(TEMPLATE, bytes32(uint256(2)), DUMMY_ACC, DUMMY_CHAIN));
        assertTrue(h1 != bytes32(0), "hash nonzero");
        assertTrue(h1 != h2, "schema_uid must affect paramsHash");
    }

    /// The domain separators the deploy supplies are live in the hash too: two networks deployed
    /// from the SAME params.json, with the same schema UID, still get different `paramsHash`es
    /// because their accumulators differ (INSTANCE_FACTORY §6.1).
    function test_HashSeparatesInstancesAndChains() public view {
        bytes32 base = ParamsCodec.hash(ParamsJson.read(TEMPLATE, DUMMY_UID, DUMMY_ACC, DUMMY_CHAIN));
        bytes32 otherAcc = ParamsCodec.hash(ParamsJson.read(TEMPLATE, DUMMY_UID, address(0xACC1), DUMMY_CHAIN));
        bytes32 otherChain = ParamsCodec.hash(ParamsJson.read(TEMPLATE, DUMMY_UID, DUMMY_ACC, 1));
        assertTrue(base != otherAcc, "accumulator must affect paramsHash");
        assertTrue(base != otherChain, "chainId must affect paramsHash");
    }
}
