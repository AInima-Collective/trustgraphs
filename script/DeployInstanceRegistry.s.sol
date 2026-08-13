// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployInstanceRegistry
/// @notice Deploys the one-per-chain `InstanceRegistry` (MULTI_PROGRAM_PLATFORM §4): the on-chain
///         directory of trustgraphs deployments that frontends/indexers discover instances from.
///
/// The registry's admin (OPERATOR_ROLE + DEFAULT_ADMIN_ROLE) is the operational timelock. Like the
/// other deploy scripts it bootstraps to the deployer when no admin is supplied; a later governance
/// step (DeployTimelocks-style) transfers the role to the timelock. The deployed address is written to
/// `.docker/instance_registry_deploy.json` so the TypeScript deploy orchestration can thread it on.
contract DeployInstanceRegistry is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the InstanceRegistry.
    /// @param adminAddr The operational-timelock admin. If empty, falls back to the `INSTANCE_REGISTRY_ADMIN`
    ///        env var, and finally to the deployer address (bootstrap; transfer to the timelock later).
    /// @param outLabel Output-file discriminator: '' -> `.docker/instance_registry_deploy.json`, else
    ///        `.docker/instance_registry_<outLabel>_deploy.json`.
    /// @return registry The deployed `InstanceRegistry` address.
    function run(string calldata adminAddr, string calldata outLabel) public returns (address registry) {
        string memory script_output_path = string.concat(
            root,
            "/.docker/instance_registry",
            bytes(outLabel).length == 0 ? "" : string.concat("_", outLabel),
            "_deploy.json"
        );

        // Admin: prefer the explicit param, else the env var, else the deployer (bootstrap).
        address admin;
        if (bytes(adminAddr).length != 0) {
            admin = vm.parseAddress(adminAddr);
        } else {
            admin = vm.envOr("INSTANCE_REGISTRY_ADMIN", vm.addr(_privateKey));
        }
        require(admin != address(0), "DeployInstanceRegistry: admin is zero");

        vm.startBroadcast(_privateKey);

        InstanceRegistry instanceRegistry = new InstanceRegistry(admin);
        registry = address(instanceRegistry);

        vm.stopBroadcast();

        console.log("InstanceRegistry admin:", admin);
        console.log("InstanceRegistry deployed at:", registry);

        // Persist for the deploy orchestration.
        string memory _json = "json";
        _json.serialize("admin", Strings.toChecksumHexString(admin));
        string memory finalJson = _json.serialize("instance_registry", Strings.toChecksumHexString(registry));
        vm.writeFile(script_output_path, finalJson);
    }
}
