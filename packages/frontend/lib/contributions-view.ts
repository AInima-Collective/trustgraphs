//! On-chain view building for the contributions screens.
//!
//! The claims / responses / ratings shown in the UI come straight from the chain: the Ponder
//! `accumulator_record` table indexes every attestation AND revocation folded by the instance's
//! `ContributionResolver` (one row per fold marker, `accumulator` = the resolver address), and this
//! module reconciles those rows with the SAME parity-locked logic the proof runs
//! (`lib/contributions/` — read-only import, never forked). NOTE: contribution attestations are NOT
//! in the generic `eas_attestation` table — that table is only populated for the trust-graph
//! `EASIndexerResolver` (`packages/indexer/src/eas.ts`), never for the `ContributionResolver`. Derived SCORES
//! (which need the trust-graph reputation) come from the indexer routes via
//! `lib/contributions-api.ts`; nothing in this module is used to compute money.

import { type Client } from '@ponder/client'
import { type ResolvedSchema } from '@ponder/react'
import { Hex, zeroHash } from 'viem'

import {
  type ContributionsParams,
  KIND_CLAIM_ATTEST,
  type LiveState,
  actorKey,
  eligibility,
  reconcile,
  stage2,
} from './contributions'
import {
  getReviewAttestations,
  getReviewTrustAttestations,
} from './contributions-review-fixtures'
import { type RawEdge } from './pagerank/types'
import { withReviewFixture } from './review-fixture-query'
import { SchemaManager } from './schemas'
import { ContributionsNetwork, NetworkSchema } from './types'
// Type-only: keeps this module runtime-independent of the ponder package (the indexer and
// scripts import this file too).
import { type accumulatorRecord } from '../ponder.schema'

export type AccumulatorRow = typeof accumulatorRecord.$inferSelect

const S = 10n ** 18n

/**
 * Display-only parameter defaults, used ONLY to reconcile the record log for display (revocation,
 * last-write-wins, round window) and to preview how a rater's voice splits. The proven round runs
 * with the governance-pinned parameters; every number that moves money comes from the proof via
 * the indexer, never from these.
 */
export const displayParams = (window?: {
  start: bigint
  end: bigint
}): ContributionsParams => ({
  dampingFp: (85n * S) / 100n,
  toleranceFp: S / 10n ** 9n,
  maxIterations: 100,
  minWeightFp: 0n,
  maxWeightFp: 100n * S,
  trustMultiplierFp: 3n * S,
  trustShareFp: S,
  trustDecayFp: (8n * S) / 10n,
  trustedSeeds: [],
  precisionScale: S,
  weightFieldIndex: 1,
  // Default to an all-inclusive window: the UI annotates in/out-of-window separately once the
  // real window is known (from the round API), instead of hiding records.
  roundStart: window?.start ?? 0n,
  roundEnd: window?.end ?? 1n << 62n,
  unacceptedMultFp: S / 2n,
  collaboratorMultFp: S / 2n,
  minRaterRepFp: 0n,
  evaluatorCarveoutBps: 100,
  totalPool: 0n,
  claimSchemaUid: zeroHash,
  responseSchemaUid: zeroHash,
  valuationSchemaUid: zeroHash,
})

/** Find a schema entry on a contributions network by its config key. */
export const contributionsSchema = (
  network: ContributionsNetwork,
  key: 'contribution-claim' | 'contribution-response' | 'contribution-valuation'
): NetworkSchema | undefined =>
  network.schemas.find((schema) => schema.key === key)

/**
 * Ponder query for every fold marker (attest AND revoke) folded by this instance's resolver, in
 * fold order — `(blockNumber, logIndex)` ascending, exactly the order the guest folds. `reconcile`
 * re-sorts by `(blockTimestamp, index)` anyway. `schemaUids` is unused here (the row's `kind`
 * already encodes the schema), kept only so callers pin the query key to the instance's schemas.
 */
