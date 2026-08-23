/**
 * Contributions program — pure derivation logic shared by the Ponder handlers
 * (src/contributions.ts), the API routes (src/api/contributions.ts), and the unit tests. No
 * ponder/DB imports: everything here is deterministic data → data, built on the SAME TS port the
 * frontend recomputes with (`packages/frontend/lib/contributions` — the fourth parity leg, golden-locked
 * against `tests/golden/contributions.json`). The indexer never re-implements scoring; it feeds
 * this module its indexed fold-log rows and validates the result against the proven root.
 */
import { type Hex } from 'viem'

import * as contributionsLibNs from '../../frontend/lib/contributions'
import {
  type ContributionsParams,
  type ContributionsResult,
} from '../../frontend/lib/contributions'
import * as fixedNs from '../../frontend/lib/pagerank/fixed'
import { type RawEdge } from '../../frontend/lib/pagerank/types'

// The frontend lib is consumed two ways: bundled as ESM by Ponder's dev server, and loaded as CJS
// by `node --import tsx --test` (the frontend package is not `"type": "module"`), where the named
// exports land on `default`. Normalize once so both loaders see the same surface.
const contributionsLib = ((contributionsLibNs as any).default ??
  contributionsLibNs) as typeof contributionsLibNs
const { consentMultFp, paramsHash } = contributionsLib
const { fpMul, mulDiv } = ((fixedNs as any).default ??
  fixedNs) as typeof fixedNs

// Instance discovery used to live here as a build-time CONTRIBUTIONS_INSTANCES import from
// deployment_summary.json. It is now the `contributions_instance` DB table, populated from
// `ContributionsFactory.ContributionsInstanceCreated` (src/contributions-factory.ts) and served
// by GET /contributions/instances — rounds appear with no config edit and no restart.

/**
 * One fold-log row (the `accumulator_record` table's shape, minus provenance columns) — exactly a
 * `RawEdge` plus its chain position. Ordering by (blockNumber, logIndex) is fold order.
 */
export interface FoldRow {
  kind: number
  attester: Hex
  recipient: Hex
  uid: Hex
  data: Hex
  blockTimestamp: bigint
}

/** Convert fold-log rows (already in fold order) into the guest's `RawEdge` stream. */
export const rowsToRawEdges = (rows: FoldRow[]): RawEdge[] =>
  rows.map((r) => ({
    kind: r.kind,
    attester: r.attester,
    recipient: r.recipient,
    uid: r.uid,
    blockTimestamp: r.blockTimestamp,
    data: r.data,
  }))

/**
 * The prover's params sidecar (`params.contributions.json` — serialized
 * `contributions_core::Params`): snake_case keys, U256/u64 fields as hex strings, u32 fields as
 * numbers. This file is AVAILABILITY, not truth: the parsed params are only trusted after their
 * `paramsHash` reproduces the hash pinned on the contributions `MerkleSnapshot`.
 */
export interface ContributionsParamsFile {
  damping_fp: string
  tolerance_fp: string
  max_iterations: number
  min_weight_fp: string
  max_weight_fp: string
  trust_share_fp: string
  trust_decay_fp: string
  trusted_seeds: string[]
  precision_scale: string
  weight_field_index: number
  round_start: string
  round_end: string
  unaccepted_mult_fp: string
  collaborator_mult_fp: string
  min_rater_rep_fp: string
  evaluator_carveout_bps: number
  total_pool: string
  claim_schema_uid: string
  response_schema_uid: string
  valuation_schema_uid: string
}

