/**
 * Golden-vector reproduction test for the canonical fixed-point PageRank TS port.
 *
 * Asserts the TypeScript mirror of `crates/pagerank-core` reproduces, byte-for-byte, the
 * `tests/golden/trust-graph.json` scenario: the same accumulator, paramsHash, outputRoot, per-account
 * values, IPFS blob/CID, and journal digest that the SP1 zk guest commits.
 *
 * Run: `pnpm test` (or `npx tsx lib/pagerank/golden.test.ts`).
 *
 * The golden values below are copied verbatim from `tests/golden/trust-graph.json` (the constraint is
 * to keep a self-contained frontend fixture rather than import across package boundaries).
 */
import assert from 'node:assert/strict'

import { type Hex, concat, keccak256 } from 'viem'

import { compute, journalDigest } from './compute'
import {
  accumulate,
  edgeLeaf,
  instanceDomain,
  journalEncoded,
  paramsHash,
  selectionParamsHash,
  signerJournalDigest,
  signerJournalEncoded,
} from './encode'
import { signerSetRoot } from './merkle'
import { computeSigners, foldActivity, selectSigners } from './signer'
import {
  type GuestInput,
  type Params,
  type RawEdge,
  type SelectionParams,
} from './types'
import { wordU256 } from './words'

// ---- fixtures ---------------------------------------------------------------

const S = 10n ** 18n

const addr = (b: number): Hex =>
  `0x${b.toString(16).padStart(2, '0').repeat(20)}` as Hex
const uid = (b: number): Hex =>
  `0x${b.toString(16).padStart(2, '0').repeat(32)}` as Hex

/** ABI-encode `(string comment, uint256 confidence)` head: slot 0 = offset, slot 1 = confidence. */
const edgeData = (confidence: bigint): Hex =>
  concat([wordU256(0n), wordU256(confidence)])

