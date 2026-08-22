// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {OffchainAttestationVerifier} from "../../src/eas/OffchainAttestationVerifier.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {Signature} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

contract OffchainAttestationVerifierTest is Test {
    OffchainAttestationVerifier public verifier;
    EAS public eas;
    SchemaRegistry public schemaRegistry;

    string constant SCHEMA = "uint256 value";
    bytes32 public schemaId;

    address constant ZERO_ADDRESS = address(0);
    uint64 constant NO_EXPIRATION = 0;
    bytes32 constant ZERO_BYTES32 = bytes32(0);
    bytes constant ZERO_BYTES = "";

    // Test addresses
    address public attester;
    address public recipient;
    uint256 public attesterPrivateKey = 0x123;
    uint256 public recipientPrivateKey = 0x456;

    // Attestation versions
    uint16 constant LEGACY = 0;
    uint16 constant VERSION1 = 1;
    uint16 constant VERSION2 = 2;

    function setUp() public {
        // Create test addresses
        attester = vm.addr(attesterPrivateKey);
        recipient = vm.addr(recipientPrivateKey);

        // Deploy contracts
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        verifier = new OffchainAttestationVerifier(IEAS(address(eas)));

        // Register schema
        schemaId = schemaRegistry.register(SCHEMA, ISchemaResolver(address(0)), true);
    }

    function testConstruction_ShouldRevertWithInvalidEAS() public {
        vm.expectRevert();
        new OffchainAttestationVerifier(IEAS(ZERO_ADDRESS));
    }

    function testConstruction_ShouldBeProperlyInitialized() public view {
        assertEq(address(verifier.getEAS()), address(eas));
    }

    function testVerify_LegacyVersion_ShouldVerify() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(LEGACY);

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertTrue(verifier.verify(attestation));
    }

    function testVerify_Version1_ShouldVerify() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(VERSION1);

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertTrue(verifier.verify(attestation));
    }

    function testVerify_Version2_ShouldVerify() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(VERSION2);
        attestation.salt = keccak256("test_salt");

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertTrue(verifier.verify(attestation));
    }

    function testVerify_ShouldFailWithInvalidAttester() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(LEGACY);
        attestation.attester = ZERO_ADDRESS;

        assertFalse(verifier.verify(attestation));
    }

    function testVerify_ShouldFailWithFutureTime() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(LEGACY);
        attestation.time = uint64(block.timestamp + 365 days);

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertFalse(verifier.verify(attestation));
    }

    function testVerify_ShouldFailWithInvalidSchema() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(LEGACY);
        attestation.schema = ZERO_BYTES32;

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertFalse(verifier.verify(attestation));
    }

    function testVerify_ShouldFailWithInvalidRefUID() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(LEGACY);
        attestation.refUID = keccak256("BAD_REF");

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertFalse(verifier.verify(attestation));
    }

    function testVerify_ShouldFailWithInvalidSignature() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(LEGACY);

        // Create invalid signature
        attestation.signature = Signature(27, keccak256("BAD_SIG"), bytes32(uint256(1)));

        assertFalse(verifier.verify(attestation));
    }

    function testVerify_ShouldFailWithUnknownVersion() public view {
        OffchainAttestationVerifier.OffchainAttestation memory attestation = _createAttestation(999); // Unknown version

        // Sign the attestation
        bytes32 hash = _getTypedDataHash(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, hash);
        attestation.signature = Signature(v, r, s);

        assertFalse(verifier.verify(attestation));
    }

    function _createAttestation(uint16 version)
        internal
        view
        returns (OffchainAttestationVerifier.OffchainAttestation memory)
    {
        return OffchainAttestationVerifier.OffchainAttestation({
            version: version,
            attester: attester,
            schema: schemaId,
            recipient: recipient,
            time: uint64(block.timestamp),
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: ZERO_BYTES,
            salt: version == VERSION2 ? ZERO_BYTES32 : ZERO_BYTES32,
            signature: Signature(0, bytes32(0), bytes32(0))
        });
    }

    function _getTypedDataHash(OffchainAttestationVerifier.OffchainAttestation memory attestation)
        internal
        view
        returns (bytes32)
    {
        // This is a simplified version - in a real implementation, you'd need to properly construct
        // the EIP-712 typed data hash based on the version
        bytes32 structHash;

        if (attestation.version == LEGACY) {
            // Legacy version hash
            structHash = keccak256(
                abi.encode(
                    keccak256(
                        "Attestation(bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data)"
                    ),
                    attestation.schema,
                    attestation.recipient,
                    attestation.time,
                    attestation.expirationTime,
                    attestation.revocable,
                    attestation.refUID,
                    keccak256(attestation.data)
                )
            );
        } else if (attestation.version == VERSION1) {
            // Version 1 hash
            structHash = keccak256(
                abi.encode(
                    keccak256(
                        "Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data)"
                    ),
                    attestation.version,
                    attestation.schema,
                    attestation.recipient,
                    attestation.time,
                    attestation.expirationTime,
                    attestation.revocable,
                    attestation.refUID,
                    keccak256(attestation.data)
                )
            );
        } else if (attestation.version == VERSION2) {
            // Version 2 hash
            structHash = keccak256(
                abi.encode(
                    keccak256(
                        "Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)"
                    ),
                    attestation.version,
                    attestation.schema,
                    attestation.recipient,
                    attestation.time,
                    attestation.expirationTime,
                    attestation.revocable,
                    attestation.refUID,
                    keccak256(attestation.data),
                    attestation.salt
                )
            );
        }

        // Create domain separator
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("EAS Attestation"),
                keccak256(bytes(eas.version())),
                block.chainid,
                address(eas)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
