// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {stdJson} from "forge-std/StdJson.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {console} from "forge-std/console.sol";
import {
    ISchemaRegistry,
    SchemaRegistry
} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS, EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {SchemaRegistrar} from "../src/eas/SchemaRegistrar.sol";

import {EASIndexerResolver} from "../src/eas/resolvers/EASIndexerResolver.sol";
import {PayableEASIndexerResolver} from "../src/eas/resolvers/PayableEASIndexerResolver.sol";
import {AttesterEASIndexerResolver} from "../src/eas/resolvers/AttesterEASIndexerResolver.sol";

import {Common} from "./Common.s.sol";

/// @title DeployEAS
/// @notice Deployment script for EAS contracts (SchemaRegistry, EAS, SchemaRegistrar, resolvers)
contract DeployEAS is Common {
    using stdJson for string;

    error ExplicitEASAddressesRequired(uint256 chainId);
    error ExternalContractHasNoCode(address target);

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/eas_deploy.json");

    /// @notice Deploy EAS contracts
    function run() public {
        // Base network native EAS addresses (predeploy contracts)
        // See: https://docs.base.org/docs/contracts/
        address BASE_EAS = 0x4200000000000000000000000000000000000021;
        address BASE_SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

        uint256 chainId = block.chainid;
        bool isBase = (chainId == 8453 || chainId == 84532); // Base Mainnet (8453) or Base Sepolia (84532)
        bool isOptimism = (chainId == 10);

        if (isBase || isOptimism) {
            _requireCode(BASE_EAS);
            _requireCode(BASE_SCHEMA_REGISTRY);
            _deployRegistrar(EAS(BASE_EAS), SchemaRegistry(BASE_SCHEMA_REGISTRY));
            return;
        }
        if (chainId != 31337) revert ExplicitEASAddressesRequired(chainId);

        _startBroadcast();
        SchemaRegistry schemaRegistry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        _finishRegistrarDeployment(eas, schemaRegistry);
    }

    /// @notice Reuse canonical public-chain EAS contracts and deploy only Trustgraphs' registrar.
    function run(string memory easAddress, string memory schemaRegistryAddress) public {
        address eas = vm.parseAddress(easAddress);
        address schemaRegistry = vm.parseAddress(schemaRegistryAddress);
        _requireCode(eas);
        _requireCode(schemaRegistry);
        _deployRegistrar(EAS(eas), SchemaRegistry(schemaRegistry));
    }

    function _deployRegistrar(EAS eas, SchemaRegistry schemaRegistry) internal {
        _startBroadcast();
        _finishRegistrarDeployment(eas, schemaRegistry);
    }

    function _finishRegistrarDeployment(EAS eas, SchemaRegistry schemaRegistry) internal {
        string memory contractsJson = "contracts";
        contractsJson.serialize("schema_registry", Strings.toChecksumHexString(address(schemaRegistry)));
        contractsJson.serialize("eas", Strings.toChecksumHexString(address(eas)));
        SchemaRegistrar schemaRegistrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        string memory finalContractsJson =
            contractsJson.serialize("schema_registrar", Strings.toChecksumHexString(address(schemaRegistrar)));
        vm.stopBroadcast();
        vm.writeFile(script_output_path, finalContractsJson);

        console.log("\n=== EAS Deployment Summary ===");
        console.log("SchemaRegistry:", address(schemaRegistry));
        console.log("EAS:", address(eas));
        console.log("SchemaRegistrar:", address(schemaRegistrar));
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert ExternalContractHasNoCode(target);
    }

    //   /// @notice Create a new schema
    //   function createSchema(
    //     SchemaRegistrar schemaRegistrar,
    //     string memory schemasJson,
    //     address resolverAddr,
    //     string memory key,
    //     string memory description,
    //     string memory schema,
    //     bool revocable
    //   ) public returns (bytes32) {
    //     string memory newSchemaJson = string.concat(key, '_json');

    //     bytes32 uid = schemaRegistrar.register(
    //       schema,
    //       ISchemaResolver(resolverAddr),
    //       revocable
    //     );
    //     console.log(key, 'schema ID:', vm.toString(uid));

    //     newSchemaJson.serialize('description', description);
    //     newSchemaJson.serialize('schema', schema);
    //     newSchemaJson.serialize('resolver', vm.toString(resolverAddr));
    //     vm.serializeBool(newSchemaJson, 'revocable', revocable);
    //     newSchemaJson = newSchemaJson.serialize('uid', vm.toString(uid));

    //     // Add the new schema to the schemas JSON
    //     schemasJson.serialize(key, newSchemaJson);

    //     return uid;
    //   }
}