const edge = (
  from: number,
  to: number,
  u: number,
  ts: bigint,
  confidence: bigint,
  kind = 0
): RawEdge => ({
  kind,
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
  trustShareFp: S, // 1.0
  trustDecayFp: (80n * S) / 100n, // 0.8
  trustedSeeds: [addr(1), addr(3)],
  totalPool: 10n ** 24n, // 1e24
  precisionScale: S,
  schemaUid: `0x${'ab'.repeat(32)}` as Hex, // matches export_golden.rs: B256::from([0xAB; 32])
  weightFieldIndex: 1,
  // Params-schema v2 domain separators (matches export_golden.rs: addr(0xAC) / chain 31337).
  accumulator: `0x${'ac'.repeat(20)}` as Hex,
  chainId: 31337n,
}

// Journal-v3 bindings (matches export_golden.rs: recipient addr(0xBE), domain over addr(0x5A)/31337).
const binding = {
  recipient: `0x${'be'.repeat(20)}` as Hex,
  instanceDomain: instanceDomain(`0x${'5a'.repeat(20)}` as Hex, 31337n),
}

const input: GuestInput = {
  edges: [
    edge(1, 2, 1, 100n, 50n),
    edge(2, 3, 2, 101n, 75n),
    edge(3, 1, 3, 102n, 90n),
    // #32 regression: after the current vouch is revoked, the older vouch must not reappear.
    // The pair is absent, so the expected three-node scores below stay unchanged.
    edge(4, 5, 4, 103n, 100n),
    edge(4, 5, 5, 104n, 20n),
    edge(4, 5, 5, 105n, 20n, 1),
  ],
  params,
  binding,
}

const selection: SelectionParams = {
  topN: 3,
  minThreshold: 2,
  targetThresholdBps: 5000,
  maxInactiveBlocks: 151_200n,
  minActivityWitnesses: 2,
}

// Golden expectations (from tests/golden/trust-graph.json).
const GOLDEN = {
  acc: '0xd0f947468ef34a60000e8e43a01f57220b83e2b4fb6c4c0a06dcfde8878a658a',
  leafCount: 6n,
  paramsHash:
    '0xa27bc7ee11e51a36945dba9ffb9f4351e02d4c1c69509d357df39ffc314ca0f1', // 17-word params schema v3
  outputRoot:
    '0x28487cf1f154e4c7675af9751d2b368bd4980318e3555433eba2d69b9e92ec1f',
  ipfsHash:
    '0x2a2d60868eef3792a13136cfd18d7520d9e7b1e2fbabe3ebd1f4b229069059a1',
  cid: 'bafkreibkfvqindxpg6jkcmjwz7iy25ja3ht3dyx3vpr6xupuwiuqneczue',
  cidDigest:
    '0x439bc4ab549608c1a887b5eef17a253e7e8b56ae63875fae3b581bad28156688',
  journalEncoded:
    '0xd0f947468ef34a60000e8e43a01f57220b83e2b4fb6c4c0a06dcfde8878a658a000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a27bc7ee11e51a36945dba9ffb9f4351e02d4c1c69509d357df39ffc314ca0f128487cf1f154e4c7675af9751d2b368bd4980318e3555433eba2d69b9e92ec1f2a2d60868eef3792a13136cfd18d7520d9e7b1e2fbabe3ebd1f4b229069059a1439bc4ab549608c1a887b5eef17a253e7e8b56ae63875fae3b581bad2815668800000000000000000000000000000000000000000000d3c21bcecceda10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bebebebebebebebebebebebebebebebebebebebe84b91a0d16f37dad396b7cbf632e697cef56026c1b848c751127dc4568f0c3be',
  journalDigest:
    '0x99a3ed1b35b25a3e96dfbd27630ed046f552a8d29fa5fd54b591ee1f8cc8b7a1', // journal v3 (two-lane + recipient/instanceDomain)
  recipient: '0xbebebebebebebebebebebebebebebebebebebebe',
  instanceDomain:
    '0x84b91a0d16f37dad396b7cbf632e697cef56026c1b848c751127dc4568f0c3be',
  instanceDomainSnapshot: '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
  instanceDomainChainId: 31337n,
  totalValue: 1_000_000_000_000_000_000_000_000n, // 1e24
  edge0DataHash:
    '0x00bcd6ff29ae71d399fb597d99792fa72d0863bd723b9ab11f79d0b8d8ac5bc8',
  edge0Leaf:
    '0x0edaa7e7a8c4f17211cf3ffc8c8dad280b9a8c3792fec297f1b090dc1e0d50c5',
  blob:
    '{"0x0101010101010101010101010101010101010101":"369963739927479854959709",' +
    '"0x0202020202020202020202020202020202020202":"314467628935257870515742",' +
    '"0x0303030303030303030303030303030303030303":"315568631137262274524549"}',
  values: {
    [addr(1)]: 369963739927479854959709n,
    [addr(2)]: 314467628935257870515742n,
    [addr(3)]: 315568631137262274524549n,
  } as Record<string, bigint>,
  // Signer-sync section (from tests/golden/trust-graph.json `.signer`).
  signer: {
    selectionParamsHash:
      '0xef1faf0e7ffab6f28cbc81990983481ccd18c327738cb770ad5fb3c296508c4b',
    signers: [
      '0x0101010101010101010101010101010101010101',
      '0x0202020202020202020202020202020202020202',
    ] as Hex[],
    signerSetRoot:
      '0xaecb023ce0c4eea427a3edb2e62eaa398eb9c74b501848f147b6afe238776689',
    targetThreshold: 2n,
    // M-3 instance/chain binding (matches export_golden.rs: module addr(0x5B) / chain 31337).
    instanceDomainModule: '0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b',
    instanceDomainChainId: 31337n,
    instanceDomain:
      '0x22c5deaa03c018b95ed96ec7c4920aa51e3ed68cfa011c336d43c3d165061fae',
    journalEncoded:
      '0xd0f947468ef34a60000e8e43a01f57220b83e2b4fb6c4c0a06dcfde8878a658a0000000000000000000000000000000000000000000000000000000000000006a27bc7ee11e51a36945dba9ffb9f4351e02d4c1c69509d357df39ffc314ca0f1ef1faf0e7ffab6f28cbc81990983481ccd18c327738cb770ad5fb3c296508c4b1bec34fe7de3e75daaa6c2ac2ab0eb05ebac0abaa5bc38237fe337eab7c2ce73000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000650000000000000000000000000000000000000000000000000000000000000000e4d47a1e33cbc779a23009a9cb602e84ba1bb1b9906177d37611329debea88110000000000000000000000000000000000000000000000000000000000000001aecb023ce0c4eea427a3edb2e62eaa398eb9c74b501848f147b6afe238776689000000000000000000000000000000000000000000000000000000000000000222c5deaa03c018b95ed96ec7c4920aa51e3ed68cfa011c336d43c3d165061fae',
    journalDigest:
      '0x0f11fe2ed1edf661949d080d2bd603f6eac8a659a47a910e30ec7e61f8f0d4cf',
    activityAcc:
      '0x1bec34fe7de3e75daaa6c2ac2ab0eb05ebac0abaa5bc38237fe337eab7c2ce73',
    currentSignerSetRoot:
      '0xe4d47a1e33cbc779a23009a9cb602e84ba1bb1b9906177d37611329debea8811',
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
    console.error(
      `  FAIL ${name}\n         expected: ${String(expected)}\n         actual:   ${String(actual)}`
    )
  }
}

console.log(
  'golden-vector reproduction (canonical fixed-point PageRank TS port)'
)

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
check(
  'journal recipient',
  result.journal.recipient.toLowerCase(),
  GOLDEN.recipient
)
check(
  'journal instanceDomain',
  result.journal.instanceDomain.toLowerCase(),
  GOLDEN.instanceDomain
)
check(
  'instanceDomain derivation',
  instanceDomain(
    GOLDEN.instanceDomainSnapshot as Hex,
    GOLDEN.instanceDomainChainId
  ).toLowerCase(),
  GOLDEN.instanceDomain
)
check(
  'journalEncoded',
  journalEncoded(result.journal).toLowerCase(),
  GOLDEN.journalEncoded
)
check(
  'journalDigest',
  journalDigest(result.journal).toLowerCase(),
  GOLDEN.journalDigest
)

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
  [addr(1), addr(2), addr(3)]
)
check(
  'selectSigners threshold',
  selected.threshold,
  GOLDEN.signer.targetThreshold
)

