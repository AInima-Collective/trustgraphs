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

/// @notice Signature-replay regression coverage for the generic lane-2 ingress deployed by the
///         Nostr workspace and Hypercerts instance scripts.
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

    function _sign(
        AnchorRegistry target,
        bytes32 nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(OWNER_KEY, target.anchorDigest(nodeId, envelopeKind, head, count, dataCommitment));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------------
    // 1. Cross-instance replay is rejected by the verifying-contract domain.
    // ---------------------------------------------------------------------
    function test_headSignature_is_bound_to_one_instance() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("owner-head-at-count-9");
        bytes32 commitment = keccak256("cid-a");
        bytes memory sig = _sign(regA, nodeId, 0, head, 9, commitment);

        regA.anchor(nodeId, 0, head, 9, commitment, sig);
        assertEq(regA.lastCount(nodeId), 9);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        regB.anchor(nodeId, 0, head, 9, commitment, sig);
        assertEq(regB.lastCount(nodeId), 0, "replay did not consume the other registry's count");

        bytes32 head3 = keccak256("b-head-3");
        bytes32 commitment3 = keccak256("cid-b");
        bytes memory sig3 = _sign(regB, nodeId, 0, head3, 3, commitment3);
        regB.anchor(nodeId, 0, head3, 3, commitment3, sig3);
        assertEq(regB.lastCount(nodeId), 3, "the intended registry's history remains usable");
    }

    // ---------------------------------------------------------------------
    // 2. Cross-chain replay is rejected by the deployment-chain domain.
    // ---------------------------------------------------------------------
    function test_headSignature_is_bound_to_the_deployment_chain() public {
        vm.chainId(1);
        AnchorRegistry chainA = _deploy();
        vm.prank(owner);
        chainA.register();

        vm.chainId(999);
        AnchorRegistry chainB = _deploy();
        vm.prank(owner);
        chainB.register();

        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("head-1");
        bytes32 commitment = keccak256("cid");
        bytes memory sig = _sign(chainA, nodeId, 0, head, 1, commitment);

        chainA.anchor(nodeId, 0, head, 1, commitment, sig);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        chainB.anchor(nodeId, 0, head, 1, commitment, sig);
        assertEq(chainB.lastCount(nodeId), 0);
    }

    // ---------------------------------------------------------------------
    // 3. Mutated leaf fields are rejected without consuming the count.
    // ---------------------------------------------------------------------
    function test_unsignedFields_are_bound_and_do_not_burn_the_count() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("honest-head-at-7");
        bytes32 honestCommitment = keccak256("honest-availability-pointer");
        bytes memory sig = _sign(regA, nodeId, 0, head, 7, honestCommitment);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        regA.anchor(nodeId, 1, head, 7, keccak256("garbage"), sig);
        assertEq(regA.lastCount(nodeId), 0);

        regA.anchor(nodeId, 0, head, 7, honestCommitment, sig);
        assertEq(regA.lastCount(nodeId), 7);
    }

    // ---------------------------------------------------------------------
    // 4. Non-address node kinds still have no signature check, but the count is bounded and the
    //    constitutional admin can recover the monotonic admission gate.
    // ---------------------------------------------------------------------
    function test_nonAddressKind_needs_no_signature_but_count_gate_is_recoverable() public {
        bytes32 didNode = keccak256("did:plc:victim");
        vm.prank(admin);
        regA.registerNode(didNode, 1);

        vm.expectRevert(
            abi.encodeWithSelector(AnchorRegistry.InvalidHeadCount.selector, type(uint64).max, regA.maxTotalInputs())
        );
        regA.anchor(didNode, 1, keccak256("forged-head"), type(uint64).max, keccak256("x"), "");

        regA.anchor(didNode, 1, keccak256("forged-head"), regA.maxTotalInputs(), keccak256("x"), "");
        vm.prank(admin);
        regA.resetHeadCount(didNode);
        regA.anchor(didNode, 1, keccak256("real-head"), 1, keccak256("y"), "");
        assertEq(regA.lastCount(didNode), 1);
    }

    // ---------------------------------------------------------------------
    // 5. The legacy EIP-191 challenge is not a valid EIP-712 authorization.
    // ---------------------------------------------------------------------
    function test_a_blind_32_byte_personal_sign_is_rejected() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 attackerHead = keccak256("attacker-chosen-head");
        uint64 attackerCount = regA.maxTotalInputs();
        bytes32 challenge =
            keccak256(abi.encode(keccak256("TRUSTGRAPH_ENVELOPE0_HEAD_V1"), attackerHead, attackerCount));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, MessageHashUtils.toEthSignedMessageHash(challenge));
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        regA.anchor(nodeId, 0, attackerHead, attackerCount, keccak256("x"), sig);
        assertEq(regA.lastCount(nodeId), 0);
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
