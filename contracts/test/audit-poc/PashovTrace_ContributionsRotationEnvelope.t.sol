// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";

/// External wrapper so `vm.expectRevert` sees a real call frame for the internal library check.
contract ValidatorProbe2 {
    function validateFinal(ContributionsParamsCodec.Params calldata p) external pure {
        ContributionsParamsCodec.Params memory m = p;
        ContributionsParamsValidator.validateFinal(m);
    }
}

/// @notice Regression for the audit execution trace: the contributions controller must apply the
///         same computational envelope on rotation that the factory applies at creation.
contract PashovTrace_ContributionsRotationEnvelope is Test {
    bytes32 constant INSTANCE_ID = keccak256("contributions-instance");
    bytes32 constant PROGRAM = keccak256("contributions");
    address constant OWNER = address(0xA11CE);
    address constant EAS = address(0xEA5);
    address constant RESOLVER = address(0xC012);

    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    ContributionsParamsController controller;
    ContributionsParamsCodec.Params initial;
    ValidatorProbe2 probe;

    function setUp() public {
        initial = _params();
        probe = new ValidatorProbe2();
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
        controller.publishInitialVersion();
    }

    function test_RotationRejectsATupleOutsideTheProvenEnvelope() public {
        ContributionsParamsCodec.Params memory next = controller.getContributionsParams();

        next.precisionScale = 1; // guest constant S is 1e18; anything else is not the same maths
        next.dampingFp = 2e18; // must be strictly < 1e18 or PageRank never contracts
        next.maxIterations = 0; // zero iterations
        next.totalPool = 0; // nothing to distribute
        next.roundEnd = next.roundStart; // empty round window
        next.trustedSeeds = new address[](0); // no seeds at all -> seedSetRoot == 0

        // The creation-time validator refuses this tuple.
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidDamping.selector, uint256(2e18)));
        probe.validateFinal(next);

        bytes32 before = snapshot.paramsHash();
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidDamping.selector, uint256(2e18)));
        vm.prank(OWNER);
        controller.updateParams(next, "ipfs://round-2");

        assertEq(controller.version(), 1);
        assertEq(snapshot.paramsHash(), before, "snapshot commitment must remain unchanged");
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, before, "directory commitment must remain unchanged");
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
