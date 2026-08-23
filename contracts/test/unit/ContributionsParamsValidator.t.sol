// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";

contract ContributionsParamsValidatorHarness {
    function validateCreation(ContributionsParamsCodec.Params calldata params) external pure {
        ContributionsParamsCodec.Params memory copy = params;
        ContributionsParamsValidator.validateCreation(copy);
    }

    function validateFinal(ContributionsParamsCodec.Params calldata params) external pure {
        ContributionsParamsCodec.Params memory copy = params;
        ContributionsParamsValidator.validateFinal(copy);
    }
}

contract ContributionsParamsValidatorTest is Test {
    ContributionsParamsValidatorHarness internal harness;

    function setUp() public {
        harness = new ContributionsParamsValidatorHarness();
    }

    function _valid() internal pure returns (ContributionsParamsCodec.Params memory p) {
        p.dampingFp = 85e16;
        p.toleranceFp = 1e12;
        p.maxIterations = 100;
        p.minWeightFp = 1e18;
        p.maxWeightFp = 1_000e18;
        p.trustShareFp = 5e17;
        p.trustDecayFp = 9e17;
        p.trustedSeeds = new address[](2);
        p.trustedSeeds[0] = address(0xA1);
        p.trustedSeeds[1] = address(0xB2);
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;
        p.roundStart = 1_700_000_000;
        p.roundEnd = 1_700_604_800;
        p.unacceptedMultFp = 5e17;
        p.collaboratorMultFp = 5e17;
        p.minRaterRepFp = 1e9;
        p.evaluatorCarveoutBps = 100;
        p.totalPool = 5_000e6;
    }

    function test_ValidCreationAndFinalProfiles() public view {
        ContributionsParamsCodec.Params memory p = _valid();
        harness.validateCreation(p);

        p.claimSchemaUid = keccak256("claim");
        p.responseSchemaUid = keccak256("response");
        p.valuationSchemaUid = keccak256("valuation");
        harness.validateFinal(p);
    }

    function test_CreationRejectsDerivedSchemaIdentity() public {
        ContributionsParamsCodec.Params memory p = _valid();
        p.claimSchemaUid = keccak256("caller supplied");
        vm.expectRevert(ContributionsParamsValidator.DerivedFieldNotZero.selector);
        harness.validateCreation(p);
    }

    function test_TrustEnvelopeRejectsNumericBoundaries() public {
        ContributionsParamsCodec.Params memory p = _valid();
        p.dampingFp = 1e18;
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidDamping.selector, 1e18));
        harness.validateFinal(p);

        p = _valid();
        p.maxIterations = 501;
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidIterations.selector, uint32(501)));
        harness.validateFinal(p);

        p = _valid();
        p.minWeightFp = p.maxWeightFp + 1;
        vm.expectPartialRevert(ContributionsParamsValidator.InvalidWeightBounds.selector);
        harness.validateFinal(p);
    }

    function test_SeedSetRejectsEmptyDuplicateAndOversizedSets() public {
        ContributionsParamsCodec.Params memory p = _valid();
        p.trustedSeeds = new address[](0);
        vm.expectRevert(ContributionsParamsValidator.NoTrustedSeeds.selector);
        harness.validateFinal(p);

        p = _valid();
        p.trustedSeeds[1] = p.trustedSeeds[0];
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidSeed.selector, p.trustedSeeds[0]));
        harness.validateFinal(p);

        p = _valid();
        p.trustedSeeds = new address[](65);
        for (uint256 i; i < p.trustedSeeds.length; ++i) {
            p.trustedSeeds[i] = address(uint160(i + 1));
        }
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.TooManyTrustedSeeds.selector, uint256(65)));
        harness.validateFinal(p);
    }

    function test_RoundEnvelopeRejectsWindowCarveoutMultipliersAndPoolBounds() public {
        ContributionsParamsCodec.Params memory p = _valid();
        p.roundEnd = p.roundStart;
        vm.expectPartialRevert(ContributionsParamsValidator.InvalidRoundWindow.selector);
        harness.validateFinal(p);

        p = _valid();
        p.evaluatorCarveoutBps = 10_001;
        vm.expectRevert(abi.encodeWithSelector(ContributionsParamsValidator.InvalidCarveout.selector, uint32(10_001)));
        harness.validateFinal(p);

        p = _valid();
        p.unacceptedMultFp = 1e18 + 1;
        vm.expectPartialRevert(ContributionsParamsValidator.InvalidUnacceptedMultiplier.selector);
        harness.validateFinal(p);

        p = _valid();
        p.collaboratorMultFp = 1e18 + 1;
        vm.expectPartialRevert(ContributionsParamsValidator.InvalidCollaboratorMultiplier.selector);
        harness.validateFinal(p);

        p = _valid();
        p.totalPool = type(uint256).max / 1e18 + 1;
        vm.expectPartialRevert(ContributionsParamsValidator.InvalidTotalPool.selector);
        harness.validateFinal(p);
    }
}
