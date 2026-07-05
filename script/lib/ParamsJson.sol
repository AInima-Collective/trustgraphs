// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";

import {ParamsCodec} from "contracts/params/ParamsCodec.sol";

/// @title ParamsJson
/// @notice Reads a governance `params.json` (the same file the prover feeds to the SP1 guest,
///         serialized `pagerank_core::Params`) into a `ParamsCodec.Params`. The `schema_uid` field
///         in the file is IGNORED — the deploy is the source of truth for it and passes the freshly
///         registered UID in via `schemaUid`, so the on-chain `paramsHash` can be computed in one
///         pass (no precomputed-hash env var, no two-phase bootstrap).
/// @dev    U256 fields are stored as 0x-hex strings (alloy `U256` serde); `parseJsonUint` coerces
///         both those and plain JSON numbers.
library ParamsJson {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function read(string memory path, bytes32 schemaUid)
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
        p.schemaUid = schemaUid;
    }
}