/** Parse the sidecar into the TS port's `ContributionsParams`. Throws on a malformed file. */
export const parseParamsFile = (
  f: ContributionsParamsFile
): ContributionsParams => ({
  dampingFp: BigInt(f.damping_fp),
  toleranceFp: BigInt(f.tolerance_fp),
  maxIterations: f.max_iterations,
  minWeightFp: BigInt(f.min_weight_fp),
  maxWeightFp: BigInt(f.max_weight_fp),
  trustShareFp: BigInt(f.trust_share_fp),
  trustDecayFp: BigInt(f.trust_decay_fp),
  trustedSeeds: f.trusted_seeds.map((s) => s as Hex),
  precisionScale: BigInt(f.precision_scale),
  weightFieldIndex: f.weight_field_index,
  roundStart: BigInt(f.round_start),
  roundEnd: BigInt(f.round_end),
  unacceptedMultFp: BigInt(f.unaccepted_mult_fp),
  collaboratorMultFp: BigInt(f.collaborator_mult_fp),
  minRaterRepFp: BigInt(f.min_rater_rep_fp),
  evaluatorCarveoutBps: f.evaluator_carveout_bps,
  totalPool: BigInt(f.total_pool),
  claimSchemaUid: f.claim_schema_uid as Hex,
  responseSchemaUid: f.response_schema_uid as Hex,
  valuationSchemaUid: f.valuation_schema_uid as Hex,
})

/** Restore the JSON-safe controller-event snapshot stored by the indexer. */
export const parseParamsSnapshot = (
  value: Record<string, unknown>
): ContributionsParams => ({
  dampingFp: BigInt(value.dampingFp as string),
  toleranceFp: BigInt(value.toleranceFp as string),
  maxIterations: Number(value.maxIterations),
  minWeightFp: BigInt(value.minWeightFp as string),
  maxWeightFp: BigInt(value.maxWeightFp as string),
  trustShareFp: BigInt(value.trustShareFp as string),
  trustDecayFp: BigInt(value.trustDecayFp as string),
  trustedSeeds: value.trustedSeeds as Hex[],
  precisionScale: BigInt(value.precisionScale as string),
  weightFieldIndex: Number(value.weightFieldIndex),
  roundStart: BigInt(value.roundStart as string),
  roundEnd: BigInt(value.roundEnd as string),
  unacceptedMultFp: BigInt(value.unacceptedMultFp as string),
  collaboratorMultFp: BigInt(value.collaboratorMultFp as string),
  minRaterRepFp: BigInt(value.minRaterRepFp as string),
  evaluatorCarveoutBps: Number(value.evaluatorCarveoutBps),
  totalPool: BigInt(value.totalPool as string),
  claimSchemaUid: value.claimSchemaUid as Hex,
  responseSchemaUid: value.responseSchemaUid as Hex,
  valuationSchemaUid: value.valuationSchemaUid as Hex,
})

/** Normalize viem's named Solidity tuple into the canonical TS params type. */
export const normalizeOnchainContributionsParams = (
  p: Omit<ContributionsParams, 'trustedSeeds'> & {
    trustedSeeds: readonly Hex[]
  }
): ContributionsParams => ({
  ...p,
  trustedSeeds: [...p.trustedSeeds],
})

/** The 21-word paramsHash of parsed params (re-export for the sidecar-vs-chain check). */
export const contributionsParamsHash = (p: ContributionsParams): Hex =>
  paramsHash(p)

/**
 * A JSON-safe snapshot of validated params for the round-metadata row (bigints as decimal
 * strings, camelCase — the shape the /contributions round-summary API serves).
 */
export const paramsSnapshot = (
  p: ContributionsParams
): Record<string, unknown> => ({
  dampingFp: p.dampingFp.toString(),
  toleranceFp: p.toleranceFp.toString(),
  maxIterations: p.maxIterations,
  minWeightFp: p.minWeightFp.toString(),
  maxWeightFp: p.maxWeightFp.toString(),
  trustShareFp: p.trustShareFp.toString(),
  trustDecayFp: p.trustDecayFp.toString(),
  trustedSeeds: p.trustedSeeds,
  precisionScale: p.precisionScale.toString(),
  weightFieldIndex: p.weightFieldIndex,
  roundStart: p.roundStart.toString(),
  roundEnd: p.roundEnd.toString(),
  unacceptedMultFp: p.unacceptedMultFp.toString(),
  collaboratorMultFp: p.collaboratorMultFp.toString(),
  minRaterRepFp: p.minRaterRepFp.toString(),
  evaluatorCarveoutBps: p.evaluatorCarveoutBps,
  totalPool: p.totalPool.toString(),
  claimSchemaUid: p.claimSchemaUid,
  responseSchemaUid: p.responseSchemaUid,
  valuationSchemaUid: p.valuationSchemaUid,
})

