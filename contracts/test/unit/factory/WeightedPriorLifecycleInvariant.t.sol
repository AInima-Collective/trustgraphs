// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {WeightedPriorParamsController} from "src/factory/WeightedPriorParamsController.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "src/params/WeightedPriorValidator.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IWeightedPriorParamsController} from "interfaces/factory/IWeightedPriorParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";

contract WeightedPriorLifecycleHandler is Test {
    uint256 internal constant SCALE = 1e18;

    WeightedPriorParamsController public controller;
    uint64 public highestActivatedVersion = 1;

    function configure(WeightedPriorParamsController controller_) external {
        require(address(controller) == address(0));
        controller = controller_;
    }

    function acceptOwnership() external {
        controller.acceptOwnership();
    }

    function propose(uint8 rawCount, uint128 rawOffset, bytes32 metadataDigest) external {
        if (controller.getPendingPrior().version != 0) return;
        uint256 count = bound(rawCount, 1, 32);
        uint128 offset = rawOffset | 0x1_0000;
        bytes memory manifest = _manifest(count, uint64(block.chainid), offset);
        try controller.proposePrior(manifest, metadataDigest) {} catch {}
    }

    function cancel() external {
        if (controller.getPendingPrior().version == 0) return;
        controller.cancelPrior();
    }

    function advanceAndActivate(uint32 rawSeconds) external {
        IWeightedPriorParamsController.PendingPrior memory pending = controller.getPendingPrior();
        if (pending.version == 0) return;
        vm.warp(block.timestamp + bound(rawSeconds, 0, 4 days));
        try controller.activatePrior(pending.version) {
            highestActivatedVersion = pending.version;
        } catch {}
    }

    function _manifest(uint256 count, uint64 chainId, uint128 offset) private pure returns (bytes memory manifest) {
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

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) private pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}

contract WeightedPriorLifecycleInvariantTest is Test {
    bytes32 internal constant INSTANCE_ID = keccak256("weighted-invariant");
    uint48 internal constant DELAY = 1 days;

    InstanceRegistry internal registry;
    MerkleSnapshot internal snapshot;
    WeightedPriorParamsController internal controller;
    WeightedPriorLifecycleHandler internal handler;

    function setUp() public {
        bytes memory manifest = _manifest();
        WeightedPriorValidator.Commitment memory prior =
            WeightedPriorValidator.validateManifestMemory(manifest, uint64(block.chainid));
        WeightedPriorParamsCodec.Params memory params;
        params.version = 1;
        params.dampingFp = 85e16;
        params.toleranceFp = 1e12;
        params.maxIterations = 40;
        params.maxWeight = 100;
        params.priorRoot = prior.priorRoot;
        params.priorCount = prior.priorCount;
        params.manifestSha256 = prior.manifestSha256;
        params.schemaUid = keccak256("invariant schema");
        params.weightFieldIndex = 1;
        params.accumulator = address(0xACCA);
        params.chainId = uint64(block.chainid);

        registry = new InstanceRegistry(address(this));
        snapshot = new MerkleSnapshot(
            new MockZkVerifier(),
            WeightedPriorParamsCodec.hash(params),
            new MockAccumulator(),
            address(this),
            address(this)
        );
        controller = new WeightedPriorParamsController(
            INSTANCE_ID, address(snapshot), registry, params, manifest, bytes32(0), address(this), address(this), DELAY
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), address(this));
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: keccak256("trust-graph-weighted"),
                snapshot: address(snapshot),
                verifier: address(0xBEEF),
                registryOrAccumulator: params.accumulator,
                paramsHash: WeightedPriorParamsCodec.hash(params)
            }),
            address(controller)
        );
        controller.publishInitialVersion();

        handler = new WeightedPriorLifecycleHandler();
        handler.configure(controller);
        controller.transferOwnership(address(handler));
        handler.acceptOwnership();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.propose.selector;
        selectors[1] = handler.cancel.selector;
        selectors[2] = handler.advanceAndActivate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_LiveCommitmentsMoveAtomicallyAndVersionsNeverRegress() public view {
        bytes32 currentHash = controller.currentParamsHash();
        assertEq(snapshot.paramsHash(), currentHash);
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, currentHash);
        assertEq(WeightedPriorParamsCodec.hash(controller.getCurrentParams()), currentHash);
        assertEq(controller.version(), handler.highestActivatedVersion());

        IWeightedPriorParamsController.VersionCommitment memory active =
            controller.versionCommitment(controller.version());
        assertEq(active.paramsHash, currentHash);
        assertGt(active.activatedAt, 0);

        IWeightedPriorParamsController.PendingPrior memory pending = controller.getPendingPrior();
        if (pending.version != 0) {
            assertEq(pending.version, controller.version() + 1);
            assertEq(controller.versionCommitment(pending.version).paramsHash, pending.paramsHash);
            assertEq(controller.versionCommitment(pending.version).activatedAt, 0);
        }
    }

    function _manifest() private view returns (bytes memory manifest) {
        manifest = new bytes(46);
        manifest[0] = 0x54;
        manifest[1] = 0x47;
        manifest[2] = 0x57;
        manifest[3] = 0x50;
        manifest[5] = 0x01;
        _writeBigEndian(manifest, 6, block.chainid, 8);
        _writeBigEndian(manifest, 14, 1, 4);
        address account = address(1);
        uint256 weight = 1e18;
        assembly ("memory-safe") {
            mstore(add(add(manifest, 32), 18), shl(96, account))
            mstore(add(add(add(manifest, 32), 18), 20), shl(192, weight))
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) private pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
