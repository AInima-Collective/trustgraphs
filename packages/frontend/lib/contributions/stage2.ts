//! Stage-2 rep-weighted budgeted valuation + evaluator carve-out. Mirrors
//! `contributions_core::compute::stage2`.
//!
//! `σ_r(c) = s_{r,c} / Σ_{c'} s_{r,c'}` (the rater's budget), `S(c) = Σ_r rep(r) · σ_r(c) ·
//! collabMult(r,c)`, `P(a) = Σ_c S(c) · attribShare(a,c) · consentMult(a,c)`. The collaborator
//! discount applies AFTER budget normalization — applied before, a rater whose eligible ratings
//! were all discounted would renormalize the discount away, making the conflict rule a no-op
//! for exactly the rings it targets.
//!
//! Carve-out: β = `evaluatorCarveoutBps`/10000 of the pool goes to participating raters
//! pro-rata rep; contributors share 1 − β pro-rata P. Each side is normalized over its own
//! mass, so the split is exact (up to distribution quantization). If one side has zero mass
//! the other absorbs the pool (deterministic).

import { type Hex } from 'viem'

import { type Eligibility } from './eligibility'
import { type LiveState, consentMultFp } from './reconcile'
import { type ContributionsParams } from './types'
import { fpMul, mulDiv } from '../pagerank/fixed'

/** Lexicographic compare for equal-length lowercase hex keys (= byte order). */
const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Stage-2 result before quantization, all fixed point (scale S). Keys are lowercase hex. */
export interface Stage2 {
  /** S(c): rep-weighted budgeted score per claim uid. */
  claimScores: Map<string, bigint>
  /** P(a): contributor payout weight (pre carve-out scaling). */
  contributorWeights: Map<string, bigint>
  /** Final combined weight per address: (1−β)·P(a)/ΣP + β·rep(r)/Σrep over participants. */
  combinedWeights: Map<string, bigint>
}

/** Run stage 2 over the reconciled live state. */
export const stage2 = (
  state: LiveState,
  rep: Map<string, bigint>,
  elig: Eligibility,
  p: ContributionsParams
): Stage2 => {
  const s = p.precisionScale

  // Per-rater budgets: Σ of eligible scores (integer domain — scores are 0..=100).
  const budgets = new Map<string, bigint>()
  for (const v of elig.eligible) {
    const key = v.rater.toLowerCase()
    budgets.set(key, (budgets.get(key) ?? 0n) + BigInt(v.score))
  }

  // S(c) = Σ_r rep(r) · σ_r(c) · discount(r,c). A rater whose eligible scores sum to zero
  // has no budget to allocate (their zero-scores still count as participation).
  const claimScores = new Map<string, bigint>()
  for (const v of elig.eligible) {
    const rater = v.rater.toLowerCase()
    const budget = budgets.get(rater)!
    if (budget === 0n) continue
    const raterRep = rep.get(rater) ?? 0n
    // σ_r(c) in fp: score · S / budget.
    const sigma = mulDiv(BigInt(v.score), s, budget)
    const contribution = fpMul(fpMul(raterRep, sigma, s), v.discountFp, s)
    const uid = v.claimUid.toLowerCase()
    claimScores.set(uid, (claimScores.get(uid) ?? 0n) + contribution)
  }

  // P(a) = Σ_c S(c) · attribShare(a,c) · consentMult(a,c).
  const contributorWeights = new Map<string, bigint>()
  const claimUids = Array.from(claimScores.keys()).sort(cmpKey)
  for (const uid of claimUids) {
    const score = claimScores.get(uid)!
    if (score === 0n) continue
    const claim = state.claims.get(uid)!
    const contributors = Array.from(claim.shares.keys()).sort(cmpKey)
    for (const a of contributors) {
      const share = claim.shares.get(a)!
      const attrib = mulDiv(share, s, claim.totalShares)
      const consent = consentMultFp(state, claim, a as Hex, p)
      const w = fpMul(fpMul(score, attrib, s), consent, s)
      if (w !== 0n) {
        contributorWeights.set(a, (contributorWeights.get(a) ?? 0n) + w)
      }
    }
  }

  // Combine: contributors get 1−β of the pool pro-rata P(a); participating raters get β
  // pro-rata rep. Each side normalized over its own mass so the split is exact.
  const betaFp = mulDiv(s, BigInt(p.evaluatorCarveoutBps), 10000n)
  const oneMinusBetaFp = s - betaFp

  let totalP = 0n
  for (const v of contributorWeights.values()) totalP += v
  const participantRep = new Map<string, bigint>()
  for (const r of Array.from(elig.participants).sort(cmpKey)) {
    participantRep.set(r, rep.get(r) ?? 0n)
  }
  let totalRep = 0n
  for (const v of participantRep.values()) totalRep += v

  const combined = new Map<string, bigint>()
  if (totalP !== 0n) {
    for (const [a, w] of contributorWeights) {
      const share = mulDiv(w, oneMinusBetaFp, totalP)
      if (share !== 0n) combined.set(a, (combined.get(a) ?? 0n) + share)
    }
  }
  if (betaFp !== 0n && totalRep !== 0n) {
    for (const [r, rr] of participantRep) {
      const share = mulDiv(rr, betaFp, totalRep)
      if (share !== 0n) combined.set(r, (combined.get(r) ?? 0n) + share)
    }
  }

  return { claimScores, contributorWeights, combinedWeights: combined }
}
