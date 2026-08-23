// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ContributionsFactory} from "src/factory/ContributionsFactory.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

import {Common} from "script/Common.s.sol";
import {ContributionsParamsJson} from "script/lib/ContributionsParamsJson.sol";

/// @title CreateDevContributionsRound
/// @notice Creates the local dev demo round **through the factory** (the `CreateDevInstances`
///         pattern): the dev stack exercises the exact one-transaction path a community's
///         authority uses from the app, and the indexer discovers the round from the factory's
///         creation event — no static config entry, no params-file write-back, no per-round
///         verifier or TestUSDC scaffolding. Replaces `DeployContributionsInstance` in the dev
///         deploy chain (that script stays only as a legacy reference).
///
/// @dev The broadcaster must hold the PARENT snapshot's `CONSTITUTIONAL_ROLE` — on a fresh dev
///      stack that is the deployer (CreateDevInstances names it the admin), so this must run
///      BEFORE `DeployTimelocks` hands authority off.
contract CreateDevContributionsRound is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Create one round against a parent trust network, through the factory.
    /// @param factoryAddr The `ContributionsFactory`.
    /// @param parentSnapshotAddr The PARENT trust network's `MerkleSnapshot` — resolved to its
    ///        registry instance id below (the dev deploy artifacts record addresses, not ids).
    /// @param paramsPath The contributions params file (serialized `contributions_core::Params`).
    ///        Only the tunable knobs are read; the three schema-UID fields are DERIVED by the
    ///        factory and the file is never written back.
    /// @param name The round's display name (part of its instance id).
    /// @param distributorTokenAddr The intended payout token (presentation only; "" = unset).
    /// @param distributorSafeAddr Initialized Safe that owns the round and its payout distributor.
    /// @param outLabel Output-file discriminator: `.docker/contributions_round_<outLabel>_deploy.json`.
    function run(
        string calldata factoryAddr,
        string calldata parentSnapshotAddr,
        string calldata paramsPath,
        string calldata name,
        string calldata distributorTokenAddr,
        string calldata distributorSafeAddr,
        string calldata outLabel
    ) public {
        ContributionsFactory factory = ContributionsFactory(vm.parseAddress(factoryAddr));
        address parentSnapshot = vm.parseAddress(parentSnapshotAddr);
        require(parentSnapshot != address(0), "CreateDevContributionsRound: parent snapshot is zero");
        address distributorToken =
            bytes(distributorTokenAddr).length == 0 ? address(0) : vm.parseAddress(distributorTokenAddr);
        address distributorSafe = vm.parseAddress(distributorSafeAddr);
        require(distributorSafe != address(0), "CreateDevContributionsRound: Safe is zero");

        // Resolve the parent's instance id from the registry: the factory's parent link is a
        // first-class registry key, and the dev artifacts only carry addresses.
        bytes32 parentInstanceId = _findInstanceIdBySnapshot(factory.INSTANCE_REGISTRY(), parentSnapshot);

        // The tunable knobs, with the derived schema-UID fields left at zero — the factory
        // rejects anything else, and fills them itself.
        ContributionsParamsCodec.Params memory params =
            ContributionsParamsJson.read(paramsPath, bytes32(0), bytes32(0), bytes32(0));

        _startBroadcast();

        (bytes32 instanceId, address snapshot, address resolver, address mirror, address distributor) = factory.createInstance(
            ContributionsFactory.CreateArgs({
                parentInstanceId: parentInstanceId,
                name: name,
                // The dev catalog's presentation comes from the indexer row, not IPFS.
                metadataURI: "",
                params: params,
                admin: distributorSafe,
                // Floor-clamped by the factory (one block locally).
                epochLength: 1,
                distributorToken: distributorToken,
                // Mix chain state into the salt so a re-run against a live chain creates a FRESH
                // round instead of reverting `InstanceAlreadyExists` (deploys stay re-runnable).
                salt: keccak256(abi.encode(block.number, block.timestamp))
            })
        );

        vm.stopBroadcast();

        console.log("contributions round", name);
        console.log("  id:         ", vm.toString(instanceId));
        console.log("  parent:     ", vm.toString(parentInstanceId));
        console.log("  snapshot:   ", snapshot);
        console.log("  resolver:   ", resolver);
        console.log("  mirror:     ", mirror);
        console.log("  distributor:", distributor);

        // The deploy-time record of this factory-minted round. The app's catalog of record is the
        // indexer's /contributions/instances route (built from the creation event); this file is
        // what the operator-side tooling reads when no indexer is running — taskfile/demo.yml and
        // taskfile/contributions.yml explicitly work without one, and the round seed driver
        // (packages/frontend/scripts/contribution-round.ts) falls back to it. The schema UIDs are derived
        // exactly as the factory derives them: keccak256(schema string ‖ resolver ‖ revocable).
        IInstanceRegistry registry = factory.INSTANCE_REGISTRY();
        string memory _json = "json";
        _json.serialize("name", name);
        _json.serialize("instance_id", vm.toString(instanceId));
        _json.serialize("parent_instance_id", vm.toString(parentInstanceId));
        _json.serialize("merkle_snapshot", Strings.toChecksumHexString(snapshot));
        _json.serialize("contribution_resolver", Strings.toChecksumHexString(resolver));
        _json.serialize("trust_accumulator_mirror", Strings.toChecksumHexString(mirror));
        _json.serialize("fund_distributor", Strings.toChecksumHexString(distributor));
        _json.serialize("params_controller", Strings.toChecksumHexString(registry.paramsAuthority(instanceId)));
        _json.serialize(
            "trust_accumulator",
            Strings.toChecksumHexString(registry.getInstance(parentInstanceId).registryOrAccumulator)
        );
        _json.serialize(
            "pool_token", distributorToken == address(0) ? "" : Strings.toChecksumHexString(distributorToken)
        );
        _json.serialize(
            "claim_schema_uid", vm.toString(keccak256(abi.encodePacked(factory.CLAIM_SCHEMA(), resolver, true)))
        );
        _json.serialize(
            "response_schema_uid", vm.toString(keccak256(abi.encodePacked(factory.RESPONSE_SCHEMA(), resolver, true)))
        );
        string memory finalJson = _json.serialize(
            "valuation_schema_uid", vm.toString(keccak256(abi.encodePacked(factory.VALUATION_SCHEMA(), resolver, true)))
        );
        vm.writeFile(string.concat(root, "/.docker/contributions_round_", outLabel, "_deploy.json"), finalJson);
    }

    /// @dev Scan the public directory for the instance whose snapshot matches. Dev-scale registries
    ///      hold a handful of rows, so enumeration is fine here (the app uses the indexer instead).
    function _findInstanceIdBySnapshot(IInstanceRegistry registry, address snapshot) internal view returns (bytes32) {
        bytes32[] memory ids = registry.getInstanceIds();
        for (uint256 i = 0; i < ids.length; i++) {
            if (registry.getInstance(ids[i]).snapshot == snapshot) {
                return ids[i];
            }
        }
        revert("CreateDevContributionsRound: parent snapshot not found in the registry");
    }
}
