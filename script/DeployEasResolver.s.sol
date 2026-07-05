// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {
    ISchemaRegistry,
    SchemaRegistry
} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS, EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {
    ISchemaResolver
} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";

/// @title DeployEasResolver
/// @notice The MINIMAL deploy the input-exporter e2e needs: EAS + the EASIndexerResolver (which is
///         the AttestationAccumulator) + a `(string comment, uint256 confidence)` schema wired to it.
///         No MerkleSnapshot / verifier / timelocks — `checkpoint()` is permissionless on the resolver.
contract DeployEasResolver is Script {
    function run() external {
        vm.startBroadcast();

        SchemaRegistry registry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(registry)));
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        SchemaRegistrar registrar = new SchemaRegistrar(ISchemaRegistry(address(registry)));
        // Schema shape matches params.weight_field_index = 1 (confidence in ABI head slot 1).
        bytes32 schemaUid = registrar.register(
            "string comment,uint256 confidence", ISchemaResolver(address(resolver)), true
        );

        vm.stopBroadcast();

        string memory json = "e2e";
        vm.serializeAddress(json, "eas", address(eas));
        vm.serializeAddress(json, "resolver", address(resolver));
        vm.serializeAddress(json, "schema_registrar", address(registrar));
        string memory out = vm.serializeBytes32(json, "schema_uid", schemaUid);
        vm.writeFile("test/e2e/deploy.json", out);

        console.log("EAS:      ", address(eas));
        console.log("RESOLVER: ", address(resolver));
        console.log("REGISTRAR:", address(registrar));
        console.log("SCHEMA_UID:");
        console.logBytes32(schemaUid);
    }
}
