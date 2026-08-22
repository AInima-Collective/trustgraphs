// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Independent Solidity twin of the issue-60 canonical codec. This research fixture is not
///         a production registry adapter; it exists to make the proposed mirror/prover/verifier
///         bytes and their gas shape executable before any upstream registry integration.
contract ERC8004CompletenessCodec {
    bytes32 public constant EVENT_DOMAIN = keccak256("TRUSTGRAPHS_ERC8004_EVENT_V1");
    bytes32 public constant CHECKPOINT_DOMAIN = keccak256("TRUSTGRAPHS_ERC8004_CHECKPOINT_V1");
    bytes32 public constant EVENT_SET_VERSION = keccak256("TRUSTGRAPHS_ERC8004_EVENT_SET_V1");

    struct EventEnvelope {
        uint256 chainId;
        address registry;
        uint64 blockNumber;
        uint64 sequence;
        bytes32 implementationCodeHash;
        bytes32 eventSetVersion;
        uint8 kind;
        bytes32 topicsHash;
        bytes32 dataHash;
    }

    struct CheckpointEnvelope {
        uint256 chainId;
        address accumulator;
        address identityRegistry;
        address reputationRegistry;
        uint64 activationBlock;
        uint64 endBlock;
        bytes32 endBlockHash;
        uint64 count;
        bytes32 head;
        bytes32 eventSetVersion;
        bytes32 identityImplementationCodeHash;
        bytes32 reputationImplementationCodeHash;
        bytes32 preimageCommitment;
    }

    function topicsHash(bytes32[] memory topics) public pure returns (bytes32) {
        require(topics.length <= 4, "too many topics");
        return keccak256(abi.encodePacked(uint8(topics.length), topics));
    }

    function preimageHash(bytes32[] memory topics, bytes memory data) public pure returns (bytes32) {
        require(topics.length <= 4, "too many topics");
        return keccak256(abi.encodePacked(uint8(topics.length), topics, uint64(data.length), data));
    }

    function eventLeaf(EventEnvelope memory event_) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EVENT_DOMAIN,
                event_.chainId,
                event_.registry,
                event_.blockNumber,
                event_.sequence,
                event_.implementationCodeHash,
                event_.eventSetVersion,
                event_.kind,
                event_.topicsHash,
                event_.dataHash
            )
        );
    }

    function fold(bytes32 previous, bytes32 leaf) public pure returns (bytes32) {
        return keccak256(abi.encode(previous, leaf));
    }

    function checkpointDigest(CheckpointEnvelope memory checkpoint) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CHECKPOINT_DOMAIN,
                checkpoint.chainId,
                checkpoint.accumulator,
                checkpoint.identityRegistry,
                checkpoint.reputationRegistry,
                checkpoint.activationBlock,
                checkpoint.endBlock,
                checkpoint.endBlockHash,
                checkpoint.count,
                checkpoint.head,
                checkpoint.eventSetVersion,
                checkpoint.identityImplementationCodeHash,
                checkpoint.reputationImplementationCodeHash,
                checkpoint.preimageCommitment
            )
        );
    }
}

