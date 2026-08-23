// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";

contract TrustgraphsParamsValidatorHarness {
    function validateCreation(ParamsCodec.Params calldata params) external pure {
        ParamsCodec.Params memory copy = params;
        TrustgraphsParamsValidator.validateCreation(copy);
    }

    function validateFinal(ParamsCodec.Params calldata params) external pure {
        ParamsCodec.Params memory copy = params;
        TrustgraphsParamsValidator.validateFinal(copy);
    }

    function validateUpdate(ParamsCodec.Params calldata next, ParamsCodec.Params calldata initial) external pure {
        ParamsCodec.Params memory nextCopy = next;
        ParamsCodec.Params memory initialCopy = initial;
        TrustgraphsParamsValidator.validateUpdate(nextCopy, initialCopy);
    }
}

contract TrustgraphsParamsValidatorTest is Test {
    TrustgraphsParamsValidatorHarness internal harness;

    function setUp() public {
        harness = new TrustgraphsParamsValidatorHarness();
    }

    function _validFinal() internal pure returns (ParamsCodec.Params memory p) {
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
        p.totalPool = 1_000_000e18;
        p.precisionScale = 1e18;
        p.schemaUid = keccak256("schema");
        p.weightFieldIndex = 1;
        p.accumulator = address(0xACC);
        p.chainId = 1;
    }

    function _validCreation() internal pure returns (ParamsCodec.Params memory p) {
        p = _validFinal();
        p.schemaUid = bytes32(0);
        p.accumulator = address(0);
        p.chainId = 0;
    }

    function test_ValidCreationFinalAndUpdateProfiles() public view {
        ParamsCodec.Params memory creation = _validCreation();
        harness.validateCreation(creation);

        ParamsCodec.Params memory initial = _validFinal();
        harness.validateFinal(initial);
        ParamsCodec.Params memory next = _validFinal();
        next.dampingFp = 8e17;
        next.maxIterations = 200;
        harness.validateUpdate(next, initial);

        bytes32[] memory lane2 = new bytes32[](2);
        lane2[0] = keccak256("EAS domain");
        lane2[1] = keccak256("head domain");
        initial.envelope0DomainSeparators = lane2;
        harness.validateFinal(initial);
    }

    function test_CreationRejectsDerivedAndLane2Fields() public {
        ParamsCodec.Params memory p = _validCreation();
        p.schemaUid = keccak256("caller supplied");
        vm.expectRevert(TrustgraphsParamsValidator.DerivedFieldNotZero.selector);
        harness.validateCreation(p);

        p = _validCreation();
        p.envelope0DomainSeparators = new bytes32[](2);
        p.envelope0DomainSeparators[0] = keccak256("one");
        p.envelope0DomainSeparators[1] = keccak256("two");
        vm.expectRevert(TrustgraphsParamsValidator.Lane2NotSupported.selector);
        harness.validateCreation(p);
    }

    function test_ComputationalEnvelopeRejectsNumericBoundaries() public {
        ParamsCodec.Params memory p = _validFinal();
        p.dampingFp = 1e18;
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidDamping.selector, 1e18));
        harness.validateFinal(p);

        p = _validFinal();
        p.toleranceFp = 1e6 - 1;
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTolerance.selector, uint256(1e6 - 1)));
        harness.validateFinal(p);

        p = _validFinal();
        p.maxIterations = 501;
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidIterations.selector, uint32(501)));
        harness.validateFinal(p);

        p = _validFinal();
        p.minWeightFp = p.maxWeightFp + 1;
        vm.expectPartialRevert(TrustgraphsParamsValidator.InvalidWeightBounds.selector);
        harness.validateFinal(p);

        p = _validFinal();
        p.totalPool = 0;
        vm.expectRevert(TrustgraphsParamsValidator.InvalidTotalPool.selector);
        harness.validateFinal(p);
    }

    function test_SeedSetRejectsEmptyZeroDuplicateAndOversizedSets() public {
        ParamsCodec.Params memory p = _validFinal();
        p.trustedSeeds = new address[](0);
        vm.expectRevert(TrustgraphsParamsValidator.NoTrustedSeeds.selector);
        harness.validateFinal(p);

        p = _validFinal();
        p.trustedSeeds[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidSeed.selector, address(0)));
        harness.validateFinal(p);

        p = _validFinal();
        p.trustedSeeds[1] = p.trustedSeeds[0];
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidSeed.selector, p.trustedSeeds[0]));
        harness.validateFinal(p);

        p = _validFinal();
        p.trustedSeeds = new address[](65);
        for (uint256 i; i < p.trustedSeeds.length; ++i) {
            p.trustedSeeds[i] = address(uint160(i + 1));
        }
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.TooManyTrustedSeeds.selector, uint256(65)));
        harness.validateFinal(p);
    }

    function test_FinalRejectsMalformedLane2AndUpdateRejectsIdentityDrift() public {
        ParamsCodec.Params memory initial = _validFinal();
        initial.envelope0DomainSeparators = new bytes32[](1);
        initial.envelope0DomainSeparators[0] = keccak256("only one");
        vm.expectRevert(TrustgraphsParamsValidator.Lane2NotSupported.selector);
        harness.validateFinal(initial);

        initial = _validFinal();
        ParamsCodec.Params memory next = _validFinal();
        next.chainId = 2;
        vm.expectRevert(TrustgraphsParamsValidator.IdentityFieldChanged.selector);
        harness.validateUpdate(next, initial);

        next = _validFinal();
        next.dampingFp = 8e17;
        harness.validateUpdate(next, initial);
    }
}
