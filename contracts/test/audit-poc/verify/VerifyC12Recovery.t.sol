// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";

/// Regression: C12 is closed at ingress, so recovery from an invalid live tuple is unnecessary.
contract VerifyC12Recovery is Test {
    bytes32 constant INSTANCE_ID = keccak256("c");
    address constant OWNER = address(0xA11CE);

    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    ContributionsParamsController controller;

    function setUp() public {
        ContributionsParamsCodec.Params memory initial = _params();
        registry = new InstanceRegistry(address(this));
        snapshot = new MerkleSnapshot(
            new MockZkVerifier(),
            ContributionsParamsCodec.hash(initial),
            new MockAccumulator(),
            address(this),
            address(this)
        );
        controller = new ContributionsParamsController(
            INSTANCE_ID, address(snapshot), address(0xEA5), registry, initial, OWNER, address(this)
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), address(this));
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: keccak256("contributions"),
                snapshot: address(snapshot),
                verifier: address(0xBEEF),
                registryOrAccumulator: address(0xC012),
                paramsHash: ContributionsParamsCodec.hash(initial)
            }),
            address(controller)
        );
        controller.publishInitialVersion();
    }

    function test_OwnerCannotInstallAnOutOfEnvelopeRotation() public {
        bytes32 good = controller.currentParamsHash();
        ContributionsParamsCodec.Params memory bad = controller.getContributionsParams();
        bad.trustDecayFp = 10e18; // guest panics: "total standing exceeded precision scale"
        bad.evaluatorCarveoutBps = 10_001; // guest wraps 1-beta and inverts the split
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidTrustDecay.selector, uint256(10e18)));
        vm.prank(OWNER);
        controller.updateParams(bad, "");

        assertEq(snapshot.paramsHash(), good);
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, good);
        assertEq(controller.version(), 1, "rejected rotations must not consume a version");
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
