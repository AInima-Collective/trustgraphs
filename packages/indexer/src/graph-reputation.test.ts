import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Address, type Hex, zeroHash } from 'viem'

import {
  GRAPH_REPUTATION_ERROR_BOUND,
  GRAPH_REPUTATION_SCALE,
  type GraphReputationInput,
  computeGraphReputation,
  encodeGraphReputationInput,
  graphReputationL1,
  normalizeGraphWeights,
} from './graph-reputation'

const word = (value: number) =>
  `0x${value.toString(16).padStart(64, '0')}` as Hex
const address = (value: number) =>
  `0x${value.toString(16).padStart(40, '0')}` as Address

const golden = JSON.parse(
  readFileSync(
    new URL('../../../tests/golden/graph-reputation.json', import.meta.url),
    'utf8'
  )
) as {
  cases: Array<{
    mode: 'disconnected' | 'ingress' | 'dangling'
    ingressWeight: string
    inputCommitment: Hex
    resultCommitment: Hex
    residual: string
    scores: string[]
    cartelMass: string
    matrix?: Array<{
      spent: string
      unused: string
      referrals: Array<{
        endorsementId: Hex
        subjectLineageId: Hex
        weight: string
        validUntil: string
      }>
    }>
  }>
}

export const graphReputationFixture = (
  ingress: boolean
): GraphReputationInput => {
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    lineageId: word(index + 1),
    configurationId: word(index + 101),
    epochId: word(index + 201),
    familyId: word(index < 3 ? index + 301 : 399),
    methodId: word(index < 3 ? index + 401 : 499),
    controller: address(index < 3 ? index + 1 : 99),
    authority: address(index < 3 ? index + 11 : 88),
    createdAt: 100n,
    epochAcceptedBlock: 900n,
    epochPublishedBlock: 901n,
  }))
  const referrals: Array<[number, number, bigint]> = ingress
    ? [
        [0, 1, 900_000_000_000_000_000n],
        [0, 3, 100_000_000_000_000_000n],
        [1, 2, GRAPH_REPUTATION_SCALE],
        [2, 0, GRAPH_REPUTATION_SCALE],
        [3, 4, GRAPH_REPUTATION_SCALE],
        [4, 5, GRAPH_REPUTATION_SCALE],
        [5, 3, GRAPH_REPUTATION_SCALE],
      ]
    : [
        [0, 1, GRAPH_REPUTATION_SCALE],
        [1, 2, GRAPH_REPUTATION_SCALE],
        [2, 0, GRAPH_REPUTATION_SCALE],
        [3, 4, GRAPH_REPUTATION_SCALE],
        [4, 5, GRAPH_REPUTATION_SCALE],
        [5, 3, GRAPH_REPUTATION_SCALE],
      ]
  return {
    version: 1,
    chainId: 10n,
    registry: address(500),
    scopeHash: word(500),
    cutoffBlock: 1_000n,
    finalizedBlock: 1_010n,
    cutoffTimestamp: 2_000n,
    roots: [
      { lineageId: nodes[0]!.lineageId, weight: 340_000_000_000_000_000n },
      { lineageId: nodes[1]!.lineageId, weight: 330_000_000_000_000_000n },
      { lineageId: nodes[2]!.lineageId, weight: 330_000_000_000_000_000n },
    ],
    nodes,
    edges: referrals.map(([from, to, weight], index) => ({
      endorsementId: word(600 + index),
      issuerLineageId: nodes[Number(from)]!.lineageId,
      subjectLineageId: nodes[Number(to)]!.lineageId,
      issuerConfigurationId: nodes[Number(from)]!.configurationId,
      subjectConfigurationId: nodes[Number(to)]!.configurationId,
      scopeHash: word(500),
      weight: BigInt(weight),
      validFrom: 1_000n,
      validUntil: 3_000n,
      issuedBlock: 800n,
      evidenceDigest: index === 0 ? zeroHash : word(700 + index),
      revokedAt: null,
      supersededBy: null,
    })),
  }
}

const cartelMass = (input: GraphReputationInput) => {
  const cartel = new Set(input.nodes.slice(3).map((node) => node.lineageId))
  return computeGraphReputation(input).scores.reduce(
    (sum, score) => sum + (cartel.has(score.lineageId) ? score.score : 0n),
    0n
  )
}

const danglingFixture = () => {
  const input = graphReputationFixture(false)
  input.edges = input.edges.filter(
    (edge) => edge.issuerLineageId === input.nodes[0]!.lineageId
  )
  input.edges[0]!.weight = 100_000_000_000_000_000n
  return input
}

test('disconnected permissionless cartels receive zero sparse-prior mass', () => {
  const result = computeGraphReputation(graphReputationFixture(false))
  assert.equal(cartelMass(graphReputationFixture(false)), 0n)
  assert.equal(
    result.scores.reduce((sum, score) => sum + score.score, 0n),
    GRAPH_REPUTATION_SCALE
  )
  assert.ok(result.residual <= GRAPH_REPUTATION_ERROR_BOUND)
})

