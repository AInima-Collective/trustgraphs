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
    edge('11', '33', '03', 102n, 4n),
    edge('22', '11', '02', 101n, 1n),
    edge('22', '33', '04', 103n, 5n),
    edge('33', '22', '05', 104n, 2n),
    edge('33', '33', '06', 105n, 99n),
    edge('44', '55', '07', 106n, 1n),
    edge('55', '44', '08', 107n, 1n),
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
    '0x54474d520001000000000000000a0000000311111111111111111111111111111111111111110a47a3c77282f68522222222222222222222222222222222222222220291e8f1dca0bda13333333333333333333333333333333333333333010729fa58404bda',
  manifestSha256:
    '0x1af4115457f13c76a13c8fab4df1975ac6525c882d130bbddb547bc78c541af5',
  paramsHash:
    '0x46051661fa1bcdf0afe80630eeebeb94bc82725df299172fe8b4616e4ed97ab0',
  edge0Leaf:
    '0xfe36df80fe05a3eef60f6fb48daa4b0af32dd5e439c248eafd6871336b0292d3',
  acc: '0x9370aee4d72501b1b2b10107fd16d808d28c72b34be4e1d10f56a49be26bd260',
  values: [245690412099172047n, 474039874813594971n, 280269713087232982n],
  outputRoot:
    '0x17c3ac5d3c174118a5d64459e8a40dcdc097732fdc95735325419e4fcfe906ed',
  ipfsHash:
    '0x14f43930ded607f443ccec49ea0c4175c7ccb5090e94d8d5251f2e8c024ae9b5',
  cid: 'bafkreiau6q4tbxwwa72ehthmjhvayqlvy7glkciostmnkji7f2gaesxjwu',
  cidDigest:
    '0x45fbb483aa2332e02ad6bea95fb5c4cd4d7228e440872a46ab1c8995fc8152be',
  journalDigest:
    '0xf5cf10a4c45b134dea90044e8f80537748224536d6d000b3e77d4e25e4086ed7',
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

console.log('mutual-recognition production golden parity: ok')
