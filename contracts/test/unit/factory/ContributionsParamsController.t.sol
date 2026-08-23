// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IContributionsParamsController} from "interfaces/factory/IContributionsParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";

contract ContributionsParamsControllerTest is Test {
    bytes32 constant INSTANCE_ID = keccak256("contributions-instance");
    bytes32 constant PROGRAM = keccak256("contributions");
    address constant OWNER = address(0xA11CE);
    address constant EAS = address(0xEA5);
    address constant RESOLVER = address(0xC012);

    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    ContributionsParamsController controller;
    ContributionsParamsCodec.Params initial;

    function setUp() public {
        initial = _params();
        registry = new InstanceRegistry(address(this));
        snapshot = new MerkleSnapshot(
            new MockZkVerifier(),
            ContributionsParamsCodec.hash(initial),
            new MockAccumulator(),
            address(this),
            address(this)
        );
        controller = new ContributionsParamsController(
            INSTANCE_ID, address(snapshot), EAS, registry, initial, OWNER, address(this)
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), address(this));
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(0xBEEF),
                registryOrAccumulator: RESOLVER,
                paramsHash: ContributionsParamsCodec.hash(initial)
            }),
            address(controller)
        );
    }

    function test_PublishesCompleteDiscoverableVersionOne() public {
        vm.recordLogs();
        controller.publishInitialVersion();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], IContributionsParamsController.ContributionsParamsUpdated.selector);
        assertEq(logs[0].topics[1], INSTANCE_ID);
        assertEq(logs[0].topics[2], bytes32(uint256(1)));
        assertEq(logs[0].topics[3], ContributionsParamsCodec.hash(initial));

        ContributionsParamsCodec.Params memory reconstructed = controller.getContributionsParams();
        assertEq(ContributionsParamsCodec.hash(reconstructed), snapshot.paramsHash());
        assertEq(controller.eas(), EAS);
        assertEq(controller.snapshot(), address(snapshot));
        assertEq(registry.paramsAuthority(INSTANCE_ID), address(controller));
    }

    function test_OwnerAtomicallyRotatesAllThreeCommitments() public {
        controller.publishInitialVersion();
        ContributionsParamsCodec.Params memory next = controller.getContributionsParams();
        next.roundEnd -= 1;
        bytes32 nextHash = ContributionsParamsCodec.hash(next);

        vm.prank(OWNER);
        (uint64 version, bytes32 publishedHash) = controller.updateParams(next, "ipfs://round-2");

        assertEq(version, 2);
        assertEq(publishedHash, nextHash);
        assertEq(controller.currentParamsHash(), nextHash);
        assertEq(snapshot.paramsHash(), nextHash);
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, nextHash);
        assertEq(ContributionsParamsCodec.hash(controller.getContributionsParams()), nextHash);
    }

    function test_RejectsMismatchBeforeAnyRotation() public {
        controller.publishInitialVersion();
        ContributionsParamsCodec.Params memory next = controller.getContributionsParams();

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ContributionsParamsController.NoopUpdate.selector, ContributionsParamsCodec.hash(next)
            )
        );
        controller.updateParams(next, "");

        vm.prank(OWNER);
        vm.expectRevert();
        snapshot.setParamsHash(keccak256("raw bypass"));
    }

    function test_RejectsSchemaIdentityRotation() public {
        controller.publishInitialVersion();
        ContributionsParamsCodec.Params memory next = controller.getContributionsParams();
        next.claimSchemaUid = keccak256("different resolver schema");

        vm.prank(OWNER);
        vm.expectRevert(ContributionsParamsController.IdentityFieldChanged.selector);
        controller.updateParams(next, "");
    }

    function test_InitialTupleMustMatchSnapshot() public {
        ContributionsParamsCodec.Params memory wrong = initial;
        wrong.totalPool += 1;
        bytes32 encoded = ContributionsParamsCodec.hash(wrong);

        vm.expectRevert(
            abi.encodeWithSelector(
                ContributionsParamsController.InitialHashMismatch.selector,
                encoded,
                ContributionsParamsCodec.hash(initial)
            )
        );
        new ContributionsParamsController(INSTANCE_ID, address(snapshot), EAS, registry, wrong, OWNER, address(this));
    }

    function _params() internal pure returns (ContributionsParamsCodec.Params memory p) {
        p.dampingFp = 85e16;
        p.toleranceFp = 1e12;
        p.maxIterations = 100;
        p.maxWeightFp = 100e18;
        p.trustShareFp = 15e16;
        p.trustDecayFp = 80e16;
        p.trustedSeeds = new address[](2);
        p.trustedSeeds[0] = address(0x1111);
        p.trustedSeeds[1] = address(0x2222);
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;
        p.roundStart = 1_700_000_000;
        p.roundEnd = 1_700_604_800;
        p.unacceptedMultFp = 5e17;
        p.collaboratorMultFp = 5e17;
        p.minRaterRepFp = 1e9;
        p.evaluatorCarveoutBps = 100;
        p.totalPool = 5_000e6;
        p.claimSchemaUid = keccak256("claim");
        p.responseSchemaUid = keccak256("response");
        p.valuationSchemaUid = keccak256("valuation");
    }
}
