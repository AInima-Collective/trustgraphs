/**
 * Golden-vector reproduction test for the canonical fixed-point PageRank TS port.
 *
 * Asserts the TypeScript mirror of `packages/pagerank-core` reproduces, byte-for-byte, the
 * `test/golden/trust-graph.json` scenario: the same accumulator, paramsHash, outputRoot, per-account
 * values, IPFS blob/CID, and journal digest that the SP1 zk guest commits.
 *
 * Run: `pnpm test` (or `npx tsx lib/pagerank/golden.test.ts`).
 *
 * The golden values below are copied verbatim from `test/golden/trust-graph.json` (the constraint is
 * to keep a self-contained frontend fixture rather than import across package boundaries).
 */
import assert from 'node:assert/strict'

import { concat, keccak256, type Hex } from 'viem'

import { compute, journalDigest } from './compute'
import {
  accumulate,
  edgeLeaf,
  paramsHash,
  selectionParamsHash,
  signerJournalEncoded,
  signerJournalDigest,
} from './encode'
import { signerSetRoot } from './merkle'
import { computeSigners, selectSigners } from './signer'
import {
  type GuestInput,
  type Params,
  type RawEdge,
  type SelectionParams,
} from './types'
import { wordU256 } from './words'

// ---- fixtures ---------------------------------------------------------------

const S = 10n ** 18n

const addr = (b: number): Hex => (`0x${b.toString(16).padStart(2, '0').repeat(20)}`) as Hex
const uid = (b: number): Hex => (`0x${b.toString(16).padStart(2, '0').repeat(32)}`) as Hex

/** ABI-encode `(string comment, uint256 confidence)` head: slot 0 = offset, slot 1 = confidence. */
const edgeData = (confidence: bigint): Hex => concat([wordU256(0n), wordU256(confidence)])

const edge = (
  from: number,
  to: number,
  u: number,
  ts: bigint,
  confidence: bigint
): RawEdge => ({
  kind: 0,
  attester: addr(from),
  recipient: addr(to),
  uid: uid(u),
  blockTimestamp: ts,
  data: edgeData(confidence),
})

const params: Params = {
  dampingFp: (85n * S) / 100n, // 0.85
  toleranceFp: S / 1_000_000n, // 1e-6
  maxIterations: 100,
  minWeightFp: 0n,
  maxWeightFp: 100n * S,
  trustMultiplierFp: 2n * S, // 2.0
  trustShareFp: (15n * S) / 100n, // 0.15
  trustDecayFp: (80n * S) / 100n, // 0.8
  trustedSeeds: [addr(1), addr(3)],
  totalPool: 10n ** 24n, // 1e24
  precisionScale: S,
  schemaUid: `0x${'ab'.repeat(32)}` as Hex, // matches export_golden.rs: B256::from([0xAB; 32])
  weightFieldIndex: 1,
}

const input: GuestInput = {
  edges: [
    edge(1, 2, 1, 100n, 50n),
    edge(2, 3, 2, 101n, 75n),
    edge(3, 1, 3, 102n, 90n),
  ],
  params,
}

const selection: SelectionParams = { topN: 3, minThreshold: 1, targetThresholdBps: 5000 }

// Golden expectations (from test/golden/trust-graph.json).
const GOLDEN = {
  acc: '0x827b99d32b30d230c48dd0af36bf8d906c1b813a100092e4c40d81a1dde3d151',
  leafCount: 3n,
  paramsHash: '0xca027783e35ae2db8d91e560dcaf1a9ce86a678d3e75e2b781d78c2bfb7c42f4',
  outputRoot: '0x0eda9f4e92cd62624c67b676144f51a75fa8269fbc333129ee014a6e7b448d27',
  ipfsHash: '0x581de820277c149de623a324809eb644c487f085887a7d88f840e34917c8fe1f',
  cid: 'bafkreicydxucaj34cso6mi5desaj5nseysd7bbmipj6yr6ca4nerpsh6d4',
  cidDigest: '0x4e8914b7f3f0bcc0d5cb3e54f7e21b3406a0febae224c4b8eb18dda3ac71f418',
  journalDigest: '0x2d6cd18629ab0f23ff8119d671b3abef09b1bfd71c2f65cbdd33cb3050dba34e', // journal v2 (two-lane; empty lane 2)
  totalValue: 1_000_000_000_000_000_000_000_000n, // 1e24
  edge0DataHash: '0x00bcd6ff29ae71d399fb597d99792fa72d0863bd723b9ab11f79d0b8d8ac5bc8',
  edge0Leaf: '0x0edaa7e7a8c4f17211cf3ffc8c8dad280b9a8c3792fec297f1b090dc1e0d50c5',
  blob:
    '{"0x0101010101010101010101010101010101010101":"220016440032880065760133",' +
    '"0x0202020202020202020202020202020202020202":"300189600379200758401516",' +
    '"0x0303030303030303030303030303030303030303":"479793959587919175838351"}',
  values: {
    [addr(1)]: 220016440032880065760133n,
    [addr(2)]: 300189600379200758401516n,
    [addr(3)]: 479793959587919175838351n,
  } as Record<string, bigint>,
  // Signer-sync section (from test/golden/trust-graph.json `.signer`).
  signer: {
    selectionParamsHash: '0xae2d1032599756c83d4983d00779c8d219dde056cb890378511e0237c5204310',
    signers: [
      '0x0101010101010101010101010101010101010101',
      '0x0202020202020202020202020202020202020202',
      '0x0303030303030303030303030303030303030303',
    ] as Hex[],
    signerSetRoot: '0x2a003402caab905ccb03be65b010037277f9381fe0dc0081465c0de866bcfac3',
    targetThreshold: 2n,
    journalEncoded:
      '0x827b99d32b30d230c48dd0af36bf8d906c1b813a100092e4c40d81a1dde3d1510000000000000000000000000000000000000000000000000000000000000003ca027783e35ae2db8d91e560dcaf1a9ce86a678d3e75e2b781d78c2bfb7c42f4ae2d1032599756c83d4983d00779c8d219dde056cb890378511e0237c52043102a003402caab905ccb03be65b010037277f9381fe0dc0081465c0de866bcfac30000000000000000000000000000000000000000000000000000000000000002',
    journalDigest: '0xb81a2e5e10bb3651155b62351aed96d9460ca7709e9c8b8e75db0434519f0946',
  },
}