export const getContributionAttestations = (
  resolver: Hex,
  _schemaUids: Hex[]
) =>
  withReviewFixture(
    (db: Client<ResolvedSchema>['db']): Promise<AccumulatorRow[]> =>
      db.query.accumulatorRecord.findMany({
        where: (t, { eq }) => eq(t.accumulator, resolver),
        orderBy: (t, { asc }) => [asc(t.blockNumber), asc(t.logIndex)],
        limit: 1000,
      }),
    getReviewAttestations
  )

/** The sibling trust network's fold log, fetched once for exact optimistic score previews. */
export const getTrustAttestations = (accumulator: Hex) =>
  withReviewFixture(
    (db: Client<ResolvedSchema>['db']): Promise<AccumulatorRow[]> =>
      db.query.accumulatorRecord.findMany({
        where: (t, { eq }) => eq(t.accumulator, accumulator),
        orderBy: (t, { asc }) => [asc(t.blockNumber), asc(t.logIndex)],
        limit: 10_000,
      }),
    getReviewTrustAttestations
  )

/** Preserve the fold log exactly, including revoke markers, for the canonical recompute. */
export const accumulatorRowsToRawEdges = (rows: AccumulatorRow[]): RawEdge[] =>
  rows.map((row) => ({
    kind: row.kind,
    attester: row.attester,
    recipient: row.recipient,
    uid: row.uid,
    blockTimestamp: row.blockTimestamp,
    data: row.data,
  }))

/** One contributor row of a claim, as displayed. */
export interface ClaimViewContributor {
  account: Hex
  share: bigint
  /** Rounded percentage of the claim's total shares. */
  sharePct: number
  /** accept / reject / none (none = reduced weight until accepted; see round rules). */
  response: 'accept' | 'reject' | 'none'
  /** The claim's own attester's share is treated as accepted unless they explicitly respond. */
  isAttester: boolean
}

/** One rating of a claim, as displayed. */
export interface ClaimViewValuation {
  rater: Hex
  score: number
  /** True when the rater is the claim's attester or one of its contributors (never counts). */
  isSelf: boolean
}

/** A live claim decorated with display data, built from the reconciled on-chain log. */
export interface ClaimView {
  uid: Hex
  attester: Hex
  timestamp: bigint
  title: string
  uri: string
  contentHash: Hex
  contributors: ClaimViewContributor[]
  valuations: ClaimViewValuation[]
  /** Whether the claim falls inside the round window (null = window unknown yet). */
  inWindow: boolean | null
}

/**
 * Reconcile raw attestation rows into displayable claims using the parity-locked lib logic
 * (revocation excludes, one live response/valuation per actor, malformed payloads skipped).
 */
export const buildClaimViews = (
  rows: AccumulatorRow[],
  schemaUids: { claim: Hex; response: Hex; valuation: Hex },
  window?: { start: bigint; end: bigint }
): { claims: ClaimView[]; state: LiveState; records: RawEdge[] } => {
  // Reconciliation consumes the exact fold log. It applies revoke and last-write-wins semantics
  // itself, while retaining these same raw records for the optimistic canonical recompute.
  const records = accumulatorRowsToRawEdges(rows)

  // Reconcile with an all-inclusive window so out-of-window claims still render (annotated
  // below); responses/valuations have no window of their own.
  const state = reconcile(records, displayParams())

  // Display data (title / uri) comes from the schema decoder; attribution comes from the
  // reconciled state.
  const displayByUid = new Map<
    string,
    { title: string; uri: string; contentHash: Hex }
  >()
  for (const row of rows) {
    if (row.kind !== KIND_CLAIM_ATTEST) continue
    try {
      const decoded = SchemaManager.decode(schemaUids.claim, row.data)
      displayByUid.set(row.uid.toLowerCase(), {
        title: String(decoded.title ?? ''),
        uri: String(decoded.uri ?? ''),
        contentHash: String(decoded.contentHash ?? zeroHash) as Hex,
      })
    } catch {
      // Malformed payloads were already skipped by reconcile; nothing to display.
    }
  }

  const claims: ClaimView[] = []
  for (const claim of state.claims.values()) {
    const display = displayByUid.get(claim.uid) ?? {
      title: '',
      uri: '',
      contentHash: zeroHash as Hex,
    }
    const contributors: ClaimViewContributor[] = Array.from(
      claim.shares.entries()
    ).map(([account, share]) => {
      const response = state.responses.get(actorKey(claim.uid, account as Hex))
      return {
        account: account as Hex,
        share,
        sharePct: Number((share * 1000n) / claim.totalShares) / 10,
        response:
          response === 1 ? 'accept' : response === 2 ? 'reject' : 'none',
        isAttester: account === claim.attester,
      }
    })

    const valuations: ClaimViewValuation[] = []
    for (const [key, score] of state.valuations.entries()) {
      const [uid, rater] = key.split('|') as [string, Hex]
      if (uid !== claim.uid) continue
      valuations.push({
        rater,
        score,
        isSelf: claim.shares.has(rater) || rater === claim.attester,
      })
    }

    claims.push({
      uid: claim.uid,
      attester: claim.attester,
      timestamp: claim.blockTimestamp,
      title: display.title,
      uri: display.uri,
      contentHash: display.contentHash,
      contributors,
      valuations,
      inWindow: window
        ? claim.blockTimestamp >= window.start &&
          claim.blockTimestamp <= window.end
        : null,
    })
  }

  // Newest first for display.
  claims.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
  return { claims, state, records }
}

