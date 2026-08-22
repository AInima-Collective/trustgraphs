import assert from 'node:assert/strict'

import { type Hex, concat, keccak256, sha256 } from 'viem'

import {
  type GuestInput,
  type Params,
  apportion,
  canonicalManifest,
  compute,
  normalize,
  paramsEncoded,
  paramsHash,
  priorLeaf,
  priorRoot,
} from './core'
import {
  accumulate,
  edgeLeaf,
  instanceDomain,
  journalDigest,
  journalEncoded,
} from '../pagerank/encode'
import { type RawEdge } from '../pagerank/types'
import { wordU256 } from '../pagerank/words'

const addr = (byte: string): Hex => `0x${byte.repeat(20)}` as Hex
const hash = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex
const edge = (
  from: string,
  to: string,
  uid: string,
  timestamp: bigint,
  weight: bigint
): RawEdge => ({
  kind: 0,
  attester: addr(from),
  recipient: addr(to),
  uid: hash(uid),
  blockTimestamp: timestamp,
  data: concat([wordU256(0n), wordU256(weight)]),
})

const prior = normalize([
  { account: addr('11'), weight: '10' },
  { account: addr('22'), weight: '2.5' },
  { account: addr('33'), weight: '1' },
])
const manifest = canonicalManifest(10n, prior)
const params: Params = {
  version: 1,
  dampingFp: 850_000_000_000_000_000n,
  toleranceFp: 0n,
  maxIterations: 40,
  minWeight: 0n,
  maxWeight: 100n,
  priorRoot: priorRoot(prior),
  priorCount: 3,
  manifestSha256: sha256(manifest),
  schemaUid: hash('ab'),
  weightFieldIndex: 1,
  accumulator: addr('ac'),
  chainId: 10n,
}
const input: GuestInput = {
  params,
  manifest,
  edges: [
    edge('11', '22', '01', 100n, 3n),
    edge('11', '33', '02', 101n, 1n),
    edge('22', '33', '03', 102n, 5n),
    edge('33', '33', '04', 103n, 99n),
    edge('44', '55', '05', 104n, 1n),
    edge('55', '44', '06', 105n, 1n),
  ],
  binding: {
    recipient: addr('be'),
    instanceDomain: instanceDomain(addr('5a'), 10n),
  },
}

const expected = {
  priorWeights: [740740740740740741n, 185185185185185185n, 74074074074074074n],
  priorLeaves: [
    '0xaddcc0abeeecb536f53079a4d48ae426a3083e1c9a9f62319b85ac631401983f',
    '0x65bbc290da582760748a39220ba28959da2cf59a439c41ccc2eab852a7ff8d12',
    '0x997f9107f9c8c4e0500e1093f3581d32952ee4b7fa4b33b4fee71ceba77116fa',
  ],
  priorRoot:
    '0x3bfa55c8c22dc55892da0439ba84748c4072b323d2ae036cb4088a60f46095cd',
  manifest:
    '0x544757500001000000000000000a0000000311111111111111111111111111111111111111110a47a3c77282f68522222222222222222222222222222222222222220291e8f1dca0bda13333333333333333333333333333333333333333010729fa58404bda',
  manifestSha256:
    '0xcabfa154d35790a2decec957f63391a8ce6347a617ead7378ef2190fecc9e45b',
  paramsHash:
    '0x4698fbef47b9c0fa994297d5d92f4cef94037c50ae6c9174891d95990c68953e',
  edge0Leaf:
    '0xfe36df80fe05a3eef60f6fb48daa4b0af32dd5e439c248eafd6871336b0292d3',
  acc: '0x2078e85cb0094b5f04d4a27169e136d798d277a7b4b2517ee9eb5e738b8d60c5',
  values: [338481065194550339n, 300401950323518854n, 361116984481930807n],
  outputRoot:
    '0x2e21a1800e91098d97c113eb4ea04db8b30d10cae48cf88895d455e86d50d898',
  ipfsHash:
    '0xa641e0e99099168384bcc1ae894aabb6e7417782b8a3455dd4d4119180341ac6',
  cid: 'bafkreifgihqoteezc2byjpgbv2euvk5w45axpavyuncv3vgucgiyana2yy',
  cidDigest:
    '0xea6cc53b71e680a0e832e3b3c5ed2c0df4c77a136f8cd17d1ee2c90c39a024c0',
  journalDigest:
    '0xae29b5cc5e8d27a6d1d77d4b094efb4bfe5242b5d2336063270758c457196b37',
  tieNormalizedWeights: [
    333333333333333334n,
    333333333333333333n,
    333333333333333333n,
  ],
  tieApportionValues: [1n, 1n, 0n],
}

const tieAccounts = [addr('01'), addr('02'), addr('03')]
assert.deepEqual(
  normalize(tieAccounts.map((account) => ({ account, weight: '1' }))).map(
    (entry) => entry.weight
  ),
  expected.tieNormalizedWeights
)
assert.deepEqual(
  [
    ...apportion(
      tieAccounts.map((account) => [account, 1n] as [Hex, bigint]),
      2n,
      3n
    ).values(),
  ],
  expected.tieApportionValues
)

assert.deepEqual(
  prior.map((entry) => entry.weight),
  expected.priorWeights
)
assert.deepEqual(prior.map(priorLeaf), expected.priorLeaves)
assert.equal(priorRoot(prior), expected.priorRoot)
assert.equal(manifest, expected.manifest)
assert.equal(sha256(manifest), expected.manifestSha256)
assert.equal(paramsEncoded(params).length, 2 + 13 * 64)
assert.equal(paramsHash(params), expected.paramsHash)

const dataHash = keccak256(input.edges[0].data)
assert.equal(
  edgeLeaf(0, addr('11'), addr('22'), hash('01'), 100n, dataHash),
  expected.edge0Leaf
)
assert.equal(accumulate(input.edges).acc, expected.acc)

const result = compute(input)
assert.equal(result.iterations, 40)
assert.deepEqual(
  result.scores.map(([, value]) => value),
  expected.values
)
assert.equal(
  result.scores.some(
    ([account]) => account === addr('44') || account === addr('55')
  ),
  false
)
assert.equal(result.journal.outputRoot, expected.outputRoot)
assert.equal(result.journal.ipfsHash, expected.ipfsHash)
assert.equal(result.cid, expected.cid)
assert.equal(result.journal.cidDigest, expected.cidDigest)
assert.equal(journalEncoded(result.journal).length, 2 + 12 * 64)
assert.equal(journalDigest(result.journal), expected.journalDigest)

const empty = compute({ ...input, edges: [] })
assert.deepEqual(
  empty.scores.map(([, value]) => value),
  expected.priorWeights
)

console.log('weighted-prior production golden parity: ok')
