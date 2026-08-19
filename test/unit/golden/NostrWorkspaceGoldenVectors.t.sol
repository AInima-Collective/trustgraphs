// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {NostrWorkspaceParamsCodec} from "contracts/params/NostrWorkspaceParamsCodec.sol";

contract NostrWorkspaceGoldenVectorsTest is Test {
    using stdJson for string;

    string private golden;

    function setUp() public {
        golden = vm.readFile("test/golden/nostr-workspace.json");
    }

    function test_ParamsEncodingMatchesRustGolden() public view {
        NostrWorkspaceParamsCodec.Params memory p = _params();
        assertEq(NostrWorkspaceParamsCodec.programId(), golden.readBytes32(".programId"));
        assertEq(NostrWorkspaceParamsCodec.outputDomain(), golden.readBytes32(".outputDomain"));
        assertEq(NostrWorkspaceParamsCodec.seedSetRoot(p.trustedSeedPubkeys), golden.readBytes32(".params.seedSetRoot"));
        assertEq(NostrWorkspaceParamsCodec.encode(p), golden.readBytes(".params.encoded"));
        assertEq(NostrWorkspaceParamsCodec.hash(p), golden.readBytes32(".paramsHash"));
    }

    function test_NodeIdsLeavesRootAndBlobCommitments() public view {
        bytes32[] memory seeds = golden.readBytes32Array(".params.trustedSeedPubkeys");
        assertEq(NostrWorkspaceParamsCodec.nostrNodeId(seeds[0]), golden.readBytes32(".metadata.agents[0].ownerNodeId"));

        uint256 count = golden.readUint(".scores.count");
        bytes32[] memory leaves = new bytes32[](count + 1);
        for (uint256 i = 0; i < count; i++) {
            string memory base = string.concat(".scores.entries[", vm.toString(i), "]");
            bytes32 nodeId = golden.readBytes32(string.concat(base, ".nodeId"));
            uint256 value = golden.readUint(string.concat(base, ".value"));
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(nodeId, value))));
            assertEq(leaves[i], golden.readBytes32(string.concat(base, ".nodeLeaf")));
        }
        address bound = golden.readAddress(".scores.entries[1].address");
        uint256 boundValue = golden.readUint(".scores.entries[1].value");
        leaves[count] = keccak256(bytes.concat(keccak256(abi.encode(bound, boundValue))));
        assertEq(leaves[count], golden.readBytes32(".scores.entries[1].addressLeaf"));
        assertEq(_ozRoot(leaves), golden.readBytes32(".journal.outputRoot"));

        bytes memory blob = bytes(golden.readString(".cid.blob"));
        assertEq(sha256(blob), golden.readBytes32(".journal.ipfsHash"));
        assertEq(keccak256(bytes(golden.readString(".cid.cid"))), golden.readBytes32(".journal.cidDigest"));
    }

    function test_AddressShapedNodeLeafStillRequiresTheNostrOutputDomain() public pure {
        address account = address(0x4444444444444444444444444444444444444444);
        bytes32 collidingNodeKey = bytes32(uint256(uint160(account)));
        uint256 value = 7;
        bytes32 nodeLeaf = keccak256(bytes.concat(keccak256(abi.encode(collidingNodeKey, value))));
        bytes32 addressLeaf = keccak256(bytes.concat(keccak256(abi.encode(account, value))));
        assertEq(nodeLeaf, addressLeaf);
        assertNotEq(NostrWorkspaceParamsCodec.outputDomain(), keccak256("trustgraphs.output.hypercerts-node.v1"));
    }

    function test_AnchorAndSkipFoldsMatchJournal() public view {
        bytes32 anchorAcc;
        uint256 anchorCount = golden.readUint(".journal.anchorCount");
        for (uint256 i = 0; i < anchorCount; i++) {
            string memory base = string.concat(".anchors[", vm.toString(i), "]");
            bytes32 leaf = keccak256(
                abi.encode(
                    golden.readBytes32(string.concat(base, ".nodeId")),
                    uint8(golden.readUint(string.concat(base, ".envelopeKind"))),
                    golden.readBytes32(string.concat(base, ".head")),
                    uint64(golden.readUint(string.concat(base, ".count"))),
                    golden.readBytes32(string.concat(base, ".dataCommitment")),
                    golden.readUint(string.concat(base, ".blockTimestamp"))
                )
            );
            assertEq(leaf, golden.readBytes32(string.concat(base, ".leaf")));
            anchorAcc = keccak256(abi.encode(anchorAcc, leaf));
        }
        assertEq(anchorAcc, golden.readBytes32(".journal.anchorAcc"));

        bytes32 skippedAcc;
        uint256 skippedCount = golden.readUint(".skipped.count");
        for (uint256 i = 0; i < skippedCount; i++) {
            string memory base = string.concat(".skipped.entries[", vm.toString(i), "]");
            bytes32 leaf = keccak256(
                abi.encode(
                    golden.readBytes32(string.concat(base, ".nodeId")),
                    uint8(golden.readUint(string.concat(base, ".reason"))),
                    uint64(golden.readUint(string.concat(base, ".epochObserved")))
                )
            );
            assertEq(leaf, golden.readBytes32(string.concat(base, ".leaf")));
            skippedAcc = keccak256(abi.encode(skippedAcc, leaf));
        }
        assertEq(skippedAcc, golden.readBytes32(".skipped.digest"));
        assertEq(skippedAcc, golden.readBytes32(".journal.skippedDigest"));
    }

    function test_JournalEncodingAndDigestMatchRustAndGuest() public view {
        bytes memory encoded = abi.encode(
            golden.readBytes32(".journal.acc"),
            uint64(golden.readUint(".journal.leafCount")),
            golden.readBytes32(".journal.anchorAcc"),
            uint64(golden.readUint(".journal.anchorCount")),
            golden.readBytes32(".journal.paramsHash"),
            golden.readBytes32(".journal.outputRoot"),
            golden.readBytes32(".journal.ipfsHash"),
            golden.readBytes32(".journal.cidDigest"),
            golden.readUint(".journal.totalValue"),
            golden.readBytes32(".journal.skippedDigest"),
            golden.readAddress(".journal.recipient"),
            golden.readBytes32(".journal.instanceDomain")
        );
        assertEq(keccak256(encoded), keccak256(golden.readBytes(".journal.encoded")));
        assertEq(keccak256(encoded), golden.readBytes32(".journal.digest"));
    }

    function _params() private view returns (NostrWorkspaceParamsCodec.Params memory p) {
        p.version = uint32(golden.readUint(".params.version"));
        p.outputDomain = golden.readBytes32(".params.outputDomain");
        p.dampingFp = golden.readUint(".params.dampingFp");
        p.toleranceFp = golden.readUint(".params.toleranceFp");
        p.maxIterations = uint32(golden.readUint(".params.maxIterations"));
        p.trustMultiplierFp = golden.readUint(".params.trustMultiplierFp");
        p.trustShareFp = golden.readUint(".params.trustShareFp");
        p.trustDecayFp = golden.readUint(".params.trustDecayFp");
        p.precisionScale = golden.readUint(".params.precisionScale");
        p.totalPool = golden.readUint(".params.totalPool");
        p.trustedSeedPubkeys = golden.readBytes32Array(".params.trustedSeedPubkeys");
        bytes memory community = golden.readBytes(".params.communityId");
        assembly ("memory-safe") {
            mstore(add(p, 0x160), mload(add(community, 0x20)))
        }
        p.instanceDomain = golden.readBytes32(".params.instanceDomain");
        p.relayPubkey = golden.readBytes32(".params.relayPubkey");
        p.chainId = uint64(golden.readUint(".params.chainId"));
        p.allowedVariants = uint8(golden.readUint(".params.allowedVariants"));
        p.wVouchFp = golden.readUint(".params.wVouchFp");
        p.wMergeFp = golden.readUint(".params.wMergeFp");
        p.wJobFp = golden.readUint(".params.wJobFp");
        p.wForumFp = golden.readUint(".params.wForumFp");
        p.relayAttestedWeightFp = golden.readUint(".params.relayAttestedWeightFp");
        p.forumPairCap = uint32(golden.readUint(".params.forumPairCap"));
        p.jobPairCap = uint32(golden.readUint(".params.jobPairCap"));
        p.lane2MaxHeadAge = uint64(golden.readUint(".params.lane2MaxHeadAge"));
        p.maxAnchorRecords = uint32(golden.readUint(".params.maxAnchorRecords"));
        p.maxEstimatedPgu = uint64(golden.readUint(".params.maxEstimatedPgu"));
        p.limits = NostrWorkspaceParamsCodec.Limits({
            envelopeBytes: uint32(golden.readUint(".params.limits.envelopeBytes")),
            selectedHeads: uint32(golden.readUint(".params.limits.selectedHeads")),
            auditEntries: uint32(golden.readUint(".params.limits.auditEntries")),
            events: uint32(golden.readUint(".params.limits.events")),
            encodedEventBytes: uint32(golden.readUint(".params.limits.encodedEventBytes")),
            contentBytes: uint32(golden.readUint(".params.limits.contentBytes")),
            tagsPerEvent: uint32(golden.readUint(".params.limits.tagsPerEvent")),
            elementsPerTag: uint32(golden.readUint(".params.limits.elementsPerTag")),
            tagStringBytes: uint32(golden.readUint(".params.limits.tagStringBytes")),
            allTagStringsBytes: uint32(golden.readUint(".params.limits.allTagStringsBytes")),
            auditDetailBytes: uint32(golden.readUint(".params.limits.auditDetailBytes")),
            nip01Signatures: uint32(golden.readUint(".params.limits.nip01Signatures")),
            oaSignatures: uint32(golden.readUint(".params.limits.oaSignatures"))
        });
    }

    function _ozRoot(bytes32[] memory leaves) private pure returns (bytes32) {
        for (uint256 i = 1; i < leaves.length; i++) {
            bytes32 key = leaves[i];
            uint256 j = i;
            while (j > 0 && leaves[j - 1] > key) {
                leaves[j] = leaves[j - 1];
                j--;
            }
            leaves[j] = key;
        }
        if (leaves.length == 0) return bytes32(0);
        if (leaves.length == 1) return leaves[0];
        bytes32[] memory tree = new bytes32[](2 * leaves.length - 1);
        for (uint256 i = 0; i < leaves.length; i++) {
            tree[tree.length - 1 - i] = leaves[i];
        }
        for (uint256 i = leaves.length - 1; i > 0; i--) {
            uint256 index = i - 1;
            bytes32 left = tree[2 * index + 1];
            bytes32 right = tree[2 * index + 2];
            tree[index] = left <= right ? keccak256(abi.encode(left, right)) : keccak256(abi.encode(right, left));
        }
        return tree[0];
    }
}
