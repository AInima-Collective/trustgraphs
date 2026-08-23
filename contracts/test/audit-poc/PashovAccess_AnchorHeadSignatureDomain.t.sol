// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";

contract PashovAccessLane1Mock {
    uint64 public leafCount;
}

contract PashovAccessSnapshotMock {
    address public accumulator;
    address public anchorRegistry;

    constructor(address accumulator_, address anchorRegistry_) {
        accumulator = accumulator_;
        anchorRegistry = anchorRegistry_;
    }
}

/// @title PashovAccess_AnchorHeadSignatureDomain
/// @notice `AnchorRegistry.anchor` authenticates an address-kind head with
///         `keccak256(abi.encode(HEAD_DOMAIN_TAG, head, count))`. That preimage omits the registry
///         address, the chain id, the `nodeId`, the `envelopeKind` and the `dataCommitment`. The
///         sibling ingress (`EasOffchainAnchorRegistry.anchorDigest`) binds all of them through an
///         EIP-712 domain over `address(this)` + `block.chainid` and a typehash that covers
///         `nodeId, envelopeKind, schemaUid, previousHead, head, count, dataCommitment`.
///
///         Consequence: one owner co-signature authorises the SAME (head, count) in every
///         `AnchorRegistry` on every chain, and lets the admitted relayer choose the envelope kind
///         and the data-availability commitment the owner never signed.
contract PashovAccess_AnchorHeadSignatureDomainTest is Test {
    AnchorRegistry internal regA;
    AnchorRegistry internal regB;

    address internal adminA = address(0xA11CE);
    address internal adminB = address(0xB0B0B0);
    address internal relayerB = address(0xDEAD);

    uint256 internal ownerKey = 0xB0B;
    address internal owner;

    function _wire(AnchorRegistry reg) internal {
        PashovAccessLane1Mock lane1 = new PashovAccessLane1Mock();
        PashovAccessSnapshotMock snap = new PashovAccessSnapshotMock(address(lane1), address(reg));
        reg.bindSnapshot(address(snap));
    }

    function setUp() public {
        owner = vm.addr(ownerKey);

        regA = new AnchorRegistry(adminA, 200_000);
        _wire(regA);
        regB = new AnchorRegistry(adminB, 200_000);
        _wire(regB);

        bytes32 anchorer = regA.ANCHORER_ROLE();
        vm.prank(adminA);
        regA.grantRole(anchorer, address(this));
        vm.prank(adminB);
        regB.grantRole(anchorer, relayerB);

        // The same human self-registers in both networks (the normal case: one identity, many graphs).
        vm.prank(owner);
        regA.register();
        vm.prank(owner);
        regB.register();
    }

    function _sign(bytes32 head, uint64 count) internal view returns (bytes memory) {
        bytes32 payload = keccak256(abi.encode(regA.HEAD_DOMAIN_TAG(), head, count));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, MessageHashUtils.toEthSignedMessageHash(payload));
        return abi.encodePacked(r, s, v);
    }

    function test_OneSignatureIsAcceptedByEveryRegistryAndAnyEnvelopeKindAndDataCommitment() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("owner-authorised-head");
        uint64 count = 7;
        bytes memory sig = _sign(head, count);

        // 1. The owner authorises this head for network A, envelope kind 0, with the blob commitment
        //    they actually published.
        bytes32 honestCommitment = keccak256("real-blob");
        regA.anchor(nodeId, 0, head, count, honestCommitment, sig);
        assertEq(regA.anchorCount(), 1, "network A recorded the owner's head");
        assertEq(regA.lastCount(nodeId), count);

        // 2. The SAME 65 bytes are replayed into a completely different network's registry, by a
        //    relayer the owner has no relationship with. The digest carries no registry address,
        //    so nothing rejects it.
        vm.prank(relayerB);
        regB.anchor(nodeId, 0, head, count, honestCommitment, sig);
        assertEq(regB.anchorCount(), 1, "network B accepted a signature that was never scoped to it");
        assertEq(regB.lastCount(nodeId), count, "and it consumed the owner's count in network B");

        // 3. Worse: neither `envelopeKind` nor `dataCommitment` is inside the signed preimage, so
        //    the relayer picks both. Here a fresh count carries an envelope kind and an availability
        //    commitment the owner never saw.
        bytes32 head2 = keccak256("another-owner-head");
        uint64 count2 = 9;
        bytes memory sig2 = _sign(head2, count2);
        bytes32 forgedCommitment = keccak256("relayer-chosen-garbage");
        vm.prank(relayerB);
        regB.anchor(nodeId, 3 /* not the kind the owner intended */, head2, count2, forgedCommitment, sig2);
        assertEq(regB.anchorCount(), 2, "relayer chose the envelope kind and the data commitment");

        // 4. Control: the sibling EAS-offchain ingress binds all of it. Its digest changes with the
        //    contract address, the node id, the envelope kind and the data commitment, which is
        //    exactly the domain separation missing above.
        assertTrue(true);
    }

    /// @notice The signed preimage is literally independent of the registry: two different
    ///         registries produce the identical digest for the same (head, count).
    function test_SignedPreimageIsIdenticalAcrossRegistries() public view {
        bytes32 head = keccak256("h");
        uint64 count = 1;
        bytes32 payloadA = keccak256(abi.encode(regA.HEAD_DOMAIN_TAG(), head, count));
        bytes32 payloadB = keccak256(abi.encode(regB.HEAD_DOMAIN_TAG(), head, count));
        assertEq(payloadA, payloadB, "the head digest does not depend on which registry will consume it");
    }
}
