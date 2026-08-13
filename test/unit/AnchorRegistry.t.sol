// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AnchorRegistry} from "contracts/registry/AnchorRegistry.sol";

/// @title AnchorRegistryTest
/// @notice Lane-2 anchor log (OFFCHAIN_ATTESTATIONS_ZK §4.1): fold parity against the frozen golden
///         leaf, registration gates, role gating, unregistered reverts, fold-index monotonicity, the
///         H-5 ingress checks (owner co-signature over `(head, count)` + strictly increasing counts
///         for address-kind nodes), and a fuzzed fold-vs-events invariant. The leaf/fold encodings
///         are FROZEN and golden-locked — the tests assert against
///         `test/golden/trust-graph.json .anchor`, never redefine them.
contract AnchorRegistryTest is Test {
    using stdJson for string;

    AnchorRegistry reg;
    address admin = address(0xA11CE);

    // An address-kind node owner with a known key (for head co-signatures).
    uint256 ownerKey = 0xB0B;
    address owner;

    string json;

    // Golden `.anchor.leaf` vector fields.
    bytes32 goldenNodeId;
    uint8 goldenKind;
    bytes32 goldenHead;
    uint64 goldenCount;
    bytes32 goldenDataCommitment;
    uint256 goldenTimestamp;
    bytes32 goldenLeaf;

    // Mirror of the contract events (so expectEmit binds by name).
    event HeadAnchored(
        uint64 indexed foldIndex,
        bytes32 indexed nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        uint256 blockTimestamp
    );
    event NodeRegistered(bytes32 indexed nodeId, uint8 kind, address registrant);

    function setUp() public {
        reg = new AnchorRegistry(admin);
        owner = vm.addr(ownerKey);

        json = vm.readFile("test/golden/trust-graph.json");
        goldenNodeId = json.readBytes32(".anchor.leaf.nodeId");
        goldenKind = uint8(json.readUint(".anchor.leaf.envelopeKind"));
        goldenHead = json.readBytes32(".anchor.leaf.head");
        goldenCount = uint64(json.readUint(".anchor.leaf.count"));
        goldenDataCommitment = json.readBytes32(".anchor.leaf.dataCommitment");
        goldenTimestamp = json.readUint(".anchor.leaf.blockTimestamp");
        goldenLeaf = json.readBytes32(".anchor.leaf.leaf");
    }

    /// The Solidity twin of `zk_core::anchor::anchor_leaf` — kept local so a divergence in the contract
    /// surfaces as a failing assertion, not a silently-matching helper.
    function _leaf(bytes32 nodeId, uint8 kind, bytes32 head, uint64 count, bytes32 dataCommitment, uint256 ts)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(nodeId, kind, head, count, dataCommitment, ts));
    }

    function _fold(bytes32 acc, bytes32 leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(acc, leaf));
    }

    /// EIP-191 co-signature by `key` over the frozen head payload
    /// `keccak256(abi.encode(HEAD_DOMAIN_TAG, head, uint64 count))` (envelopes::eas_offchain).
    function _headSig(uint256 key, bytes32 head, uint64 count) internal view returns (bytes memory) {
        bytes32 payload = keccak256(abi.encode(reg.HEAD_DOMAIN_TAG(), head, count));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(payload));
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                        FOLD PARITY (golden-locked)
    //////////////////////////////////////////////////////////////*/

    /// Anchoring the golden vector's fields at its timestamp reproduces the frozen golden leaf, and the
    /// registry's running fold equals the Solidity re-fold from acc_0 = 0. (The golden node is a
    /// non-address kind, so no head signature is required — signature ingress is covered below.)
    function test_FoldParityReproducesGoldenLeaf() public {
        vm.warp(goldenTimestamp);

        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);

        // Local re-derivation must equal the frozen golden leaf before we trust it.
        bytes32 localLeaf =
            _leaf(goldenNodeId, goldenKind, goldenHead, goldenCount, goldenDataCommitment, goldenTimestamp);
        assertEq(localLeaf, goldenLeaf, "local leaf must match frozen golden leaf");

        reg.anchor(goldenNodeId, goldenKind, goldenHead, goldenCount, goldenDataCommitment, "");

        assertEq(reg.anchorCount(), 1);
        assertEq(reg.anchorAcc(), _fold(bytes32(0), goldenLeaf), "acc must be fold(0, goldenLeaf)");
    }

    /// A multi-anchor sequence's running fold equals an independent Solidity re-fold.
    function test_FoldParityMultiAnchor() public {
        vm.warp(goldenTimestamp);
        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);

        bytes32 acc = bytes32(0);
        for (uint64 i = 0; i < 5; i++) {
            bytes32 head = keccak256(abi.encode("head", i));
            bytes32 dc = keccak256(abi.encode("dc", i));
            reg.anchor(goldenNodeId, goldenKind, head, i + 1, dc, "");
            acc = _fold(acc, _leaf(goldenNodeId, goldenKind, head, i + 1, dc, block.timestamp));
        }
        assertEq(reg.anchorCount(), 5);
        assertEq(reg.anchorAcc(), acc, "running fold must match re-fold");
    }

    /*//////////////////////////////////////////////////////////////
                        REGISTRATION GATES
    //////////////////////////////////////////////////////////////*/

    /// Self-registration derives the nodeId from msg.sender itself — a caller cannot bind an id that
    /// does not match their address derivation (register() takes no id argument).
    function test_SelfRegisterBindsSenderDerivedNodeId() public {
        address user = address(0xBEEF);
        bytes32 expected = keccak256(abi.encode(user));

        vm.expectEmit(true, false, false, true, address(reg));
        emit NodeRegistered(expected, reg.NODE_KIND_ADDRESS(), user);

        vm.prank(user);
        reg.register();

        assertTrue(reg.registered(expected));
        assertEq(reg.nodeKind(expected), reg.NODE_KIND_ADDRESS());
        assertEq(reg.ownerOf(expected), user, "address node must record its head signer");
    }

    function test_SelfRegisterRejectsDouble() public {
        address user = address(0xBEEF);
        vm.startPrank(user);
        reg.register();
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.AlreadyRegistered.selector, keccak256(abi.encode(user))));
        reg.register();
        vm.stopPrank();
    }

    function test_RegisterNodeRejectsAddressKind() public {
        vm.prank(admin);
        vm.expectRevert(AnchorRegistry.AddressKindIsSelfRegisterOnly.selector);
        reg.registerNode(bytes32(uint256(0xdead)), 0);
    }

    function test_RegisterNodeRoleGated() public {
        bytes32 nodeId = keccak256("did:plc:example");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), reg.REGISTRAR_ROLE()
            )
        );
        reg.registerNode(nodeId, 1);
    }

    function test_RegisterNodeByRegistrar() public {
        bytes32 nodeId = keccak256("did:plc:example");
        vm.expectEmit(true, false, false, true, address(reg));
        emit NodeRegistered(nodeId, 1, admin);
        vm.prank(admin);
        reg.registerNode(nodeId, 1);
        assertTrue(reg.registered(nodeId));
        assertEq(reg.nodeKind(nodeId), 1);
        assertEq(reg.ownerOf(nodeId), address(0), "non-address nodes have no recorded signer");
    }

    function test_RegisterNodeRejectsDouble() public {
        bytes32 nodeId = keccak256("did:plc:example");
        vm.startPrank(admin);
        reg.registerNode(nodeId, 1);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.AlreadyRegistered.selector, nodeId));
        reg.registerNode(nodeId, 1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        ANCHOR GATE + EVENTS
    //////////////////////////////////////////////////////////////*/

    function test_AnchorRevertsForUnregistered() public {
        bytes32 nodeId = keccak256("unregistered");
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.NotRegistered.selector, nodeId));
        reg.anchor(nodeId, 0, bytes32(uint256(1)), 1, bytes32(uint256(2)), "");
    }

    /// Every anchor emits HeadAnchored with a monotonically increasing foldIndex starting at 0.
    function test_FoldIndexMonotonicInEvents() public {
        vm.warp(goldenTimestamp);
        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);

        for (uint64 i = 0; i < 4; i++) {
            bytes32 head = keccak256(abi.encode("h", i));
            bytes32 dc = keccak256(abi.encode("d", i));
            vm.expectEmit(true, true, false, true, address(reg));
            emit HeadAnchored(i, goldenNodeId, goldenKind, head, i + 1, dc, block.timestamp);
            reg.anchor(goldenNodeId, goldenKind, head, i + 1, dc, "");
        }
        assertEq(reg.anchorCount(), 4);
    }

    /// Anchoring is permissionless for a registered node (any address may relay).
    function test_AnchorPermissionlessForRegistered() public {
        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);
        vm.prank(address(0xD00D));
        reg.anchor(goldenNodeId, goldenKind, bytes32(uint256(7)), 1, bytes32(uint256(8)), "");
        assertEq(reg.anchorCount(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                H-5: ADDRESS-KIND INGRESS (sig + monotonic count)
    //////////////////////////////////////////////////////////////*/

    function _registerOwnerNode() internal returns (bytes32 nodeId) {
        nodeId = keccak256(abi.encode(owner));
        vm.prank(owner);
        reg.register();
    }

    /// A third party can RELAY the owner's co-signed head (permissionless force-inclusion), and
    /// lastCount advances.
    function test_H5_RelayWithOwnerSignatureWorks() public {
        bytes32 nodeId = _registerOwnerNode();
        bytes32 head = keccak256("head-3");
        vm.prank(address(0xD00D));
        reg.anchor(nodeId, 0, head, 3, bytes32(0), _headSig(ownerKey, head, 3));
        assertEq(reg.anchorCount(), 1);
        assertEq(reg.lastCount(nodeId), 3);
    }

    /// H-5 regression: a STALE head (owner-signed at a lower count) cannot be re-anchored once a
    /// newer head is in the log — the exact replay the audit flagged.
    function test_H5_StaleHeadReplayRejected() public {
        bytes32 nodeId = _registerOwnerNode();
        bytes32 headOld = keccak256("head-pre-revocation");
        bytes32 headNew = keccak256("head-post-revocation");
        bytes memory sigOld = _headSig(ownerKey, headOld, 3); // still a VALID owner signature

        reg.anchor(nodeId, 0, headNew, 5, bytes32(0), _headSig(ownerKey, headNew, 5));

        // Re-anchoring the old head (count 3 <= lastCount 5) reverts for anyone — including the owner.
        vm.prank(address(0xD00D));
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(3), uint64(5)));
        reg.anchor(nodeId, 0, headOld, 3, bytes32(0), sigOld);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(3), uint64(5)));
        reg.anchor(nodeId, 0, headOld, 3, bytes32(0), sigOld);

        // Equal count is also stale (strictly increasing).
        bytes memory sigNew = _headSig(ownerKey, headNew, 5);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(5), uint64(5)));
        reg.anchor(nodeId, 0, headNew, 5, bytes32(0), sigNew);
    }

    /// A head not co-signed by the node owner is rejected: a third party can relay, never forge.
    function test_H5_ForeignSignatureRejected() public {
        bytes32 nodeId = _registerOwnerNode();
        bytes32 head = keccak256("head-1");
        bytes memory foreignSig = _headSig(0xBADD, head, 1);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        reg.anchor(nodeId, 0, head, 1, bytes32(0), foreignSig);
    }

    /// A lied-about count breaks the signature binding: the owner signed (head, 3), so anchoring it
    /// as count 4 recovers a different signer and is rejected.
    function test_H5_LiedCountRejected() public {
        bytes32 nodeId = _registerOwnerNode();
        bytes32 head = keccak256("head-3");
        bytes memory sigFor3 = _headSig(ownerKey, head, 3);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        reg.anchor(nodeId, 0, head, 4, bytes32(0), sigFor3);
    }

    /// The count binds into the folded leaf byte-for-byte (guest parity depends on it).
    function test_H5_CountBindsIntoLeaf() public {
        vm.warp(goldenTimestamp);
        bytes32 nodeId = _registerOwnerNode();
        bytes32 head = keccak256("head-7");
        reg.anchor(nodeId, 0, head, 7, bytes32(uint256(9)), _headSig(ownerKey, head, 7));
        assertEq(
            reg.anchorAcc(),
            _fold(bytes32(0), _leaf(nodeId, 0, head, 7, bytes32(uint256(9)), goldenTimestamp)),
            "leaf must commit the signed count"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                FUZZ
    //////////////////////////////////////////////////////////////*/

    /// Arbitrary anchor sequences: count tracks the number of anchors and the running fold equals an
    /// independent Solidity re-fold over the same leaves at the same timestamps.
    function testFuzz_FoldMatchesRefold(bytes32[] calldata heads, uint8 kind, uint32 warp) public {
        vm.assume(heads.length <= 32);
        vm.warp(uint256(warp) + 1);

        // Node kind 0 is self-register-only; fuzz over the registrar-registerable kinds.
        kind = uint8(bound(kind, 1, type(uint8).max));
        bytes32 nodeId = keccak256(abi.encode("fuzz-node"));
        vm.prank(admin);
        reg.registerNode(nodeId, kind);

        bytes32 acc = bytes32(0);
        for (uint256 i = 0; i < heads.length; i++) {
            bytes32 dc = keccak256(abi.encode(heads[i], i));
            reg.anchor(nodeId, kind, heads[i], uint64(i + 1), dc, "");
            acc = _fold(acc, _leaf(nodeId, kind, heads[i], uint64(i + 1), dc, block.timestamp));
        }

        assertEq(reg.anchorCount(), uint64(heads.length), "count == number of anchors");
        assertEq(reg.anchorAcc(), acc, "acc == independent re-fold");
    }
}