/** One entry of the rating-power preview. */
export interface RatingPowerEntry {
  claimUid: Hex
  score: number
  /**
   * This claim's slice of the rater's total voice, in basis points of the counted total
   * (sums to 10000 across counted entries).
   */
  shareBps: number
  /** True when this rating can never count: the rater is on the claim themselves. */
  doesNotCount: boolean
  /** True when the rating counts at reduced weight (rater shares a claim with a contributor). */
  reducedWeight: boolean
}

/**
 * Preview how the connected rater's voice splits across their (draft) ratings, using the SAME
 * budget math the proof runs: `stage2`'s σ_r(c) = score / Σ scores over the rater's counted
 * ratings. Self-ratings are dropped by the same eligibility filter the proof applies.
 */
export const ratingPowerPreview = (
  rater: Hex,
  state: LiveState,
  draftScores: Map<string, number>
): RatingPowerEntry[] => {
  const raterKey = rater.toLowerCase() as Hex

  // Synthetic single-rater state: the real live claims, exactly the draft ratings.
  const previewState: LiveState = {
    claims: state.claims,
    responses: new Map(),
    valuations: new Map(),
  }
  for (const [uid, score] of draftScores.entries()) {
    if (!state.claims.has(uid.toLowerCase())) continue
    previewState.valuations.set(
      actorKey(uid.toLowerCase() as Hex, raterKey),
      score
    )
  }

  const rep = new Map<string, bigint>([[raterKey, S]])

  // Eligibility with real display defaults → which ratings count / are discounted.
  const elig = eligibility(previewState, rep, displayParams())

  // σ split with the discount neutralized (collaboratorMultFp = S) so the bar is the pure
  // budget split and sums to 100%; the discount is surfaced as a flag instead.
  const sigmaParams = { ...displayParams(), collaboratorMultFp: S }
  const sigmaElig = eligibility(previewState, rep, sigmaParams)
  const sigma = stage2(previewState, rep, sigmaElig, sigmaParams)

  const discounted = new Set(
    elig.eligible
      .filter((v) => v.discountFp !== S)
      .map((v) => v.claimUid.toLowerCase())
  )
  const skippedSelf = new Set(
    elig.skipped
      .filter((v) => v.reason === 'selfValuation')
      .map((v) => v.claimUid.toLowerCase())
  )

  const entries: RatingPowerEntry[] = []
  for (const [uid, score] of draftScores.entries()) {
    const key = uid.toLowerCase()
    if (!state.claims.has(key)) continue
    // With rep(r) = S, stage2's claim score is exactly σ_r(c) in fixed point.
    const sigmaFp = sigma.claimScores.get(key) ?? 0n
    entries.push({
      claimUid: key as Hex,
      score,
      shareBps: Number((sigmaFp * 10000n) / S),
      doesNotCount: skippedSelf.has(key),
      reducedWeight: discounted.has(key),
    })
  }
  entries.sort((a, b) => b.shareBps - a.shareBps || b.score - a.score)
  return entries
}
