//! Thin client for the indexer's `/contributions` routes (the M3 lane). EVERY HTTP call the
//! contributions screens make to the indexer goes through this module, so if the M3 route shapes
//! drift, this file is the one-file fix.
//!
//! Route map (built against the M3 interface expectation; each returns `null` on 404 = "not
//! indexed yet"):
//!   GET /contributions/:snapshot/round            → ContributionsRound
//!   GET /contributions/:snapshot/claims           → ContributionsClaimsResponse
//!   GET /contributions/:snapshot/score/:claimUID  → ContributionsScoreDetail
//!   GET /contributions/:snapshot/payout/:account  → ContributionsPayout
//!
//! REVIEW FIXTURES: NEXT_PUBLIC_TG_REVIEW_FIXTURES=1 lets the production-build screenshot
//! harness select deterministic phases and wallet personas without a live indexer. The flag is
//! off in normal builds, where every request below follows the real HTTP path.

import { queryOptions } from '@tanstack/react-query'
import { Hex } from 'viem'

import { APIS } from './config'
import { ContributionsParams } from './contributions'
import {
  getReviewClaims,
  getReviewPayout,
  getReviewRound,
  getReviewScore,
} from './contributions-review-fixtures'
import { REVIEW_FIXTURES_ENABLED } from './review-fixture-query'
import {
  parseScoreKeyDomainProvenance,
  parseScoreProgramProvenance,
} from './score-program'

/** Skip reasons the indexer derives (mirrors `lib/contributions/eligibility.SkipReason`). */
export type ContributionsSkipReason = 'selfValuation' | 'belowMinRep'

/** GET /contributions/:snapshot/round */
export type ContributionsRound = {
  /** Unix seconds, inclusive. */
  window: { start: string; end: string }
  /** The round's funding pool (raw token units). */
  pool: string
  /** The pool ERC20 address. */
  token: string
  /** The latest proven payout root, or null before the first proof lands. */
  root: string | null
  /** CID of the payout blob behind `root`, if any. */
  cid: string | null
  /** Lifecycle from the round window vs now (the indexer's vocabulary). */
  status: 'upcoming' | 'open' | 'closed' | 'unknown'
  /** Governance-pinned inputs for an exact optimistic recompute; null when unavailable. */
  params: ContributionsParams | null
}

/** One contributor's slice of a claim, from the indexer's derived-score breakdown. */
export type ContributionsClaimContributor = {
  account: string
  /** Relative share of this claim (raw attested weight). */
  share: string
  /** accept / reject / none (none = counted at reduced weight until accepted). */
  response: 'accept' | 'reject' | 'none'
}

/** One claim with its live derived score (GET /contributions/:snapshot/claims). */
export type ContributionsScoredClaim = {
  claimUid: string
  attester: string
  title: string
  uri: string
  contentHash: string
  timestamp: string
  revoked: boolean
  /** Live derived S(c), fixed-point decimal string (1e18 scale), or null if unscored. */
  score: string | null
  contributors: ContributionsClaimContributor[]
}

export type ContributionsClaimsResponse = {
  snapshot: string
  claims: ContributionsScoredClaim[]
}

/** One rater's valuation in the audit view (GET /contributions/:snapshot/score/:claimUID). */
export type ContributionsValuationAudit = {
  rater: string
  score: number
  /** False iff the rating was filtered out of scoring entirely. */
  counted: boolean
  /** Why it was filtered, when `counted` is false. */
  reason?: ContributionsSkipReason
  /** True when counted at reduced weight because the rater co-claims with a contributor. */
  collaboratorDiscount?: boolean
}

export type ContributionsScoreDetail = {
  claimUid: string
  /** Derived S(c), fixed-point decimal string. */
  score: string
  valuations: ContributionsValuationAudit[]
}

/** GET /contributions/:snapshot/payout/:account — the merkle claim bundle. */
export type ContributionsPayout = {
  account: string
  value: string
  proof: string[]
}

