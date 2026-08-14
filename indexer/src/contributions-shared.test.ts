/**
 * Unit tests for the contributions derive glue (src/contributions-shared.ts) against the frozen
 * golden vectors (test/golden/contributions.json — the M1 fixture oracle shared by every lane).
 * The scoring itself is the golden-locked `frontend/lib/contributions` port; what's under test
 * here is the indexer's glue: fold-log rows → RawEdge stream, params sidecar → ContributionsParams
 * (hash-checked), and the score/audit row derivation the API serves.
 *
 * Run: npm run test (node --test).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { toHex } from 'viem'

import {
  type ContributionsParamsFile,
  type FoldRow,
  applyDiscountStatus,
  contributionsParamsHash,
  deriveAudit,
  deriveScores,
  paramsSnapshot,
  parseParamsFile,
  parseParamsSnapshot,
  rowsToRawEdges,
} from './contributions-shared'
import * as contributionsLibNs from '../../frontend/lib/contributions'
import { type ContributionsParams } from '../../frontend/lib/contributions'
import * as encodeNs from '../../frontend/lib/pagerank/encode'

// CJS/ESM interop (see the note in contributions-shared.ts).
const { computeContributions } = ((contributionsLibNs as any).default ??
  contributionsLibNs) as typeof contributionsLibNs
const { accumulate } = ((encodeNs as any).default ??
  encodeNs) as typeof encodeNs

const dirname = path.dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(
  readFileSync(
    path.join(dirname, '../../test/golden/contributions.json'),
    'utf8'
  )
)

/** The golden compute family's params (camelCase decimal strings) → the TS port's params. */
const goldenParams = (p: any): ContributionsParams => ({
  dampingFp: BigInt(p.dampingFp),
  toleranceFp: BigInt(p.toleranceFp),
  maxIterations: p.maxIterations,
  minWeightFp: BigInt(p.minWeightFp),
  maxWeightFp: BigInt(p.maxWeightFp),
  trustMultiplierFp: BigInt(p.trustMultiplierFp),
  trustShareFp: BigInt(p.trustShareFp),
  trustDecayFp: BigInt(p.trustDecayFp),
  trustedSeeds: p.trustedSeeds,
  precisionScale: BigInt(p.precisionScale),
  weightFieldIndex: p.weightFieldIndex,
  roundStart: BigInt(p.roundStart),
  roundEnd: BigInt(p.roundEnd),
  unacceptedMultFp: BigInt(p.unacceptedMultFp),
  collaboratorMultFp: BigInt(p.collaboratorMultFp),
  minRaterRepFp: BigInt(p.minRaterRepFp),
  evaluatorCarveoutBps: p.evaluatorCarveoutBps,
  totalPool: BigInt(p.totalPool),
  claimSchemaUid: p.claimSchemaUid,
  responseSchemaUid: p.responseSchemaUid,
  valuationSchemaUid: p.valuationSchemaUid,
})

/** Golden records/trustEdges → the indexed fold-log row shape (fold order preserved). */
const goldenRows = (records: any[]): FoldRow[] =>
  records.map((r) => ({
    kind: r.kind,
    attester: r.attester,
    recipient: r.recipient,
    uid: r.uid,
    data: r.data,
    blockTimestamp: BigInt(r.blockTimestamp),
  }))

/** The prover's snake_case-hex sidecar built from the same params. */
const sidecarOf = (p: ContributionsParams): ContributionsParamsFile => ({
  damping_fp: toHex(p.dampingFp),
  tolerance_fp: toHex(p.toleranceFp),
  max_iterations: p.maxIterations,
  min_weight_fp: toHex(p.minWeightFp),
  max_weight_fp: toHex(p.maxWeightFp),
  trust_multiplier_fp: toHex(p.trustMultiplierFp),
  trust_share_fp: toHex(p.trustShareFp),
  trust_decay_fp: toHex(p.trustDecayFp),
  trusted_seeds: p.trustedSeeds,
  precision_scale: toHex(p.precisionScale),
  weight_field_index: p.weightFieldIndex,
  round_start: toHex(p.roundStart),
  round_end: toHex(p.roundEnd),
  unaccepted_mult_fp: toHex(p.unacceptedMultFp),
  collaborator_mult_fp: toHex(p.collaboratorMultFp),
  min_rater_rep_fp: toHex(p.minRaterRepFp),
  evaluator_carveout_bps: p.evaluatorCarveoutBps,
  total_pool: toHex(p.totalPool),
  claim_schema_uid: p.claimSchemaUid,
  response_schema_uid: p.responseSchemaUid,
  valuation_schema_uid: p.valuationSchemaUid,
})

