// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ParamsCodec} from "src/params/ParamsCodec.sol";

/// @title TrustgraphsParamsValidator
/// @notice The single computational-safety envelope shared by factory creation and typed updates.
/// @dev Keep the error signatures stable: the creation path exposed these selectors before the
///      validator was factored out, and existing clients use them for field-level feedback.
library TrustgraphsParamsValidator {
    uint256 internal constant PRECISION_SCALE = 1e18;
    uint32 internal constant WEIGHT_FIELD_INDEX = 1;
    uint32 internal constant MAX_ITERATIONS = 500;
    uint256 internal constant MAX_TOLERANCE_FP = 1e15;
    uint256 internal constant MIN_TOLERANCE_FP = 1e6;
    uint256 internal constant MAX_WEIGHT_FP = 1e6 * PRECISION_SCALE;
    uint256 internal constant MAX_TRUSTED_SEEDS = 64;

    error DerivedFieldNotZero();
    error InvalidDamping(uint256 dampingFp);
    error InvalidTolerance(uint256 toleranceFp);
    error InvalidIterations(uint32 maxIterations);
    error InvalidWeightBounds(uint256 minWeightFp, uint256 maxWeightFp);
    error InvalidTrustShare(uint256 trustShareFp);
    error InvalidTrustDecay(uint256 trustDecayFp);
    error InvalidPrecisionScale(uint256 precisionScale);
    error InvalidTotalPool();
    error InvalidWeightFieldIndex(uint32 weightFieldIndex);
    error NoTrustedSeeds();
    error TooManyTrustedSeeds(uint256 count);
    error InvalidSeed(address seed);
    error Lane2NotSupported();
    error IdentityFieldChanged();

    /// @notice Validate the tuple accepted by `TrustgraphsFactory.createInstance`.
    /// @dev The factory derives the three instance-domain fields after this check.
    function validateCreation(ParamsCodec.Params memory p) internal pure {
        if (p.schemaUid != bytes32(0) || p.accumulator != address(0) || p.chainId != 0) {
            revert DerivedFieldNotZero();
        }
        validateComputationalEnvelope(p);
        // `createInstance` remains lane-1-only. The hybrid selector derives both separators
        // itself only after the EAS resolver and head registry exist.
        if (p.envelope0DomainSeparators.length != 0 || p.lane2MaxHeadAge != 0) {
            revert Lane2NotSupported();
        }
    }

    /// @notice Validate a complete, already-derived tuple (used for controller version 1).
    function validateFinal(ParamsCodec.Params memory p) internal pure {
        validateComputationalEnvelope(p);
        _validateLane2Profile(p);
    }

    /// @notice Validate an update and prove that no identity/program field moved from version 1.
    function validateUpdate(ParamsCodec.Params memory next, ParamsCodec.Params memory initial) internal pure {
        validateComputationalEnvelope(next);
        _validateLane2Profile(next);
        if (
            next.schemaUid != initial.schemaUid || next.accumulator != initial.accumulator
                || next.chainId != initial.chainId || next.precisionScale != initial.precisionScale
                || next.weightFieldIndex != initial.weightFieldIndex || next.lane2MaxHeadAge != initial.lane2MaxHeadAge
                || ParamsCodec.domainSetHash(next.envelope0DomainSeparators)
                    != ParamsCodec.domainSetHash(initial.envelope0DomainSeparators)
        ) {
            revert IdentityFieldChanged();
        }
    }

    /// @notice The guest's hard validity envelope, independent of how the tuple was published.
    function validateComputationalEnvelope(ParamsCodec.Params memory p) internal pure {
        if (p.dampingFp == 0 || p.dampingFp >= PRECISION_SCALE) revert InvalidDamping(p.dampingFp);
        if (p.toleranceFp < MIN_TOLERANCE_FP || p.toleranceFp > MAX_TOLERANCE_FP) {
            revert InvalidTolerance(p.toleranceFp);
        }
        if (p.maxIterations == 0 || p.maxIterations > MAX_ITERATIONS) {
            revert InvalidIterations(p.maxIterations);
        }
        if (p.maxWeightFp == 0 || p.minWeightFp > p.maxWeightFp || p.maxWeightFp > MAX_WEIGHT_FP) {
            revert InvalidWeightBounds(p.minWeightFp, p.maxWeightFp);
        }
        if (p.trustShareFp > PRECISION_SCALE) revert InvalidTrustShare(p.trustShareFp);
        if (p.trustDecayFp > PRECISION_SCALE) revert InvalidTrustDecay(p.trustDecayFp);
        if (p.precisionScale != PRECISION_SCALE) revert InvalidPrecisionScale(p.precisionScale);
        if (p.totalPool == 0) revert InvalidTotalPool();
        if (p.weightFieldIndex != WEIGHT_FIELD_INDEX) {
            revert InvalidWeightFieldIndex(p.weightFieldIndex);
        }

        uint256 seedCount = p.trustedSeeds.length;
        if (seedCount == 0) revert NoTrustedSeeds();
        if (seedCount > MAX_TRUSTED_SEEDS) revert TooManyTrustedSeeds(seedCount);
        for (uint256 i = 0; i < seedCount; i++) {
            address seed = p.trustedSeeds[i];
            if (seed == address(0)) revert InvalidSeed(seed);
            for (uint256 j = 0; j < i; j++) {
                if (p.trustedSeeds[j] == seed) revert InvalidSeed(seed);
            }
        }
    }

    /// Lane 2 is either absent or the strict pair `[EAS domain, head domain]`. Head freshness is
    /// checked against the first lane-1 anchor inside the guest, so `lane2MaxHeadAge` is
    /// deliberately fixed to zero for both profiles.
    function _validateLane2Profile(ParamsCodec.Params memory p) private pure {
        uint256 length = p.envelope0DomainSeparators.length;
        if (p.lane2MaxHeadAge != 0) revert Lane2NotSupported();
        if (length == 0) return;
        if (length != 2 || p.envelope0DomainSeparators[0] == bytes32(0) || p.envelope0DomainSeparators[1] == bytes32(0))
        {
            revert Lane2NotSupported();
        }
    }
}
