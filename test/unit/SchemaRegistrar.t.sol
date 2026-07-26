// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {SchemaRegistrar} from "../../src/contracts/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "../../src/contracts/eas/resolvers/EASIndexerResolver.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry, SchemaRecord} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

contract SchemaRegistrarTest is Test {
    SchemaRegistrar public registrar;
    SchemaRegistry public schemaRegistry;
    EASIndexerResolver public resolver;
    EAS public eas;

    address constant ZERO_ADDRESS = address(0);
    string constant VALID_SCHEMA = "uint256 value";
    string constant EMPTY_SCHEMA = "";

    function setUp() public {
        // Deploy contracts
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        resolver = new EASIndexerResolver(IEAS(address(eas)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
    }

    function testConstruction_ShouldInitializeCorrectly() public view {
        // Verify the registrar was created successfully
        // We can't directly test internal state, so we test functionality instead
        assertTrue(address(registrar) != ZERO_ADDRESS);
    }

    function testConstruction_ShouldRevertWithInvalidSchemaRegistry() public {
        vm.expectRevert(SchemaRegistrar.InvalidSchemaRegistry.selector);
        new SchemaRegistrar(ISchemaRegistry(ZERO_ADDRESS));
    }

    function testRegister_ShouldRegisterValidSchema() public {
        bytes32 schemaId = registrar.register(VALID_SCHEMA, ISchemaResolver(address(resolver)), true);

        // Verify the schema was registered
        assertTrue(schemaId != bytes32(0));

        // Verify the schema exists in the registry
        SchemaRecord memory schemaRecord = schemaRegistry.getSchema(schemaId);

        assertEq(schemaRecord.uid, schemaId);
        assertEq(address(schemaRecord.resolver), address(resolver));
        assertTrue(schemaRecord.revocable);
        assertEq(schemaRecord.schema, VALID_SCHEMA);
    }

    function testRegister_ShouldRegisterNonRevocableSchema() public {
        bytes32 schemaId = registrar.register(VALID_SCHEMA, ISchemaResolver(address(resolver)), false);

        // Verify the schema was registered with correct revocable flag
        SchemaRecord memory schemaRecord = schemaRegistry.getSchema(schemaId);

        assertEq(schemaRecord.uid, schemaId);
        assertEq(address(schemaRecord.resolver), address(resolver));
        assertFalse(schemaRecord.revocable);
        assertEq(schemaRecord.schema, VALID_SCHEMA);
    }

    function testRegister_ShouldRegisterMultipleSchemas() public {
        string[] memory schemas = new string[](3);
        schemas[0] = "uint256 value1";
        schemas[1] = "string name";
        schemas[2] = "bool flag,uint256 timestamp";

        bytes32[] memory schemaIds = new bytes32[](3);

        for (uint256 i = 0; i < schemas.length; i++) {
            schemaIds[i] = registrar.register(schemas[i], ISchemaResolver(address(resolver)), true);

            // Verify each schema is unique
            assertTrue(schemaIds[i] != bytes32(0));

            // Verify schema details
            SchemaRecord memory schemaRecord = schemaRegistry.getSchema(schemaIds[i]);

            assertEq(schemaRecord.uid, schemaIds[i]);
            assertEq(address(schemaRecord.resolver), address(resolver));
            assertTrue(schemaRecord.revocable);
            assertEq(schemaRecord.schema, schemas[i]);
        }

        // Verify all schemas are different
        for (uint256 i = 0; i < schemaIds.length; i++) {
            for (uint256 j = i + 1; j < schemaIds.length; j++) {
                assertTrue(schemaIds[i] != schemaIds[j]);
            }
        }
    }

    function testRegister_ShouldRevertWithEmptySchema() public {
        vm.expectRevert(SchemaRegistrar.InvalidSchema.selector);
        registrar.register(EMPTY_SCHEMA, ISchemaResolver(address(resolver)), true);
    }

    function testRegister_ShouldHandleComplexSchemas() public {
        string memory complexSchema = "uint256 id,string name,bool active,bytes32 hash,address owner,uint64 timestamp";

        bytes32 schemaId = registrar.register(complexSchema, ISchemaResolver(address(resolver)), true);

        // Verify the complex schema was registered correctly
        SchemaRecord memory schemaRecord = schemaRegistry.getSchema(schemaId);

        assertEq(schemaRecord.uid, schemaId);
        assertEq(address(schemaRecord.resolver), address(resolver));
        assertTrue(schemaRecord.revocable);
        assertEq(schemaRecord.schema, complexSchema);
    }

    function testRegister_ShouldHandleVeryLongSchema() public {
        // Create a very long schema string
        string memory longSchema =
            "uint256 field1,uint256 field2,uint256 field3,uint256 field4,uint256 field5,uint256 field6,uint256 field7,uint256 field8,uint256 field9,uint256 field10,string veryLongFieldName,bytes32 anotherLongFieldName,address yetAnotherLongFieldName";

        bytes32 schemaId = registrar.register(longSchema, ISchemaResolver(address(resolver)), false);

        // Verify the long schema was registered correctly
        SchemaRecord memory schemaRecord = schemaRegistry.getSchema(schemaId);

        assertEq(schemaRecord.uid, schemaId);
        assertEq(address(schemaRecord.resolver), address(resolver));
        assertFalse(schemaRecord.revocable);
        assertEq(schemaRecord.schema, longSchema);
    }

    function testRegister_ShouldReturnUniqueIdsForDifferentSchemas() public {
        bytes32 schemaId1 = registrar.register("uint256 value", ISchemaResolver(address(resolver)), true);

        bytes32 schemaId2 = registrar.register("string name", ISchemaResolver(address(resolver)), true);

        // Schema IDs should be different
        assertTrue(schemaId1 != schemaId2);
        assertTrue(schemaId1 != bytes32(0));
        assertTrue(schemaId2 != bytes32(0));
    }

    function testRegister_ShouldAllowSameSchemaWithDifferentResolvers() public {
        // Create another resolver for testing
        EASIndexerResolver resolver2 = new EASIndexerResolver(IEAS(address(eas)));

        bytes32 schemaId1 = registrar.register(VALID_SCHEMA, ISchemaResolver(address(resolver)), true);

        bytes32 schemaId2 = registrar.register(VALID_SCHEMA, ISchemaResolver(address(resolver2)), true);

        // Should create different schema IDs even with same schema string
        assertTrue(schemaId1 != schemaId2);

        // Verify both schemas exist with different resolvers
        SchemaRecord memory schemaRecord1 = schemaRegistry.getSchema(schemaId1);
        SchemaRecord memory schemaRecord2 = schemaRegistry.getSchema(schemaId2);

        assertEq(address(schemaRecord1.resolver), address(resolver));
        assertEq(address(schemaRecord2.resolver), address(resolver2));
    }
}
