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

/// @notice Every other typed controller re-runs its program's computational-safety envelope on the
///         rotation path (`TrustgraphsParamsValidator.validateUpdate`,
///         `WeightedPriorValidator.validateRotation`, `TrustComposeValidator.validateRotation`).
///         `ContributionsParamsController.updateParams` checks only the three schema UIDs, so the
///         round owner can pin a paramsHash the guest is not proven over — and cannot prove.
contract QuillBehav_ContributionsParamsEnvelope is Test {
    bytes32 constant INSTANCE_ID = keccak256("contributions-instance");
    bytes32 constant PROGRAM = keccak256("contributions");
    address constant OWNER = address(0xA11CE);
    address constant EAS_ADDR = address(0xEA5);

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
            INSTANCE_ID, address(snapshot), EAS_ADDR, registry, initial, OWNER, address(this)
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(controller));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), address(this));
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(0xBEEF),
                registryOrAccumulator: address(0xC012),
                paramsHash: ContributionsParamsCodec.hash(initial)
            }),
            address(controller)
        );
        controller.publishInitialVersion();
    }

    /// Damping 0 is outside the guest's proven envelope. Creation rejects it; rotation does not.
    function test_RotationAcceptsParamsCreationRejects_ZeroDamping() public {
        ContributionsParamsCodec.Params memory next = controller.getContributionsParams();
        next.dampingFp = 0;

        // The creation-time gate the factory applies would refuse this tuple outright.
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidDamping.selector, uint256(0)));
        this.validateEnvelope(next);

        // The rotation path accepts it and pins it as the live truth-defining commitment.
        vm.prank(OWNER);
        (, bytes32 newHash) = controller.updateParams(next, "");
        assertEq(snapshot.paramsHash(), newHash, "an out-of-envelope tuple is now the pinned params");
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, newHash);
    }

    /// The same hole admits every other envelope field at once.
    function test_RotationAcceptsUnprovableTuple() public {
        ContributionsParamsCodec.Params memory next = controller.getContributionsParams();
        next.precisionScale = 1;               // guest constant S is 1e18
        next.maxIterations = 0;                // no iterations at all
        next.totalPool = 0;                    // nothing to allocate
        next.roundStart = next.roundEnd + 1;   // window inverted
        next.trustedSeeds = new address[](0);  // no seeds: teleport set is empty

        vm.expectRevert();
        this.validateEnvelope(next);

        vm.prank(OWNER);
        (, bytes32 newHash) = controller.updateParams(next, "");
        assertEq(snapshot.paramsHash(), newHash, "rotation pinned a tuple no honest prover can satisfy");
    }

    /// external so `vm.expectRevert` can catch the library revert through a call boundary
    function validateEnvelope(ContributionsParamsCodec.Params memory p) external pure {
        ContributionsParamsValidator.validateComputationalEnvelope(p);
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
