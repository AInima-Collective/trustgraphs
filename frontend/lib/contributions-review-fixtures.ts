//! Deterministic review-only data for the contributions screenshot harness.
//!
//! Enabled only by NEXT_PUBLIC_TG_REVIEW_FIXTURES=1. The harness selects a
//! phase and connected-wallet persona in localStorage before application code
//! runs, so a single production build can cover the entire review matrix.

import { Hex, encodeAbiParameters, zeroAddress, zeroHash } from 'viem'

import type { ContributionsParams } from './contributions'
import type {
  ContributionsClaimsResponse,
  ContributionsPayout,
  ContributionsRound,
  ContributionsScoreDetail,
} from './contributions-api'
import {
  REVIEW_ACCOUNTS,
  REVIEW_PERSONA_STORAGE_KEY,
  getReviewPersona,
  getReviewWalletAccount,
} from './review-wallet-fixture'

export {
  REVIEW_ACCOUNTS,
  REVIEW_PERSONAS,
  getReviewPersona,
  getReviewWalletAccount,
} from './review-wallet-fixture'
export type { ReviewPersona } from './review-wallet-fixture'

export const REVIEW_PHASES = [
  'upcoming',
  'open-empty',
  'open-with-claims',
  'settling',
  'claimable',
  'indexer-down',
] as const
export type ReviewPhase = (typeof REVIEW_PHASES)[number]

export const REVIEW_STORAGE = {
  persona: REVIEW_PERSONA_STORAGE_KEY,
  phase: 'tg-review-phase',
} as const

const MAKER = '0x4000000000000000000000000000000000000004' as Hex
const BUILDER = '0x5000000000000000000000000000000000000005' as Hex
const FUNDER = '0x6000000000000000000000000000000000000006' as Hex
const TRUST_SEED = '0x7000000000000000000000000000000000000007' as Hex
const DISTRIBUTOR = '0x26Abd1EFaAE385Ab1036b10b2c4F2598d714EDEB' as Hex
const CONTRIBUTION_RESOLVER =
  '0x1342547eb8549Ac818E4Aa8717FF1d84e1e9F5c0' as Hex
const SNAPSHOT = '0x153362E7fbb00c4eCf2159d9174c6ac370D51403' as Hex
const TOKEN = '0x69Ac6589e1FC9B46671B0D7f5e5860A3f3027eFA' as Hex

export const REVIEW_ROOT = `0x${'11'.repeat(32)}` as Hex
const IPFS_HASH = `0x${'22'.repeat(32)}` as Hex
const CONTENT_A = `0x${'a1'.repeat(32)}` as Hex
const CONTENT_B = `0x${'b2'.repeat(32)}` as Hex
const CLAIM_A = `0x${'aa'.repeat(32)}` as Hex
const CLAIM_B = `0x${'bb'.repeat(32)}` as Hex

const CLAIM_SCHEMA =
  '0x24f1bac4cefd3ceca88b2c990ebaf7470a56d8b1b6d9a80f6ba23726384782d0' as Hex
const VALUATION_SCHEMA =
  '0x5f2fc0262768b446191445c6c30a43ec5b2ed505c0a3777909ddd1454231ed2a' as Hex
const RESPONSE_SCHEMA = `0x${'3c'.repeat(32)}` as Hex

const asSelection = <T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T
): T => (allowed.includes(value as T) ? (value as T) : fallback)

export const getReviewPhase = (): ReviewPhase => {
  const stored =
    typeof window === 'undefined'
      ? undefined
      : window.localStorage.getItem(REVIEW_STORAGE.phase)
  return asSelection(
    stored ?? process.env.NEXT_PUBLIC_TG_REVIEW_PHASE,
    REVIEW_PHASES,
    'open-with-claims'
  )
}

const hasClaims = (phase: ReviewPhase) =>
  !['upcoming', 'open-empty'].includes(phase)

const claimData = (
  title: string,
  contentHash: Hex,
  uri: string,
  contributors: Hex[],
  shares: number[]
) =>
  encodeAbiParameters(
    [
      { type: 'string' },
      { type: 'bytes32' },
      { type: 'string' },
      { type: 'address[]' },
      { type: 'uint32[]' },
    ],
    [title, contentHash, uri, contributors, shares]
  )

const valuationData = (claimUid: Hex, score: number) =>
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint8' }],
    [claimUid, score]
  )

const trustData = encodeAbiParameters(
  [{ type: 'string' }, { type: 'uint256' }],
  ['review fixture trust', 100n]
)