const params = goldenParams(golden.compute.input.params)
const trustEdges = rowsToRawEdges(goldenRows(golden.compute.input.trustEdges))
const records = rowsToRawEdges(goldenRows(golden.compute.input.records))
const result = computeContributions({ trustEdges, records, params })

test('params sidecar (snake_case hex) parses to the identical paramsHash', () => {
  const parsed = parseParamsFile(sidecarOf(params))
  assert.deepEqual(parsed, params)
  assert.equal(
    contributionsParamsHash(parsed),
    golden.compute.journal.paramsHash
  )
})

test('on-chain controller snapshot round-trips to the identical paramsHash', () => {
  const parsed = parseParamsSnapshot(paramsSnapshot(params))
  assert.deepEqual(parsed, params)
  assert.equal(
    contributionsParamsHash(parsed),
    golden.compute.journal.paramsHash
  )
})

test('fold-log rows refold to the golden accumulator checkpoints', () => {
  const trust = accumulate(trustEdges)
  const contrib = accumulate(records)
  assert.equal(trust.acc, golden.compute.journal.acc)
  assert.equal(
    trust.leafCount.toString(),
    String(golden.compute.journal.leafCount)
  )
  assert.equal(contrib.acc, golden.compute.journal.anchorAcc)
  assert.equal(
    contrib.leafCount.toString(),
    String(golden.compute.journal.anchorCount)
  )
})

test('the recompute over fold-log rows reproduces the golden journal + payouts', () => {
  assert.equal(result.journal.outputRoot, golden.compute.journal.outputRoot)
  assert.equal(result.journal.ipfsHash, golden.compute.journal.ipfsHash)
  assert.equal(
    result.journal.totalValue.toString(),
    golden.compute.journal.totalValue
  )
  assert.equal(result.cid, golden.compute.cid)
  assert.deepEqual(
    result.scores.map(([account, value]) => ({
      account,
      value: value.toString(),
    })),
    golden.compute.payouts
  )
})

test('deriveScores serves exactly the golden per-claim S(c) values', () => {
  const scores = deriveScores(result, params)
  assert.deepEqual(
    scores.map((s) => ({
      claimUid: s.claimUid,
      scoreFp: s.scoreFp.toString(),
    })),
    golden.compute.claimScores
  )
  // Every breakdown row's weight is consistent: nonzero consent implies attribution > 0, and a
  // zero consent (rejected share) zeroes the weight.
  for (const s of scores) {
    for (const b of s.contributors) {
      if (b.consentFp === '0') assert.equal(b.weightFp, '0')
      assert.ok(BigInt(b.share) > 0n)
    }
  }
})

test('deriveAudit partitions every live valuation with guest-identical verdicts', () => {
  const audit = applyDiscountStatus(deriveAudit(result), params)
  // One row per live valuation.
  assert.equal(audit.length, result.liveState.valuations.size)
  // Partition sizes match the eligibility result exactly.
  const filtered = audit.filter((a) => a.status === 'filtered')
  const counted = audit.filter((a) => a.status !== 'filtered')
  assert.equal(filtered.length, result.eligibility.skipped.length)
  assert.equal(counted.length, result.eligibility.eligible.length)
  // Skip reasons are only the two frozen ones; discounted rows carry the collaborator multiplier.
  for (const a of filtered) {
    assert.ok(a.reason === 'selfValuation' || a.reason === 'belowMinRep')
    assert.equal(a.discountFp, null)
  }
  for (const a of counted) {
    assert.equal(a.reason, null)
    if (a.status === 'discounted') {
      assert.equal(a.discountFp, params.collaboratorMultFp)
    } else {
      assert.equal(a.discountFp, params.precisionScale)
    }
  }
  // The fixture exercises both filters and the discount (the M1 worked example includes a
  // self-valuation and a collaborator pair) — guard against a silently-empty audit.
  assert.ok(filtered.length > 0)
  assert.ok(audit.some((a) => a.status === 'discounted'))
})

test('a truncated fold log no longer reproduces the checkpoint (the refuse path)', () => {
  const truncated = records.slice(0, records.length - 1)
  const fold = accumulate(truncated)
  assert.notEqual(fold.acc, golden.compute.journal.anchorAcc)
})

// The FoldRow → RawEdge conversion is 1:1 (no reordering, no field remapping surprises).
test('rowsToRawEdges preserves order and fields', () => {
  const rows = goldenRows(golden.compute.input.records)
  const edges = rowsToRawEdges(rows)
  assert.equal(edges.length, rows.length)
  edges.forEach((e, i) => {
    const row = rows[i]!
    assert.equal(e.uid, row.uid)
    assert.equal(e.kind, row.kind)
    assert.equal(e.blockTimestamp, row.blockTimestamp)
    assert.equal(e.data, row.data)
  })
})
