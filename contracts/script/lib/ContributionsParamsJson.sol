// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";

import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";

/// @title ContributionsParamsJson
/// @notice Reads a contributions `params.contributions.json` (serialized
///         `contributions_core::Params`, snake_case — the same file the contributions prover feeds
///         the SP1 guest) into a `ContributionsParamsCodec.Params`. The three schema-UID fields are
///         NOT read from the file: the deploy is the source of truth for them and passes the
///         freshly registered UIDs in, so the on-chain `paramsHash` is computed in one pass
///         (no precomputed-hash env var, no two-phase bootstrap) — same pattern as `ParamsJson`.
/// @dev    U256 fields are stored as 0x-hex strings (alloy `U256` serde); `parseJsonUint` coerces
///         both those and plain JSON numbers.
library ContributionsParamsJson {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function read(string memory path, bytes32 claimSchemaUid, bytes32 responseSchemaUid, bytes32 valuationSchemaUid)
        internal
        view
        returns (ContributionsParamsCodec.Params memory p)
    {
        string memory j = vm.readFile(path);
        p.dampingFp = vm.parseJsonUint(j, ".damping_fp");
        p.toleranceFp = vm.parseJsonUint(j, ".tolerance_fp");
        p.maxIterations = uint32(vm.parseJsonUint(j, ".max_iterations"));
        p.minWeightFp = vm.parseJsonUint(j, ".min_weight_fp");
        p.maxWeightFp = vm.parseJsonUint(j, ".max_weight_fp");
        p.trustShareFp = vm.parseJsonUint(j, ".trust_share_fp");
        p.trustDecayFp = vm.parseJsonUint(j, ".trust_decay_fp");
        p.trustedSeeds = vm.parseJsonAddressArray(j, ".trusted_seeds");
        p.precisionScale = vm.parseJsonUint(j, ".precision_scale");
        p.weightFieldIndex = uint32(vm.parseJsonUint(j, ".weight_field_index"));
        p.roundStart = uint64(vm.parseJsonUint(j, ".round_start"));
        p.roundEnd = uint64(vm.parseJsonUint(j, ".round_end"));
        p.unacceptedMultFp = vm.parseJsonUint(j, ".unaccepted_mult_fp");
        p.collaboratorMultFp = vm.parseJsonUint(j, ".collaborator_mult_fp");
        p.minRaterRepFp = vm.parseJsonUint(j, ".min_rater_rep_fp");
        p.evaluatorCarveoutBps = uint32(vm.parseJsonUint(j, ".evaluator_carveout_bps"));
        p.totalPool = vm.parseJsonUint(j, ".total_pool");
        p.claimSchemaUid = claimSchemaUid;
        p.responseSchemaUid = responseSchemaUid;
        p.valuationSchemaUid = valuationSchemaUid;
    }
}
