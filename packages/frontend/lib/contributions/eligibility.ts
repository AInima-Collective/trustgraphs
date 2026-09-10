//! Stage-2 eligibility: the §5 filters over the live valuation set, with skip reasons for the
//! indexer's honest-UI audit surface. Mirrors `contributions_core::compute::{eligibility,
//! EligibleValuation, SkipReason, Eligibility}`.

import { type Hex } from 'viem'

import { type LiveState, splitActorKey } from './reconcile'
import { type ContributionsParams } from './types'
import { cmpHex } from '../pagerank/words'

/**
 * One rater's eligible valuation of one claim, after every filter, with the post-budget
 * discount. Exposed for the indexer's audit view — the guest and the display recompute
 * share this exact eligibility logic.
 */
export interface EligibleValuation {
  claimUid: Hex
  rater: Hex
  score: number
  /** S (no conflict) or `collaboratorMultFp` (rater co-claims with a contributor). */
  discountFp: bigint
}

/**
 * Why a live valuation was excluded from scoring (the indexer's honest-UI audit surface).
 * Mirrors `SkipReason::{SelfValuation, BelowMinRep}`.
 */
export type SkipReason = 'selfValuation' | 'belowMinRep'

export interface SkippedValuation {
  claimUid: Hex
  rater: Hex
  /**
   * `selfValuation`: rater is the claim's attester or one of its contributors.
   * `belowMinRep`: rater's stage-1 reputation is below `minRaterRepFp`.
   */
  reason: SkipReason
}

/** The full stage-2 eligibility partition of the live valuation set. */
export interface Eligibility {
  eligible: EligibleValuation[]
  skipped: SkippedValuation[]
  /** Lowercase raters with ≥ 1 eligible valuation (the carve-out's "participated" set). */
  participants: Set<string>
}

/**
 * Apply the §5.2 filters to the live valuations, in `(claimUid, rater)` ascending order
 * (the Rust `BTreeMap<(B256, Address), _>` iteration order).
 */
export const eligibility = (
  state: LiveState,
  rep: Map<string, bigint>,
  p: ContributionsParams
): Eligibility => {
  // Same-round co-claim sets: a ↔ b iff both are contributors of some live in-window claim.
  // (If the shared claim is the rated claim itself, the rater is one of its contributors and
  // the self-valuation rule already drops the record.)
  const coClaim = new Map<string, Set<string>>()
  for (const claim of state.claims.values()) {
    for (const a of claim.shares.keys()) {
      for (const b of claim.shares.keys()) {
        if (a !== b) {
          let peers = coClaim.get(a)
          if (peers === undefined) {
            peers = new Set<string>()
            coClaim.set(a, peers)
          }
          peers.add(b)
        }
      }
    }
  }

  const entries = Array.from(state.valuations.entries()).map(([key, score]) => {
    const [claimUid, rater] = splitActorKey(key)
    return { claimUid, rater, score }
  })
  entries.sort(
    (x, y) => cmpHex(x.claimUid, y.claimUid) || cmpHex(x.rater, y.rater)
  )

  const out: Eligibility = {
    eligible: [],
    skipped: [],
    participants: new Set(),
  }
  for (const { claimUid, rater, score } of entries) {
    const claim = state.claims.get(claimUid)!

    // Self-valuation: rater is a contributor or the claim's attester.
    if (claim.shares.has(rater) || rater === claim.attester) {
      out.skipped.push({ claimUid, rater, reason: 'selfValuation' })
      continue
    }
    // Minimum rater reputation (dust-spam pruning).
    const raterRep = rep.get(rater) ?? 0n
    if (raterRep < p.minRaterRepFp) {
      out.skipped.push({ claimUid, rater, reason: 'belowMinRep' })
      continue
    }
    // Collaborator discount: the rater co-claims (same round) with any contributor.
    const peers = coClaim.get(rater)
    const conflicted =
      peers !== undefined &&
      Array.from(claim.shares.keys()).some((a) => peers.has(a))
    const discountFp = conflicted ? p.collaboratorMultFp : p.precisionScale

    out.participants.add(rater)
    out.eligible.push({ claimUid, rater, score, discountFp })
  }
  return out
}
