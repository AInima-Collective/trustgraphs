/**
 * Golden-vector reproduction test for the contributions program's TS port — the FOURTH parity
 * leg (Rust crate ⟷ Solidity ⟷ SP1 guest ⟷ TS), per research/operations/contributions/interfaces.md §6.
 *
 * Loads `tests/golden/contributions.json` (written by `cargo run -p contributions-core --example
 * export_golden`) and asserts byte-identity for:
 *  - the `params` family (21-word paramsHash + seedSetRoot);
 *  - the `kinds` table (kind = schemaIndex * 2 + isRevoke, plus inverses);
 *  - the accumulator `leaf` sample (dataHash, leaf ABI, fold);
 *  - the `blob` sample (canonical blob string, hex, sha256 ipfsHash, CIDv1);
 *  - the `compute` family: EVERYTHING recomputed from `.compute.input` (trust edges +
 *    records + params) — stage-1 reputation, claim scores, payouts, blob, cid, and every
 *    journal field + `encoded` + `digest`.
 *
 * Run via `pnpm test` (compiled with the pagerank + hypercerts suites).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { type Hex, keccak256, stringToHex } from 'viem'

import { computeContributions, journalDigest, journalEncoded } from './compute'
import { isRevoke, kindTag, schemaIndex } from './kind'
import { contributionsSeedSetRoot, paramsHash } from './params'
import { type ContributionsParams } from './types'
import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from '../pagerank/cid'
import { accumulate, edgeLeaf, fold } from '../pagerank/encode'
import { type RawEdge } from '../pagerank/types'

// ---- load the exported golden vectors ---------------------------------------

const g = JSON.parse(readFileSync('../../tests/golden/contributions.json', 'utf8'))

/* eslint-disable @typescript-eslint/no-explicit-any */
const toParams = (p: any): ContributionsParams => ({
  dampingFp: BigInt(p.dampingFp),
  toleranceFp: BigInt(p.toleranceFp),
  maxIterations: Number(p.maxIterations),
  minWeightFp: BigInt(p.minWeightFp),
  maxWeightFp: BigInt(p.maxWeightFp),
  trustShareFp: BigInt(p.trustShareFp),
  trustDecayFp: BigInt(p.trustDecayFp),
  trustedSeeds: p.trustedSeeds as Hex[],
  precisionScale: BigInt(p.precisionScale),
  weightFieldIndex: Number(p.weightFieldIndex),
  roundStart: BigInt(p.roundStart),
  roundEnd: BigInt(p.roundEnd),
  unacceptedMultFp: BigInt(p.unacceptedMultFp),
  collaboratorMultFp: BigInt(p.collaboratorMultFp),
  minRaterRepFp: BigInt(p.minRaterRepFp),
  evaluatorCarveoutBps: Number(p.evaluatorCarveoutBps),
  totalPool: BigInt(p.totalPool),
  claimSchemaUid: p.claimSchemaUid as Hex,
  responseSchemaUid: p.responseSchemaUid as Hex,
  valuationSchemaUid: p.valuationSchemaUid as Hex,
})

const toEdge = (e: any): RawEdge => ({
  kind: Number(e.kind),
  attester: e.attester as Hex,
  recipient: e.recipient as Hex,
  uid: e.uid as Hex,
  blockTimestamp: BigInt(e.blockTimestamp),
  data: e.data as Hex,
})

// ---- test harness -----------------------------------------------------------

let failures = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  try {
    assert.deepEqual(actual, expected)
    console.log(`  ok   ${name}`)
  } catch {
    failures++
    console.error(
      `  FAIL ${name}\n         expected: ${String(expected)}\n         actual:   ${String(actual)}`
    )
  }
}

console.log(
  'golden-vector reproduction (contributions TS port — fourth parity leg)'
)

// ---- params family: 21-word paramsHash + seedSetRoot ------------------------

const gp = g.params
check(
  'params seedSetRoot',
  contributionsSeedSetRoot(gp.trustedSeeds as Hex[]).toLowerCase(),
  String(gp.seedSetRoot).toLowerCase()
)
check(
  'paramsHash (21 words)',
  paramsHash(toParams(gp)).toLowerCase(),
  String(gp.paramsHash).toLowerCase()
)

// ---- kinds table: kind = schemaIndex * 2 + isRevoke -------------------------

for (const k of g.kinds as Array<{
  kind: number
  schemaIndex: number
  isRevoke: boolean
}>) {
  check(
    `kind formula (schema ${k.schemaIndex}, revoke ${k.isRevoke})`,
    kindTag(k.schemaIndex, k.isRevoke),
    k.kind
  )
  check(`kind ${k.kind} schemaIndex`, schemaIndex(k.kind), k.schemaIndex)
  check(`kind ${k.kind} isRevoke`, isRevoke(k.kind), k.isRevoke)
}

// ---- accumulator leaf sample: dataHash, leaf ABI, fold ----------------------