/** One `contribution_score` row's worth of derived data. */
export interface DerivedScore {
  claimUid: string
  scoreFp: bigint
  contributors: {
    contributor: string
    share: string
    attribFp: string
    consentFp: string
    weightFp: string
  }[]
}

/**
 * Per-claim S(c) + per-contributor breakdown from a verified compute result. The breakdown
 * re-walks stage 2's P(a) accumulation per claim (attribution share × consent multiplier) with
 * the exact fixed-point helpers, so the displayed weights sum to the claim's contribution to
 * P(a) — never an alternative formula.
 */
export const deriveScores = (
  result: ContributionsResult,
  p: ContributionsParams
): DerivedScore[] => {
  const s = p.precisionScale
  const out: DerivedScore[] = []
  for (const [uid, scoreFp] of result.claimScores) {
    const claim = result.liveState.claims.get(uid)
    if (claim === undefined) continue
    const contributors = Array.from(claim.shares.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([contributor, share]) => {
        const attribFp = mulDiv(share, s, claim.totalShares)
        const consentFp = consentMultFp(
          result.liveState,
          claim,
          contributor as Hex,
          p
        )
        const weightFp = fpMul(fpMul(scoreFp, attribFp, s), consentFp, s)
        return {
          contributor,
          share: share.toString(),
          attribFp: attribFp.toString(),
          consentFp: consentFp.toString(),
          weightFp: weightFp.toString(),
        }
      })
    out.push({ claimUid: uid, scoreFp, contributors })
  }
  out.sort((a, b) => (a.claimUid < b.claimUid ? -1 : 1))
  return out
}

/** One `contribution_valuation_audit` row's worth of derived data. */
export interface DerivedAudit {
  claimUid: string
  rater: string
  score: number
  status: 'counted' | 'discounted' | 'filtered'
  reason: 'selfValuation' | 'belowMinRep' | null
  discountFp: bigint | null
  raterRepFp: bigint
}

/**
 * The audit partition of every live valuation: counted / discounted / filtered, straight from the
 * guest-identical eligibility result (never re-derived policy).
 */
export const deriveAudit = (result: ContributionsResult): DerivedAudit[] => {
  const rep = result.reputation
  const rows: DerivedAudit[] = []
  for (const v of result.eligibility.eligible) {
    const rater = v.rater.toLowerCase()
    rows.push({
      claimUid: v.claimUid.toLowerCase(),
      rater,
      score: v.score,
      status: 'counted',
      reason: null,
      discountFp: v.discountFp,
      raterRepFp: rep.get(rater) ?? 0n,
    })
  }
  for (const v of result.eligibility.skipped) {
    const rater = v.rater.toLowerCase()
    rows.push({
      claimUid: v.claimUid.toLowerCase(),
      rater,
      score:
        result.liveState.valuations.get(
          `${v.claimUid.toLowerCase()}|${rater}`
        ) ?? 0,
      status: 'filtered',
      reason: v.reason,
      discountFp: null,
      raterRepFp: rep.get(rater) ?? 0n,
    })
  }
  return rows
}

/**
 * Mark eligible rows whose discount is not the full precisionScale as 'discounted' (the
 * collaborator rule applied). Split out so `deriveAudit` stays a pure partition of the
 * eligibility result.
 */
export const applyDiscountStatus = (
  rows: DerivedAudit[],
  p: ContributionsParams
): DerivedAudit[] =>
  rows.map((r) =>
    r.status === 'counted' &&
    r.discountFp !== null &&
    r.discountFp !== p.precisionScale
      ? { ...r, status: 'discounted' as const }
      : r
  )