test('ten percent trusted ingress yields the frozen 16.3225 percent cartel result', () => {
  const mass = cartelMass(graphReputationFixture(true))
  const expected = 163_225_000_000_000_000n
  const error = mass >= expected ? mass - expected : expected - mass
  assert.ok(error <= 500_000_000_000n, `${mass} differs by ${error}`)
})

test('TypeScript matches the frozen cross-language golden vectors', () => {
  for (const expected of golden.cases) {
    const result = computeGraphReputation(
      expected.mode === 'dangling'
        ? danglingFixture()
        : graphReputationFixture(expected.mode === 'ingress')
    )
    assert.equal(result.inputCommitment, expected.inputCommitment)
    assert.equal(result.resultCommitment, expected.resultCommitment)
    assert.equal(result.residual.toString(), expected.residual)
    assert.deepEqual(
      result.scores.map((score) => score.score.toString()),
      expected.scores
    )
    assert.equal(result.families.at(-1)!.mass.toString(), expected.cartelMass)
    if (expected.matrix)
      assert.deepEqual(
        result.matrix.map((row) => ({
          spent: row.spent.toString(),
          unused: row.unused.toString(),
          referrals: row.referrals.map((referral) => ({
            ...referral,
            weight: referral.weight.toString(),
            validUntil: referral.validUntil.toString(),
          })),
        })),
        expected.matrix
      )
  }
})

test('canonical input and output do not depend on caller array order', () => {
  const input = graphReputationFixture(true)
  const reversed = {
    ...input,
    roots: [...input.roots].reverse(),
    nodes: [...input.nodes].reverse(),
    edges: [...input.edges].reverse(),
  }
  const left = computeGraphReputation(input)
  const right = computeGraphReputation(reversed)
  assert.deepEqual(
    encodeGraphReputationInput(input),
    encodeGraphReputationInput(reversed)
  )
  assert.equal(left.inputCommitment, right.inputCommitment)
  assert.equal(left.resultCommitment, right.resultCommitment)
  assert.deepEqual(left.scores, right.scores)
})

test('noncanonical bytes32 spelling is rejected instead of creating ordering aliases', () => {
  const input = graphReputationFixture(true)
  input.nodes[0]!.lineageId = input.nodes[0]!.lineageId.toUpperCase() as Hex
  assert.throws(() => computeGraphReputation(input), /invalid-lineage-id/)
})

test('cutoff, scope, version, lifecycle, and budget checks fail closed', () => {
  const base = graphReputationFixture(true)
  const cases: Array<[string, GraphReputationInput, RegExp]> = [
    [
      'same epoch',
      {
        ...base,
        nodes: base.nodes.map((node, index) =>
          index ? node : { ...node, epochAcceptedBlock: base.cutoffBlock }
        ),
      },
      /same-or-future-epoch/,
    ],
    [
      'wrong scope',
      {
        ...base,
        edges: base.edges.map((edge, index) =>
          index ? edge : { ...edge, scopeHash: word(999) }
        ),
      },
      /wrong-scope/,
    ],
    [
      'wrong version',
      {
        ...base,
        edges: base.edges.map((edge, index) =>
          index ? edge : { ...edge, issuerConfigurationId: word(998) }
        ),
      },
      /wrong-issuer-version/,
    ],
    [
      'expired',
      {
        ...base,
        edges: base.edges.map((edge, index) =>
          index ? edge : { ...edge, validUntil: base.cutoffTimestamp }
        ),
      },
      /inactive-at-cutoff/,
    ],
    [
      'revoked',
      {
        ...base,
        edges: base.edges.map((edge, index) =>
          index ? edge : { ...edge, revokedAt: 1_900n }
        ),
      },
      /revoked-edge/,
    ],
    [
      'unfinalized',
      { ...base, cutoffBlock: base.finalizedBlock + 1n },
      /unfinalized-cutoff/,
    ],
  ]
  for (const [label, input, expected] of cases)
    assert.throws(() => computeGraphReputation(input), expected, label)
})

test('unused and dangling referral mass returns to the sparse prior', () => {
  const input = danglingFixture()
  const result = computeGraphReputation(input)
  assert.equal(
    result.scores.slice(3).reduce((sum, score) => sum + score.score, 0n),
    0n
  )
  assert.equal(result.matrix[0]!.unused, 900_000_000_000_000_000n)
  assert.equal(
    result.scores.reduce((sum, score) => sum + score.score, 0n),
    GRAPH_REPUTATION_SCALE
  )
})

test('leave-one-root-out sensitivity exposes dependence on one compromised root', () => {
  const input = graphReputationFixture(true)
  const base = computeGraphReputation(input)
  const distances = input.roots.map((omitted) => {
    const remaining = input.roots.filter(
      (root) => root.lineageId !== omitted.lineageId
    )
    const roots = normalizeGraphWeights(
      remaining.map((root) => ({
        key: root.lineageId,
        weight: root.weight,
        data: root.lineageId,
      }))
    ).map(({ data, weight }) => ({ lineageId: data, weight }))
    return graphReputationL1(
      base,
      computeGraphReputation({ ...input, roots })
    ).toString()
  })
  assert.deepEqual(distances, [
    '76365313134000152',
    '70606420703059644',
    '55635808045293184',
  ])
})