const record = (
  id: string,
  kind: number,
  attester: Hex,
  uid: Hex,
  schema: Hex,
  data: Hex,
  blockTimestamp: bigint,
  logIndex: number
) => ({
  id,
  accumulator: CONTRIBUTION_RESOLVER,
  kind,
  attester,
  recipient: zeroAddress,
  uid,
  schema,
  data,
  blockTimestamp,
  blockNumber: 101n + BigInt(logIndex),
  logIndex,
  txHash: `0x${String(logIndex + 1).padStart(64, '0')}` as Hex,
})

const RECORDS = [
  record(
    'review-claim-a',
    0,
    MAKER,
    CLAIM_A,
    CLAIM_SCHEMA,
    claimData(
      'Member onboarding field guide',
      CONTENT_A,
      'https://example.org/demo-co-op/onboarding-guide',
      [MAKER, REVIEW_ACCOUNTS.nominee],
      [60, 40]
    ),
    1_781_000_000n,
    0
  ),
  record(
    'review-claim-b',
    0,
    BUILDER,
    CLAIM_B,
    CLAIM_SCHEMA,
    claimData(
      'Treasury reporting dashboard',
      CONTENT_B,
      'https://example.org/demo-co-op/treasury-dashboard',
      [BUILDER],
      [100]
    ),
    1_782_000_000n,
    1
  ),
  record(
    'review-rating-a',
    4,
    REVIEW_ACCOUNTS.rater,
    `0x${'ca'.repeat(32)}` as Hex,
    VALUATION_SCHEMA,
    valuationData(CLAIM_A, 92),
    1_783_000_000n,
    2
  ),
  record(
    'review-rating-b',
    4,
    REVIEW_ACCOUNTS.rater,
    `0x${'cb'.repeat(32)}` as Hex,
    VALUATION_SCHEMA,
    valuationData(CLAIM_B, 68),
    1_783_000_100n,
    3
  ),
] as const

const TRUST_RECORDS = [
  {
    ...record(
      'review-trust-rater',
      0,
      TRUST_SEED,
      `0x${'d1'.repeat(32)}` as Hex,
      zeroHash,
      trustData,
      1_780_000_000n,
      0
    ),
    accumulator: '0x8000000000000000000000000000000000000008' as Hex,
    recipient: REVIEW_ACCOUNTS.rater,
  },
] as const

const SCORED_CLAIMS: ContributionsClaimsResponse = {
  snapshot: SNAPSHOT,
  claims: [
    {
      claimUid: CLAIM_A,
      attester: MAKER,
      title: 'Member onboarding field guide',
      uri: 'https://example.org/demo-co-op/onboarding-guide',
      contentHash: CONTENT_A,
      timestamp: '1781000000',
      revoked: false,
      score: '575000000000000000',
      contributors: [
        { account: MAKER, share: '60', response: 'none' },
        {
          account: REVIEW_ACCOUNTS.nominee,
          share: '40',
          response: 'none',
        },
      ],
    },
    {
      claimUid: CLAIM_B,
      attester: BUILDER,
      title: 'Treasury reporting dashboard',
      uri: 'https://example.org/demo-co-op/treasury-dashboard',
      contentHash: CONTENT_B,
      timestamp: '1782000000',
      revoked: false,
      score: '425000000000000000',
      contributors: [{ account: BUILDER, share: '100', response: 'none' }],
    },
  ],
}

const round = (
  status: ContributionsRound['status'],
  start: string,
  end: string,
  root: Hex | null
): ContributionsRound => ({
  window: { start, end },
  pool: '1000000000',
  token: TOKEN,
  root,
  cid: root ? 'bafyreviewcontributionsfixture' : null,
  status,
  params: {
    dampingFp: 850_000_000_000_000_000n,
    toleranceFp: 1_000_000_000n,
    maxIterations: 100,
    minWeightFp: 0n,
    maxWeightFp: 100_000_000_000_000_000_000n,
    trustMultiplierFp: 3_000_000_000_000_000_000n,
    trustShareFp: 1_000_000_000_000_000_000n,
    trustDecayFp: 800_000_000_000_000_000n,
    trustedSeeds: [TRUST_SEED],
    precisionScale: 1_000_000_000_000_000_000n,
    weightFieldIndex: 1,
    roundStart: BigInt(start),
    roundEnd: BigInt(end),
    unacceptedMultFp: 500_000_000_000_000_000n,
    collaboratorMultFp: 500_000_000_000_000_000n,
    minRaterRepFp: 0n,
    evaluatorCarveoutBps: 100,
    totalPool: 1_000_000_000n,
    claimSchemaUid: CLAIM_SCHEMA,
    responseSchemaUid: RESPONSE_SCHEMA,
    valuationSchemaUid: VALUATION_SCHEMA,
  } satisfies ContributionsParams,
})

