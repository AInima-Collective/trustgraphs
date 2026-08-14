// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {WeightedPriorParamsController} from "contracts/factory/WeightedPriorParamsController.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {WeightedPriorParamsCodec} from "contracts/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "contracts/params/WeightedPriorValidator.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {IWeightedPriorParamsController} from "interfaces/factory/IWeightedPriorParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";

contract WeightedPriorParamsControllerTest is Test {
    bytes32 internal constant INSTANCE_ID = keccak256("weighted-instance");
    bytes32 internal constant PROGRAM = keccak256("trust-graph-weighted");
    address internal constant OWNER = address(0xA11CE);
    uint48 internal constant DELAY = 3 days;
    uint256 internal constant SCALE = 1e18;

    InstanceRegistry internal registry;
    MockAccumulator internal accumulator;
    MerkleSnapshot internal snapshot;
    WeightedPriorParamsController internal controller;
    WeightedPriorParamsCodec.Params internal initial;
    bytes internal initialManifest;

    function setUp() public {
        initialManifest = _manifest(3, uint64(block.chainid), 1);
        WeightedPriorValidator.Commitment memory prior = _validate(initialManifest, uint64(block.chainid));
        initial = _params(prior);

        registry = new InstanceRegistry(address(this));
        accumulator = new MockAccumulator();
        snapshot = new MerkleSnapshot(
            new MockZkVerifier(), WeightedPriorParamsCodec.hash(initial), accumulator, address(this), address(this)
        );
        controller = new WeightedPriorParamsController(
            INSTANCE_ID,
            address(snapshot),
            registry,
            initial,
            initialManifest,
            keccak256("initial provenance"),
            OWNER,
            address(this),
            DELAY
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), address(this));
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(0xBEEF),
                registryOrAccumulator: address(accumulator),
                paramsHash: WeightedPriorParamsCodec.hash(initial)
            }),
            address(controller)
        );
    }

    function test_PublishesRecoverableVersionOne() public {
        vm.recordLogs();
        controller.publishInitialVersion();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], IWeightedPriorParamsController.InitialPriorPublished.selector);
        assertEq(logs[0].topics[1], INSTANCE_ID);
        assertEq(logs[0].topics[2], bytes32(uint256(1)));
        assertEq(logs[0].topics[3], WeightedPriorParamsCodec.hash(initial));

        IWeightedPriorParamsController.VersionCommitment memory v1 = controller.versionCommitment(1);
        assertEq(v1.paramsHash, WeightedPriorParamsCodec.hash(initial));
        assertEq(v1.priorRoot, initial.priorRoot);
        assertEq(v1.priorCount, initial.priorCount);
        assertEq(v1.manifestSha256, sha256(initialManifest));
        assertEq(v1.metadataDigest, keccak256("initial provenance"));
        assertEq(v1.proposedAt, v1.activatedAt);
        assertEq(WeightedPriorParamsCodec.hash(controller.getCurrentParams()), snapshot.paramsHash());
    }

    function test_ProposalValidatesManifestButDoesNotChangeLiveState() public {
        controller.publishInitialVersion();
        bytes32 live = controller.currentParamsHash();
        bytes memory nextManifest = _manifest(5, uint64(block.chainid), 7);
        bytes32 metadataDigest = keccak256("rotation provenance");

        vm.prank(OWNER);
        (uint64 nextVersion, bytes32 proposalId, uint48 readyAt) = controller.proposePrior(nextManifest, metadataDigest);

        IWeightedPriorParamsController.PendingPrior memory pending = controller.getPendingPrior();
        WeightedPriorValidator.Commitment memory expected = _validate(nextManifest, uint64(block.chainid));
        assertEq(nextVersion, 2);
        assertEq(pending.version, 2);
        assertEq(pending.proposalId, proposalId);
        assertEq(pending.priorRoot, expected.priorRoot);
        assertEq(pending.priorCount, expected.priorCount);
        assertEq(pending.manifestSha256, sha256(nextManifest));
        assertEq(pending.metadataDigest, metadataDigest);
        assertEq(readyAt, block.timestamp + DELAY);

        assertEq(controller.version(), 1, "pending is not active");
        assertEq(controller.currentParamsHash(), live);
        assertEq(snapshot.paramsHash(), live);
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, live);
    }

    function test_TimelockedActivationIsPermissionlessAtomicAndNotReplayable() public {
        controller.publishInitialVersion();
        bytes memory nextManifest = _manifest(4, uint64(block.chainid), 11);

        vm.prank(OWNER);
        controller.proposePrior(nextManifest, keccak256("next"));

        vm.expectPartialRevert(WeightedPriorParamsController.ActivationDelayNotElapsed.selector);
        controller.activatePrior(2);
        vm.warp(block.timestamp + DELAY);

        vm.prank(address(0xB0B));
        bytes32 activated = controller.activatePrior(2);
        assertEq(controller.version(), 2);
        assertEq(controller.currentParamsHash(), activated);
        assertEq(snapshot.paramsHash(), activated);
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, activated);
        assertEq(WeightedPriorParamsCodec.hash(controller.getCurrentParams()), activated);
        assertEq(controller.versionCommitment(2).activatedAt, block.timestamp);
        assertEq(controller.getPendingPrior().version, 0);

        vm.expectRevert(WeightedPriorParamsController.NoPendingPrior.selector);
        controller.activatePrior(2);
    }

    function test_CheckpointTriggeredWhilePendingKeepsOldParams() public {
        controller.publishInitialVersion();
        bytes32 oldHash = controller.currentParamsHash();
        bytes memory nextManifest = _manifest(2, uint64(block.chainid), 13);

        vm.prank(OWNER);
        controller.proposePrior(nextManifest, bytes32(0));
        accumulator.setState(keccak256("first input"), 1);
        uint256 oldCheckpoint = snapshot.trigger();
        assertEq(snapshot.checkpointParamsHash(oldCheckpoint), oldHash);

        vm.warp(block.timestamp + DELAY);
        bytes32 newHash = controller.activatePrior(2);
        assertEq(snapshot.checkpointParamsHash(oldCheckpoint), oldHash, "frozen checkpoint changed");

        accumulator.setState(keccak256("second input"), 2);
        uint256 newCheckpoint = snapshot.trigger();
        assertEq(snapshot.checkpointParamsHash(newCheckpoint), newHash);
    }

    function test_RejectsWrongChainMalformedNoopUnauthorizedOverwriteAndWrongVersion() public {
        controller.publishInitialVersion();

        vm.prank(OWNER);
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestChain.selector);
        controller.proposePrior(_manifest(2, uint64(block.chainid + 1), 1), bytes32(0));

        bytes memory malformed = _manifest(2, uint64(block.chainid), 1);
        for (uint256 i; i < 20; ++i) {
            malformed[18 + 28 + i] = malformed[18 + i];
        }
        vm.prank(OWNER);
        vm.expectRevert();
        controller.proposePrior(malformed, bytes32(0));

        vm.prank(OWNER);
        vm.expectPartialRevert(WeightedPriorParamsController.NoopPrior.selector);
        controller.proposePrior(initialManifest, bytes32(0));

        vm.expectRevert();
        controller.proposePrior(_manifest(2, uint64(block.chainid), 5), bytes32(0));

        vm.prank(OWNER);
        controller.proposePrior(_manifest(2, uint64(block.chainid), 5), bytes32(0));
        vm.prank(OWNER);
        vm.expectPartialRevert(WeightedPriorParamsController.PendingPriorExists.selector);
        controller.proposePrior(_manifest(3, uint64(block.chainid), 8), bytes32(0));

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(WeightedPriorParamsController.PendingVersionMismatch.selector, uint64(3), uint64(2))
        );
        controller.activatePrior(3);
    }

    function test_CancelRequiresOwnerAndAllowsFreshValidatedProposal() public {
        controller.publishInitialVersion();
        vm.prank(OWNER);
        (, bytes32 cancelledId,) =
            controller.proposePrior(_manifest(2, uint64(block.chainid), 3), keccak256("cancel me"));

        vm.expectRevert();
        controller.cancelPrior();
        vm.prank(OWNER);
        controller.cancelPrior();
        assertEq(controller.getPendingPrior().version, 0);
        assertEq(controller.versionCommitment(2).paramsHash, bytes32(0));

        vm.recordLogs();
        vm.prank(OWNER);
        (, bytes32 replacementId,) =
            controller.proposePrior(_manifest(4, uint64(block.chainid), 9), keccak256("replacement"));
        assertNotEq(cancelledId, replacementId);
        assertEq(controller.getPendingPrior().version, 2);
    }

    function test_ConstructorRejectsManifestAbsentOrCommitmentMismatch() public {
        bytes memory absent;
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestLength.selector);
        new WeightedPriorParamsController(
            INSTANCE_ID, address(snapshot), registry, initial, absent, bytes32(0), OWNER, address(this), DELAY
        );

        WeightedPriorParamsCodec.Params memory wrong = initial;
        wrong.priorRoot = keccak256("fabricated");
        vm.expectRevert(WeightedPriorValidator.PriorCommitmentMismatch.selector);
        new WeightedPriorParamsController(
            INSTANCE_ID, address(snapshot), registry, wrong, initialManifest, bytes32(0), OWNER, address(this), DELAY
        );
    }

    function test_Max2048ProposalGasEnvelope() public {
        controller.publishInitialVersion();
        bytes memory manifest = _manifest(2048, uint64(block.chainid), 17);
        bytes memory call = abi.encodeCall(controller.proposePrior, (manifest, keccak256("max provenance")));

        vm.prank(OWNER);
        uint256 beforeGas = gasleft();
        controller.proposePrior(manifest, keccak256("max provenance"));
        uint256 executionGas = beforeGas - gasleft();
        uint256 calldataGas = _calldataGas(call);
        uint256 totalL1Gas = executionGas + calldataGas + 21_000;

        emit log_named_uint("weighted max proposal execution gas", executionGas);
        emit log_named_uint("weighted max proposal calldata gas", calldataGas);
        emit log_named_uint("weighted max proposal total L1 gas", totalL1Gas);
        assertLt(executionGas, 5_000_000, "max proposal execution gas");
        assertLt(totalL1Gas, 4_500_000, "max proposal total L1 gas");
    }

    function testFuzz_ProposalStateMatchesCanonicalManifest(uint8 rawCount, uint64 salt) public {
        uint256 count = bound(rawCount, 4, 64);
        controller.publishInitialVersion();
        bytes memory manifest = _manifest(count, uint64(block.chainid), salt ^ 100);
        WeightedPriorValidator.Commitment memory expected = _validate(manifest, uint64(block.chainid));

        vm.prank(OWNER);
        controller.proposePrior(manifest, bytes32(uint256(salt)));
        IWeightedPriorParamsController.PendingPrior memory pending = controller.getPendingPrior();
        assertEq(pending.priorRoot, expected.priorRoot);
        assertEq(pending.priorCount, expected.priorCount);
        assertEq(pending.manifestSha256, expected.manifestSha256);
    }

    function _params(WeightedPriorValidator.Commitment memory prior)
        internal
        view
        returns (WeightedPriorParamsCodec.Params memory p)
    {
        p.version = 1;
        p.dampingFp = 85e16;
        p.toleranceFp = 1e12;
        p.maxIterations = 40;
        p.minWeight = 0;
        p.maxWeight = 100;
        p.priorRoot = prior.priorRoot;
        p.priorCount = prior.priorCount;
        p.manifestSha256 = prior.manifestSha256;
        p.schemaUid = keccak256("weighted schema");
        p.weightFieldIndex = 1;
        p.accumulator = address(0xACCA);
        p.chainId = uint64(block.chainid);
    }

    function _validate(bytes memory manifest, uint64 chainId)
        internal
        pure
        returns (WeightedPriorValidator.Commitment memory)
    {
        return WeightedPriorValidator.validateManifestMemory(manifest, chainId);
    }

    function _manifest(uint256 count, uint64 chainId, uint64 salt) internal pure returns (bytes memory manifest) {
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
            uint256 offset = 18 + i * 28;
            address account = address(uint160(i + 1));
            uint256 weight = base + (i < remainder ? 1 : 0);
            if (i == 0 && count > 1 && salt % 2 == 1) {
                weight += 1;
            } else if (i == count - 1 && count > 1 && salt % 2 == 1) {
                weight -= 1;
            }
            assembly ("memory-safe") {
                mstore(add(add(manifest, 32), offset), shl(96, account))
                mstore(add(add(add(manifest, 32), offset), 20), shl(192, weight))
            }
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 gasUnits) {
        for (uint256 i; i < data.length; ++i) {
            gasUnits += data[i] == 0 ? 4 : 16;
        }
    }
}