check(
  'signerSetRoot',
  signerSetRoot(GOLDEN.signer.signers).toLowerCase(),
  GOLDEN.signer.signerSetRoot
)

check(
  'signer instanceDomain derivation',
  instanceDomain(
    GOLDEN.signer.instanceDomainModule as Hex,
    GOLDEN.signer.instanceDomainChainId
  ),
  GOLDEN.signer.instanceDomain
)

const signerResult = computeSigners({
  edges: input.edges,
  params,
  selection,
  activity: [
    { account: addr(1) as Hex, proposalId: 1n, blockNumber: 100n },
    { account: addr(2) as Hex, proposalId: 2n, blockNumber: 101n },
  ],
  activityCheckpoint: {
    acc: GOLDEN.signer.activityAcc as Hex,
    count: 2n,
    blockNumber: 101n,
  },
  activityCheckpointId: 1n,
  currentSigners: [addr(1) as Hex],
  currentThreshold: 1n,
  wasInitialized: false,
  instanceDomain: GOLDEN.signer.instanceDomain as Hex,
})
check(
  'signer journal currentSignerSetRoot',
  signerResult.journal.currentSignerSetRoot.toLowerCase(),
  GOLDEN.signer.currentSignerSetRoot
)
check(
  'computeSigners signers',
  signerResult.signers.map((a) => a.toLowerCase()),
  GOLDEN.signer.signers.map((a) => a.toLowerCase())
)
check(
  'computeSigners targetThreshold',
  signerResult.targetThreshold,
  GOLDEN.signer.targetThreshold
)
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
  'signer journal instanceDomain',
  signerResult.journal.instanceDomain.toLowerCase(),
  GOLDEN.signer.instanceDomain
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

const absent = computeSigners({
  edges: input.edges,
  params,
  selection,
  currentSigners: [addr(1) as Hex, addr(2) as Hex, addr(3) as Hex],
  currentThreshold: 2n,
  wasInitialized: true,
  instanceDomain: GOLDEN.signer.instanceDomain as Hex,
})
check('absent activity means no change', absent.activityApplied, false)
check(
  'absent activity preserves owners',
  absent.signers.map((address) => address.toLowerCase()),
  [addr(1), addr(2), addr(3)]
)

const loneRecord = { account: addr(1) as Hex, proposalId: 9n, blockNumber: 500n }
const lone = computeSigners({
  edges: input.edges,
  params,
  selection,
  activity: [loneRecord],
  activityCheckpoint: {
    acc: foldActivity(`0x${'00'.repeat(32)}` as Hex, 1n, loneRecord),
    count: 1n,
    blockNumber: 500n,
  },
  currentSigners: [addr(1) as Hex, addr(2) as Hex, addr(3) as Hex],
  currentThreshold: 2n,
  wasInitialized: true,
  instanceDomain: GOLDEN.signer.instanceDomain as Hex,
})
check('one current owner cannot activate removals', lone.activityApplied, false)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`)
  process.exit(1)
} else {
  console.log('\nAll golden vectors reproduced. PASS')
}
