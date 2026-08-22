// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @title EasOffchainPayloadGolden
/// @notice Solidity's independent lock on the official-SDK Envelope0PayloadV1 corpus. This is not
///         a production payload parser; it deliberately decodes the frozen positive bytes with
///         small local helpers and reproduces the hashes a registry must verify.
contract EasOffchainPayloadGoldenTest is Test {
    using stdJson for string;

    string internal json;
    bytes internal payload;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ATTEST_TYPEHASH = keccak256(
        "Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)"
    );
    bytes32 internal constant ANCHOR_TYPEHASH = keccak256(
        "Anchor(bytes32 nodeId,uint8 envelopeKind,bytes32 schemaUid,bytes32 previousHead,bytes32 head,uint64 count,bytes32 dataCommitment)"
    );

    function setUp() public {
        json = vm.readFile("tests/fixtures/eas-offchain/v1/manifest.json");
        payload = vm.readFileBinary("tests/fixtures/eas-offchain/v1/payload.bin");
    }

    function test_PayloadHeaderCommitmentAndLogHead() public view {
        assertEq(payload.length, json.readUint(".positive.payloadLength"), "payload length");
        assertEq(sha256(payload), json.readBytes32(".positive.dataCommitment"), "payload commitment");
        assertEq(bytes8(_bytes32At(payload, 0)), bytes8("TGEAS0PL"), "magic");
        assertEq(_uintAt(payload, 8, 2), 1, "payload version");
        assertEq(_addressAt(payload, 10), json.readAddress(".owner"), "owner");
        assertEq(_uintAt(payload, 30, 4), 3, "entry count");
        assertEq(_uintAt(payload, 34, 4), 2, "attestation count");

        bytes32[] memory expected = json.readBytes32Array(".positive.prefixHeads");
        bytes32 head;
        for (uint256 i; i < 3; ++i) {
            uint256 offset = 38 + i * 33;
            uint8 kind = uint8(_uintAt(payload, offset, 1));
            bytes32 uid = _bytes32At(payload, offset + 1);
            bytes32 leaf = keccak256(abi.encode(kind, uid));
            head = keccak256(abi.encode(head, leaf));
            assertEq(head, expected[i], "prefix head");
        }
    }

    function test_OfficialSdkUidTypedDigestAndSignature() public view {
        // Header (38) + three 33-byte log entries = first attestation record at byte 137.
        uint256 offset = 137;
        uint16 version = uint16(_uintAt(payload, offset, 2));
        bytes32 schema = _bytes32At(payload, offset + 2);
        address recipient = _addressAt(payload, offset + 34);
        uint64 time = uint64(_uintAt(payload, offset + 54, 8));
        uint64 expirationTime = uint64(_uintAt(payload, offset + 62, 8));
        bool revocable = _uintAt(payload, offset + 70, 1) == 1;
        bytes32 refUID = _bytes32At(payload, offset + 71);
        uint256 dataLength = _uintAt(payload, offset + 103, 4);
        bytes memory data = _slice(payload, offset + 107, dataLength);
        bytes32 salt = _bytes32At(payload, offset + 107 + dataLength);
        bytes memory signature = _slice(payload, offset + 139 + dataLength, 65);

        bytes32 uid = keccak256(
            abi.encodePacked(
                version,
                bytes(vm.toString(schema)),
                recipient,
                address(0),
                time,
                expirationTime,
                revocable,
                refUID,
                data,
                salt,
                uint32(0)
            )
        );
        assertEq(uid, json.readBytes32(".positive.attestations[0].uid"), "official SDK UID");

        bytes32 domain = _domainSeparator(
            "EAS Attestation",
            json.readString(".easDomain.version"),
            _uintString(".easDomain.chainId"),
            json.readAddress(".easDomain.verifyingContract")
        );
        assertEq(domain, json.readBytes32(".easDomain.separator"), "EAS domain");
        bytes32 structHash = keccak256(
            abi.encode(
                ATTEST_TYPEHASH,
                version,
                schema,
                recipient,
                time,
                expirationTime,
                revocable,
                refUID,
                keccak256(data),
                salt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        assertEq(digest, json.readBytes32(".positive.attestations[0].typedDigest"), "EAS typed digest");
        assertEq(_recover(digest, signature), json.readAddress(".owner"), "EAS signer");
    }

    function test_HeadDomainTypedDigestAndSignature() public view {
        string memory prefix = ".positive.anchorHistory[1].authorization";
        bytes32 domain = _domainSeparator(
            "Trustgraphs Offchain Head",
            "2",
            _uintString(".headDomain.chainId"),
            json.readAddress(".headDomain.verifyingContract")
        );
        assertEq(domain, json.readBytes32(".headDomain.separator"), "head domain");

        bytes32 structHash = keccak256(
            abi.encode(
                ANCHOR_TYPEHASH,
                json.readBytes32(string.concat(prefix, ".message.nodeId")),
                uint8(json.readUint(string.concat(prefix, ".message.envelopeKind"))),
                json.readBytes32(string.concat(prefix, ".message.schemaUid")),
                json.readBytes32(string.concat(prefix, ".message.previousHead")),
                json.readBytes32(string.concat(prefix, ".message.head")),
                uint64(_uintString(string.concat(prefix, ".message.count"))),
                json.readBytes32(string.concat(prefix, ".message.dataCommitment"))
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        assertEq(digest, json.readBytes32(string.concat(prefix, ".typedDigest")), "head typed digest");
        assertEq(
            _recover(digest, json.readBytes(string.concat(prefix, ".signature"))),
            json.readAddress(".owner"),
            "head signer"
        );
    }

    function _domainSeparator(string memory name, string memory version, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
    }

    function _uintString(string memory path) internal view returns (uint256) {
        return vm.parseUint(json.readString(path));
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        return ecrecover(digest, v, r, s);
    }

    function _slice(bytes memory value, uint256 offset, uint256 length) internal pure returns (bytes memory out) {
        require(offset + length <= value.length, "slice bounds");
        out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = value[offset + i];
        }
    }

    function _bytes32At(bytes memory value, uint256 offset) internal pure returns (bytes32 out) {
        require(offset + 32 <= value.length, "bytes32 bounds");
        assembly ("memory-safe") {
            out := mload(add(add(value, 0x20), offset))
        }
    }

    function _addressAt(bytes memory value, uint256 offset) internal pure returns (address out) {
        require(offset + 20 <= value.length, "address bounds");
        assembly ("memory-safe") {
            out := shr(96, mload(add(add(value, 0x20), offset)))
        }
    }

    function _uintAt(bytes memory value, uint256 offset, uint256 width) internal pure returns (uint256 out) {
        require(width <= 32 && offset + width <= value.length, "uint bounds");
        for (uint256 i; i < width; ++i) {
            out = (out << 8) | uint8(value[offset + i]);
        }
    }
}
