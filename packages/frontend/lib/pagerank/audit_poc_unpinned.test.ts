/**
 * AUDIT PoC (pre-testnet review, agent 2 — cross-language encoding parity).
 *
 * An independent TypeScript check for the boundary encodings promoted into the canonical
 * trust-graph golden fixture: the non-empty `domainSetHash` branch and a `paramsHash` with
 * `minWeightFp`, the separator list and `lane2MaxHeadAge` all non-default.
 *
 * Expected values come from `cargo test -p pagerank-core --test audit_poc_encoding`, which
 * writes `contracts/test/audit-poc/audit-vectors.json`.
 *
 * It also records what this port does NOT implement: `zk_core::anchor::anchor_leaf` and
 * `skipped_digest` exist in Rust and Solidity but have no TypeScript port at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { type Hex } from 'viem'

import { domainSetHash, paramsHash } from './encode'
import * as encodeModule from './encode'
import { seedSetRoot } from './merkle'
import { type Params } from './types'

const vectors = JSON.parse(
  readFileSync('../../contracts/test/audit-poc/audit-vectors.json', 'utf8')
)

const S = 10n ** 18n
const addr = (b: number): Hex =>
  `0x${b.toString(16).padStart(2, '0').repeat(20)}` as Hex
const word = (b: number): Hex =>
  `0x${b.toString(16).padStart(2, '0').repeat(32)}` as Hex

const separators: Hex[] = [word(0xd1), word(0xd2)]

const params: Params = {
  dampingFp: (85n * S) / 100n,
  toleranceFp: S / 1_000_000n,
  maxIterations: 100,
  minWeightFp: S / 4n,
  maxWeightFp: 100n * S,
  trustShareFp: S,
  trustDecayFp: (80n * S) / 100n,
  trustedSeeds: [addr(1), addr(3)],
  totalPool: 10n ** 24n,
  precisionScale: S,
  schemaUid: word(0xab),
  weightFieldIndex: 1,
  envelope0DomainSeparators: separators,
  lane2MaxHeadAge: 86_400,
  accumulator: addr(0xac),
  chainId: 31337n,
}

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

console.log('audit regression: canonical boundary encodings')
check(
  'domainSetHash (non-empty branch)',
  domainSetHash(separators).toLowerCase(),
  String(vectors.domainSetHash).toLowerCase()
)
check(
  'seedSetRoot',
  seedSetRoot([addr(1), addr(3)]).toLowerCase(),
  String(vectors.seedSetRoot).toLowerCase()
)
check(
  'paramsHash (minWeightFp / separators / lane2MaxHeadAge non-default)',
  paramsHash(params).toLowerCase(),
  String(vectors.paramsHash).toLowerCase()
)

// Missing third implementation: no TS port of the lane-2 leaf encodings.
const exported = Object.keys(encodeModule)
check(
  'no anchorLeaf in the TS port (Rust + Solidity only)',
  exported.includes('anchorLeaf'),
  false
)
check(
  'no skipLeaf/skippedDigest in the TS port (Rust + Solidity only)',
  exported.includes('skipLeaf') || exported.includes('skippedDigest'),
  false
)


// ---------------------------------------------------------------------------
// Concatenation ambiguity in the TypeScript port only.
//
// `journalEncoded` / `edgeLeaf` concatenate caller-supplied `Hex` values with NO width
// enforcement (`concat([j.acc, ...])`). Rust (`B256`) and Solidity (`bytes32`) cannot express a
// non-32-byte field; TypeScript can. Two DISTINCT logical journals therefore encode to the SAME
// bytes and the SAME digest, and a field written `0x0` instead of `0x00..00` silently shifts
// every following word.
import { journalDigest, journalEncoded } from './encode'
import { type Journal } from './types'

const base = {
  acc: word(0xaa),
  leafCount: 6n,
  anchorAcc: word(0),
  anchorCount: 0n,
  paramsHash: word(0xbb),
  cidDigest: word(0xcc),
  totalValue: 1n,
  skippedDigest: word(0),
  recipient: addr(0xbe),
  instanceDomain: word(0xdd),
}

// ("ab","c") vs ("a","bc") across the adjacent outputRoot / ipfsHash words.
const left: Journal = {
  ...base,
  outputRoot: `0x${'11'.repeat(31)}` as Hex, // 31 bytes
  ipfsHash: `0x${'11'.repeat(1)}${'22'.repeat(32)}` as Hex, // 33 bytes
}
const right: Journal = {
  ...base,
  outputRoot: `0x${'11'.repeat(32)}` as Hex, // 32 bytes
  ipfsHash: `0x${'22'.repeat(32)}` as Hex, // 32 bytes
}

console.log('\naudit PoC: TS-only concatenation ambiguity')
check(
  'two distinct journals encode to identical bytes',
  journalEncoded(left),
  journalEncoded(right)
)
check(
  'two distinct journals share one digest',
  journalDigest(left),
  journalDigest(right)
)
check(
  'the encoded tuple is not even 12 words when a field is short',
  journalEncoded({ ...right, skippedDigest: '0x0' as Hex }).length,
  2 + 12 * 64 - 63
)

// ---------------------------------------------------------------------------
// `initializeScores` counts seeds differently in the two ports.
//
//   Rust  (pagerank.rs): `trusted_count = cfg.seeds.len()`  — cfg.seeds is a BTreeSet, DEDUPED.
//   TS    (pagerank.ts): `trustedCount  = p.trustedSeeds.length` — the RAW array length.
//
// So [A, A] and [A] are the SAME input to the Rust guest and DIFFERENT inputs to this port.
// Proving TS([A,A]) !== TS([A]) therefore proves the two ports disagree, without running Rust.
// It is currently unreachable on chain only because TrustgraphsParamsValidator rejects a
// duplicated seed; nothing in pagerank-core or in this port enforces that.
import { compute as computeScores } from './compute'
import { type GuestInput as GI, type RawEdge } from './types'

const edgeData = (confidence: bigint): Hex =>
  (`0x${'0'.repeat(64)}${confidence.toString(16).padStart(64, '0')}`) as Hex
const mkEdge = (from: number, to: number, u: number, ts: bigint, c: bigint): RawEdge => ({
  kind: 0,
  attester: addr(from),
  recipient: addr(to),
  uid: word(u),
  blockTimestamp: ts,
  data: edgeData(c),
})

const dupParams = (seeds: Hex[]): Params => ({ ...params, trustedSeeds: seeds })
const dupEdges: RawEdge[] = [
  mkEdge(1, 2, 1, 100n, 50n),
  mkEdge(2, 3, 2, 101n, 75n),
  mkEdge(3, 1, 3, 102n, 90n),
]
const once = computeScores({ edges: dupEdges, params: dupParams([addr(1)]) } as GI)
const twice = computeScores({ edges: dupEdges, params: dupParams([addr(1), addr(1)]) } as GI)

console.log('\naudit PoC: duplicate-seed count divergence (TS array length vs Rust BTreeSet)')
// Status probe, not a pass/fail assertion: at git HEAD 9a34786 the two roots DIFFER (the port
// counted the raw array while pagerank-core counted a BTreeSet). The params-schema v3 refactor
// changed `trustedCount` to `seeds.size`, so on a tree that carries it the two roots MATCH.
if (once.journal.outputRoot === twice.journal.outputRoot) {
  console.log(
    `  DEDUPED  TS([A,A]) === TS([A]) === ${once.journal.outputRoot}`
  )
  console.log(
    '           this port agrees with pagerank-core: `trustedCount = seeds.size`. Finding closed.'
  )
} else {
  console.log(
    `  DIVERGED TS([A,A]) ${twice.journal.outputRoot} != TS([A]) ${once.journal.outputRoot}`
  )
  console.log(
    '           pagerank-core produces ONE root for both (cfg.seeds is a BTreeSet), so one of'
  )
  console.log(
    '           these two browser roots is unprovable. Fix: `const trustedCount = seeds.size`.'
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll audit PoC checks reproduced. PASS')