const get = async <T>(
  path: string,
  keyDomain?: 'contributions-claim-v1'
): Promise<T | null> => {
  const response = await fetch(`${APIS.ponder}${path}`)
  if (response.ok) {
    const body = (await response.json()) as T & { scoreProgram?: unknown }
    parseScoreProgramProvenance(body.scoreProgram, 'contributions')
    if (keyDomain) {
      parseScoreKeyDomainProvenance(
        (body as T & { scoreKeyDomain?: unknown }).scoreKeyDomain,
        'contributions',
        keyDomain
      )
    }
    return body
  }
  if (response.status === 404) {
    // Route not wired / nothing indexed yet.
    return null
  }
  throw new Error(
    `Failed to fetch ${path}: ${response.status} ${response.statusText} (${await response.text()})`
  )
}

// ---- Indexer → client shape normalization -------------------------------------------------
// The indexer's `/contributions/:snapshot/{round,claims,score}` rows use the storage-layer field
// names (round `roundStart`/`roundEnd`/`totalPool`; claim `uid`/`scoreFp`/`blockTimestamp`; audit
// `status`/`discountFp`). The types above are the shape the screens consume. Normalize here so the
// drift lives in exactly one place (this file), rather than crashing consumers on a renamed field.

/** A round row as the indexer's `/round` route actually serializes it (subset consumed here). */
type RawRound = {
  root: string | null
  ipfsHashCid: string | null
  status: 'upcoming' | 'open' | 'closed' | 'unknown'
  roundStart: string | null
  roundEnd: string | null
  totalPool: string | null
  token?: string | null
  params?: Record<string, unknown> | null
}

const normalizeParams = (
  raw: Record<string, unknown> | null | undefined
): ContributionsParams | null => {
  if (!raw) return null
  try {
    if (!Array.isArray(raw.trustedSeeds)) return null
    const bigintValue = (key: string) => {
      const value = raw[key]
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new Error(`Missing ${key}`)
      return BigInt(value)
    }
    const numberValue = (key: string) => {
      const value = raw[key]
      if (typeof value !== 'number') throw new Error(`Missing ${key}`)
      return value
    }
    const hexValue = (key: string) => {
      const value = raw[key]
      if (typeof value !== 'string') throw new Error(`Missing ${key}`)
      return value as Hex
    }
    return {
      dampingFp: bigintValue('dampingFp'),
      toleranceFp: bigintValue('toleranceFp'),
      maxIterations: numberValue('maxIterations'),
      minWeightFp: bigintValue('minWeightFp'),
      maxWeightFp: bigintValue('maxWeightFp'),
      trustShareFp: bigintValue('trustShareFp'),
      trustDecayFp: bigintValue('trustDecayFp'),
      trustedSeeds: raw.trustedSeeds as Hex[],
      precisionScale: bigintValue('precisionScale'),
      weightFieldIndex: numberValue('weightFieldIndex'),
      roundStart: bigintValue('roundStart'),
      roundEnd: bigintValue('roundEnd'),
      unacceptedMultFp: bigintValue('unacceptedMultFp'),
      collaboratorMultFp: bigintValue('collaboratorMultFp'),
      minRaterRepFp: bigintValue('minRaterRepFp'),
      evaluatorCarveoutBps: numberValue('evaluatorCarveoutBps'),
      totalPool: bigintValue('totalPool'),
      claimSchemaUid: hexValue('claimSchemaUid'),
      responseSchemaUid: hexValue('responseSchemaUid'),
      valuationSchemaUid: hexValue('valuationSchemaUid'),
    }
  } catch {
    return null
  }
}

const normalizeRound = (raw: RawRound): ContributionsRound => ({
  window: { start: raw.roundStart ?? '0', end: raw.roundEnd ?? '0' },
  pool: raw.totalPool ?? '0',
  token: raw.token ?? '',
  root: raw.root,
  cid: raw.ipfsHashCid,
  status: raw.status,
  params: normalizeParams(raw.params),
})

/** A claim row as the indexer's `/claims` route actually serializes it. */
type RawScoredClaim = {
  uid: string
  attester: string
  title: string
  uri: string
  contentHash: string
  blockTimestamp: string
  revoked: boolean
  scoreFp: string | null
  contributors?: { contributor: string; share: string }[]
  responses?: { responder: string; response: string }[]
}
type RawClaimsResponse = { snapshot: string; claims: RawScoredClaim[] }

