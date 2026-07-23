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
//! MOCKS: set NEXT_PUBLIC_CONTRIBUTIONS_MOCKS=1 to serve the clearly-marked fixtures below
//! instead of hitting the network (for driving the screens before the M3 routes are live).
//! Everything mock-related lives between the MOCK markers — delete that block and the
//! `mocksEnabled` branches once M3 is live.

import { queryOptions } from '@tanstack/react-query'

import { APIS } from './config'

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
  status: 'open' | 'closing' | 'settled'
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

// =============================== MOCK FIXTURES (delete with M3) ===============================
// These fixtures exist ONLY so the screens can be driven before the M3 indexer routes are live.
// They are served exclusively when NEXT_PUBLIC_CONTRIBUTIONS_MOCKS=1.

const mocksEnabled = () => process.env.NEXT_PUBLIC_CONTRIBUTIONS_MOCKS === '1'

const MOCK_ROUND: ContributionsRound = {
  window: { start: '1750000000', end: '1782000000' },
  pool: '1000000000', // 1,000 USDC at 6dp
  token: '0x0000000000000000000000000000000000000000',
  root: null,
  cid: null,
  status: 'open',
}

const MOCK_CLAIMS: ContributionsClaimsResponse = {
  snapshot: 'mock',
  claims: [],
}

const MOCK_PAYOUT: ContributionsPayout = {
  account: '0x0000000000000000000000000000000000000000',
  value: '0',
  proof: [],
}
// ============================== END MOCK FIXTURES =============================================

const get = async <T>(path: string): Promise<T | null> => {
  const response = await fetch(`${APIS.ponder}${path}`)
  if (response.ok) {
    return (await response.json()) as T
  }
  if (response.status === 404) {
    // Route not wired / nothing indexed yet.
    return null
  }
  throw new Error(
    `Failed to fetch ${path}: ${response.status} ${response.statusText} (${await response.text()})`
  )
}

export const fetchContributionsRound = async (
  snapshot: string
): Promise<ContributionsRound | null> => {
  if (mocksEnabled()) return MOCK_ROUND
  return await get<ContributionsRound>(`/contributions/${snapshot}/round`)
}

export const fetchContributionsClaims = async (
  snapshot: string
): Promise<ContributionsClaimsResponse | null> => {
  if (mocksEnabled()) return MOCK_CLAIMS
  return await get<ContributionsClaimsResponse>(
    `/contributions/${snapshot}/claims`
  )
}

export const fetchContributionsScore = async (
  snapshot: string,
  claimUid: string
): Promise<ContributionsScoreDetail | null> => {
  if (mocksEnabled()) return null
  return await get<ContributionsScoreDetail>(
    `/contributions/${snapshot}/score/${claimUid}`
  )
}

export const fetchContributionsPayout = async (
  snapshot: string,
  account: string
): Promise<ContributionsPayout | null> => {
  if (mocksEnabled()) return MOCK_PAYOUT
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
