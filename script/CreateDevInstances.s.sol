// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {ParamsJson} from "script/lib/ParamsJson.sol";

import {Common} from "script/Common.s.sol";

/// @title CreateDevInstances
/// @notice Creates the local dev-seed networks **through the factory**, so there is exactly one
///         catalog: everything a community can create, the dev stack creates the same way.
///
/// @dev This replaces `DeployNetwork` in the dev deploy chain. It still writes the legacy
///      `config/network_deploy_<env>_<i>.json` files because the rest of the local stack consumes
///      them (`DeployZodiacSafes`, `DeployTimelocks`, `DeployContributionsInstance`, and the
///      networks-config merge in `deploy/env.ts`). Those files are now a DERIVED artifact of the
///      on-chain event, not a second source of truth — the indexer catalogs instances from
///      `InstanceCreated` directly.
contract CreateDevInstances is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Create `count` instances via the factory.
    /// @param factoryAddr The `TrustgraphsFactory`.
    /// @param paramsPath The governance params file (its `schema_uid` / `accumulator` / `chain_id`
    ///        are ignored — the factory derives all three).
    /// @param templatePath The networks config TEMPLATE, read for each instance's display name.
    /// @param env Output-file environment suffix (`dev`).
    /// @param firstIndex Index of the first network to create.
    /// @param count How many to create.
    /// @param withDistributor Whether each instance gets a fund distributor.
    /// @param prepayWei ETH deposited into each instance's proving tank during creation.
    /// @param maxPerRootUsd Optional initial proving policy, set before governance is handed off.
    function run(
        string calldata factoryAddr,
        string calldata paramsPath,
        string calldata templatePath,
        string calldata env,
        uint256 firstIndex,
        uint256 count,
        bool withDistributor,
        uint256 prepayWei,
        uint96 maxPerRootUsd
    ) public {
        TrustgraphsFactory factory = TrustgraphsFactory(vm.parseAddress(factoryAddr));
        address deployer = vm.addr(_privateKey);
        string memory template = vm.readFile(templatePath);
        require(maxPerRootUsd == 0 || prepayWei > 0, "CreateDevInstances: policy needs a funded tank");

        // The governance knobs, with every derived (instance-identity) field left at zero — the
        // factory rejects anything else, and fills them itself.
        ParamsCodec.Params memory params = ParamsJson.read(paramsPath, bytes32(0), address(0), 0);

        vm.startBroadcast(_privateKey);

        for (uint256 i = firstIndex; i < firstIndex + count; i++) {
            string memory name = template.readString(string.concat("$[", Strings.toString(i), "].name"));

            (bytes32 instanceId, address snapshot, address resolver, address distributor, bytes32 schemaUid) = factory.createInstance{
                value: prepayWei
            }(
                TrustgraphsFactory.CreateArgs({
                    name: name,
                    // The dev catalog's presentation comes from the networks template, not IPFS.
                    metadataURI: "",
                    params: params,
                    admin: deployer,
                    // Floor-clamped by the factory; on a devnet the floor is small so triggers are
                    // not the thing that slows a local proving loop down.
                    epochLength: 1,
                    withDistributor: withDistributor,
                    distributorToken: address(0),
                    // Mix the chain's current state into the salt so a re-run against a live
                    // chain creates FRESH instances instead of reverting `InstanceAlreadyExists`
                    // on a deterministic id. `pnpm deploy:contracts` has to stay re-runnable.
                    salt: keccak256(abi.encode(i, block.number, block.timestamp))
                })
            );

            // This must happen before DeployTimelocks renounces the deployer's constitutional
            // role. A post-deploy demo task cannot set policy without waiting out that timelock.
            if (maxPerRootUsd > 0) {
                factory.VAULT().setPolicy(instanceId, 0, maxPerRootUsd);
            }

            console.log("instance", i, name);
            console.log("  id:       ", vm.toString(instanceId));
            console.log("  snapshot: ", snapshot);
            console.log("  resolver: ", resolver);

            address controller = factory.INSTANCE_REGISTRY().paramsAuthority(instanceId);
            require(controller != address(0), "CreateDevInstances: missing params controller");

            _writeNetworkDeployJson(
                env,
                i,
                deployer,
                snapshot,
                resolver,
                distributor,
                controller,
                schemaUid,
                factory.VOUCH_SCHEMA(),
                withDistributor
            );

            // Keep the prover's params file in sync for a single-instance run, exactly as
            // DeployNetwork does (multi-instance runs need one params file per instance, or —
            // better — the M5 loop, which reads all three derived fields off the chain).
            if (count == 1) {
                vm.writeJson(vm.toString(schemaUid), paramsPath, ".schema_uid");
                vm.writeJson(vm.toString(resolver), paramsPath, ".accumulator");
                vm.writeJson(vm.toString(block.chainid), paramsPath, ".chain_id");
            }
        }

        vm.stopBroadcast();
    }

    /// @dev Write the legacy per-network deploy file the local stack still reads.
    function _writeNetworkDeployJson(
        string calldata env,
        uint256 index,
        address deployer,
        address snapshot,
        address resolver,
        address distributor,
        address controller,
        bytes32 schemaUid,
        string memory vouchSchema,
        bool withDistributor
    ) internal {
        string memory contractsJson = string.concat("contracts", Strings.toString(index));
        vm.serializeString(contractsJson, "eas_indexer_resolver", Strings.toChecksumHexString(resolver));
        if (withDistributor) {
            vm.serializeString(contractsJson, "fund_distributor", Strings.toChecksumHexString(distributor));
        }
        vm.serializeString(contractsJson, "params_controller", Strings.toChecksumHexString(controller));
        string memory finalContractsJson =
            vm.serializeString(contractsJson, "merkle_snapshot", Strings.toChecksumHexString(snapshot));

        string memory vouchingJson = string.concat("vouching", Strings.toString(index));
        vm.serializeString(vouchingJson, "uid", vm.toString(schemaUid));
        vm.serializeString(vouchingJson, "key", "vouching");
        vm.serializeString(vouchingJson, "name", "Vouch");
        vm.serializeString(vouchingJson, "description", "Weighted endorsement");
        vm.serializeString(vouchingJson, "schema", vouchSchema);
        vm.serializeBool(vouchingJson, "revocable", true);
        string memory finalVouchingJson =
            vm.serializeString(vouchingJson, "resolver", Strings.toChecksumHexString(resolver));

        string memory schemasJson = string.concat("schemas", Strings.toString(index));
        string memory finalSchemasJson = vm.serializeString(schemasJson, "vouching", finalVouchingJson);

        string memory rootJson = string.concat("root", Strings.toString(index));
        vm.serializeString(rootJson, "deployer", Strings.toChecksumHexString(deployer));
        vm.serializeString(rootJson, "contracts", finalContractsJson);
        rootJson = vm.serializeString(rootJson, "schemas", finalSchemasJson);

        vm.writeFile(
            string.concat(root, "/config/network_deploy_", env, "_", Strings.toString(index), ".json"), rootJson
        );
    }
}
