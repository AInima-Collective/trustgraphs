//! Types for the contributions program's TS port. Mirrors `contributions_core` (`lib.rs`,
//! `compute::GuestInput`). The trust-edge / journal primitives are the canonical pagerank port's
//! types, reused unchanged (the contributions journal is journal v2, unmodified).

import { type Hex } from 'viem'

import { type Journal, type RawEdge } from '../pagerank/types'

export type { Hex, Journal, RawEdge }

/**
 * Governance-pinned parameters for one contributions round. All `*Fp` fields are scaled by
 * `precisionScale` (1e18). Mirrors `contributions_core::Params`; the exact 21-word ABI tuple
 * hashed into `paramsHash` is frozen in `params.paramsHash` (INTERFACES.md §3).
 *
 * Slots 1–11 mirror the trust program's reputation params (stage 1 re-runs the exact
 * pagerank-core algorithm over the trust accumulator's edges); the rest are the round params.
 */
export interface ContributionsParams {
  // --- stage-1 reputation (mirror of the trust program) ---
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeightFp: bigint
  maxWeightFp: bigint
  trustMultiplierFp: bigint
  trustShareFp: bigint
  trustDecayFp: bigint
  /** Trusted seed addresses. `seedSetRoot` is computed over the *sorted* set. */
  trustedSeeds: Hex[]
  /** Internal fixed-point scale S (1e18). */
  precisionScale: bigint
  /** ABI head-slot index of the confidence field in vouch attestation `data` (currently 1). */
  weightFieldIndex: number
  // --- contributions round ---
  /** Claims count only if `blockTimestamp ∈ [roundStart, roundEnd]` (inclusive, unix seconds). */
  roundStart: bigint
  roundEnd: bigint
  /** Consent multiplier for contributor shares with no response (default 0.5 · S). */
  unacceptedMultFp: bigint
  /** Same-round co-claim rater discount (default 0.5 · S; 0 = hard exclusion). */
  collaboratorMultFp: bigint
  /** Raters with rep below this are ignored (and earn no carve-out). */
  minRaterRepFp: bigint
  /** Evaluator carve-out β in basis points (default 100 = 1%; 0 disables). */
  evaluatorCarveoutBps: number
  /** The distribution scale fed to the point distributor. */
  totalPool: bigint
  /** Bind the fold kind tags (INTERFACES.md §2) to concrete schemas inside the proven statement. */
  claimSchemaUid: Hex
  responseSchemaUid: Hex
  valuationSchemaUid: Hex
}

/**
 * The complete input the contributions computer receives. Mirrors
 * `contributions_core::compute::GuestInput`.
 */
export interface ContributionsInput {
  /** Trust (vouch) edges in TRUST-accumulator fold order — journal slot A. */
  trustEdges: RawEdge[]
  /**
   * Contribution records in CONTRIBUTION-accumulator fold order — journal slot B.
   * Kinds per INTERFACES.md §2 (0–5).
   */
  records: RawEdge[]
  params: ContributionsParams
  /**
   * Journal-v3 pass-through commitments. Omitted, both are zero: the payouts and output root
   * still reproduce, but the digest is the digest of an unbound journal.
   */
  binding?: { recipient: Hex; instanceDomain: Hex }
}
