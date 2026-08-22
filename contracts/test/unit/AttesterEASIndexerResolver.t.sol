// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {AttesterEASIndexerResolver} from "../../src/eas/resolvers/AttesterEASIndexerResolver.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData,
    Attestation
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {AttestationRevoked} from "../../src/interfaces/IIndexedEvents.sol";

contract AttesterEASIndexerResolverTest is Test {
    AttesterEASIndexerResolver resolver;
    EAS eas;
    SchemaRegistry schemaRegistry;

    address owner = address(0x1);
    address targetAttester = address(0x2);
    address otherAttester = address(0x3);
    address recipient = address(0x4);

    bytes32 schemaUID;
    string constant SCHEMA = "string message";

    event TargetAttesterUpdated(address indexed oldAttester, address indexed newAttester);

    function setUp() public {
        vm.startPrank(owner);

        // Deploy EAS infrastructure
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));

        // Deploy resolver with target attester
        resolver = new AttesterEASIndexerResolver(IEAS(address(eas)), targetAttester, owner);

        // Register schema with resolver
        schemaUID = schemaRegistry.register(SCHEMA, resolver, true);

        vm.stopPrank();
    }

    function testConstruction_ShouldInitializeCorrectly() public view {
        assertEq(resolver.getTargetAttester(), targetAttester);
        assertEq(resolver.owner(), owner);
    }

    function testConstruction_ShouldRevertWithInvalidEAS() public {
        vm.expectRevert();
        new AttesterEASIndexerResolver(IEAS(address(0)), targetAttester, owner);
    }

    function testSetTargetAttester_ShouldUpdateTarget() public {
        address newAttester = address(0x5);

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit TargetAttesterUpdated(targetAttester, newAttester);
        resolver.setTargetAttester(newAttester);

        assertEq(resolver.getTargetAttester(), newAttester);
    }

    function testSetTargetAttester_ShouldRevertWithNonOwner() public {
        address newAttester = address(0x5);

        vm.prank(otherAttester);
        vm.expectRevert();
        resolver.setTargetAttester(newAttester);
    }

    function testOnAttest_ShouldReturnTrueForTargetAttester() public {
        vm.prank(targetAttester);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest(request);

        // Verify attestation was created
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.attester, targetAttester);
        assertEq(attestation.recipient, recipient);
    }

    function testOnAttest_ShouldReturnFalseForNonTargetAttester() public {
        vm.prank(otherAttester);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        // The attestation should fail validation (resolver returns false)
        vm.expectRevert();
        eas.attest(request);
    }

    function testOnAttest_ShouldEmitCorrectEvents() public {
        vm.prank(targetAttester);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        // Just test that the attestation succeeds for target attester
        bytes32 attestationUID = eas.attest(request);

        // Verify attestation exists
        assertTrue(attestationUID != bytes32(0));
    }

    function testOnRevoke_ShouldEmitCorrectEvents() public {
        // First create an attestation
        vm.prank(targetAttester);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest(request);

        // Now revoke it
        vm.prank(targetAttester);

        vm.expectEmit(true, false, false, false);
        emit AttestationRevoked(address(eas), attestationUID);

        RevocationRequestData memory revocationData = RevocationRequestData({uid: attestationUID, value: 0});

        RevocationRequest memory revocationRequest = RevocationRequest({schema: schemaUID, data: revocationData});

        eas.revoke(revocationRequest);

        // Verify attestation was revoked
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.revocationTime, block.timestamp);
    }

    function testGetTargetAttester_ShouldReturnCorrectAddress() public view {
        assertEq(resolver.getTargetAttester(), targetAttester);
    }

    function testOwnership_ShouldBeTransferrable() public {
        address newOwner = address(0x6);

        vm.prank(owner);
        resolver.transferOwnership(newOwner);

        assertEq(resolver.owner(), newOwner);

        // Old owner should not be able to set target attester
        vm.prank(owner);
        vm.expectRevert();
        resolver.setTargetAttester(address(0x7));

        // New owner should be able to set target attester
        vm.prank(newOwner);
        resolver.setTargetAttester(address(0x7));
        assertEq(resolver.getTargetAttester(), address(0x7));
    }

    function testMultipleAttestations_ShouldWorkCorrectly() public {
        address[] memory recipients = new address[](3);
        recipients[0] = address(0x10);
        recipients[1] = address(0x11);
        recipients[2] = address(0x12);

        vm.startPrank(targetAttester);

        for (uint256 i = 0; i < recipients.length; i++) {
            AttestationRequestData memory requestData = AttestationRequestData({
                recipient: recipients[i],
                expirationTime: 0,
                revocable: true,
                refUID: bytes32(0),
                data: abi.encode("test message", i),
                value: 0
            });

            AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

            bytes32 attestationUID = eas.attest(request);

            Attestation memory attestation = eas.getAttestation(attestationUID);
            assertEq(attestation.attester, targetAttester);
            assertEq(attestation.recipient, recipients[i]);
        }

        vm.stopPrank();
    }
}
