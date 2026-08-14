// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequestData,
    MultiDelegatedAttestationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {
    EMPTY_UID,
    NO_EXPIRATION_TIME,
    Attestation,
    InvalidSignature,
    Signature
} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";

/// @notice Contract-level lock for the frontend relay's exact EAS 1.3.0 typed message and grouped,
///         increasing-nonce multi-attestation semantics.
contract EASDelegatedAttestationTest is Test {
    uint256 internal constant ATTESTER_KEY = 0xA11CE;

    EAS internal eas;
    EASIndexerResolver internal resolver;
    bytes32 internal schemaUid;
    address internal attester;
    address internal relayer = address(0xB0B);

    function setUp() public {
        SchemaRegistry registry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(registry)));
        resolver = new EASIndexerResolver(IEAS(address(eas)));
        schemaUid = registry.register("address recipient,uint8 confidence,string comment", resolver, true);
        resolver.bindSchema(schemaUid);
        attester = vm.addr(ATTESTER_KEY);
    }

    function _data(address recipient, uint8 confidence, string memory comment)
        internal
        pure
        returns (AttestationRequestData memory)
    {
        return AttestationRequestData({
            recipient: recipient,
            expirationTime: NO_EXPIRATION_TIME,
            revocable: true,
            refUID: EMPTY_UID,
            data: abi.encode(recipient, confidence, comment),
            value: 0
        });
    }

    function _sign(AttestationRequestData memory data, uint256 nonce, uint64 deadline)
        internal
        view
        returns (Signature memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                eas.getAttestTypeHash(),
                attester,
                schemaUid,
                data.recipient,
                data.expirationTime,
                data.revocable,
                data.refUID,
                keccak256(data.data),
                data.value,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eas.getDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, digest);
        return Signature({v: v, r: r, s: s});
    }

    function _request(uint64 deadline) internal view returns (MultiDelegatedAttestationRequest[] memory requests) {
        AttestationRequestData[] memory data = new AttestationRequestData[](2);
        data[0] = _data(address(0x1111), 80, "first");
        data[1] = _data(address(0x2222), 60, "second");
        Signature[] memory signatures = new Signature[](2);
        signatures[0] = _sign(data[0], 0, deadline);
        signatures[1] = _sign(data[1], 1, deadline);

        requests = new MultiDelegatedAttestationRequest[](1);
        requests[0] = MultiDelegatedAttestationRequest({
            schema: schemaUid, data: data, signatures: signatures, attester: attester, deadline: deadline
        });
    }

    function test_RelayerPaysGasButSignerIsAttesterAndNoncesAreSequential() public {
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        vm.prank(relayer);
        bytes32[] memory uids = eas.multiAttestByDelegation(_request(deadline));

        assertEq(uids.length, 2);
        assertEq(eas.getNonce(attester), 2);
        assertEq(resolver.leafCount(), 2);
        assertNotEq(resolver.acc(), bytes32(0));

        Attestation memory first = eas.getAttestation(uids[0]);
        Attestation memory second = eas.getAttestation(uids[1]);
        assertEq(first.attester, attester, "gas payer became attester");
        assertEq(second.attester, attester, "gas payer became attester");
        assertEq(first.recipient, address(0x1111));
        assertEq(second.recipient, address(0x2222));
    }

    function test_TamperingWithSignedDataRevertsAndDoesNotConsumeNonce() public {
        uint64 deadline = uint64(block.timestamp + 15 minutes);
        MultiDelegatedAttestationRequest[] memory requests = _request(deadline);
        requests[0].data[1].recipient = address(0xDEAD);

        vm.prank(relayer);
        vm.expectRevert(InvalidSignature.selector);
        eas.multiAttestByDelegation(requests);
        assertEq(eas.getNonce(attester), 0, "reverted batch consumed nonce");
        assertEq(resolver.leafCount(), 0, "reverted batch partially folded");
    }
}