const gl = g.leaf
const dataHash = keccak256(gl.data as Hex)
check(
  'leaf dataHash',
  dataHash.toLowerCase(),
  String(gl.dataHash).toLowerCase()
)
const leaf = edgeLeaf(
  Number(gl.kind),
  gl.attester as Hex,
  gl.recipient as Hex,
  gl.uid as Hex,
  BigInt(gl.blockTimestamp),
  dataHash
)
check('leaf', leaf.toLowerCase(), String(gl.leaf).toLowerCase())
check(
  'leaf fold',
  fold(gl.prevAcc as Hex, leaf).toLowerCase(),
  String(gl.foldedAcc).toLowerCase()
)

// ---- blob sample: canonical blob + hex + sha256 + CID -----------------------

const gb = g.blob
const blobScores: Array<[Hex, bigint]> = (
  gb.scores as Array<{ account: string; value: string }>
).map((s) => [s.account as Hex, BigInt(s.value)])
const sampleBlob = canonicalBlob(blobScores)
check('blob string', sampleBlob, String(gb.blob))
check(
  'blob hex',
  stringToHex(sampleBlob).toLowerCase(),
  String(gb.blobHex).toLowerCase()
)
const sampleDigest = sha256Utf8(sampleBlob)
check(
  'blob ipfsHash',
  digestToHex(sampleDigest).toLowerCase(),
  String(gb.ipfsHash).toLowerCase()
)
check('blob cid', cidV1Raw(sampleDigest), String(gb.cid))

// ---- compute family: full recompute from `.compute.input` -------------------

console.log('\nfull recompute (trust edges + records + params → journal)')

const gc = g.compute
const input = {
  trustEdges: (gc.input.trustEdges as any[]).map(toEdge),
  records: (gc.input.records as any[]).map(toEdge),
  params: toParams(gc.input.params),
  // The journal-v3 bindings the vectors pin (pass-throughs, not computed).
  binding: {
    recipient: gc.journal.recipient as Hex,
    instanceDomain: gc.journal.instanceDomain as Hex,
  },
}
const result = computeContributions(input)

// Input commitments (both accumulators, recomputed independently too).
const trustAcc = accumulate(input.trustEdges)
check(
  'trust acc (slot A)',
  trustAcc.acc.toLowerCase(),
  String(gc.journal.acc).toLowerCase()
)
check(
  'record acc (slot B)',
  String(result.journal.anchorAcc).toLowerCase(),
  String(gc.journal.anchorAcc).toLowerCase()
)

// Stage-1 reputation, exact per-account fixed-point values.
const gRep = gc.reputation as Array<{ account: string; repFp: string }>
check('reputation size', result.reputation.size, gRep.length)
for (const r of gRep) {
  check(
    `reputation ${r.account}`,
    (result.reputation.get(r.account.toLowerCase()) ?? 0n).toString(),
    r.repFp
  )
}

// Stage-2 claim scores S(c), exact.
const gotClaimScores = Array.from(result.claimScores.entries())
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  .map(([claimUid, scoreFp]) => ({ claimUid, scoreFp: scoreFp.toString() }))
check(
  'claimScores',
  gotClaimScores,
  (gc.claimScores as Array<{ claimUid: string; scoreFp: string }>).map((c) => ({
    claimUid: c.claimUid.toLowerCase(),
    scoreFp: c.scoreFp,
  }))
)

// Quantized payouts, exact.
const gotPayouts = result.scores.map(([account, value]) => ({
  account: account.toLowerCase(),
  value: value.toString(),
}))
check(
  'payouts',
  gotPayouts,
  (gc.payouts as Array<{ account: string; value: string }>).map((s) => ({
    account: s.account.toLowerCase(),
    value: s.value,
  }))
)

// Canonical artifacts.
check('compute blob', result.blob, String(gc.blob))
check('compute cid', result.cid, String(gc.cid))

// Every journal field, then the frozen encoding + digest.
const gj = gc.journal
const rj = result.journal
check('journal acc', String(rj.acc).toLowerCase(), String(gj.acc).toLowerCase())
check('journal leafCount', rj.leafCount.toString(), String(gj.leafCount))
check(
  'journal anchorAcc',
  String(rj.anchorAcc).toLowerCase(),
  String(gj.anchorAcc).toLowerCase()
)
check('journal anchorCount', rj.anchorCount.toString(), String(gj.anchorCount))
check(
  'journal paramsHash',
  String(rj.paramsHash).toLowerCase(),
  String(gj.paramsHash).toLowerCase()
)
check(
  'journal outputRoot',
  String(rj.outputRoot).toLowerCase(),
  String(gj.outputRoot).toLowerCase()
)
check(
  'journal ipfsHash',
  String(rj.ipfsHash).toLowerCase(),
  String(gj.ipfsHash).toLowerCase()
)
check(
  'journal cidDigest',
  String(rj.cidDigest).toLowerCase(),
  String(gj.cidDigest).toLowerCase()
)
check('journal totalValue', rj.totalValue.toString(), String(gj.totalValue))
check(
  'journal skippedDigest',
  String(rj.skippedDigest).toLowerCase(),
  String(gj.skippedDigest).toLowerCase()
)
check(
  'journal encoded',
  journalEncoded(rj).toLowerCase(),
  String(gj.encoded).toLowerCase()
)
check(
  'journal digest',
  journalDigest(rj).toLowerCase(),
  String(gj.digest).toLowerCase()
)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`)
  process.exit(1)
} else {
  console.log('\nAll contributions golden vectors reproduced. PASS')
}
