// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {EASIndexerResolver} from "../../src/eas/resolvers/EASIndexerResolver.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import {AttestationAttested, AttestationRevoked} from "../../src/interfaces/IIndexedEvents.sol";

contract EASIndexerResolverTest is Test {
    EASIndexerResolver public resolver;
    EAS public eas;
    SchemaRegistry public schemaRegistry;

    string constant SCHEMA = "uint256 value";
    bytes32 public schemaId;

    address constant ZERO_ADDRESS = address(0);
    address public attester = address(0x1);
    address public recipient = address(0x2);

    function setUp() public {
        // Deploy contracts
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        resolver = new EASIndexerResolver(IEAS(address(eas)));

        // Register schema with the resolver
        schemaId = schemaRegistry.register(SCHEMA, resolver, true);
    }

    function testConstruction_ShouldInitializeCorrectly() public view {
        // Verify the resolver was created successfully
        assertTrue(address(resolver) != address(0));
    }

    function testOnAttest_ShouldEmitEventOnAttestation() public {
        uint256 testValue = 12345;

        // Expect the AttestationAttested event to be emitted
        vm.expectEmit(false, false, false, false);
        emit AttestationAttested(address(eas), bytes32(0)); // Check event signature only

        // Create an attestation which will trigger the resolver
        eas.attest(
            AttestationRequest({
                schema: schemaId,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode(testValue),
                    value: 0
                })
            })
        );
    }

    function testOnAttest_ShouldEmitEventOnMultipleAttestations() public {
        uint256[] memory values = new uint256[](3);
        values[0] = 100;
        values[1] = 200;
        values[2] = 300;

        bytes32[] memory uids = new bytes32[](3);

        for (uint256 i = 0; i < values.length; i++) {
            // Expect the AttestationAttested event
            vm.expectEmit(false, false, false, false);
            emit AttestationAttested(address(eas), bytes32(0));

            uids[i] = eas.attest(
                AttestationRequest({
                    schema: schemaId,
                    data: AttestationRequestData({
                        recipient: recipient,
                        expirationTime: NO_EXPIRATION_TIME,
                        revocable: true,
                        refUID: EMPTY_UID,
                        data: abi.encode(values[i]),
                        value: 0
                    })
                })
            );
        }
    }

    function testOnRevoke_ShouldEmitEventOnRevocation() public {
        uint256 testValue = 24680;

        // Create an attestation first
        bytes32 uid = eas.attest(
            AttestationRequest({
                schema: schemaId,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode(testValue),
                    value: 0
                })
            })
        );

        // Verify attestation exists and is valid
        assertTrue(eas.isAttestationValid(uid));

        // Expect the AttestationRevoked event
        vm.expectEmit(false, false, false, false);
        emit AttestationRevoked(address(eas), bytes32(0)); // Check event signature only

        // Revoke the attestation - should succeed
        eas.revoke(RevocationRequest({schema: schemaId, data: RevocationRequestData({uid: uid, value: 0})}));
    }

    function testOnRevoke_ShouldEmitEventOnMultipleRevocations() public {
        uint256[] memory values = new uint256[](2);
        values[0] = 777;
        values[1] = 888;

        bytes32[] memory uids = new bytes32[](2);

        // Create attestations
        for (uint256 i = 0; i < values.length; i++) {
            uids[i] = eas.attest(
                AttestationRequest({
                    schema: schemaId,
                    data: AttestationRequestData({
                        recipient: recipient,
                        expirationTime: NO_EXPIRATION_TIME,
                        revocable: true,
                        refUID: EMPTY_UID,
                        data: abi.encode(values[i]),
                        value: 0
                    })
                })
            );
        }

        // Revoke them and verify they remain indexed
        for (uint256 i = 0; i < values.length; i++) {
            // Expect the AttestationRevoked event
            vm.expectEmit(false, false, false, false);
            emit AttestationRevoked(address(eas), bytes32(0)); // Check event signature only

            eas.revoke(RevocationRequest({schema: schemaId, data: RevocationRequestData({uid: uids[i], value: 0})}));
        }
    }
}
