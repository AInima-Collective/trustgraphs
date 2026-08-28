// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";

/// @title TrustgraphsFactoryBoundsTest
/// @notice The §2.2 creation-time bounds, one test per bound, each pinned to its specific custom
///         error. Permissionless creation makes `paramsHash` an otherwise opaque bytes32 that would
///         accept anything; these bounds are the envelope the fixed-point guest is proven over, plus
///         the two identity rules (derived fields, lane-2 exclusion).
/// @dev    Every bound is asserted against BOTH entry points. `validateParams` is what the wizard
///         calls to warn before asking for a signature; if the two could ever disagree, the wizard
///         would either block valid creations or wave through ones that revert after the user signs.
///         The name bounds are the documented exception: they belong to `CreateArgs`, not to the
///         params struct, so only `createInstance` can see them.
contract TrustgraphsFactoryBoundsTest is TrustgraphsFactoryBase {
    /*//////////////////////////////////////////////////////////////
                                HARNESS
    //////////////////////////////////////////////////////////////*/

    /// @dev The view and the transaction must reject identically, with the same error data.
    function _expectRejected(ParamsCodec.Params memory p, bytes memory err) internal {
        vm.expectRevert(err);
        factory.validateParams(p);

        TrustgraphsFactory.CreateArgs memory args = _args("bounds", p);
        vm.expectRevert(err);
        factory.createInstance(args);
    }

    /// @dev Sanity anchor for every rejection below: the unmodified base params are accepted, so a
    ///      revert can only be attributable to the single field the test changed.
    function test_BaseParamsAreAccepted() public {
        factory.validateParams(_baseParams());
        Created memory c = _create(_args("accepted"));
        assertTrue(c.snapshot != address(0));
    }

    /*//////////////////////////////////////////////////////////////
                     IDENTITY — THE DERIVED FIELDS
    //////////////////////////////////////////////////////////////*/

    /// An instance may not name its own identity: a params struct copy-pasted from another network
    /// would bind the new snapshot to a foreign domain, which is exactly the replay hazard the v2
    /// schema fields exist to close.
    function test_RejectsSuppliedSchemaUid() public {
        ParamsCodec.Params memory p = _baseParams();
        p.schemaUid = keccak256("someone else's schema");
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.DerivedFieldNotZero.selector));
    }

    function test_RejectsSuppliedAccumulator() public {
        ParamsCodec.Params memory p = _baseParams();
        p.accumulator = address(0xACC);
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.DerivedFieldNotZero.selector));
    }

    function test_RejectsSuppliedChainId() public {
        ParamsCodec.Params memory p = _baseParams();
        p.chainId = 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.DerivedFieldNotZero.selector));
    }

    /// The golden vector itself carries all three derived fields, so submitting it verbatim — the
    /// most likely copy-paste a creator would attempt — is refused.
    function test_RejectsTheGoldenParamsVerbatim() public {
        _expectRejected(_goldenParams(), abi.encodeWithSelector(TrustgraphsParamsValidator.DerivedFieldNotZero.selector));
    }

    /*//////////////////////////////////////////////////////////////
                          THE PROVEN ENVELOPE
    //////////////////////////////////////////////////////////////*/

    /// Damping is a probability: zero makes PageRank a constant, S makes it never teleport (so the
    /// trusted seed set stops mattering at all).
    function test_RejectsZeroDamping() public {
        ParamsCodec.Params memory p = _baseParams();
        p.dampingFp = 0;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidDamping.selector, 0));
    }

    function test_RejectsDampingAtOrAboveScale() public {
        uint256 scale = TrustgraphsParamsValidator.PRECISION_SCALE;
        ParamsCodec.Params memory p = _baseParams();
        p.dampingFp = scale;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidDamping.selector, scale));

        p.dampingFp = scale + 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidDamping.selector, scale + 1));
    }

    /// Tolerance zero never converges within the iteration cap; too loose and "converged" stops
    /// meaning anything (1e15 is 0.1% of a unit score).
    function test_RejectsToleranceBelowMin() public {
        uint256 min = TrustgraphsParamsValidator.MIN_TOLERANCE_FP;
        ParamsCodec.Params memory p = _baseParams();
        p.toleranceFp = min - 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTolerance.selector, min - 1));

        p.toleranceFp = min;
        factory.validateParams(p);
    }

    function test_RejectsToleranceAboveMax() public {
        uint256 max = TrustgraphsParamsValidator.MAX_TOLERANCE_FP;
        ParamsCodec.Params memory p = _baseParams();
        p.toleranceFp = max + 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTolerance.selector, max + 1));

        // The boundary itself is inside the envelope.
        p.toleranceFp = max;
        factory.validateParams(p);
    }

    function test_RejectsZeroIterations() public {
        ParamsCodec.Params memory p = _baseParams();
        p.maxIterations = 0;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidIterations.selector, 0));
    }

    /// Past the cap the guest's cycle count, not the mathematics, becomes the limit.
    function test_RejectsIterationsAboveMax() public {
        uint32 max = TrustgraphsParamsValidator.MAX_ITERATIONS;
        ParamsCodec.Params memory p = _baseParams();
        p.maxIterations = max + 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidIterations.selector, max + 1));

        p.maxIterations = max;
        factory.validateParams(p);
    }

    /// A zero ceiling clamps every vouch weight to zero — an edge set that scores nobody.
    function test_RejectsZeroMaxWeight() public {
        ParamsCodec.Params memory p = _baseParams();
        p.minWeightFp = 0;
        p.maxWeightFp = 0;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidWeightBounds.selector, 0, 0));
    }

    /// An inverted window would clamp every weight to a value outside its own range.
    function test_RejectsInvertedWeightBounds() public {
        ParamsCodec.Params memory p = _baseParams();
        p.minWeightFp = 10e18;
        p.maxWeightFp = 1e18;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidWeightBounds.selector, 10e18, 1e18));
    }

    /// A degenerate-but-coherent window (min == max) is a choice, not an error.
    function test_AcceptsEqualWeightBounds() public view {
        ParamsCodec.Params memory p = _baseParams();
        p.minWeightFp = 5e18;
        p.maxWeightFp = 5e18;
        factory.validateParams(p);
    }

    /// Trust share is the fraction of rank mass reserved for the seeded component: above S it is not
    /// a fraction.
    function test_RejectsTrustShareAboveScale() public {
        uint256 scale = TrustgraphsParamsValidator.PRECISION_SCALE;
        ParamsCodec.Params memory p = _baseParams();
        p.trustShareFp = scale + 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTrustShare.selector, scale + 1));

        p.trustShareFp = scale; // 100% seeded is extreme but coherent
        factory.validateParams(p);
    }

    function test_RejectsTrustDecayAboveScale() public {
        uint256 scale = TrustgraphsParamsValidator.PRECISION_SCALE;
        ParamsCodec.Params memory p = _baseParams();
        p.trustDecayFp = scale + 1;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTrustDecay.selector, scale + 1));

        p.trustDecayFp = scale;
        factory.validateParams(p);
    }

    /// The scale is the guest's own constant, never a per-instance choice — a different S would make
    /// every fixed-point comparison in the proof mean something else.
    function test_RejectsWrongPrecisionScale() public {
        ParamsCodec.Params memory p = _baseParams();
        p.precisionScale = 1e17;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidPrecisionScale.selector, 1e17));
    }

    /// A zero pool scores every member zero — a network that renders as all-zeros forever.
    function test_RejectsZeroTotalPool() public {
        ParamsCodec.Params memory p = _baseParams();
        p.totalPool = 0;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTotalPool.selector));
    }

    /// `weightFieldIndex` is fixed by the canonical vouch schema: `confidence` is ABI head slot 1.
    /// Any other index reads a different field as the edge weight.
    function test_RejectsWrongWeightFieldIndex() public {
        ParamsCodec.Params memory p = _baseParams();
        p.weightFieldIndex = 0;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidWeightFieldIndex.selector, 0));

        p.weightFieldIndex = 2;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidWeightFieldIndex.selector, 2));
    }

    /*//////////////////////////////////////////////////////////////
                             TRUSTED SEEDS
    //////////////////////////////////////////////////////////////*/

    /// Trust has to start somewhere; an empty set is rejected rather than silently producing an
    /// entirely untrusted graph.
    function test_RejectsEmptySeedSet() public {
        ParamsCodec.Params memory p = _baseParams();
        p.trustedSeeds = new address[](0);
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.NoTrustedSeeds.selector));
    }

    /// Seeds are hashed into a merkle root at creation; the loop stays bounded.
    function test_RejectsTooManySeeds() public {
        uint256 max = TrustgraphsParamsValidator.MAX_TRUSTED_SEEDS;
        ParamsCodec.Params memory p = _baseParams();
        p.trustedSeeds = _seeds(max + 1);
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.TooManyTrustedSeeds.selector, max + 1));
    }

    function test_AcceptsExactlyMaxSeeds() public {
        ParamsCodec.Params memory p = _baseParams();
        p.trustedSeeds = _seeds(TrustgraphsParamsValidator.MAX_TRUSTED_SEEDS);
        factory.validateParams(p);

        Created memory c = _create(_args("full-seed-set", p));
        assertTrue(c.snapshot != address(0));
    }

    /// The zero address cannot vouch or be vouched for; seeding it wastes trust mass on nobody.
    function test_RejectsZeroAddressSeed() public {
        ParamsCodec.Params memory p = _baseParams();
        p.trustedSeeds = _seeds(3);
        p.trustedSeeds[1] = address(0);
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidSeed.selector, address(0)));
    }

    /// `seedSetRoot` sorts and would absorb a duplicate silently, so a repeated seed is always a
    /// mistake in the caller's list and is surfaced instead of swallowed.
    function test_RejectsDuplicateSeed() public {
        ParamsCodec.Params memory p = _baseParams();
        p.trustedSeeds = _seeds(4);
        p.trustedSeeds[3] = p.trustedSeeds[1];
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidSeed.selector, p.trustedSeeds[1]));
    }

    /*//////////////////////////////////////////////////////////////
                          LANE 2 IS NOT BUNDLED
    //////////////////////////////////////////////////////////////*/

    /// Lane 2 needs a per-instance `AnchorRegistry` and an envelope-signing story; the v1 bundle is
    /// lane-1 only, and the snapshot is created with no anchor registry to match. Accepting the
    /// params without the wiring would produce an instance whose params promise a lane it lacks.
    function test_RejectsEnvelopeDomainSeparators() public {
        ParamsCodec.Params memory p = _baseParams();
        p.envelope0DomainSeparators = new bytes32[](1);
        p.envelope0DomainSeparators[0] = keccak256("some-eip712-domain");
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.Lane2NotSupported.selector));
    }

    function test_RejectsLane2MaxHeadAge() public {
        ParamsCodec.Params memory p = _baseParams();
        p.lane2MaxHeadAge = 86_400;
        _expectRejected(p, abi.encodeWithSelector(TrustgraphsParamsValidator.Lane2NotSupported.selector));
    }

    /*//////////////////////////////////////////////////////////////
                          NAME (CreateArgs ONLY)
    //////////////////////////////////////////////////////////////*/

    /// An unnamed instance would be indistinguishable in every directory row, and its `instanceId`
    /// would collapse to a per-creator salt namespace.
    function test_RejectsEmptyName() public {
        TrustgraphsFactory.CreateArgs memory args = _args("");
        vm.expectRevert(TrustgraphsFactory.EmptyName.selector);
        factory.createInstance(args);
    }

    /// The name is part of `instanceId` and of every directory row; it is bounded in BYTES, so a
    /// multi-byte label is measured the way calldata charges for it.
    function test_RejectsOverlongName() public {
        uint256 max = factory.MAX_NAME_BYTES();
        TrustgraphsFactory.CreateArgs memory args = _args(_name(max + 1));
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsFactory.NameTooLong.selector, max + 1));
        factory.createInstance(args);
    }

    function test_AcceptsNameAtTheLimit() public {
        Created memory c = _create(_args(_name(factory.MAX_NAME_BYTES())));
        assertEq(bytes(c.evt.name).length, factory.MAX_NAME_BYTES());
    }

    /// The name bounds are deliberately NOT part of `validateParams`: they live on `CreateArgs`, not
    /// on the params struct, so the wizard checks them client-side. Pinning that asymmetry keeps it
    /// from being mistaken for a gap in the "both entry points agree" property above.
    function test_ValidateParamsIsIndifferentToTheName() public {
        ParamsCodec.Params memory p = _baseParams();
        factory.validateParams(p); // the view is content...

        TrustgraphsFactory.CreateArgs memory args = _args("", p);
        vm.expectRevert(TrustgraphsFactory.EmptyName.selector); // ...the transaction is not
        factory.createInstance(args);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _seeds(uint256 n) internal pure returns (address[] memory seeds) {
        seeds = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            seeds[i] = address(uint160(i + 1));
        }
    }

    function _name(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = "a";
        }
        return string(b);
    }
}
