import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { type Hex } from 'viem'

import { calculateDetailed } from './pagerank'
import { type Graph } from './reconcile'
import { type Params } from './types'

const SCALE = 10n ** 18n
const MASK_64 = (1n << 64n) - 1n
const SEEDS = [
  0x243f_6a88_85a3_08d3n,
  0x1319_8a2e_0370_7344n,
  0xa409_3822_299f_31d0n,
  0x082e_fa98_ec4e_6c89n,
  0x4528_21e6_38d0_1377n,
  0xbe54_66cf_34e9_0c6cn,
  0xc0ac_29b7_c97c_50ddn,
  0x3f84_d5b5_b547_0917n,
  0x9216_d5d9_8979_fb1bn,
  0xd131_0ba6_98df_b5acn,
] as const

class Lcg {
  constructor(private state: bigint) {}

  bounded(bound: number): number {
    this.state =
      (this.state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) &
      MASK_64
    return Number((this.state >> 32n) % BigInt(bound))
  }
}

type WireCase = {
  nodes: number[]
  edges: Array<{ source: number; target: number; weight: string }>
  config: {
    dampingFp: string
    toleranceFp: string
    maxIterations: number
    trustShareFp: string
    trustDecayFp: string
    scale: string
    seeds: number[]
  }
}

const address = (node: number): Hex =>
  `0x${node.toString(16).padStart(40, '0')}` as Hex

const makeCase = (seed: bigint, index: number): WireCase => {
  const random = new Lcg(seed)
  const nodeCount = 1 + random.bounded(18)
  const maxDegree = 1 + random.bounded(8)
  const seedCount = random.bounded(nodeCount + 1)
  const edges = new Map<
    string,
    { source: number; target: number; weight: string }
  >()
  for (let source = 0; source < nodeCount; source++) {
    const degree = 1 + random.bounded(maxDegree)
    for (let edge = 0; edge < degree; edge++) {
      const target = random.bounded(nodeCount)
      edges.set(`${source}:${target}`, {
        source,
        target,
        weight: String(random.bounded(101)),
      })
    }
  }
  return {
    nodes: Array.from({ length: nodeCount }, (_, node) => node),
    edges: Array.from(edges.values()).sort(
      (a, b) => a.source - b.source || a.target - b.target
    ),
    config: {
      dampingFp: String(
        (SCALE * BigInt([0, 1, 50, 85, 99, 100][index % 6]!)) / 100n
      ),
      toleranceFp: String([0n, 1n, 10n ** 12n][index % 3]!),
      maxIterations: index % 17,
      trustShareFp: String(
        (SCALE * BigInt([0, 1, 15, 50, 99, 100][index % 6]!)) / 100n
      ),
      trustDecayFp: String(
        (SCALE * BigInt([0, 1, 60, 80, 99, 100][index % 6]!)) / 100n
      ),
      scale: String(SCALE),
      seeds: Array.from({ length: seedCount }, (_, node) => node),
    },
  }
}

const graph = (testCase: WireCase): Graph => {
  const outgoing = new Map<string, Map<string, bigint>>()
  for (const edge of testCase.edges) {
    const source = address(edge.source).toLowerCase()
    let row = outgoing.get(source)
    if (!row) {
      row = new Map()
      outgoing.set(source, row)
    }
    row.set(address(edge.target).toLowerCase(), BigInt(edge.weight))
  }
  return { nodes: testCase.nodes.map(address), outgoing }
}

const params = (testCase: WireCase): Params => ({
  dampingFp: BigInt(testCase.config.dampingFp),
  toleranceFp: BigInt(testCase.config.toleranceFp),
  maxIterations: testCase.config.maxIterations,
  minWeightFp: 0n,
  maxWeightFp: 100n * SCALE,
  trustShareFp: BigInt(testCase.config.trustShareFp),
  trustDecayFp: BigInt(testCase.config.trustDecayFp),
  trustedSeeds: testCase.config.seeds.map(address),
  totalPool: 1_000_000n,
  precisionScale: SCALE,
  schemaUid: `0x${'00'.repeat(32)}`,
  weightFieldIndex: 1,
  accumulator: `0x${'00'.repeat(20)}`,
  chainId: 0,
})

const cases = Array.from({ length: 128 }, (_, index) =>
  makeCase(SEEDS[index % SEEDS.length]! ^ BigInt(index), index)
)
const rust = spawnSync(
  'cargo',
  [
    'run',
    '--quiet',
    '-p',
    'pagerank-core',
    '--example',
    'differential_runner',
  ],
  {
    cwd: resolve(process.cwd(), '../..'),
    input: JSON.stringify(cases),
    encoding: 'utf8',
  }
)
assert.equal(rust.status, 0, rust.stderr)
const expected = JSON.parse(rust.stdout) as Array<{
  scores: Array<[number, string]>
  iterations: number
  converged: boolean
}>

for (const [index, testCase] of cases.entries()) {
  const actual = calculateDetailed(graph(testCase), params(testCase))
  assert.deepEqual(
    Array.from(actual.scores).map(([node, score]) => [
      Number.parseInt(node.slice(-8), 16),
      String(score),
    ]),
    expected[index]!.scores,
    `Rust/TypeScript score mismatch in case ${index}`
  )
  assert.equal(actual.iterations, expected[index]!.iterations)
  assert.equal(actual.converged, expected[index]!.converged)
}

const malformed = graph(cases[0]!)
malformed.outgoing.set(address(999).toLowerCase(), new Map())
assert.throws(
  () => calculateDetailed(malformed, params(cases[0]!)),
  /edge source missing/
)

const overflow = graph(cases[0]!)
overflow.nodes = [address(0), address(1), address(2)]
overflow.outgoing = new Map([
  [
    address(0).toLowerCase(),
    new Map([
      [address(1).toLowerCase(), (1n << 256n) - 1n],
      [address(2).toLowerCase(), 1n],
    ]),
  ],
])
const overflowParams = params(cases[0]!)
overflowParams.trustedSeeds = []
overflowParams.maxIterations = 1
assert.throws(
  () => calculateDetailed(overflow, overflowParams),
  /outgoing-weight sum overflowed 256 bits/
)

console.log(
  `pagerank Rust/TypeScript differential fuzz: ${cases.length} cases PASS`
)
