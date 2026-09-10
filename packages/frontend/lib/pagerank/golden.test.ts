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
import { distributePoints } from './distribute'
import {
  accumulate,
  domainSetHash,
  edgeLeaf,
  instanceDomain,
  journalEncoded,
  paramsHash,
  selectionParamsHash,
  signerJournalDigest,
  signerJournalEncoded,
} from './encode'
import { signerSetRoot } from './merkle'
import {
  computeSigners,
  computeSignersForProof,
  foldActivity,
  selectSigners,
} from './signer'
import {
  type GuestInput,
  type Params,
  type RawEdge,
  type SelectionParams,
  type SignerInput,
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
  minWeightFp: S / 4n,
  maxWeightFp: 100n * S,
  trustShareFp: S, // 1.0
  trustDecayFp: (80n * S) / 100n, // 0.8
  trustedSeeds: [addr(1), addr(3)],
  totalPool: 10n ** 24n, // 1e24
  precisionScale: S,
  schemaUid: `0x${'ab'.repeat(32)}` as Hex, // matches export_golden.rs: B256::from([0xAB; 32])
  weightFieldIndex: 1,
  envelope0DomainSeparators: [uid(0xd1), uid(0xd2)],
  lane2MaxHeadAge: 86_400,
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
    '0xa8ab5ec908b6a0ec70138497852a9ea2b351bda5c3d824b5a35a4489cc1a8b68', // 17-word params schema v3
  domainSetHash:
    '0xbf1cb4496241c117ba3d1998198867c6af2e29c154c9180662304713d9013d48',
  outputRoot:
    '0xfce3dd62ed0649524a718391dafd651189c94f7b27a7d652d2a65d6d83e722e4',
  ipfsHash:
    '0x61d27a12570052d326e3b520b8f86909cd0af3991da156af164ae76f8e1db7fb',
  cid: 'bafkreidb2j5bevyakljsny5vec4pq2ijzufphgi5uflk6fsk45xy4hnx7m',
  cidDigest:
    '0x6846724a751aa12ca943794e0851c2151f38df903145b2f74067ed922872b301',
  journalEncoded:
    '0xd0f947468ef34a60000e8e43a01f57220b83e2b4fb6c4c0a06dcfde8878a658a000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a8ab5ec908b6a0ec70138497852a9ea2b351bda5c3d824b5a35a4489cc1a8b68fce3dd62ed0649524a718391dafd651189c94f7b27a7d652d2a65d6d83e722e461d27a12570052d326e3b520b8f86909cd0af3991da156af164ae76f8e1db7fb6846724a751aa12ca943794e0851c2151f38df903145b2f74067ed922872b30100000000000000000000000000000000000000000000d3c21bcecceda10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bebebebebebebebebebebebebebebebebebebebe84b91a0d16f37dad396b7cbf632e697cef56026c1b848c751127dc4568f0c3be',
  journalDigest:
    '0x39c1b0ee4d53459f3f7f8362295288836e24a2f39d171371064ad78dc64be86e', // journal v3 (two-lane + recipient/instanceDomain)
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
    '{"0x0101010101010101010101010101010101010101":"369963244713634688000000",' +
    '"0x0202020202020202020202020202020202020202":"314467970300360562000000",' +
    '"0x0303030303030303030303030303030303030303":"315568784986004750000000"}',
  values: {
    [addr(1)]: 369963244713634688000000n,
    [addr(2)]: 314467970300360562000000n,
    [addr(3)]: 315568784986004750000000n,
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
      '0xd0f947468ef34a60000e8e43a01f57220b83e2b4fb6c4c0a06dcfde8878a658a0000000000000000000000000000000000000000000000000000000000000006a8ab5ec908b6a0ec70138497852a9ea2b351bda5c3d824b5a35a4489cc1a8b68ef1faf0e7ffab6f28cbc81990983481ccd18c327738cb770ad5fb3c296508c4b1bec34fe7de3e75daaa6c2ac2ab0eb05ebac0abaa5bc38237fe337eab7c2ce73000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000650000000000000000000000000000000000000000000000000000000000000000e4d47a1e33cbc779a23009a9cb602e84ba1bb1b9906177d37611329debea88110000000000000000000000000000000000000000000000000000000000000001aecb023ce0c4eea427a3edb2e62eaa398eb9c74b501848f147b6afe238776689000000000000000000000000000000000000000000000000000000000000000222c5deaa03c018b95ed96ec7c4920aa51e3ed68cfa011c336d43c3d165061fae',
    journalDigest:
      '0xaf076c1598271c3ee6bd8a30a9344822cf3acb389433e8386b1f735c4651cbb9',
    activityAcc:
      '0x1bec34fe7de3e75daaa6c2ac2ab0eb05ebac0abaa5bc38237fe337eab7c2ce73',
    currentSignerSetRoot:
      '0xe4d47a1e33cbc779a23009a9cb602e84ba1bb1b9906177d37611329debea8811',
  },
}

