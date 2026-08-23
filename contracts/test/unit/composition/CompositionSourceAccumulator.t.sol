// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {
    ICompositionSourceAdapter,
    ICompositionSourceAdapterFactory
} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {CompositionPolicyTestLib} from "test/helpers/CompositionPolicyTestLib.sol";

contract DirectCompositionAdapterFactory is ICompositionSourceAdapterFactory {
    IInstanceRegistry public registry = IInstanceRegistry(address(0xBEEF));
    mapping(address adapter => bool authentic) public isAdapter;

    function setAdapter(address adapter, bool authentic) external {
        isAdapter[adapter] = authentic;
    }
}

contract DirectCompositionAdapter is ICompositionSourceAdapter {
    uint64 public immutable chainId = uint64(block.chainid);
    bytes32 public immutable sourceId;
    address public immutable snapshot;
    bytes32 public immutable familyId = CompositionPolicyTestLib.family();
    bytes32 public immutable programId = CompositionPolicyTestLib.sourceProgram();
    bytes32 public immutable outputKind = CompositionPolicyTestLib.outputKind();
    bytes32 public immutable deploymentProvenance = keccak256("reviewed deployment");
    CapturedState private _state;

    constructor(bytes32 sourceId_, address snapshot_) {
        sourceId = sourceId_;
        snapshot = snapshot_;
        setState(uint64(block.number), uint64(block.number), uint256(sourceId_));
    }

    function setState(uint64 freezeBlock, uint64 acceptedAtBlock, uint256 checkpointId) public {
        _state = CapturedState({
            stateIndex: uint64(checkpointId),
            freezeBlock: freezeBlock,
            outputRoot: keccak256(abi.encode("root", sourceId, checkpointId)),
            blobSha256: sha256(abi.encode("blob", sourceId, checkpointId)),
            cidDigest: keccak256(abi.encode("cid", sourceId, checkpointId)),
            totalValue: uint128(100 + checkpointId),
            checkpointId: checkpointId,
            acceptedAtBlock: acceptedAtBlock,
            paramsHash: keccak256("params"),
            verifier: address(0xCAFE),
            verifierCodehash: keccak256("verifier code"),
            programVKey: keccak256("vkey")
        });
    }

    function readLatest() external view returns (CapturedState memory) {
        return _state;
    }

    function readAt(uint256) external view returns (CapturedState memory) {
        return _state;
    }

    function readCheckpoint(uint256) external view returns (CapturedState memory) {
        return _state;
    }
}

contract DirectCompositionSnapshotView {
    address public immutable accumulator;

    constructor(address accumulator_) {
        accumulator = accumulator_;
    }
}

