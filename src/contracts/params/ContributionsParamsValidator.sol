// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ContributionsParamsCodec} from "contracts/params/ContributionsParamsCodec.sol";

/// @title ContributionsParamsValidator
/// @notice Creation-time safety envelope for the contributions program's 21-field tuple
///         (docs/build/contributions/interfaces.md §3). Slots 1–11 are the stage-1 reputation
///         params mirrored from the trust program, so their bounds are RE-DERIVED from
///         `TrustgraphsParamsValidator` — the same fixed-point guest runs underneath, so the same
///         envelope applies. Slots 12–21 are the round params, which get their own bounds here:
///         window ordering, carve-out ≤ 100%, consent/collaborator multipliers ≤ the fixed-point
///         scale, and pool sanity.
/// @dev    These are not opinions about what makes a good round — they are the envelope the
///         fixed-point guest is proven over, plus the identity rule (the three schema UIDs are
///         DERIVED by the factory and must be submitted as zero). Bounds validation never touches
///         the frozen codec: `ContributionsParamsCodec.hash` stays byte-identical to
///         `contributions_core::params::params_hash`.
library ContributionsParamsValidator {
    /// @notice The fixed-point scale S every instance must use (the guest's own constant).
    uint256 internal constant PRECISION_SCALE = 1e18;
    /// @notice `weightFieldIndex` is fixed by the canonical vouch schema: `confidence` is slot 1.
    uint32 internal constant WEIGHT_FIELD_INDEX = 1;
    /// @notice Iteration ceiling — past this the guest's cycle count, not the maths, is the limit.
    uint32 internal constant MAX_ITERATIONS = 500;
    /// @notice Convergence tolerance must be meaningfully below S; 1e15 is 0.1% of a unit score.
    uint256 internal constant MAX_TOLERANCE_FP = 1e15;
    /// @notice Ceiling on the seed boost; `_validateGrowth` is the real decision-maker.
    uint256 internal constant MAX_TRUST_MULTIPLIER_FP = 100e18;
    /// @notice Ceiling on a single vouch's weight (four orders of headroom over the live cap).
    uint256 internal constant MAX_WEIGHT_FP = 1e6 * PRECISION_SCALE;
    /// @notice The largest rank the fixed-point core can hold with headroom for one more multiply.
    uint256 internal constant MAX_RANK_FP = type(uint256).max / PRECISION_SCALE;
    /// @notice Seeds are hashed into a merkle root at creation; keep the loop bounded.
    uint256 internal constant MAX_TRUSTED_SEEDS = 64;
    /// @notice `evaluatorCarveoutBps` is basis points: 10_000 = the whole pool to evaluators.
    uint32 internal constant MAX_CARVEOUT_BPS = 10_000;

    // ---- Stage-1 (trust-mirrored) errors. Signatures match TrustgraphsParamsValidator so ----
    // ---- clients can reuse their field-level feedback for the shared slots.               ----
    error DerivedFieldNotZero();
    error InvalidDamping(uint256 dampingFp);
    error InvalidTolerance(uint256 toleranceFp);
    error InvalidIterations(uint32 maxIterations);
    error InvalidWeightBounds(uint256 minWeightFp, uint256 maxWeightFp);
    error RankGrowthUnbounded(uint256 factorFp, uint32 maxIterations);
    error InvalidTrustShare(uint256 trustShareFp);
    error InvalidTrustDecay(uint256 trustDecayFp);
    error InvalidTrustMultiplier(uint256 trustMultiplierFp);
    error InvalidPrecisionScale(uint256 precisionScale);
    error InvalidWeightFieldIndex(uint32 weightFieldIndex);
    error NoTrustedSeeds();
    error TooManyTrustedSeeds(uint256 count);
    /// @notice A seed was the zero address, or the same address appeared twice.
    error InvalidSeed(address seed);

    // ---- Round-specific (slots 12–21) errors. ----
    /// @notice `roundStart` must strictly precede `roundEnd` (a round needs a real window; the
    ///         guest counts claims in the inclusive `[roundStart, roundEnd]`).
    error InvalidRoundWindow(uint64 roundStart, uint64 roundEnd);
    /// @notice β is basis points; more than 10_000 would allocate over 100% of the pool.
    error InvalidCarveout(uint32 evaluatorCarveoutBps);
    /// @notice The no-response consent multiplier is a fraction of S.
    error InvalidUnacceptedMultiplier(uint256 unacceptedMultFp);
    /// @notice The same-round co-claim rater discount is a fraction of S (0 = hard exclusion).
    error InvalidCollaboratorMultiplier(uint256 collaboratorMultFp);
    /// @notice The pool must be a nonzero distribution scale the fixed-point core can hold.
    error InvalidTotalPool(uint256 totalPool);

    /// @notice Validate the tuple accepted by `ContributionsFactory.createInstance`.
    /// @dev The factory derives the three schema-UID identity fields after this check — a
    ///      copy-pasted tuple from another round would otherwise bind this instance's kind tags to
    ///      a foreign resolver's schemas.
    function validateCreation(ContributionsParamsCodec.Params memory p) internal pure {
        if (p.claimSchemaUid != bytes32(0) || p.responseSchemaUid != bytes32(0) || p.valuationSchemaUid != bytes32(0))
        {
            revert DerivedFieldNotZero();
        }
        validateComputationalEnvelope(p);
    }

    /// @notice Validate a complete, already-derived tuple.
    function validateFinal(ContributionsParamsCodec.Params memory p) internal pure {
        validateComputationalEnvelope(p);
    }

    /// @notice The guest's hard validity envelope, independent of how the tuple was published.
    function validateComputationalEnvelope(ContributionsParamsCodec.Params memory p) internal pure {
        // ---- Stage-1 reputation bounds, re-derived from the trust program's validator. ----
        if (p.dampingFp == 0 || p.dampingFp >= PRECISION_SCALE) revert InvalidDamping(p.dampingFp);
        if (p.toleranceFp == 0 || p.toleranceFp > MAX_TOLERANCE_FP) {
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
        if (p.trustMultiplierFp > MAX_TRUST_MULTIPLIER_FP) {
            revert InvalidTrustMultiplier(p.trustMultiplierFp);
        }
        if (p.precisionScale != PRECISION_SCALE) revert InvalidPrecisionScale(p.precisionScale);
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

        // ---- Round bounds (slots 12–21). ----
        if (p.roundStart >= p.roundEnd) revert InvalidRoundWindow(p.roundStart, p.roundEnd);
        if (p.evaluatorCarveoutBps > MAX_CARVEOUT_BPS) revert InvalidCarveout(p.evaluatorCarveoutBps);
        if (p.unacceptedMultFp > PRECISION_SCALE) revert InvalidUnacceptedMultiplier(p.unacceptedMultFp);
        if (p.collaboratorMultFp > PRECISION_SCALE) {
            revert InvalidCollaboratorMultiplier(p.collaboratorMultFp);
        }
        // `minRaterRepFp` is deliberately unbounded: reputation is an open scale and a threshold
        // above every rater is a legal (if silly) configuration, not an unprovable one.
        if (p.totalPool == 0 || p.totalPool > MAX_RANK_FP) revert InvalidTotalPool(p.totalPool);

        _validateGrowth(p);
    }

    /// @dev `damping x multiplier` compounding past what U256 can hold within `maxIterations`
    ///      makes the instance unprovable (the guest aborts on overflow), not merely badly tuned.
    function _validateGrowth(ContributionsParamsCodec.Params memory p) private pure {
        uint256 factor = (p.dampingFp * p.trustMultiplierFp) / PRECISION_SCALE;
        if (factor <= PRECISION_SCALE) return;

        uint256 growth = PRECISION_SCALE;
        for (uint256 i = 0; i < p.maxIterations; i++) {
            if (growth > type(uint256).max / factor) {
                revert RankGrowthUnbounded(factor, p.maxIterations);
            }
            growth = (growth * factor) / PRECISION_SCALE;
            if (growth > MAX_RANK_FP) revert RankGrowthUnbounded(factor, p.maxIterations);
        }
    }
}
