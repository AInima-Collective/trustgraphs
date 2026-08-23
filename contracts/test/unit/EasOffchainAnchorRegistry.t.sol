// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {EasOffchainAnchorRegistry} from "src/registry/EasOffchainAnchorRegistry.sol";
import {EasOffchainAnchorRegistryDeployer} from "src/factory/HybridInstanceDeployers.sol";

contract EasOffchainAccumulatorMock {
    uint64 public leafCount;

    function setLeafCount(uint64 count) external {
        leafCount = count;
    }
}

contract EasOffchainSnapshotMock {
    address public accumulator;
    address public anchorRegistry;

    constructor(address accumulator_, address anchorRegistry_) {
        accumulator = accumulator_;
        anchorRegistry = anchorRegistry_;
    }
}

/// @notice Security and accounting lock for the opt-in strict off-chain EAS v2 ingress.
contract EasOffchainAnchorRegistryTest is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ANCHOR_TYPEHASH = keccak256(
        "Anchor(bytes32 nodeId,uint8 envelopeKind,bytes32 schemaUid,bytes32 previousHead,bytes32 head,uint64 count,bytes32 dataCommitment)"
    );
    bytes32 internal constant SCHEMA_UID = keccak256("strict-envelope-0-schema");

    uint256 internal constant OWNER_KEY = 0xA11CE;
    address internal owner;
    address internal admin = address(0xAD11);
    address internal binder = address(this);

    EAS internal eas;
    EasOffchainAnchorRegistry internal registry;
    EasOffchainAccumulatorMock internal lane1;
    EasOffchainSnapshotMock internal snapshot;

    event NodeRegistered(bytes32 indexed nodeId, address indexed owner);
    event HeadAnchored(
        uint64 indexed foldIndex,
        bytes32 indexed nodeId,
        address indexed owner,
        uint8 envelopeKind,
        bytes32 schemaUid,
        bytes32 previousHead,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        uint256 blockTimestamp,
        bytes headSignature
    );

    function setUp() public {
        SchemaRegistry schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        lane1 = new EasOffchainAccumulatorMock();
        address[] memory relayers = new address[](1);
        relayers[0] = address(this);
        registry = new EasOffchainAnchorRegistry(IEAS(address(eas)), SCHEMA_UID, 200_000, admin, binder, relayers);
        snapshot = new EasOffchainSnapshotMock(address(lane1), address(registry));
        registry.bindSnapshot(address(snapshot));
        owner = vm.addr(OWNER_KEY);
    }

    function test_DomainSeparatorsAndDigestMatchIndependentEip712Derivation() public view {
        bytes32 expectedEas = _domain("EAS Attestation", eas.version(), block.chainid, address(eas));
        bytes32 expectedHead = _domain("Trustgraphs Offchain Head", "2", block.chainid, address(registry));
        assertEq(registry.easDomainSeparator(), expectedEas);
        assertEq(registry.headDomainSeparator(), expectedHead);

        bytes32 nodeId = _nodeId(owner);
        bytes32 head = keccak256("head-1");
        bytes32 commitment = sha256("payload-1");
        bytes32 expectedDigest = _digest(expectedHead, nodeId, SCHEMA_UID, bytes32(0), head, 1, commitment);
        assertEq(registry.anchorDigest(nodeId, 0, bytes32(0), head, 1, commitment), expectedDigest);
    }

    function test_FirstAnchorAtomicallyRegistersOwnerAndEmitsCompleteFoldMetadata() public {
        vm.warp(1_770_000_060);
        bytes32 nodeId = _nodeId(owner);
        bytes32 head = keccak256("head-1");
        bytes32 commitment = sha256("payload-1");
        bytes memory signature = _signature(OWNER_KEY, nodeId, bytes32(0), head, 1, commitment);

        vm.expectEmit(true, true, false, true, address(registry));
        emit NodeRegistered(nodeId, owner);
        vm.expectEmit(true, true, true, true, address(registry));
        emit HeadAnchored(0, nodeId, owner, 0, SCHEMA_UID, bytes32(0), head, 1, commitment, block.timestamp, signature);
        registry.anchor(nodeId, 0, bytes32(0), head, 1, commitment, signature);

        bytes32 leaf = keccak256(abi.encode(nodeId, uint8(0), head, uint64(1), commitment, block.timestamp));
        assertTrue(registry.registered(nodeId));
        assertEq(registry.ownerOf(nodeId), owner);
        assertEq(registry.lastCount(nodeId), 1);
        assertEq(registry.lastHead(nodeId), head);
        assertEq(registry.lastDataCommitment(nodeId), commitment);
        assertEq(registry.anchorCount(), 1);
        assertEq(registry.aggregateLatestEnvelope0EntryCount(), 1);
        assertEq(registry.workCount(), 5, "one anchor + one latest entry times four");
        assertEq(registry.anchorAcc(), keccak256(abi.encode(bytes32(0), leaf)));
    }

    function test_AppendsUseCountDeltaForWorkAndPreserveFoldOrder() public {
        bytes32 nodeId = _nodeId(owner);
        bytes32 head1 = keccak256("head-1");
        bytes32 commitment1 = sha256("payload-1");
        registry.anchor(
            nodeId,
            0,
            bytes32(0),
            head1,
            1,
            commitment1,
            _signature(OWNER_KEY, nodeId, bytes32(0), head1, 1, commitment1)
        );
        bytes32 acc1 = registry.anchorAcc();

        vm.warp(block.timestamp + 60);
        bytes32 head3 = keccak256("head-3");
        bytes32 commitment3 = sha256("payload-3");
        registry.anchor(
            nodeId, 0, head1, head3, 3, commitment3, _signature(OWNER_KEY, nodeId, head1, head3, 3, commitment3)
        );

        bytes32 leaf2 = keccak256(abi.encode(nodeId, uint8(0), head3, uint64(3), commitment3, block.timestamp));
        assertEq(registry.anchorAcc(), keccak256(abi.encode(acc1, leaf2)));
        assertEq(registry.anchorCount(), 2);
        assertEq(registry.aggregateLatestEnvelope0EntryCount(), 3);
        assertEq(registry.workCount(), 14, "two anchors + three latest entries times four");
    }

    function test_SignatureIsBoundToChainRegistrySchemaAndEveryTransitionField() public {
        bytes32 nodeId = _nodeId(owner);
        bytes32 head = keccak256("head");
        bytes32 commitment = sha256("payload");

        bytes32 otherChainDomain = _domain("Trustgraphs Offchain Head", "2", block.chainid + 1, address(registry));
        _expectWrongDomainSignature(nodeId, head, commitment, otherChainDomain);

        bytes32 otherRegistryDomain = _domain("Trustgraphs Offchain Head", "2", block.chainid, address(0xBEEF));
        _expectWrongDomainSignature(nodeId, head, commitment, otherRegistryDomain);

        bytes32 wrongSchemaDigest =
            _digest(registry.headDomainSeparator(), nodeId, keccak256("wrong-schema"), bytes32(0), head, 1, commitment);
        _expectWrongSignature(nodeId, head, commitment, _sign(OWNER_KEY, wrongSchemaDigest));

        bytes memory wrongCommitment = _signature(OWNER_KEY, nodeId, bytes32(0), head, 1, keccak256("other"));
        _expectWrongSignature(nodeId, head, commitment, wrongCommitment);
    }

    function test_RejectsPreviousHeadMismatchStaleAndSameCounts() public {
        bytes32 nodeId = _nodeId(owner);
        bytes32 head1 = keccak256("head-1");
        bytes32 commitment1 = sha256("payload-1");
        registry.anchor(
            nodeId,
            0,
            bytes32(0),
            head1,
            2,
            commitment1,
            _signature(OWNER_KEY, nodeId, bytes32(0), head1, 2, commitment1)
        );

        bytes32 head2 = keccak256("head-2");
        bytes32 commitment2 = sha256("payload-2");
        vm.expectRevert(abi.encodeWithSelector(EasOffchainAnchorRegistry.SameCountConflict.selector, nodeId, uint64(2)));
        registry.anchor(nodeId, 0, head1, head2, 2, commitment2, hex"");

        vm.expectRevert(
            abi.encodeWithSelector(EasOffchainAnchorRegistry.StaleHeadCount.selector, nodeId, uint64(1), uint64(2))
        );
        registry.anchor(nodeId, 0, head1, head2, 1, commitment2, hex"");

        bytes32 wrongPrevious = keccak256("wrong-previous");
        vm.expectRevert(
            abi.encodeWithSelector(
                EasOffchainAnchorRegistry.PreviousHeadMismatch.selector, nodeId, wrongPrevious, head1
            )
        );
        registry.anchor(nodeId, 0, wrongPrevious, head2, 3, commitment2, hex"");
    }

    function test_RejectsWrongKindEmptyFieldsAndEntryMaximum() public {
        bytes32 nodeId = _nodeId(owner);
        vm.expectRevert(abi.encodeWithSelector(EasOffchainAnchorRegistry.InvalidEnvelopeKind.selector, uint8(1)));
        registry.anchor(nodeId, 1, bytes32(0), bytes32(uint256(1)), 1, bytes32(uint256(2)), hex"");

        vm.expectRevert(EasOffchainAnchorRegistry.ZeroBytes32.selector);
        registry.anchor(nodeId, 0, bytes32(0), bytes32(0), 1, bytes32(uint256(2)), hex"");

        vm.expectRevert(
            abi.encodeWithSelector(EasOffchainAnchorRegistry.InvalidEntryCount.selector, uint64(2_049), uint64(2_048))
        );
        registry.anchor(nodeId, 0, bytes32(0), bytes32(uint256(1)), 2_049, bytes32(uint256(2)), hex"");
    }

    function test_CombinedLaneWorkCapChecksLane1AndLatestEntryDelta() public {
        EasOffchainAnchorRegistry capped = _boundRegistry(10, address(this));
        bytes32 nodeId = _nodeId(owner);
        bytes32 head2 = keccak256("head-2");
        bytes32 commitment2 = sha256("payload-2");
        capped.anchor(
            nodeId,
            0,
            bytes32(0),
            head2,
            2,
            commitment2,
            _signatureFor(capped, OWNER_KEY, nodeId, bytes32(0), head2, 2, commitment2)
        );
        assertEq(capped.workCount(), 9);

        bytes32 head3 = keccak256("head-3");
        bytes32 commitment3 = sha256("payload-3");
        bytes memory signature3 = _signatureFor(capped, OWNER_KEY, nodeId, head2, head3, 3, commitment3);
        vm.expectRevert(
            abi.encodeWithSelector(
                EasOffchainAnchorRegistry.InputCapacityExceeded.selector, uint64(0), uint64(14), uint64(10)
            )
        );
        capped.anchor(nodeId, 0, head2, head3, 3, commitment3, signature3);

        EasOffchainAnchorRegistry lane1Capped = _boundRegistry(10, address(this));
        lane1.setLeafCount(6);
        bytes32 head1 = keccak256("one");
        bytes32 commitment1 = sha256("one");
        bytes memory signature1 = _signatureFor(lane1Capped, OWNER_KEY, nodeId, bytes32(0), head1, 1, commitment1);
        vm.expectRevert(
            abi.encodeWithSelector(
                EasOffchainAnchorRegistry.InputCapacityExceeded.selector, uint64(6), uint64(5), uint64(10)
            )
        );
        lane1Capped.anchor(nodeId, 0, bytes32(0), head1, 1, commitment1, signature1);
    }

    function test_RelayerRoleAndInertDeployerReceiveNoAuthority() public {
        address outsider = address(0xBAD);
        bytes32 nodeId = _nodeId(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, registry.ANCHORER_ROLE()
            )
        );
        vm.prank(outsider);
        registry.anchor(nodeId, 0, bytes32(0), bytes32(uint256(1)), 1, bytes32(uint256(2)), hex"");

        EasOffchainAnchorRegistryDeployer deployer = new EasOffchainAnchorRegistryDeployer();
        address[] memory relayers = new address[](1);
        relayers[0] = address(this);
        EasOffchainAnchorRegistry deployed =
            deployer.deploy(IEAS(address(eas)), SCHEMA_UID, 200_000, admin, address(this), relayers);
        assertFalse(deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), address(deployer)));
        assertFalse(deployed.hasRole(deployed.ANCHORER_ROLE(), address(deployer)));
    }

    function test_SnapshotBindingIsBinderOnlyReciprocalAndOneShot() public {
        address[] memory relayers = new address[](1);
        relayers[0] = address(this);
        EasOffchainAnchorRegistry unbound =
            new EasOffchainAnchorRegistry(IEAS(address(eas)), SCHEMA_UID, 100, admin, binder, relayers);
        EasOffchainSnapshotMock wrong = new EasOffchainSnapshotMock(address(lane1), address(registry));
        vm.expectRevert(
            abi.encodeWithSelector(
                EasOffchainAnchorRegistry.SnapshotRegistryMismatch.selector,
                address(wrong),
                address(unbound),
                address(registry)
            )
        );
        unbound.bindSnapshot(address(wrong));

        EasOffchainSnapshotMock right = new EasOffchainSnapshotMock(address(lane1), address(unbound));
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(EasOffchainAnchorRegistry.NotBinder.selector, address(0xBAD)));
        unbound.bindSnapshot(address(right));
        unbound.bindSnapshot(address(right));
        vm.expectRevert(abi.encodeWithSelector(EasOffchainAnchorRegistry.SnapshotAlreadyBound.selector, address(right)));
        unbound.bindSnapshot(address(right));
    }

    function testFuzz_SequenceMaintainsExactWorkInvariant(uint64[12] memory requestedDeltas) public {
        bytes32 nodeId = _nodeId(owner);
        bytes32 previous;
        uint64 count;
        for (uint256 i; i < requestedDeltas.length; ++i) {
            uint64 remaining = 2_048 - count;
            if (remaining == 0) break;
            uint64 delta = uint64(bound(requestedDeltas[i], 1, remaining));
            uint64 nextCount = count + delta;
            bytes32 head = keccak256(abi.encode("head", i, nextCount));
            bytes32 commitment = keccak256(abi.encode("payload", i, nextCount));
            registry.anchor(
                nodeId,
                0,
                previous,
                head,
                nextCount,
                commitment,
                _signature(OWNER_KEY, nodeId, previous, head, nextCount, commitment)
            );
            count = nextCount;
            previous = head;
            assertEq(registry.aggregateLatestEnvelope0EntryCount(), count);
            assertEq(registry.workCount(), registry.anchorCount() + count * 4);
        }
    }

    function _boundRegistry(uint64 cap, address relayer) internal returns (EasOffchainAnchorRegistry out) {
        address[] memory relayers = new address[](1);
        relayers[0] = relayer;
        out = new EasOffchainAnchorRegistry(IEAS(address(eas)), SCHEMA_UID, cap, admin, binder, relayers);
        EasOffchainSnapshotMock bound = new EasOffchainSnapshotMock(address(lane1), address(out));
        out.bindSnapshot(address(bound));
    }

    function _expectWrongDomainSignature(bytes32 nodeId, bytes32 head, bytes32 commitment, bytes32 domain) internal {
        bytes32 digest = _digest(domain, nodeId, SCHEMA_UID, bytes32(0), head, 1, commitment);
        _expectWrongSignature(nodeId, head, commitment, _sign(OWNER_KEY, digest));
    }

    function _expectWrongSignature(bytes32 nodeId, bytes32 head, bytes32 commitment, bytes memory signature) internal {
        vm.expectPartialRevert(EasOffchainAnchorRegistry.WrongNodeId.selector);
        registry.anchor(nodeId, 0, bytes32(0), head, 1, commitment, signature);
    }

    function _signature(uint256 key, bytes32 nodeId, bytes32 previous, bytes32 head, uint64 count, bytes32 commitment)
        internal
        view
        returns (bytes memory)
    {
        return _signatureFor(registry, key, nodeId, previous, head, count, commitment);
    }

    function _signatureFor(
        EasOffchainAnchorRegistry target,
        uint256 key,
        bytes32 nodeId,
        bytes32 previous,
        bytes32 head,
        uint64 count,
        bytes32 commitment
    ) internal view returns (bytes memory) {
        return _sign(key, target.anchorDigest(nodeId, 0, previous, head, count, commitment));
    }

    function _sign(uint256 key, bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _digest(
        bytes32 domain,
        bytes32 nodeId,
        bytes32 schema,
        bytes32 previous,
        bytes32 head,
        uint64 count,
        bytes32 commitment
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ANCHOR_TYPEHASH, nodeId, uint8(0), schema, previous, head, count, commitment)
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    function _domain(string memory name, string memory version, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
    }

    function _nodeId(address account) internal pure returns (bytes32) {
        return keccak256(abi.encode(account));
    }
}