// ---- test -------------------------------------------------------------------

let failures = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  try {
    assert.deepEqual(actual, expected)
    console.log(`  ok   ${name}`)
  } catch {
    failures++
    console.error(`  FAIL ${name}\n         expected: ${String(expected)}\n         actual:   ${String(actual)}`)
  }
}

console.log('golden-vector reproduction (canonical fixed-point PageRank TS port)')

// Accumulator + leaf-level encodings.
const dataHash0 = keccak256(input.edges[0].data)
check('edge0 dataHash', dataHash0.toLowerCase(), GOLDEN.edge0DataHash)
check(
  'edge0 leaf',
  edgeLeaf(0, addr(1), addr(2), uid(1), 100n, dataHash0 as Hex).toLowerCase(),
  GOLDEN.edge0Leaf
)
const { acc, leafCount } = accumulate(input.edges)
check('accumulator acc', acc.toLowerCase(), GOLDEN.acc)
check('leafCount', leafCount, GOLDEN.leafCount)

// paramsHash.
check('paramsHash', paramsHash(params).toLowerCase(), GOLDEN.paramsHash)

// Full pipeline.
const result = compute(input)
check('outputRoot', result.journal.outputRoot.toLowerCase(), GOLDEN.outputRoot)
check('ipfsHash', result.journal.ipfsHash.toLowerCase(), GOLDEN.ipfsHash)
check('cid', result.cid, GOLDEN.cid)
check('cidDigest', result.journal.cidDigest.toLowerCase(), GOLDEN.cidDigest)
check('totalValue', result.journal.totalValue, GOLDEN.totalValue)
check('blob', result.blob, GOLDEN.blob)
check('journalDigest', journalDigest(result.journal).toLowerCase(), GOLDEN.journalDigest)

// Per-account values.
const gotValues: Record<string, bigint> = {}
for (const [a, v] of result.scores) gotValues[a.toLowerCase()] = v
check('value 0x01..01', gotValues[addr(1)], GOLDEN.values[addr(1)])
check('value 0x02..02', gotValues[addr(2)], GOLDEN.values[addr(2)])
check('value 0x03..03', gotValues[addr(3)], GOLDEN.values[addr(3)])

// Signer-sync selection (byte-parity with the Rust `pagerank_core::signer`).
check(
  'selectionParamsHash',
  selectionParamsHash(selection).toLowerCase(),
  GOLDEN.signer.selectionParamsHash
)

const selected = selectSigners(result.scores, selection)
check(
  'selectSigners signers',
  selected.signers.map((a) => a.toLowerCase()),
  GOLDEN.signer.signers.map((a) => a.toLowerCase())
)
check('selectSigners threshold', selected.threshold, GOLDEN.signer.targetThreshold)

check(
  'signerSetRoot',
  signerSetRoot(GOLDEN.signer.signers).toLowerCase(),
  GOLDEN.signer.signerSetRoot
)

const signerResult = computeSigners({ edges: input.edges, params, selection })
check(
  'computeSigners signers',
  signerResult.signers.map((a) => a.toLowerCase()),
  GOLDEN.signer.signers.map((a) => a.toLowerCase())
)
check('computeSigners targetThreshold', signerResult.targetThreshold, GOLDEN.signer.targetThreshold)
check(
  'signer journal signerSetRoot',
  signerResult.journal.signerSetRoot.toLowerCase(),
  GOLDEN.signer.signerSetRoot
)
check(
  'signer journal selectionParamsHash',
  signerResult.journal.selectionParamsHash.toLowerCase(),
  GOLDEN.signer.selectionParamsHash
)
check(
  'signerJournalEncoded',
  signerJournalEncoded(signerResult.journal).toLowerCase(),
  GOLDEN.signer.journalEncoded
)
check(
  'signerJournalDigest',
  signerJournalDigest(signerResult.journal).toLowerCase(),
  GOLDEN.signer.journalDigest
)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`)
  process.exit(1)
} else {
  console.log('\nAll golden vectors reproduced. PASS')
}
