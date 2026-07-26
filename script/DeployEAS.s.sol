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
import {SchemaRegistrar} from "../src/contracts/eas/SchemaRegistrar.sol";

import {EASIndexerResolver} from "../src/contracts/eas/resolvers/EASIndexerResolver.sol";
import {PayableEASIndexerResolver} from "../src/contracts/eas/resolvers/PayableEASIndexerResolver.sol";
import {AttesterEASIndexerResolver} from "../src/contracts/eas/resolvers/AttesterEASIndexerResolver.sol";

import {Common} from "./Common.s.sol";

/// @title DeployEAS
/// @notice Deployment script for EAS contracts (SchemaRegistry, EAS, SchemaRegistrar, resolvers)
contract DeployEAS is Common {
    using stdJson for string;

    string public root = vm.projectRoot();
    string public script_output_path = string.concat(root, "/.docker/eas_deploy.json");

    /// @notice Deploy EAS contracts
    function run() public {
        vm.startBroadcast(_privateKey);

        console.log("Deploying EAS contracts...");

        string memory _contractsJson = "contracts";
        // string memory _schemasJson = 'schemas';

        // Base network native EAS addresses (predeploy contracts)
        // See: https://docs.base.org/docs/contracts/
        address BASE_EAS = 0x4200000000000000000000000000000000000021;
        address BASE_SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

        uint256 chainId = block.chainid;
        bool isBase = (chainId == 8453 || chainId == 84532); // Base Mainnet (8453) or Base Sepolia (84532)
        bool isOptimism = (chainId == 10);

        SchemaRegistry schemaRegistry;
        EAS eas;

        if (isBase || isOptimism) {
            console.log("Detected Base/Optimism network (chainId:", chainId, ") - using native EAS contracts");
            schemaRegistry = SchemaRegistry(BASE_SCHEMA_REGISTRY);
            eas = EAS(BASE_EAS);
            console.log("Using Base/Optimism SchemaRegistry at:", address(schemaRegistry));
            console.log("Using Base/Optimism EAS at:", address(eas));
        } else {
            // Deploy our own EAS contracts for non-Base networks
            console.log("Deploying EAS contracts for chainId:", chainId);

            // 1. Deploy SchemaRegistry
            schemaRegistry = new SchemaRegistry();
            console.log("SchemaRegistry deployed at:", address(schemaRegistry));

            // 2. Deploy EAS
            eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
            console.log("EAS deployed at:", address(eas));
        }

        _contractsJson.serialize("schema_registry", Strings.toChecksumHexString(address(schemaRegistry)));
        _contractsJson.serialize("eas", Strings.toChecksumHexString(address(eas)));

        // 3. Deploy EASIndexerResolver
        // EASIndexerResolver indexerResolver = new EASIndexerResolver(
        //   IEAS(address(eas))
        // );
        // _contractsJson.serialize(
        //   'indexer_resolver',
        //   Strings.toChecksumHexString(address(indexerResolver))
        // );
        // console.log('EASIndexerResolver deployed at:', address(indexerResolver));

        // // 4. Deploy PayableEASIndexerResolver (0.001 ETH target value)
        // PayableEASIndexerResolver payableIndexerResolver = new PayableEASIndexerResolver(
        //     IEAS(address(eas)),
        //     0.001 ether, // Target value for attestations
        //     msg.sender // Owner (deployer)
        // );
        // _contractsJson.serialize(
        //     "payable_indexer_resolver", Strings.toChecksumHexString(address(payableIndexerResolver))
        // );
        // console.log("PayableEASIndexerResolver deployed at:", address(payableIndexerResolver));

        // 5. Deploy SchemaRegistrar
        SchemaRegistrar schemaRegistrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        string memory finalContractsJson =
            _contractsJson.serialize("schema_registrar", Strings.toChecksumHexString(address(schemaRegistrar)));
        console.log("SchemaRegistrar deployed at:", address(schemaRegistrar));

        // // 6. Register basic schemas
        // console.log('Registering schemas...');

        // // Vouching schema for weighted endorsements
        // createSchema(
        //   schemaRegistrar,
        //   _schemasJson,
        //   address(indexerResolver),
        //   'vouching',
        //   'Weighted endorsement',
        //   'string comment,uint256 confidence',
        //   true
        // );

        // string memory finalSchemasJson = vm.serializeString(_schemasJson, '_', '_');

        vm.stopBroadcast();

        // string memory rootJson = 'root';
        // rootJson.serialize('contracts', finalContractsJson);
        // rootJson = rootJson.serialize('schemas', finalSchemasJson);
        vm.writeFile(script_output_path, finalContractsJson);

        // Log deployment summary
        console.log("\n=== EAS Deployment Summary ===");
        console.log("SchemaRegistry:", address(schemaRegistry));
        console.log("EAS:", address(eas));
        console.log("SchemaRegistrar:", address(schemaRegistrar));
        // console.log('EASIndexerResolver:', address(indexerResolver));
        // console.log('PayableEASIndexerResolver:', address(payableIndexerResolver));
        // console.log(
        //   'AttesterEASIndexerResolver:',
        //   address(attesterIndexerResolver)
        // );
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
