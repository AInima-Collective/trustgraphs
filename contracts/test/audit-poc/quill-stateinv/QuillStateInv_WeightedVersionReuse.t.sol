// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {WeightedPriorParamsController} from "src/factory/WeightedPriorParamsController.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "src/params/WeightedPriorValidator.sol";
import {IWeightedPriorParamsController} from "interfaces/factory/IWeightedPriorParamsController.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";

/// @notice state-invariant-detection PoC.
///
/// Invariant under test (Type 4, monotonic ordering / append-only history):
///   A parameter version number cannot later be reused for different commitment contents.
///
/// `TrustComposeParamsController` states and enforces this ("Cancelled proposal versions remain
/// queryable; gaps are never reused") using a separate `latestVersion` high-water mark.
/// `WeightedPriorParamsController` now follows that pattern: `proposePrior` derives the pending
/// version from a monotonic `latestVersion` rather than the activated `version`. Cancellation may
/// remove the pending commitment, but it cannot make that version number available again.
contract QuillStateInv_WeightedVersionReuse is Test {
    uint256 internal constant SCALE = 1e18;

    InstanceRegistry internal registry;
    MerkleSnapshot internal snapshot;
    MockAccumulator internal accumulator;
    MockZkVerifier internal verifier;
    WeightedPriorParamsController internal controller;

    address internal registryAdmin = address(0xBEEF);
    address internal owner = address(0xCAFE);
    bytes32 internal constant INSTANCE_ID = keccak256("quill.weighted");

    function setUp() public {
        registry = new InstanceRegistry(registryAdmin);
        verifier = new MockZkVerifier();
        accumulator = new MockAccumulator();

        bytes memory manifest = _manifest(4, uint64(block.chainid), 0x1000);
        WeightedPriorValidator.Commitment memory c =
            WeightedPriorValidator.validateManifestMemory(manifest, uint64(block.chainid));

        WeightedPriorParamsCodec.Params memory p = _params();
        p.priorRoot = c.priorRoot;
        p.priorCount = c.priorCount;
        p.manifestSha256 = c.manifestSha256;
        bytes32 paramsHash = WeightedPriorParamsCodec.hash(p);

        snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            paramsHash,
            IAttestationAccumulator(address(accumulator)),
            address(this),
            address(this),
            ""
        );

        controller = new WeightedPriorParamsController(
            INSTANCE_ID,
            address(snapshot),
            IInstanceRegistry(address(registry)),
            p,
            manifest,
            keccak256("meta1"),
            owner,
            address(this),
            1 days
        );

        vm.prank(registryAdmin);
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: keccak256("trust-graph-weighted"),
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accumulator),
                paramsHash: paramsHash
            }),
            address(controller)
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        controller.publishInitialVersion();
    }

    function test_CancelledVersionNumberCannotBeReusedWithDifferentContents() public {
        bytes memory manifestA = _manifest(3, uint64(block.chainid), 0x2000);
        bytes memory manifestB = _manifest(5, uint64(block.chainid), 0x3000);

        vm.prank(owner);
        (uint64 vA,,) = controller.proposePrior(manifestA, keccak256("metaA"));
        assertEq(vA, 2, "first proposal is version 2");
        assertEq(controller.latestVersion(), 2);
        IWeightedPriorParamsController.VersionCommitment memory commitA = controller.versionCommitment(2);
        assertTrue(commitA.priorRoot != bytes32(0));
        bytes32 rootA = commitA.priorRoot;
        uint48 proposedAtA = commitA.proposedAt;

        vm.prank(owner);
        controller.cancelPrior();

        // The whole commitment record is erased, not marked cancelled: the on-chain audit trail of
        // what version 2 once was is gone.
        IWeightedPriorParamsController.VersionCommitment memory erased = controller.versionCommitment(2);
        assertEq(erased.priorRoot, bytes32(0), "cancelled commitment was deleted, not retained");
        assertEq(erased.proposedAt, 0);
        assertTrue(proposedAtA != 0);

        vm.warp(block.timestamp + 1);
        vm.prank(owner);
        (uint64 vB,,) = controller.proposePrior(manifestB, keccak256("metaB"));

        assertEq(vB, 3, "cancelled version number must not be reused");
        assertEq(controller.latestVersion(), 3);
        assertEq(controller.versionCommitment(2).paramsHash, bytes32(0), "version 2 remains an unallocated gap");
        IWeightedPriorParamsController.VersionCommitment memory commitB = controller.versionCommitment(3);
        assertTrue(commitB.priorRoot != rootA, "replacement proposal has a different prior set");
        assertEq(commitB.priorCount, 5);

        // The replacement activates under its fresh version, while the cancelled version cannot
        // acquire different contents later.
        vm.warp(block.timestamp + 2 days);
        controller.activatePrior(3);
        assertEq(controller.version(), 3);
        assertEq(controller.getCurrentParams().priorCount, 5);
    }

    /*//////////////////////// helpers ////////////////////////*/

    function _params() internal view returns (WeightedPriorParamsCodec.Params memory p) {
        p.version = 1;
        p.dampingFp = 85e16;
        p.toleranceFp = 1e12;
        p.maxIterations = 20;
        p.minWeight = 1;
        p.maxWeight = 1e18;
        p.schemaUid = keccak256("schema");
        p.weightFieldIndex = 1;
        p.accumulator = address(accumulator);
        p.chainId = uint64(block.chainid);
    }

    function _manifest(uint256 count, uint64 chainId, uint128 offset) internal pure returns (bytes memory manifest) {
        manifest = new bytes(18 + count * 28);
        manifest[0] = 0x54;
        manifest[1] = 0x47;
        manifest[2] = 0x57;
        manifest[3] = 0x50;
        manifest[5] = 0x01;
        _writeBigEndian(manifest, 6, chainId, 8);
        _writeBigEndian(manifest, 14, count, 4);

        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint256 entryOffset = 18 + i * 28;
            address account = address(uint160(uint256(offset) + i + 1));
            uint256 weight = base + (i < remainder ? 1 : 0);
            assembly ("memory-safe") {
                mstore(add(add(manifest, 32), entryOffset), shl(96, account))
                mstore(add(add(add(manifest, 32), entryOffset), 20), shl(192, weight))
            }
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