/// @notice Minimal cooperating sidecar used only for gas and lifecycle evidence. A reviewed
///         Identity/Reputation implementation calls append in the same transaction as each source
///         mutation. The sidecar supplies global order and cannot be reset by a UUPS implementation.
contract ERC8004AccumulatorMiniature is ERC8004CompletenessCodec {
    address public immutable identityRegistry;
    address public immutable reputationRegistry;
    uint64 public immutable activationBlock;

    bytes32 public head;
    bytes32 public preimageHead;
    uint64 public count;
    mapping(address registry => bytes32 codeHash) public currentImplementationCodeHash;
    mapping(uint256 checkpointId => bytes32 digest) public checkpointDigestAt;
    uint256 public checkpointCount;

    event CanonicalEventAppended(
        uint64 indexed sequence,
        address indexed registry,
        uint8 indexed kind,
        bytes32 implementationCodeHash,
        bytes32 topicsHash,
        bytes32 dataHash,
        bytes32 preimageHash,
        bytes32 head
    );
    event Checkpointed(uint256 indexed checkpointId, bytes32 digest, bytes32 head, uint64 count);

    error NotRegistry(address caller);
    error WrongImplementation(bytes32 expected, bytes32 actual);

    constructor(
        address identityRegistry_,
        address reputationRegistry_,
        bytes32 identityImplementationCodeHash_,
        bytes32 reputationImplementationCodeHash_
    ) {
        identityRegistry = identityRegistry_;
        reputationRegistry = reputationRegistry_;
        activationBlock = uint64(block.number);
        currentImplementationCodeHash[identityRegistry_] = identityImplementationCodeHash_;
        currentImplementationCodeHash[reputationRegistry_] = reputationImplementationCodeHash_;
    }

    function append(
        uint8 kind,
        bytes32 implementationCodeHash,
        bytes32 sourceTopicsHash,
        bytes32 sourceDataHash,
        bytes32 sourcePreimageHash
    ) external returns (bytes32 leaf) {
        if (msg.sender != identityRegistry && msg.sender != reputationRegistry) {
            revert NotRegistry(msg.sender);
        }
        bytes32 current = currentImplementationCodeHash[msg.sender];
        // kind 10 is the frozen Upgraded record and binds the post-upgrade code hash. Every other
        // append must come from the currently recorded reviewed epoch.
        if (kind == 10) currentImplementationCodeHash[msg.sender] = implementationCodeHash;
        else if (current != implementationCodeHash) revert WrongImplementation(current, implementationCodeHash);

        uint64 sequence = count;
        leaf = eventLeaf(
            EventEnvelope({
                chainId: block.chainid,
                registry: msg.sender,
                blockNumber: uint64(block.number),
                sequence: sequence,
                implementationCodeHash: implementationCodeHash,
                eventSetVersion: EVENT_SET_VERSION,
                kind: kind,
                topicsHash: sourceTopicsHash,
                dataHash: sourceDataHash
            })
        );
        head = fold(head, leaf);
        preimageHead = fold(preimageHead, sourcePreimageHash);
        count = sequence + 1;
        emit CanonicalEventAppended(
            sequence,
            msg.sender,
            kind,
            implementationCodeHash,
            sourceTopicsHash,
            sourceDataHash,
            sourcePreimageHash,
            head
        );
    }

    function checkpoint(bytes32 endBlockHash) external returns (uint256 checkpointId, bytes32 digest) {
        checkpointId = checkpointCount++;
        digest = checkpointDigest(
            CheckpointEnvelope({
                chainId: block.chainid,
                accumulator: address(this),
                identityRegistry: identityRegistry,
                reputationRegistry: reputationRegistry,
                activationBlock: activationBlock,
                endBlock: uint64(block.number),
                endBlockHash: endBlockHash,
                count: count,
                head: head,
                eventSetVersion: EVENT_SET_VERSION,
                identityImplementationCodeHash: currentImplementationCodeHash[identityRegistry],
                reputationImplementationCodeHash: currentImplementationCodeHash[reputationRegistry],
                preimageCommitment: preimageHead
            })
        );
        checkpointDigestAt[checkpointId] = digest;
        emit Checkpointed(checkpointId, digest, head, count);
    }
}

contract ERC8004RegistryCallerMiniature {
    ERC8004AccumulatorMiniature public mirror;

    function bind(ERC8004AccumulatorMiniature mirror_) external {
        require(address(mirror) == address(0), "already bound");
        mirror = mirror_;
    }

    function append(
        uint8 kind,
        bytes32 implementationCodeHash,
        bytes32 sourceTopicsHash,
        bytes32 sourceDataHash,
        bytes32 sourcePreimageHash
    ) external {
        mirror.append(kind, implementationCodeHash, sourceTopicsHash, sourceDataHash, sourcePreimageHash);
    }
}

