// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {TrustComposeParamsControllerV2} from "src/factory/TrustComposeParamsControllerV2.sol";
import {CompositionSourceAccumulatorV2} from "src/composition/CompositionSourceAccumulatorV2.sol";
import {TrustComposeParamsCodecV2} from "src/params/TrustComposeParamsCodecV2.sol";
import {TrustComposeValidatorV2} from "src/params/TrustComposeValidatorV2.sol";
import {ITrustComposeParamsControllerV2} from "interfaces/factory/ITrustComposeParamsControllerV2.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {CompositionPolicyV2TestLib} from "test/helpers/CompositionPolicyV2TestLib.sol";

contract TrustComposeParamsControllerV2Test is Test {
    bytes32 internal constant INSTANCE_ID = keccak256("composition v2 instance");
    uint64 internal constant MAX_AGE = 100;
    uint48 internal constant DELAY = 2 days;
    address internal constant OWNER = address(0xA11CE);
    address internal constant PUBLISHER = address(0xB0B);
    address internal constant SNAPSHOT = address(0x500);
    address internal constant ACCUMULATOR = address(0xACC0);
    address internal constant REGISTRY = address(0x600);
    address internal constant FIRST_SNAPSHOT = address(0x101);
    address internal constant SECOND_SNAPSHOT = address(0x202);

    TrustComposeParamsControllerV2 internal controller;
    TrustComposeParamsCodecV2.Params internal initialParams;
    bytes internal initialManifest;
    address[] internal adapters;
    bytes32 internal initialHash;

    function setUp() public {
        initialManifest = CompositionPolicyV2TestLib.manifest(FIRST_SNAPSHOT, SECOND_SNAPSHOT, MAX_AGE, false);
        initialParams =
            CompositionPolicyV2TestLib.finalParams(ACCUMULATOR, FIRST_SNAPSHOT, SECOND_SNAPSHOT, MAX_AGE, false);
        initialHash = TrustComposeParamsCodecV2.hash(initialParams);
        adapters.push(address(0xA1));
        adapters.push(address(0xA2));
        _mockPolicyValidation();
        vm.mockCall(SNAPSHOT, abi.encodeWithSignature("paramsHash()"), abi.encode(initialHash));
        controller = _deploy(DELAY);
        _mockLiveState();
    }

    function _deploy(uint48 delay) internal returns (TrustComposeParamsControllerV2) {
        return new TrustComposeParamsControllerV2(
            INSTANCE_ID,
            SNAPSHOT,
            CompositionSourceAccumulatorV2(ACCUMULATOR),
            IInstanceRegistry(REGISTRY),
            initialParams,
            initialManifest,
            adapters,
            keccak256("initial review"),
            OWNER,
            PUBLISHER,
            delay
        );
    }

    function _mockPolicyValidation() internal {
        TrustComposeValidatorV2.Commitment memory commitment = TrustComposeValidatorV2.Commitment({
            sourcePolicyRoot: initialParams.sourcePolicyRoot,
            sourceCount: initialParams.sourceCount,
            manifestSha256: initialParams.policyManifestSha256,
            chainId: initialParams.chainId
        });
        vm.mockCall(
            ACCUMULATOR,
            abi.encodeWithSelector(CompositionSourceAccumulatorV2.validatePolicy.selector),
            abi.encode(commitment)
        );
        vm.mockCall(
            ACCUMULATOR, abi.encodeWithSelector(CompositionSourceAccumulatorV2.installPolicy.selector), bytes("")
        );
    }

    function _mockLiveState() internal {
        vm.mockCall(ACCUMULATOR, abi.encodeWithSignature("controller()"), abi.encode(address(controller)));
        IInstanceRegistry.Instance memory record = IInstanceRegistry.Instance({
            program: keccak256("trust-compose"),
            snapshot: SNAPSHOT,
            verifier: address(0x700),
            registryOrAccumulator: ACCUMULATOR,
            paramsHash: initialHash
        });
        vm.mockCall(
            REGISTRY, abi.encodeWithSelector(IInstanceRegistry.getInstance.selector, INSTANCE_ID), abi.encode(record)
        );
        vm.mockCall(
            REGISTRY,
            abi.encodeWithSelector(IInstanceRegistry.paramsAuthority.selector, INSTANCE_ID),
            abi.encode(address(controller))
        );
        vm.mockCall(REGISTRY, abi.encodeWithSelector(IInstanceRegistry.updateParamsHash.selector), bytes(""));
        vm.mockCall(SNAPSHOT, abi.encodeWithSignature("setParamsHash(bytes32)"), bytes(""));
    }

    function _publish() internal {
        vm.prank(PUBLISHER);
        controller.publishInitialPolicy(initialManifest, adapters);
    }

    function test_ConstructorSnapshotsInitialVersionAndCommitment() public view {
        assertEq(controller.instanceId(), INSTANCE_ID);
        assertEq(controller.snapshot(), SNAPSHOT);
        assertEq(address(controller.accumulator()), ACCUMULATOR);
        assertEq(address(controller.registry()), REGISTRY);
        assertEq(controller.owner(), OWNER);
        assertEq(controller.initialPublisher(), PUBLISHER);
        assertEq(controller.activationDelay(), DELAY);
        assertEq(controller.version(), 1);
        assertEq(controller.latestVersion(), 1);
        assertEq(controller.currentParamsHash(), initialHash);
        assertFalse(controller.versionOnePublished());
        ITrustComposeParamsControllerV2.VersionCommitment memory commitment = controller.versionCommitment(1);
        assertEq(commitment.paramsHash, initialHash);
        assertEq(uint8(commitment.status), uint8(ITrustComposeParamsControllerV2.ProposalStatus.Activated));
    }

    function test_ConstructorRejectsZeroDelayLiveHashMismatchAndForeignClass() public {
        vm.expectRevert(TrustComposeParamsControllerV2.ZeroActivationDelay.selector);
        _deploy(0);

        bytes32 wrong = keccak256("wrong live hash");
        vm.mockCall(SNAPSHOT, abi.encodeWithSignature("paramsHash()"), abi.encode(wrong));
        vm.expectRevert(
            abi.encodeWithSelector(TrustComposeParamsControllerV2.InitialHashMismatch.selector, initialHash, wrong)
        );
        _deploy(DELAY);

        vm.mockCall(SNAPSHOT, abi.encodeWithSignature("paramsHash()"), abi.encode(initialHash));
        TrustComposeParamsCodecV2.Params memory saved = initialParams;
        initialParams.sourceCompatibilityClass = keccak256("foreign class");
        vm.expectPartialRevert(TrustComposeValidatorV2.InvalidCompatibilityClass.selector);
        _deploy(DELAY);
        initialParams = saved;
    }

    function test_InitialPublicationIsPublisherOnlyAndOneShot() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(TrustComposeParamsControllerV2.NotInitialPublisher.selector, address(0xBAD))
        );
        controller.publishInitialPolicy(initialManifest, adapters);

        _publish();
        assertTrue(controller.versionOnePublished());
        vm.prank(PUBLISHER);
        vm.expectRevert(TrustComposeParamsControllerV2.InitialVersionAlreadyPublished.selector);
        controller.publishInitialPolicy(initialManifest, adapters);
    }

    function test_ProposalRequiresPublicationOwnerAndARealChange() public {
        vm.expectRevert(TrustComposeParamsControllerV2.InitialVersionNotPublished.selector);
        vm.prank(OWNER);
        controller.proposePolicy(initialManifest, adapters, bytes32(0));

        _publish();
        vm.expectRevert();
        vm.prank(address(0xBAD));
        controller.proposePolicy(initialManifest, adapters, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                TrustComposeParamsControllerV2.NoopPolicy.selector,
                sha256(initialManifest),
                keccak256(abi.encode(adapters))
            )
        );
        vm.prank(OWNER);
        controller.proposePolicy(initialManifest, adapters, bytes32(0));
    }

    function test_CancelledVersionIsNotReusedAndPermissionlessActivationIsAtomic() public {
        _publish();
        bytes memory rotated = CompositionPolicyV2TestLib.manifest(FIRST_SNAPSHOT, SECOND_SNAPSHOT, MAX_AGE, true);

        vm.prank(OWNER);
        (uint64 cancelledVersion,,) = controller.proposePolicy(rotated, adapters, keccak256("cancelled"));
        vm.expectPartialRevert(TrustComposeParamsControllerV2.ActivationDelayNotElapsed.selector);
        controller.activatePolicy(cancelledVersion, rotated, adapters);
        vm.prank(OWNER);
        controller.cancelPolicy();
        assertEq(
            uint8(controller.versionCommitment(cancelledVersion).status),
            uint8(ITrustComposeParamsControllerV2.ProposalStatus.Cancelled)
        );

        vm.prank(OWNER);
        (uint64 activeVersion,, uint48 readyAt) = controller.proposePolicy(rotated, adapters, keccak256("activate"));
        assertEq(activeVersion, cancelledVersion + 1);
        vm.warp(readyAt);
        bytes32 newHash = controller.activatePolicy(activeVersion, rotated, adapters);

        assertEq(controller.version(), activeVersion);
        assertEq(controller.latestVersion(), activeVersion);
        assertEq(controller.currentParamsHash(), newHash);
        assertNotEq(newHash, initialHash);
        assertEq(controller.getPendingPolicy().version, 0);
        assertEq(
            uint8(controller.versionCommitment(activeVersion).status),
            uint8(ITrustComposeParamsControllerV2.ProposalStatus.Activated)
        );
    }
}
