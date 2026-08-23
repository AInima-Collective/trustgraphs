// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";

/// @notice PASS A PoC.
///
/// Regression coverage: the generic registry now follows the sibling ingress by binding the
/// registry, chain, node, envelope kind, head, count and data commitment in an EIP-712 signature.
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

    function test_PassA_RelayerCannotMutateDataCommitmentOrBurnTheCount() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        vm.prank(owner);
        registryA.register();

        bytes32 head = keccak256("owner-signed head #5");
        bytes32 intendedCommitment = keccak256("the real data commitment");
        bytes memory sig = _sign(registryA, nodeId, 0, head, 5, intendedCommitment);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        vm.prank(relayer);
        registryA.anchor(nodeId, 99, head, 5, keccak256("relayer-chosen garbage"), sig);
        assertEq(registryA.lastCount(nodeId), 0, "invalid mutation did not consume the count");

        vm.prank(relayer);
        registryA.anchor(nodeId, 0, head, 5, intendedCommitment, sig);
        assertEq(registryA.lastCount(nodeId), 5);
    }

    function test_PassA_HeadSignatureCannotReplayIntoAnUnrelatedInstanceRegistry() public {
        bytes32 nodeId = keccak256(abi.encode(owner));
        vm.prank(owner);
        registryA.register();
        vm.prank(owner);
        registryB.register();

        bytes32 head = keccak256("owner-signed head #7");
        bytes32 commitment = keccak256("dc-a");
        bytes memory sig = _sign(registryA, nodeId, 0, head, 7, commitment);

        vm.prank(relayer);
        registryA.anchor(nodeId, 0, head, 7, commitment, sig);

        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.BadHeadSignature.selector, nodeId));
        vm.prank(relayer);
        registryB.anchor(nodeId, 0, head, 7, commitment, sig);
        assertEq(registryB.anchorCount(), 0, "cross-instance replay rejected");
    }
}
