/**
 * Golden-vector reproduction test for the hypercerts program's TS view — REDUCED TIER.
 *
 * Per MULTI_PROGRAM_PLATFORM §6, the browser does not re-run the full lane-2 pipeline (CAR walk /
 * envelope-1 verification stay server-side). This test locks only the pure-hashing layer the
 * frontend actually recomputes: the 17-word `paramsHash` (incl. its `seedSetRoot`), the unified
 * `node_output_leaf`, and the journal-v2 digest — recomputed from `test/golden/hypercerts.json`
 * with viem primitives and asserted equal to the crate's exported values.
 *
 * Run via `pnpm test` (compiled with the pagerank suite).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { concat, keccak256, toBytes, toHex, type Hex } from 'viem'

// ---- pure-viem hashing helpers ----------------------------------------------

const ZERO: Hex = `0x${'00'.repeat(32)}`
const wordU256 = (x: bigint): Hex => toHex(x, { size: 32 })
const wordU32 = (x: number): Hex => toHex(BigInt(x), { size: 32 })
const wordU64 = (x: bigint): Hex => toHex(x, { size: 32 })

const cmpHex = (a: Hex, b: Hex): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}
const hashPair = (a: Hex, b: Hex): Hex => {
  const [lo, hi] = cmpHex(a, b) <= 0 ? [a, b] : [b, a]
  return keccak256(concat([lo, hi]))
}
/** OZ StandardMerkleTree root over already-computed leaves. */
const ozRoot = (leaves: Hex[]): Hex => {
  if (leaves.length === 0) return ZERO
  const sorted = [...leaves].sort(cmpHex)
  const n = sorted.length
  if (n === 1) return sorted[0]
  const size = 2 * n - 1
  const tree: Hex[] = new Array(size).fill(ZERO)
  for (let i = 0; i < n; i++) tree[size - 1 - i] = sorted[i]
  for (let i = n - 2; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2])
  return tree[0]
}

/** didNodeId = keccak256(utf8(did)) — mirrors `semantics::did_node_id`. */
const didNodeId = (did: string): Hex => keccak256(toBytes(did))

/** seedSetRoot: OZ tree over sorted seed nodeIds, leaf = keccak256(nodeId). */
const seedSetRoot = (dids: string[]): Hex => {
  const ids = dids.map(didNodeId).sort(cmpHex)
  const leaves = ids.map((id) => keccak256(id))
  return ozRoot(leaves)
}

/** node_output_leaf = keccak256(keccak256(nodeId ++ value)). */
const nodeOutputLeaf = (nodeId: Hex, value: bigint): Hex =>
  keccak256(keccak256(concat([nodeId, wordU256(value)])))

// ---- load the exported golden vectors ---------------------------------------

const g = JSON.parse(readFileSync('../test/golden/hypercerts.json', 'utf8'))
const p = g.params

const paramsHash = (): Hex =>
  keccak256(
    concat([
      wordU256(BigInt(p.dampingFp)),
      wordU256(BigInt(p.toleranceFp)),
      wordU32(Number(p.maxIterations)),
      wordU256(BigInt(p.trustMultiplierFp)),
      wordU256(BigInt(p.trustShareFp)),
      wordU256(BigInt(p.trustDecayFp)),
      wordU256(BigInt(p.precisionScale)),
      wordU256(BigInt(p.totalPool)),
      seedSetRoot(p.trustedSeedDids) as Hex,
      wordU256(BigInt(p.wFollowFp)),
      wordU256(BigInt(p.wBadgeFp)),
      wordU256(BigInt(p.wEvalFp)),
      wordU256(BigInt(p.wAttribFp)),
      wordU256(BigInt(p.ackBoostFp)),
      wordU256(BigInt(p.unackedAttribFp)),
      wordU256(BigInt(p.pdsAttestedWeightFp)),
      wordU64(BigInt(p.lane2MaxHeadAge)),
    ])
  )

const j = g.journal
const journalDigest = (): Hex =>
  keccak256(
    concat([
      j.acc as Hex,
      wordU64(BigInt(j.leafCount)),
      j.anchorAcc as Hex,
      wordU64(BigInt(j.anchorCount)),
      j.paramsHash as Hex,
      j.outputRoot as Hex,
      j.ipfsHash as Hex,
      j.cidDigest as Hex,
      wordU256(BigInt(j.totalValue)),
      j.skippedDigest as Hex,
    ])
  )

// ---- test -------------------------------------------------------------------

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

console.log('golden-vector reproduction (hypercerts TS view — reduced tier)')

check('seedSetRoot', seedSetRoot(p.trustedSeedDids).toLowerCase(), String(p.seedSetRoot).toLowerCase())
check('paramsHash', paramsHash().toLowerCase(), String(p.paramsHash).toLowerCase())
check(
  'node_output_leaf',
  nodeOutputLeaf(g.outputLeaf.nodeId as Hex, BigInt(g.outputLeaf.value)).toLowerCase(),
  String(g.outputLeaf.leaf).toLowerCase()
)
check('journalDigest', journalDigest().toLowerCase(), String(j.digest).toLowerCase())

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`)
  process.exit(1)
} else {
  console.log('\nAll hypercerts golden vectors reproduced. PASS')
}
