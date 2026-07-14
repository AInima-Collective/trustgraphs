// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AnchorRegistry} from "contracts/registry/AnchorRegistry.sol";

/// @title AnchorRegistryTest
/// @notice Lane-2 anchor log (OFFCHAIN_ATTESTATIONS_ZK §4.1): fold parity against the frozen golden
///         leaf, registration gates, role gating, unregistered reverts, fold-index monotonicity, and a
///         fuzzed fold-vs-events invariant. The leaf/fold encodings are FROZEN and golden-locked — the
///         tests assert against `test/golden/trust-graph.json .anchor`, never redefine them.
contract AnchorRegistryTest is Test {
    using stdJson for string;

    AnchorRegistry reg;
    address admin = address(0xA11CE);

    string json;

    // Golden `.anchor.leaf` vector fields.
    bytes32 goldenNodeId;
    uint8 goldenKind;
    bytes32 goldenHead;
    bytes32 goldenDataCommitment;
    uint256 goldenTimestamp;
    bytes32 goldenLeaf;

    // Mirror of the contract events (so expectEmit binds by name).
    event HeadAnchored(
        uint64 indexed foldIndex,
        bytes32 indexed nodeId,
        uint8 envelopeKind,
        bytes32 head,
        bytes32 dataCommitment,
        uint256 blockTimestamp
    );
    event NodeRegistered(bytes32 indexed nodeId, uint8 kind, address registrant);

    function setUp() public {
        reg = new AnchorRegistry(admin);

        json = vm.readFile("test/golden/trust-graph.json");
        goldenNodeId = json.readBytes32(".anchor.leaf.nodeId");
        goldenKind = uint8(json.readUint(".anchor.leaf.envelopeKind"));
        goldenHead = json.readBytes32(".anchor.leaf.head");
        goldenDataCommitment = json.readBytes32(".anchor.leaf.dataCommitment");
        goldenTimestamp = json.readUint(".anchor.leaf.blockTimestamp");
        goldenLeaf = json.readBytes32(".anchor.leaf.leaf");
    }

    /// The Solidity twin of `zk_core::anchor::anchor_leaf` — kept local so a divergence in the contract
    /// surfaces as a failing assertion, not a silently-matching helper.
    function _leaf(bytes32 nodeId, uint8 kind, bytes32 head, bytes32 dataCommitment, uint256 ts)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(nodeId, kind, head, dataCommitment, ts));
    }

    function _fold(bytes32 acc, bytes32 leaf) internal pure returns (bytes32) {
        return keccak256(abi.encode(acc, leaf));
    }

    /*//////////////////////////////////////////////////////////////
                        FOLD PARITY (golden-locked)
    //////////////////////////////////////////////////////////////*/

    /// Anchoring the golden vector's fields at its timestamp reproduces the frozen golden leaf, and the
    /// registry's running fold equals the Solidity re-fold from acc_0 = 0.
    function test_FoldParityReproducesGoldenLeaf() public {
        vm.warp(goldenTimestamp);

        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);

        // Local re-derivation must equal the frozen golden leaf before we trust it.
        bytes32 localLeaf = _leaf(goldenNodeId, goldenKind, goldenHead, goldenDataCommitment, goldenTimestamp);
        assertEq(localLeaf, goldenLeaf, "local leaf must match frozen golden leaf");

        reg.anchor(goldenNodeId, goldenKind, goldenHead, goldenDataCommitment);

        assertEq(reg.anchorCount(), 1);
        assertEq(reg.anchorAcc(), _fold(bytes32(0), goldenLeaf), "acc must be fold(0, goldenLeaf)");
    }

    /// A multi-anchor sequence's running fold equals an independent Solidity re-fold.
    function test_FoldParityMultiAnchor() public {
        vm.warp(goldenTimestamp);
        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);

        bytes32 acc = bytes32(0);
        for (uint256 i = 0; i < 5; i++) {
            bytes32 head = keccak256(abi.encode("head", i));
            bytes32 dc = keccak256(abi.encode("dc", i));
            reg.anchor(goldenNodeId, goldenKind, head, dc);
            acc = _fold(acc, _leaf(goldenNodeId, goldenKind, head, dc, block.timestamp));
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
        reg.anchor(nodeId, 0, bytes32(uint256(1)), bytes32(uint256(2)));
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
            emit HeadAnchored(i, goldenNodeId, goldenKind, head, dc, block.timestamp);
            reg.anchor(goldenNodeId, goldenKind, head, dc);
        }
        assertEq(reg.anchorCount(), 4);
    }

    /// Anchoring is permissionless for a registered node (any address may relay).
    function test_AnchorPermissionlessForRegistered() public {
        vm.prank(admin);
        reg.registerNode(goldenNodeId, 1);
        vm.prank(address(0xD00D));
        reg.anchor(goldenNodeId, goldenKind, bytes32(uint256(7)), bytes32(uint256(8)));
        assertEq(reg.anchorCount(), 1);
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
            reg.anchor(nodeId, kind, heads[i], dc);
            acc = _fold(acc, _leaf(nodeId, kind, heads[i], dc, block.timestamp));
        }

        assertEq(reg.anchorCount(), uint64(heads.length), "count == number of anchors");
        assertEq(reg.anchorAcc(), acc, "acc == independent re-fold");
    }
}
