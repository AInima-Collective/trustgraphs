// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ISchemaRegistry, SchemaRecord} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {Common} from "script/Common.s.sol";
import {console} from "forge-std/console.sol";

/// @title EasSchema
/// @notice Comprehensive script for EAS schema registration and management
/// @dev Consolidates all EAS schema registration and query functionality
contract EasSchema is Common {
    // ============================================================
    // REGISTRATION FUNCTIONS
    // ============================================================

    /// @notice Register a new schema with custom resolver
    /// @param registrarAddr Address of the schema registrar contract
    /// @param schema The schema definition string
    /// @param resolverAddr Address of the schema resolver (use 0x0 for no resolver)
    /// @param revocable Whether attestations using this schema can be revoked
    function registerSchema(
        string calldata registrarAddr,
        string calldata schema,
        string calldata resolverAddr,
        bool revocable
    ) public {
        _startBroadcast();

        SchemaRegistrar registrar = SchemaRegistrar(vm.parseAddress(registrarAddr));

        ISchemaResolver resolver = ISchemaResolver(vm.parseAddress(resolverAddr));

        console.log("Registering new EAS schema:");
        console.log("Schema:", schema);
        console.log("Resolver:", resolverAddr);
        console.log("Revocable:", revocable);

        bytes32 schemaUID = registrar.register(schema, resolver, revocable);

        console.log("Schema registered successfully!");
        console.log("Schema UID:", vm.toString(schemaUID));

        // Output JSON for easy extraction
        console.log("SCHEMA_REGISTRATION_RESULT:");
        console.log(
            string.concat(
                '{"schema_uid":"',
                vm.toString(schemaUID),
                '","schema":"',
                schema,
                '","resolver":"',
                resolverAddr,
                '","revocable":',
                revocable ? "true" : "false",
                "}"
            )
        );

        vm.stopBroadcast();
    }

    /// @notice Register a schema directly with the registry (no registrar contract)
    /// @param registryAddr Address of the EAS schema registry
    /// @param schema The schema definition string
    /// @param resolverAddr Address of the schema resolver (use 0x0 for no resolver)
    /// @param revocable Whether attestations using this schema can be revoked
    function registerSchemaDirect(
        string calldata registryAddr,
        string memory schema,
        string calldata resolverAddr,
        bool revocable
    ) public {
        _startBroadcast();

        ISchemaRegistry registry = ISchemaRegistry(vm.parseAddress(registryAddr));

        ISchemaResolver resolver = ISchemaResolver(vm.parseAddress(resolverAddr));

        console.log("Registering schema directly with registry:");
        console.log("Schema:", schema);
        console.log("Resolver:", resolverAddr);
        console.log("Revocable:", revocable);

        bytes32 schemaUID = registry.register(schema, resolver, revocable);

        console.log("Schema registered successfully!");
        console.log("Schema UID:", vm.toString(schemaUID));

        // Output JSON for easy extraction
        console.log("SCHEMA_REGISTRATION_RESULT:");
        console.log(
            string.concat(
                '{"schema_uid":"',
                vm.toString(schemaUID),
                '","schema":"',
                schema,
                '","resolver":"',
                resolverAddr,
                '","revocable":',
                revocable ? "true" : "false",
                "}"
            )
        );

        vm.stopBroadcast();
    }

    // ============================================================
    // QUERY FUNCTIONS
    // ============================================================

    /// @notice Query schema details by UID
    /// @param registryAddr Address of the EAS schema registry
    /// @param schemaUID The schema UID to query
    function showSchema(string calldata registryAddr, string calldata schemaUID) public view {
        ISchemaRegistry registry = ISchemaRegistry(vm.parseAddress(registryAddr));

        bytes32 uid = vm.parseBytes32(schemaUID);

        try registry.getSchema(uid) returns (SchemaRecord memory record) {
            console.log("Schema Details:");
            console.log("  UID:", schemaUID);
            console.log("  Schema:", record.schema);
            console.log("  Resolver:", vm.toString(address(record.resolver)));
            console.log("  Revocable:", record.revocable);
        } catch {
            console.log("Schema not found or invalid UID:", schemaUID);
        }
    }

    /// @notice Check if a schema exists
    /// @param registryAddr Address of the EAS schema registry
    /// @param schemaUID The schema UID to check
    function schemaExists(string calldata registryAddr, string calldata schemaUID) public view returns (bool) {
        ISchemaRegistry registry = ISchemaRegistry(vm.parseAddress(registryAddr));

        bytes32 uid = vm.parseBytes32(schemaUID);
        SchemaRecord memory record = registry.getSchema(uid);

        bool exists = record.uid != EMPTY_UID;
        console.log("Schema exists:", exists);

        return exists;
    }

    /// @notice List all registered schemas (limited view - shows recent activity)
    /// @param registryAddr Address of the EAS schema registry
    function listRecentSchemas(string calldata registryAddr) public pure {
        console.log("Listing recent schemas for registry:", registryAddr);
        console.log("Note: Use external indexing services or event logs for comprehensive schema lists");
        console.log("Registry address:", registryAddr);
    }

    // ============================================================
    // UTILITY FUNCTIONS
    // ============================================================

    /// @notice Generate a deterministic schema UID preview (before registration)
    /// @param schema The schema definition string
    /// @param resolverAddr The resolver address
    /// @param revocable Whether the schema is revocable
    function previewSchemaUID(string calldata schema, string calldata resolverAddr, bool revocable) public pure {
        // Note: This is a simplified preview - actual UID generation includes more context
        bytes32 preview = keccak256(abi.encodePacked(schema, resolverAddr, revocable));

        console.log("Schema UID Preview (approximate):");
        console.log("  Schema:", schema);
        console.log("  Resolver:", resolverAddr);
        console.log("  Revocable:", revocable);
        console.log("  Preview UID:", vm.toString(preview));
        console.log("Note: Actual UID will differ - this is for reference only");
    }

    /// @notice Validate schema definition syntax
    /// @param schema The schema definition to validate
    function validateSchema(string calldata schema) public pure {
        bytes memory schemaBytes = bytes(schema);

        console.log("Validating schema:", schema);
        console.log("Schema length:", schemaBytes.length);

        if (schemaBytes.length == 0) {
            console.log("ERROR: Schema cannot be empty");
            return;
        }

        // Basic validation - check for common patterns
        bool hasType = _containsPattern(schema, "uint") || _containsPattern(schema, "string")
            || _containsPattern(schema, "bool") || _containsPattern(schema, "bytes")
            || _containsPattern(schema, "address");

        if (!hasType) {
            console.log("WARNING: Schema doesn't appear to contain valid types");
        } else {
            console.log("Schema appears valid");
        }

        console.log("Remember: Schema format should be like 'string name,uint256 value,bool flag'");
    }

    /// @notice Helper function to check if a string contains a pattern
    /// @param source The source string to search in
    /// @param pattern The pattern to search for
    /// @return True if pattern is found
    function _containsPattern(string memory source, string memory pattern) internal pure returns (bool) {
        bytes memory sourceBytes = bytes(source);
        bytes memory patternBytes = bytes(pattern);

        if (patternBytes.length > sourceBytes.length) {
            return false;
        }

        for (uint256 i = 0; i <= sourceBytes.length - patternBytes.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < patternBytes.length; j++) {
                if (sourceBytes[i + j] != patternBytes[j]) {
                    found = false;
                    break;
                }
            }
            if (found) {
                return true;
            }
        }

        return false;
    }
}
