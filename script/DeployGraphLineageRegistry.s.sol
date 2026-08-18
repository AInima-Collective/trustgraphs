// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {GraphLineageRegistry} from "contracts/registry/GraphLineageRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {Common} from "script/Common.s.sol";

/// @title DeployGraphLineageRegistry
/// @notice Deploy the optional, one-per-InstanceRegistry advisory lineage plane.
contract DeployGraphLineageRegistry is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    function run(string calldata instanceRegistryAddr) public returns (address registry) {
        address instanceRegistry = vm.parseAddress(instanceRegistryAddr);
        require(instanceRegistry != address(0), "DeployGraphLineageRegistry: instance registry is zero");

        vm.startBroadcast(_privateKey);
        registry = address(new GraphLineageRegistry(IInstanceRegistry(instanceRegistry)));
        vm.stopBroadcast();

        console.log("GraphLineageRegistry:", registry);
        console.log("  InstanceRegistry:", instanceRegistry);
        string memory output = "graphLineage";
        vm.serializeAddress(output, "instance_registry", instanceRegistry);
        string memory json = vm.serializeAddress(output, "registry", registry);
        vm.writeJson(json, string.concat(root, "/.docker/graph_lineage_deploy.json"));
    }
}
