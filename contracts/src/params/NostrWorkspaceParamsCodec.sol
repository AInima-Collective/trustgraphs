// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {OzMerkle} from "../merkle/OzMerkle.sol";

/// @title NostrWorkspaceParamsCodec
/// @notice Frozen 39-word params codec for the `nostr-workspace` SP1 program.
/// @dev Field order and widths mirror `nostr_workspace_core::params::params_encoded` exactly.
library NostrWorkspaceParamsCodec {
    uint256 internal constant PARAMS_SCHEMA_VERSION = 3;

    struct Limits {
        uint32 envelopeBytes;
        uint32 selectedHeads;
        uint32 auditEntries;
        uint32 events;
        uint32 encodedEventBytes;
        uint32 contentBytes;
        uint32 tagsPerEvent;
        uint32 elementsPerTag;
        uint32 tagStringBytes;
        uint32 allTagStringsBytes;
        uint32 auditDetailBytes;
        uint32 nip01Signatures;
        uint32 oaSignatures;
    }

    struct Params {
        uint32 version;
        bytes32 outputDomain;
        uint256 dampingFp;
        uint256 toleranceFp;
        uint32 maxIterations;
        uint256 trustShareFp;
        uint256 trustDecayFp;
        uint256 precisionScale;
        uint256 totalPool;
        bytes32[] trustedSeedPubkeys;
        bytes16 communityId;
        bytes32 instanceDomain;
        bytes32 relayPubkey;
        uint64 chainId;
        uint8 allowedVariants;
        uint256 wVouchFp;
        uint256 wMergeFp;
        uint256 wJobFp;
        uint256 wForumFp;
        uint256 relayAttestedWeightFp;
        uint32 forumPairCap;
        uint32 jobPairCap;
        uint64 lane2MaxHeadAge;
        uint32 maxAnchorRecords;
        uint64 maxEstimatedPgu;
        Limits limits;
    }

    function programId() internal pure returns (bytes32) {
        return keccak256("nostr-workspace");
    }

    function outputDomain() internal pure returns (bytes32) {
        return keccak256("trustgraphs.output.nostr-member.v1");
    }

    function encode(Params memory p) internal pure returns (bytes memory) {
        bytes memory rank = abi.encode(
            PARAMS_SCHEMA_VERSION,
            p.version,
            p.outputDomain,
            p.dampingFp,
            p.toleranceFp,
            p.maxIterations,
            p.trustShareFp,
            p.trustDecayFp,
            p.precisionScale,
            p.totalPool
        );
        bytes memory identity = abi.encode(
            seedSetRoot(p.trustedSeedPubkeys),
            p.communityId,
            p.instanceDomain,
            p.relayPubkey,
            p.chainId,
            p.allowedVariants
        );
        bytes memory policy = abi.encode(
            p.wVouchFp,
            p.wMergeFp,
            p.wJobFp,
            p.wForumFp,
            p.relayAttestedWeightFp,
            p.forumPairCap,
            p.jobPairCap,
            p.lane2MaxHeadAge,
            p.maxAnchorRecords,
            p.maxEstimatedPgu
        );
        Limits memory limits = p.limits;
        bytes memory bounds = abi.encode(
            limits.envelopeBytes,
            limits.selectedHeads,
            limits.auditEntries,
            limits.events,
            limits.encodedEventBytes,
            limits.contentBytes,
            limits.tagsPerEvent,
            limits.elementsPerTag,
            limits.tagStringBytes,
            limits.allTagStringsBytes,
            limits.auditDetailBytes,
            limits.nip01Signatures,
            limits.oaSignatures
        );
        return bytes.concat(rank, identity, policy, bounds);
    }

    function hash(Params memory p) internal pure returns (bytes32) {
        return keccak256(encode(p));
    }

    function nostrNodeId(bytes32 pubkey) internal pure returns (bytes32) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory raw = abi.encodePacked(pubkey);
        bytes memory did = new bytes(74);
        bytes memory prefix = bytes("did:nostr:");
        for (uint256 i = 0; i < prefix.length; i++) {
            did[i] = prefix[i];
        }
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 value = uint8(raw[i]);
            did[10 + i * 2] = alphabet[value >> 4];
            did[11 + i * 2] = alphabet[value & 0x0f];
        }
        return keccak256(did);
    }

    function seedSetRoot(bytes32[] memory pubkeys) internal pure returns (bytes32) {
        bytes32[] memory ids = new bytes32[](pubkeys.length);
        for (uint256 i = 0; i < pubkeys.length; i++) {
            ids[i] = nostrNodeId(pubkeys[i]);
        }
        OzMerkle.sortInPlace(ids);
        bytes32[] memory leaves = new bytes32[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            leaves[i] = keccak256(abi.encodePacked(ids[i]));
        }
        return OzMerkle.root(leaves);
    }
}