// Zero confidence contributes neither reachability nor a shortcut through trust decay.
{
  const policy = {
    ...params,
    minWeightFp: 0n,
    trustShareFp: S / 2n,
    trustedSeeds: [addr(1)],
    envelope0DomainSeparators: [],
    lane2MaxHeadAge: 0,
    totalPool: S,
  }
  const disconnected = [edge(2, 3, 1, 1n, 100n), edge(3, 2, 2, 1n, 100n)]
  const before = compute({ edges: disconnected, params: policy })
  const after = compute({
    edges: [...disconnected, edge(1, 2, 3, 1n, 0n)],
    params: policy,
  })
  assert.deepEqual(after.scores, before.scores)
  const chain = [
    edge(1, 2, 1, 1n, 100n),
    edge(2, 3, 2, 1n, 100n),
    edge(3, 4, 3, 1n, 100n),
    edge(4, 5, 4, 1n, 100n),
  ]
  const fullShare = { ...policy, trustShareFp: S }
  assert.deepEqual(
    compute({ edges: [...chain, edge(1, 4, 5, 1n, 0n)], params: fullShare })
      .scores,
    compute({ edges: chain, params: fullShare }).scores
  )
  assert.deepEqual(
    compute({
      edges: [edge(1, 2, 1, 1n, 100n)],
      params: { ...fullShare, totalPool: 1n },
    }).scores,
    [[addr(1), 1n]]
  )
  assert.deepEqual(
    distributePoints(
      [
        [addr(1), S / 2n],
        [addr(2), S / 2n - 1n],
        [addr(3), 1n],
      ],
      { ...policy, totalPool: 2n }
    ).assigned,
    [
      [addr(1), 1n],
      [addr(2), 1n],
    ]
  )
  const max = (1n << 256n) - 1n
  assert.deepEqual(
    distributePoints(
      [
        [addr(2), 1n],
        [addr(3), 0n],
        [addr(1), 1n],
      ],
      { ...policy, totalPool: max }
    ).assigned,
    [
      [addr(1), max / 2n + 1n],
      [addr(2), max / 2n],
    ]
  )
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

// Non-empty lane-2 domain-set branch + the complete paramsHash.
check(
  'domainSetHash',
  domainSetHash(params.envelope0DomainSeparators!).toLowerCase(),
  GOLDEN.domainSetHash
)
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

const loneRecord = {
  account: addr(1) as Hex,
  proposalId: 9n,
  blockNumber: 500n,
}
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

// Production proof eligibility is stronger than a native preview: an unchanged fallback must
// never consume the singleton bootstrap. The real selection may equal an existing owner set.
const bootstrap: SignerInput = {
  edges: input.edges,
  params: { ...params, envelope0DomainSeparators: [], lane2MaxHeadAge: 0n },
  selection,
  activity: [loneRecord],
  activityCheckpoint: {
    acc: foldActivity(`0x${'00'.repeat(32)}` as Hex, 1n, loneRecord),
    count: 1n,
    blockNumber: 500n,
  },
  currentSigners: [addr(1)],
  currentThreshold: 1n,
  wasInitialized: false,
}
assert.equal(computeSigners(bootstrap).activityApplied, false)
assert.throws(
  () => computeSignersForProof(bootstrap),
  /insufficient authenticated signer activity/
)
const secondRecord = { ...loneRecord, account: addr(2) }
const eligible: SignerInput = {
  ...bootstrap,
  activity: [loneRecord, secondRecord],
  activityCheckpoint: {
    acc: foldActivity(bootstrap.activityCheckpoint!.acc, 2n, secondRecord),
    count: 2n,
    blockNumber: 500n,
  },
}
const initialSelection = computeSignersForProof(eligible)
assert.equal(initialSelection.signers.length, 2)
assert.equal(initialSelection.targetThreshold, 2n)
assert.equal(
  computeSignersForProof({
    ...eligible,
    wasInitialized: true,
    currentSigners: initialSelection.signers,
    currentThreshold: initialSelection.targetThreshold,
  }).activityApplied,
  true
)
assert.throws(
  () =>
    computeSignersForProof({
      ...eligible,
      selection: { ...selection, topN: 65 },
    }),
  /invalid signer selection policy/
)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`)
  process.exit(1)
} else {
  console.log('\nAll golden vectors reproduced. PASS')
}
