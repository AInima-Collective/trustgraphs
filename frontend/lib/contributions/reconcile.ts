//! Contribution-record reconciliation: the folded record log (accumulator B) → the live sets
//! stage 2 scores over. Mirrors `contributions_core::reconcile`.
//!
//! Rules (all mirroring lane-1 trust-edge reconciliation):
//! - revocation excludes: any revoke kind for a `uid` excludes that attestation entirely,
//!   regardless of fold order;
//! - last-write-wins per key by `(blockTimestamp, foldIndex)`: one live response per
//!   (responder, claim), one live valuation per (rater, claim);
//! - malformed payloads are deterministic skips (`records` decoders);
//! - claims count only if `blockTimestamp ∈ [roundStart, roundEnd]` (inclusive);
//!   responses and valuations count until the checkpoint freeze (no extra window).

import { type Hex } from 'viem'

import {
  KIND_CLAIM_ATTEST,
  KIND_RESPONSE_ATTEST,
  KIND_VALUATION_ATTEST,
  isRevoke,
} from './kind'
import { decodeClaim, decodeResponse, decodeValuation } from './records'
import { type ContributionsParams } from './types'
import { type RawEdge } from '../pagerank/types'
import { cmpBig } from '../pagerank/words'

/** A live, in-window contribution claim with aggregated attribution. */
export interface LiveClaim {
  /** Lowercase claim uid. */
  uid: Hex
  /** Lowercase attester address. */
  attester: Hex
  blockTimestamp: bigint
  /**
   * Attribution shares aggregated per lowercase contributor address (duplicates summed).
   * Never empty; total share sum is never zero.
   */
  shares: Map<string, bigint>
  totalShares: bigint
}

/**
 * The reconciled live state of one round's record log. `responses`/`valuations` are keyed by
 * `actorKey(claimUid, actor)`; all hex keys are lowercase.
 */
export interface LiveState {
  /** Live in-window claims, keyed by lowercase claim uid. */
  claims: Map<string, LiveClaim>
  /**
   * Live responses: `actorKey(claimUid, responder)` → response (1 = accept, 2 = reject).
   * Only kept for responders in the claim's contributor set.
   */
  responses: Map<string, number>
  /**
   * Live valuations: `actorKey(claimUid, rater)` → score ∈ [0, 100]. One per key (LWW).
   * Referencing a live claim; self-valuations are dropped later (stage-2 eligibility,
   * which also needs the rater's reputation).
   */
  valuations: Map<string, number>
}

/**
 * The composite `(claimUid, actor)` map key. Both parts are fixed-length lowercase hex, so
 * lexicographic key order equals the Rust `BTreeMap<(B256, Address), _>` byte order.
 */
export const actorKey = (claimUid: Hex, actor: Hex): string =>
  `${claimUid.toLowerCase()}|${actor.toLowerCase()}`

/** Split an `actorKey` back into `[claimUid, actor]` (both lowercase). */
export const splitActorKey = (key: string): [Hex, Hex] => {
  const [uid, actor] = key.split('|')
  return [uid as Hex, actor as Hex]
}

/** Reconcile the folded record log into live sets. Mirrors `reconcile::reconcile`. */
export const reconcile = (
  records: RawEdge[],
  p: ContributionsParams
): LiveState => {
  // 1. Revocation excludes, per schema kind (a revoke's uid kills the matching attest).
  const revoked = new Set<string>()
  for (const r of records) {
    if (isRevoke(r.kind)) revoked.add(r.uid.toLowerCase())
  }

  // 2. Canonical order: (blockTimestamp, foldIndex). Fold index is the array position.
  const ordered = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !isRevoke(r.kind) && !revoked.has(r.uid.toLowerCase()))
  ordered.sort((a, b) => {
    const t = cmpBig(a.r.blockTimestamp, b.r.blockTimestamp)
    return t !== 0 ? t : a.i - b.i
  })

  // 3. Claims first (responses/valuations reference them; map order is irrelevant since
  //    claim identity is the uid and uids are unique in EAS).
  const claims = new Map<string, LiveClaim>()
  for (const { r } of ordered) {
    if (r.kind !== KIND_CLAIM_ATTEST) continue
    // Round window (provable: timestamps are folded into every leaf).
    if (r.blockTimestamp < p.roundStart || r.blockTimestamp > p.roundEnd)
      continue
    const payload = decodeClaim(r.data)
    if (payload === null) continue
    const shares = new Map<string, bigint>()
    let complete = true
    for (let i = 0; i < payload.contributors.length; i++) {
      const contributor = payload.contributors[i]
      const share = payload.shares[i]
      if (contributor === undefined || share === undefined) {
        complete = false
        break
      }
      const a = contributor.toLowerCase()
      shares.set(a, (shares.get(a) ?? 0n) + BigInt(share))
    }
    if (!complete) continue
    let totalShares = 0n
    for (const v of shares.values()) totalShares += v
    // decodeClaim guarantees a nonzero share exists.
    claims.set(r.uid.toLowerCase(), {
      uid: r.uid.toLowerCase() as Hex,
      attester: r.attester.toLowerCase() as Hex,
      blockTimestamp: r.blockTimestamp,
      shares,
      totalShares,
    })
  }

  // 4. Responses and valuations: LWW per (claim, actor) — later (timestamp, foldIndex)
  //    overwrites earlier because `ordered` is sorted ascending.
  const responses = new Map<string, number>()
  const valuations = new Map<string, number>()
  for (const { r } of ordered) {
    if (r.kind === KIND_RESPONSE_ATTEST) {
      const payload = decodeResponse(r.data)
      if (payload === null) continue
      const claim = claims.get(payload.claimUid.toLowerCase())
      if (claim === undefined) continue
      // Only meaningful from an address in the claim's contributor set.
      if (!claim.shares.has(r.attester.toLowerCase())) continue
      responses.set(actorKey(payload.claimUid, r.attester), payload.response)
    } else if (r.kind === KIND_VALUATION_ATTEST) {
      const payload = decodeValuation(r.data)
      if (payload === null) continue
      if (!claims.has(payload.claimUid.toLowerCase())) continue
      valuations.set(actorKey(payload.claimUid, r.attester), payload.score)
    }
  }

  return { claims, responses, valuations }
}

/**
 * The consent multiplier for contributor `a`'s share of `claim`, in fixed point:
 * accepted → S, no response → `unacceptedMultFp`, rejected → 0. A self-claim's attester share
 * is implicitly accepted (an explicit response still overrides — people must be able to refuse
 * attribution). Mirrors `reconcile::consent_mult_fp`.
 */
export const consentMultFp = (
  state: LiveState,
  claim: LiveClaim,
  a: Hex,
  p: ContributionsParams
): bigint => {
  const resp = state.responses.get(actorKey(claim.uid, a))
  if (resp === 1) return p.precisionScale
  if (resp !== undefined) return 0n // 2 = reject (decoder admits nothing else)
  return a.toLowerCase() === claim.attester
    ? p.precisionScale // self-claim: implicitly accepted
    : p.unacceptedMultFp
}