export const getReviewRound = (): ContributionsRound | null => {
  switch (getReviewPhase()) {
    case 'upcoming':
      return round('upcoming', '1810000000', '1830000000', null)
    case 'open-empty':
      return round('open', '1780000000', '1800000000', null)
    case 'open-with-claims':
      return round('open', '1780000000', '1800000000', REVIEW_ROOT)
    case 'settling':
    case 'claimable':
      return round('closed', '1760000000', '1784000000', REVIEW_ROOT)
    case 'indexer-down':
      return null
  }
}

export const getReviewClaims = (): ContributionsClaimsResponse | null => {
  const phase = getReviewPhase()
  if (phase === 'indexer-down') return null
  if (!hasClaims(phase)) return { snapshot: SNAPSHOT, claims: [] }
  return SCORED_CLAIMS
}

export const getReviewScore = (
  claimUid: string
): ContributionsScoreDetail | null => {
  if (getReviewPhase() === 'indexer-down') return null
  const claim = SCORED_CLAIMS.claims.find(
    (candidate) => candidate.claimUid.toLowerCase() === claimUid.toLowerCase()
  )
  if (!claim?.score) return null
  return {
    claimUid: claim.claimUid,
    score: claim.score,
    valuations:
      claim.claimUid === CLAIM_A
        ? [{ rater: REVIEW_ACCOUNTS.rater, score: 92, counted: true }]
        : [{ rater: REVIEW_ACCOUNTS.rater, score: 68, counted: true }],
  }
}

const payoutValue = (persona = getReviewPersona()) =>
  persona === 'nominee' ? '412' : persona === 'rater' ? '188' : '0'

export const getReviewPayout = (): ContributionsPayout | null => {
  if (getReviewPhase() === 'indexer-down') return null
  return {
    account: getReviewWalletAccount(),
    value: payoutValue(),
    proof: payoutValue() === '0' ? [] : [`0x${'33'.repeat(32)}`],
  }
}

export const getReviewMerkleEntry = () => {
  const value = payoutValue()
  return value === '0'
    ? null
    : { value, proof: [`0x${'33'.repeat(32)}`] as Hex[] }
}

export const getReviewAttestations = () =>
  hasClaims(getReviewPhase()) ? [...RECORDS] : []

export const getReviewTrustAttestations = () => [...TRUST_RECORDS]

export const getReviewDistributions = () => {
  const phase = getReviewPhase()
  if (phase !== 'claimable' && phase !== 'indexer-down') return []
  return [
    {
      id: 0n,
      merkleFundDistributor: DISTRIBUTOR,
      blockNumber: 200n,
      timestamp: 1_784_000_100n,
      root: REVIEW_ROOT,
      ipfsHash: IPFS_HASH,
      ipfsHashCid: 'bafyreviewcontributionsfixture',
      totalMerkleValue: 1000n,
      distributor: FUNDER,
      token: TOKEN,
      amountFunded: 1_000_000_000n,
      amountDistributed: 0n,
      feeRecipient: FUNDER,
      feeAmount: 0n,
      claimDeadline: 0n,
      sweptAmount: 0n,
      sweptTo: null,
      sweptAt: null,
    },
  ]
}

export const getReviewDistributionClaims = () => []

export const getReviewLatestSnapshot = () => {
  const phase = getReviewPhase()
  if (!['settling', 'claimable', 'indexer-down'].includes(phase)) return null
  return {
    id: 'review-snapshot',
    address: SNAPSHOT,
    chainId: '31337',
    root: REVIEW_ROOT,
    ipfsHash: IPFS_HASH,
    ipfsHashCid: 'bafyreviewcontributionsfixture',
    totalValue: 1000n,
    blockNumber: 200n,
    timestamp: 1_784_000_000n,
  }
}

export const getReviewFundDistributor = () => ({
  address: DISTRIBUTOR,
  chainId: '31337',
  paused: false,
  merkleSnapshot: SNAPSHOT,
  owner: FUNDER,
  pendingOwner: zeroAddress,
  feeRecipient: FUNDER,
  feePercentage: '0',
  allowlistEnabled: false,
  allowlist: [] as Hex[],
})

// A fixture root intentionally never fabricates a proof for a different root.
export const isReviewRoot = (root: string | undefined) =>
  !!root && root.toLowerCase() === REVIEW_ROOT.toLowerCase()
