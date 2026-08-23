// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

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
/// @notice Regression coverage for the address-kind head signature. The EIP-712 domain binds the
///         registry address and chain id, while the typed `Anchor` claim binds every leaf field
///         selected by the admitted relayer.
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

    function _sign(
        AnchorRegistry target,
        bytes32 nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, target.anchorDigest(nodeId, envelopeKind, head, count, dataCommitment));
        return abi.encodePacked(r, s, v);
    }

    function test_OneSignatureCannotCrossRegistriesOrMutateClaimFields() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("owner-authorised-head");
        uint64 count = 7;
        bytes32 honestCommitment = keccak256("real-blob");
        bytes memory sig = _sign(regA, nodeId, 0, head, count, honestCommitment);

        regA.anchor(nodeId, 0, head, count, honestCommitment, sig);
        assertEq(regA.anchorCount(), 1, "network A recorded the owner's head");
        assertEq(regA.lastCount(nodeId), count);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        vm.prank(relayerB);
        regB.anchor(nodeId, 0, head, count, honestCommitment, sig);
        assertEq(regB.anchorCount(), 0, "cross-registry replay did not consume the count");

        bytes32 head2 = keccak256("another-owner-head");
        uint64 count2 = 9;
        bytes32 intendedCommitment = keccak256("owner-published-blob");
        bytes memory sig2 = _sign(regB, nodeId, 0, head2, count2, intendedCommitment);
        bytes32 forgedCommitment = keccak256("relayer-chosen-garbage");

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        vm.prank(relayerB);
        regB.anchor(
            nodeId,
            3,
            /* not the kind the owner intended */
            head2,
            count2,
            forgedCommitment,
            sig2
        );

        vm.prank(relayerB);
        regB.anchor(nodeId, 0, head2, count2, intendedCommitment, sig2);
        assertEq(regB.anchorCount(), 1, "the exact typed claim remains usable");
    }

    function test_DigestChangesAcrossRegistriesAndClaimFields() public view {
        bytes32 nodeId = keccak256(abi.encode(owner));
        bytes32 head = keccak256("h");
        uint64 count = 1;
        bytes32 commitment = keccak256("dc");
        bytes32 digest = regA.anchorDigest(nodeId, 0, head, count, commitment);

        assertNotEq(digest, regB.anchorDigest(nodeId, 0, head, count, commitment));
        assertNotEq(digest, regA.anchorDigest(keccak256("other-node"), 0, head, count, commitment));
        assertNotEq(digest, regA.anchorDigest(nodeId, 1, head, count, commitment));
        assertNotEq(digest, regA.anchorDigest(nodeId, 0, head, count, keccak256("other-dc")));
    }
}
