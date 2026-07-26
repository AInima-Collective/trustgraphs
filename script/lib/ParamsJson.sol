// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";

import {ParamsCodec} from "contracts/params/ParamsCodec.sol";

/// @title ParamsJson
/// @notice Reads a governance `params.json` (the same file the prover feeds to the SP1 guest,
///         serialized `pagerank_core::Params`) into a `ParamsCodec.Params`. Three fields in the
///         file are IGNORED because the deploy is their source of truth and supplies them here:
///         `schema_uid` (the freshly registered UID), and the params-schema v2 domain separators
///         `accumulator` (this instance's resolver) and `chain_id`. That keeps `paramsHash`
///         computable in one pass (no precomputed-hash env var, no two-phase bootstrap) and makes
///         it impossible for a stale file to bind an instance to another instance's domain.
/// @dev    U256 fields are stored as 0x-hex strings (alloy `U256` serde); `parseJsonUint` coerces
///         both those and plain JSON numbers.
library ParamsJson {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function read(string memory path, bytes32 schemaUid, address accumulator, uint64 chainId)
        internal
        view
        returns (ParamsCodec.Params memory p)
    {
        string memory j = vm.readFile(path);
        p.dampingFp = vm.parseJsonUint(j, ".damping_fp");
        p.toleranceFp = vm.parseJsonUint(j, ".tolerance_fp");
        p.maxIterations = uint32(vm.parseJsonUint(j, ".max_iterations"));
        p.minWeightFp = vm.parseJsonUint(j, ".min_weight_fp");
        p.maxWeightFp = vm.parseJsonUint(j, ".max_weight_fp");
        p.trustMultiplierFp = vm.parseJsonUint(j, ".trust_multiplier_fp");
        p.trustShareFp = vm.parseJsonUint(j, ".trust_share_fp");
        p.trustDecayFp = vm.parseJsonUint(j, ".trust_decay_fp");
        p.trustedSeeds = vm.parseJsonAddressArray(j, ".trusted_seeds");
        p.totalPool = vm.parseJsonUint(j, ".total_pool");
        p.precisionScale = vm.parseJsonUint(j, ".precision_scale");
        p.weightFieldIndex = uint32(vm.parseJsonUint(j, ".weight_field_index"));

        // Lane-2 fields. These ARE part of `paramsHash`, so skipping them (as this reader used to)
        // silently computes a lane-1 hash for a lane-2 network — the same class of bug the v2
        // domain separators were added to prevent. Optional in the file because `pagerank_core`
        // defaults both, and every lane-1 params.json in the repo omits them.
        if (vm.keyExistsJson(j, ".envelope0_domain_separators")) {
            p.envelope0DomainSeparators = vm.parseJsonBytes32Array(j, ".envelope0_domain_separators");
        }
        if (vm.keyExistsJson(j, ".lane2_max_head_age")) {
            p.lane2MaxHeadAge = uint64(vm.parseJsonUint(j, ".lane2_max_head_age"));
        }

        p.schemaUid = schemaUid;
        p.accumulator = accumulator;
        p.chainId = chainId;
    }
}