contract CompositionSourceAccumulatorTest is Test {
    uint64 internal constant MAX_AGE = 100;

    DirectCompositionAdapterFactory internal adapterFactory;
    CompositionSourceAccumulator internal accumulator;
    DirectCompositionSnapshotView internal snapshot;
    DirectCompositionAdapter internal first;
    DirectCompositionAdapter internal second;
    address[] internal adapters;
    bytes internal policyManifest;

    function setUp() public {
        adapterFactory = new DirectCompositionAdapterFactory();
        accumulator = new CompositionSourceAccumulator(adapterFactory, address(this));
        snapshot = new DirectCompositionSnapshotView(address(accumulator));
        accumulator.bind(address(snapshot), address(this));

        first = new DirectCompositionAdapter(bytes32(uint256(1)), address(0x101));
        second = new DirectCompositionAdapter(bytes32(uint256(2)), address(0x202));
        adapterFactory.setAdapter(address(first), true);
        adapterFactory.setAdapter(address(second), true);
        adapters.push(address(first));
        adapters.push(address(second));
        policyManifest = CompositionPolicyTestLib.manifest(address(0x101), address(0x202), MAX_AGE, false);
        accumulator.installPolicy(1, policyManifest, adapters);
    }

    function test_ConstructorAndBindingRejectInvalidAuthorityAndWiring() public {
        vm.expectRevert(CompositionSourceAccumulator.ZeroAddress.selector);
        new CompositionSourceAccumulator(ICompositionSourceAdapterFactory(address(0)), address(this));

        CompositionSourceAccumulator fresh = new CompositionSourceAccumulator(adapterFactory, address(this));
        DirectCompositionSnapshotView correct = new DirectCompositionSnapshotView(address(fresh));
        vm.prank(address(0xBAD));
        vm.expectRevert(CompositionSourceAccumulator.NotBinder.selector);
        fresh.bind(address(correct), address(this));

        DirectCompositionSnapshotView wrong = new DirectCompositionSnapshotView(address(accumulator));
        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAccumulator.SnapshotReadsAnotherAccumulator.selector, address(accumulator)
            )
        );
        fresh.bind(address(wrong), address(this));

        fresh.bind(address(correct), address(this));
        vm.expectRevert(CompositionSourceAccumulator.AlreadyBound.selector);
        fresh.bind(address(correct), address(this));
    }

    function test_PolicyInstallIsControllerOnlyMonotonicAndQueryable() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(CompositionSourceAccumulator.NotController.selector);
        accumulator.installPolicy(2, policyManifest, adapters);

        vm.expectRevert(
            abi.encodeWithSelector(CompositionSourceAccumulator.InvalidPolicyVersion.selector, uint64(1), uint64(1))
        );
        accumulator.installPolicy(1, policyManifest, adapters);

        assertEq(accumulator.policyCount(), 2);
        assertEq(accumulator.leafCount(), 2);
        (address adapter, uint64 weight, uint64 maxAge) = accumulator.policyAt(0);
        assertEq(adapter, address(first));
        assertEq(weight, 5e17);
        assertEq(maxAge, MAX_AGE);
        assertEq(accumulator.adapterSetHash(), keccak256(abi.encode(adapters)));
    }

    function test_ValidatePolicyRejectsCountUnauthenticatedAndDuplicateAdapters() public {
        address[] memory one = new address[](1);
        one[0] = address(first);
        vm.expectRevert(
            abi.encodeWithSelector(CompositionSourceAccumulator.AdapterCountMismatch.selector, uint256(2), uint256(1))
        );
        accumulator.validatePolicy(policyManifest, one);

        adapterFactory.setAdapter(address(second), false);
        vm.expectRevert(
            abi.encodeWithSelector(
                CompositionSourceAccumulator.UnauthenticatedAdapter.selector, uint8(1), address(second)
            )
        );
        accumulator.validatePolicy(policyManifest, adapters);
        adapterFactory.setAdapter(address(second), true);

        address[] memory duplicate = new address[](2);
        duplicate[0] = address(first);
        duplicate[1] = address(first);
        vm.expectRevert(
            abi.encodeWithSelector(CompositionSourceAccumulator.DuplicateAdapter.selector, uint8(1), address(first))
        );
        accumulator.validatePolicy(policyManifest, duplicate);
    }

    function test_CheckpointIsSnapshotOnlyAndFreezesCaptureMetadata() public {
        vm.expectRevert(CompositionSourceAccumulator.NotSnapshot.selector);
        accumulator.checkpoint();

        vm.roll(20);
        first.setState(19, 20, 7);
        second.setState(18, 19, 8);
        vm.prank(address(snapshot));
        uint256 id = accumulator.checkpoint();

        assertEq(id, 0);
        IAttestationAccumulator.Checkpoint memory checkpoint = accumulator.getCheckpoint(id);
        bytes memory captured = accumulator.getCaptureManifest(id);
        assertEq(checkpoint.acc, sha256(captured));
        assertEq(checkpoint.leafCount, 2);
        assertEq(checkpoint.blockNumber, 20);
        assertEq(accumulator.checkpointPolicyVersion(id), 1);
        assertEq(accumulator.checkpointAdapterSetHash(id), accumulator.adapterSetHash());
        uint256[] memory sourceIds = accumulator.getCaptureSourceCheckpointIds(id);
        assertEq(sourceIds.length, 2);
        assertEq(sourceIds[0], 7);
        assertEq(sourceIds[1], 8);
    }

    function test_CaptureRejectsFutureAndStaleSourceStates() public {
        first.setState(uint64(block.number + 1), uint64(block.number), 1);
        vm.expectPartialRevert(CompositionSourceAccumulator.SourceStateFromFuture.selector);
        accumulator.currentCaptureManifest();

        vm.roll(200);
        first.setState(1, 1, 1);
        second.setState(200, 200, 2);
        vm.expectPartialRevert(CompositionSourceAccumulator.StaleSource.selector);
        accumulator.currentCaptureManifest();
    }
}