const normalizeClaim = (raw: RawScoredClaim): ContributionsScoredClaim => {
  const responseByAccount = new Map(
    (raw.responses ?? []).map((r) => [r.responder.toLowerCase(), r.response])
  )
  return {
    claimUid: raw.uid,
    attester: raw.attester,
    title: raw.title,
    uri: raw.uri,
    contentHash: raw.contentHash,
    timestamp: raw.blockTimestamp,
    revoked: raw.revoked,
    score: raw.scoreFp,
    contributors: (raw.contributors ?? []).map((cont) => {
      const response = responseByAccount.get(cont.contributor.toLowerCase())
      return {
        account: cont.contributor,
        share: cont.share,
        response:
          response === 'accept' || response === 'reject' ? response : 'none',
      }
    }),
  }
}

/** A score-detail valuation as the indexer's `/score` route actually serializes it. */
type RawScoreValuation = {
  rater: string
  score: number
  status: 'counted' | 'discounted' | 'filtered'
  reason?: ContributionsSkipReason | null
  discountFp?: string | null
}
type RawScoreDetail = {
  claimUid: string
  scoreFp: string
  valuations: RawScoreValuation[]
}

const normalizeScore = (raw: RawScoreDetail): ContributionsScoreDetail => ({
  claimUid: raw.claimUid,
  score: raw.scoreFp,
  valuations: raw.valuations.map((v) => ({
    rater: v.rater,
    score: v.score,
    counted: v.status !== 'filtered',
    reason: v.reason ?? undefined,
    collaboratorDiscount: v.status === 'discounted',
  })),
})

export const fetchContributionsRound = async (
  snapshot: string
): Promise<ContributionsRound | null> => {
  if (REVIEW_FIXTURES_ENABLED) return getReviewRound()
  const raw = await get<RawRound>(`/contributions/${snapshot}/round`)
  return raw ? normalizeRound(raw) : null
}

export const fetchContributionsClaims = async (
  snapshot: string
): Promise<ContributionsClaimsResponse | null> => {
  if (REVIEW_FIXTURES_ENABLED) return getReviewClaims()
  const raw = await get<RawClaimsResponse>(
    `/contributions/${snapshot}/claims`,
    'contributions-claim-v1'
  )
  if (!raw) return null
  return {
    snapshot: raw.snapshot,
    claims: (raw.claims ?? []).map(normalizeClaim),
  }
}

export const fetchContributionsScore = async (
  snapshot: string,
  claimUid: string
): Promise<ContributionsScoreDetail | null> => {
  if (REVIEW_FIXTURES_ENABLED) return getReviewScore(claimUid)
  const raw = await get<RawScoreDetail>(
    `/contributions/${snapshot}/score/${claimUid}`,
    'contributions-claim-v1'
  )
  return raw ? normalizeScore(raw) : null
}

export const fetchContributionsPayout = async (
  snapshot: string,
  account: string
): Promise<ContributionsPayout | null> => {
  if (REVIEW_FIXTURES_ENABLED) return getReviewPayout()
  return await get<ContributionsPayout>(
    `/contributions/${snapshot}/payout/${account}`
  )
}

/** react-query wrappers (the components consume these). */
export const contributionsQueries = {
  round: (snapshot: string) =>
    queryOptions({
      queryKey: ['contributions', 'round', snapshot] as const,
      queryFn: () => fetchContributionsRound(snapshot),
      enabled: !!APIS.ponder && !!snapshot,
    }),
  claims: (snapshot: string) =>
    queryOptions({
      queryKey: ['contributions', 'claims', snapshot] as const,
      queryFn: () => fetchContributionsClaims(snapshot),
      enabled: !!APIS.ponder && !!snapshot,
    }),
  score: (snapshot: string, claimUid: string) =>
    queryOptions({
      queryKey: ['contributions', 'score', snapshot, claimUid] as const,
      queryFn: () => fetchContributionsScore(snapshot, claimUid),
      enabled: !!APIS.ponder && !!snapshot && !!claimUid,
    }),
  payout: (snapshot: string, account: string | undefined) =>
    queryOptions({
      queryKey: ['contributions', 'payout', snapshot, account] as const,
      queryFn: () => fetchContributionsPayout(snapshot, account!),
      enabled: !!APIS.ponder && !!snapshot && !!account,
    }),
}