contract ERC8004CompletenessResearchTest is Test {
    using stdJson for string;

    ERC8004CompletenessCodec codec;
    string golden;

    function setUp() public {
        codec = new ERC8004CompletenessCodec();
        golden = vm.readFile("research/erc8004-completeness/golden.json");
    }

    function _uintString(string memory path) internal view returns (uint256) {
        return vm.parseUint(golden.readString(path));
    }

    function _eventPath(uint256 index, string memory field) internal pure returns (string memory) {
        return string.concat(".events[", vm.toString(index), "].", field);
    }

    function test_GoldenEventLeavesAndFoldsMatchTypeScript() public view {
        assertEq(codec.EVENT_DOMAIN(), golden.readBytes32(".constants.eventDomain"));
        assertEq(codec.EVENT_SET_VERSION(), golden.readBytes32(".constants.eventSetVersion"));

        bytes32 head;
        bytes32 preimages;
        for (uint256 index; index < 18; ++index) {
            bytes32[] memory topics = golden.readBytes32Array(_eventPath(index, "topics"));
            bytes memory data = golden.readBytes(_eventPath(index, "data"));
            bytes32 sourceTopicsHash = codec.topicsHash(topics);
            bytes32 sourceDataHash = keccak256(data);
            bytes32 sourcePreimageHash = codec.preimageHash(topics, data);
            assertEq(sourceTopicsHash, golden.readBytes32(_eventPath(index, "topicsHash")));
            assertEq(sourceDataHash, golden.readBytes32(_eventPath(index, "dataHash")));
            assertEq(sourcePreimageHash, golden.readBytes32(_eventPath(index, "preimageHash")));

            ERC8004CompletenessCodec.EventEnvelope memory event_ = ERC8004CompletenessCodec.EventEnvelope({
                chainId: _uintString(_eventPath(index, "chainId")),
                registry: golden.readAddress(_eventPath(index, "registry")),
                blockNumber: uint64(_uintString(_eventPath(index, "blockNumber"))),
                sequence: uint64(_uintString(_eventPath(index, "sequence"))),
                implementationCodeHash: golden.readBytes32(_eventPath(index, "implementationCodeHash")),
                eventSetVersion: golden.readBytes32(_eventPath(index, "eventSetVersion")),
                kind: uint8(golden.readUint(_eventPath(index, "kind"))),
                topicsHash: sourceTopicsHash,
                dataHash: sourceDataHash
            });
            bytes32 leaf = codec.eventLeaf(event_);
            assertEq(leaf, golden.readBytes32(_eventPath(index, "leaf")));
            head = codec.fold(head, leaf);
            preimages = codec.fold(preimages, sourcePreimageHash);
            assertEq(head, golden.readBytes32(_eventPath(index, "headAfter")));
            assertEq(preimages, golden.readBytes32(_eventPath(index, "preimageHeadAfter")));
        }
    }

    function test_GoldenCheckpointDigestMatchesTypeScript() public view {
        ERC8004CompletenessCodec.CheckpointEnvelope memory checkpoint = ERC8004CompletenessCodec.CheckpointEnvelope({
            chainId: _uintString(".checkpoint.chainId"),
            accumulator: golden.readAddress(".checkpoint.accumulator"),
            identityRegistry: golden.readAddress(".checkpoint.identityRegistry"),
            reputationRegistry: golden.readAddress(".checkpoint.reputationRegistry"),
            activationBlock: uint64(_uintString(".checkpoint.activationBlock")),
            endBlock: uint64(_uintString(".checkpoint.endBlock")),
            endBlockHash: golden.readBytes32(".checkpoint.endBlockHash"),
            count: uint64(_uintString(".checkpoint.count")),
            head: golden.readBytes32(".checkpoint.head"),
            eventSetVersion: golden.readBytes32(".checkpoint.eventSetVersion"),
            identityImplementationCodeHash: golden.readBytes32(".checkpoint.identityImplementationCodeHash"),
            reputationImplementationCodeHash: golden.readBytes32(".checkpoint.reputationImplementationCodeHash"),
            preimageCommitment: golden.readBytes32(".checkpoint.preimageCommitment")
        });
        assertEq(codec.CHECKPOINT_DOMAIN(), golden.readBytes32(".constants.checkpointDomain"));
        assertEq(codec.checkpointDigest(checkpoint), golden.readBytes32(".checkpoint.digest"));
    }

    function test_MiniatureAppendUpgradeCheckpointAndGas() public {
        ERC8004RegistryCallerMiniature identity = new ERC8004RegistryCallerMiniature();
        ERC8004RegistryCallerMiniature reputation = new ERC8004RegistryCallerMiniature();
        bytes32 identityHash = keccak256("identity-v3");
        bytes32 reputationHash = keccak256("reputation-v3");
        ERC8004AccumulatorMiniature mirror =
            new ERC8004AccumulatorMiniature(address(identity), address(reputation), identityHash, reputationHash);
        identity.bind(mirror);
        reputation.bind(mirror);

        bytes32 topics = keccak256("topics");
        bytes32 data = keccak256("data");
        bytes32 preimage = keccak256("preimage");
        identity.append(3, identityHash, topics, data, preimage);

        uint256 gasBefore = gasleft();
        reputation.append(5, reputationHash, topics, data, preimage);
        uint256 steadyAppendGas = gasBefore - gasleft();
        emit log_named_uint("steady cooperating append gas", steadyAppendGas);
        assertLt(steadyAppendGas, 100_000, "append gas ceiling");

        bytes32 nextHash = keccak256("reputation-v4");
        reputation.append(10, nextHash, topics, data, preimage);
        assertEq(mirror.currentImplementationCodeHash(address(reputation)), nextHash);

        vm.expectRevert(
            abi.encodeWithSelector(ERC8004AccumulatorMiniature.WrongImplementation.selector, nextHash, reputationHash)
        );
        reputation.append(5, reputationHash, topics, data, preimage);

        gasBefore = gasleft();
        (, bytes32 digest) = mirror.checkpoint(keccak256("finalized-block"));
        uint256 checkpointGas = gasBefore - gasleft();
        emit log_named_uint("checkpoint gas", checkpointGas);
        assertNotEq(digest, bytes32(0));
        assertLt(checkpointGas, 150_000, "checkpoint gas ceiling");
    }
}
