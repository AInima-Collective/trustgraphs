import {
  type Address,
  type Hex,
  bytesToHex,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  zeroAddress,
  zeroHash,
} from 'viem'

export const GRAPH_REPUTATION_VERSION = 1
export const GRAPH_REPUTATION_SCALE = 1_000_000_000_000_000_000n
export const GRAPH_REPUTATION_LAMBDA = 850_000_000_000_000_000n
export const GRAPH_REPUTATION_ITERATIONS = 128
// 2e18 * 0.85^128 < 1.848e9; the remaining margin covers bounded Hamilton dust.
export const GRAPH_REPUTATION_ERROR_BOUND = 2_000_000_000n
export const GRAPH_REPUTATION_MAX_ROOTS = 16
export const GRAPH_REPUTATION_MAX_NODES = 256
export const GRAPH_REPUTATION_MAX_EDGES = 4_096
export const GRAPH_REPUTATION_MAX_PATH_DEPTH = 8
export const GRAPH_REPUTATION_PROBATION_SECONDS = 30n * 24n * 60n * 60n

export type GraphReputationRoot = {
  lineageId: Hex
  weight: bigint
}

export type GraphReputationNode = {
  lineageId: Hex
  configurationId: Hex
  epochId: Hex
  familyId: Hex
  methodId: Hex
  controller: Address
  authority: Address
  createdAt: bigint
  epochAcceptedBlock: bigint
  epochPublishedBlock: bigint
}

export type GraphReputationEdge = {
  endorsementId: Hex
  issuerLineageId: Hex
  subjectLineageId: Hex
  issuerConfigurationId: Hex
  subjectConfigurationId: Hex
  scopeHash: Hex
  weight: bigint
  validFrom: bigint
  validUntil: bigint
  issuedBlock: bigint
  evidenceDigest: Hex
  revokedAt: bigint | null
  supersededBy: Hex | null
}

export type GraphReputationInput = {
  version: number
  chainId: bigint
  registry: Address
  scopeHash: Hex
  cutoffBlock: bigint
  finalizedBlock: bigint
  cutoffTimestamp: bigint
  roots: GraphReputationRoot[]
  nodes: GraphReputationNode[]
  edges: GraphReputationEdge[]
}

export type GraphReputationPath = {
  rootLineageId: Hex
  lineageIds: Hex[]
  endorsementIds: Hex[]
  strength: bigint
}

export type GraphReputationResult = {
  inputCommitment: Hex
  resultCommitment: Hex
  iterations: number
  residual: bigint
  converged: boolean
  scores: Array<{
    lineageId: Hex
    score: bigint
    rank: number
    familyId: Hex
    familyMass: bigint
    rootIngress: Array<{ rootLineageId: Hex; mass: bigint }>
    paths: GraphReputationPath[]
  }>
  families: Array<{ familyId: Hex; mass: bigint }>
  matrix: Array<{
    issuerLineageId: Hex
    spent: bigint
    unused: bigint
    referrals: Array<{
      endorsementId: Hex
      subjectLineageId: Hex
      weight: bigint
      validUntil: bigint
    }>
  }>
}

type HamiltonEntry<T> = { key: string; weight: bigint; data: T }

const compareKey = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const fail = (code: string): never => {
  throw new Error(`graph-reputation: ${code}`)
}

const assertWord = (value: Hex, code: string) => {
  if (
    !isHex(value) ||
    value.length !== 66 ||
    value !== value.toLowerCase() ||
    value === zeroHash
  )
    fail(code)
}

const assertBytes32 = (value: Hex, code: string) => {
  if (!isHex(value) || value.length !== 66 || value !== value.toLowerCase())
    fail(code)
}

const hamilton = <T>(total: bigint, entries: HamiltonEntry<T>[]) => {
  if (total < 0n || entries.length === 0) fail('invalid-hamilton-input')
  const denominator = entries.reduce((sum, entry) => {
    if (entry.weight < 0n) fail('negative-hamilton-weight')
    return sum + entry.weight
  }, 0n)
  if (denominator === 0n) fail('zero-hamilton-denominator')
  const seen = new Set<string>()
  const rows = entries.map((entry) => {
    if (seen.has(entry.key)) fail('duplicate-hamilton-key')
    seen.add(entry.key)
    const product = total * entry.weight
    return {
      ...entry,
      allocation: product / denominator,
      remainder: product % denominator,
    }
  })
  let unallocated = total - rows.reduce((sum, row) => sum + row.allocation, 0n)
  const order = [...rows].sort((left, right) =>
    left.remainder === right.remainder
      ? compareKey(left.key, right.key)
      : left.remainder > right.remainder
        ? -1
        : 1
  )
  for (let index = 0; unallocated > 0n; index++, unallocated--) {
    order[index]!.allocation++
  }
  return rows
}

export const normalizeGraphWeights = <T>(
  entries: Array<{ key: Hex; weight: bigint; data: T }>
) =>
  hamilton(
    GRAPH_REPUTATION_SCALE,
    entries.map((entry) => ({ ...entry, key: entry.key }))
  ).map(({ data, allocation }) => ({ data, weight: allocation }))

class ByteWriter {
  private readonly values: number[] = []

  ascii(value: string) {
    for (const byte of new TextEncoder().encode(value)) this.values.push(byte)
  }

  hex(value: Hex, bytes: number) {
    const decoded = hexToBytes(value)
    if (decoded.length !== bytes) fail('invalid-encoded-hex')
    this.values.push(...decoded)
  }

  uint(value: bigint, bytes: number) {
    if (value < 0n || value >= 1n << BigInt(bytes * 8))
      fail('integer-does-not-fit-encoding')
    for (let shift = bytes - 1; shift >= 0; shift--)
      this.values.push(Number((value >> BigInt(shift * 8)) & 0xffn))
  }

  finish() {
    return Uint8Array.from(this.values)
  }
}

const canonicalInput = (input: GraphReputationInput) => ({
  ...input,
  roots: [...input.roots].sort((left, right) =>
    compareKey(left.lineageId, right.lineageId)
  ),
  nodes: [...input.nodes].sort((left, right) =>
    compareKey(left.lineageId, right.lineageId)
  ),
  edges: [...input.edges].sort((left, right) => {
    const issuer = compareKey(left.issuerLineageId, right.issuerLineageId)
    if (issuer !== 0) return issuer
    const subject = compareKey(left.subjectLineageId, right.subjectLineageId)
    return subject !== 0
      ? subject
      : compareKey(left.endorsementId, right.endorsementId)
  }),
})

const validateInput = (input: GraphReputationInput) => {
  if (input.version !== GRAPH_REPUTATION_VERSION) fail('unsupported-version')
  if (input.chainId <= 0n) fail('invalid-chain')
  if (!isAddress(input.registry) || input.registry === zeroAddress)
    fail('invalid-registry')
  assertWord(input.scopeHash, 'invalid-scope')
  if (
    input.cutoffBlock <= 0n ||
    input.cutoffTimestamp <= 0n ||
    input.cutoffBlock > input.finalizedBlock
  )
    fail('unfinalized-cutoff')
  if (
    input.roots.length === 0 ||
    input.roots.length > GRAPH_REPUTATION_MAX_ROOTS
  )
    fail('invalid-root-count')
  if (
    input.nodes.length === 0 ||
    input.nodes.length > GRAPH_REPUTATION_MAX_NODES
  )
    fail('invalid-node-count')
  if (input.edges.length > GRAPH_REPUTATION_MAX_EDGES)
    fail('edge-limit-exceeded')

  const nodeById = new Map<Hex, GraphReputationNode>()
  for (const node of input.nodes) {
    assertWord(node.lineageId, 'invalid-lineage-id')
    assertWord(node.configurationId, 'invalid-configuration-id')
    assertWord(node.epochId, 'invalid-epoch-id')
    assertWord(node.familyId, 'invalid-family-id')
    assertWord(node.methodId, 'invalid-method-id')
    if (
      !isAddress(node.controller) ||
      node.controller === zeroAddress ||
      !isAddress(node.authority) ||
      node.authority === zeroAddress
    )
      fail('invalid-authority-provenance')
    if (nodeById.has(node.lineageId)) fail('duplicate-lineage')
    if (
      node.createdAt > input.cutoffTimestamp ||
      node.epochAcceptedBlock >= input.cutoffBlock ||
      node.epochPublishedBlock >= input.cutoffBlock
    )
      fail('same-or-future-epoch')
    nodeById.set(node.lineageId, node)
  }

  const rootIds = new Set<Hex>()
  let priorMass = 0n
  for (const root of input.roots) {
    if (!nodeById.has(root.lineageId)) fail('root-history-unavailable')
    if (rootIds.has(root.lineageId)) fail('duplicate-root')
    if (root.weight <= 0n || root.weight > GRAPH_REPUTATION_SCALE)
      fail('invalid-root-weight')
    rootIds.add(root.lineageId)
    priorMass += root.weight
  }
  if (priorMass !== GRAPH_REPUTATION_SCALE) fail('invalid-root-mass')

  const edgeIds = new Set<Hex>()
  const pairs = new Set<string>()
  const issuerSpend = new Map<Hex, bigint>()
  for (const edge of input.edges) {
    assertWord(edge.endorsementId, 'invalid-endorsement-id')
    if (edgeIds.has(edge.endorsementId)) fail('duplicate-endorsement')
    edgeIds.add(edge.endorsementId)
    const issuer = nodeById.get(edge.issuerLineageId)
    const subject = nodeById.get(edge.subjectLineageId)
    if (!issuer || !subject) return fail('edge-history-unavailable')
    if (issuer.lineageId === subject.lineageId) fail('self-referral')
    if (edge.issuerConfigurationId !== issuer.configurationId)
      fail('wrong-issuer-version')
    if (edge.subjectConfigurationId !== subject.configurationId)
      fail('wrong-subject-version')
    if (edge.scopeHash !== input.scopeHash) fail('wrong-scope')
    if (edge.weight <= 0n || edge.weight > GRAPH_REPUTATION_SCALE)
      fail('invalid-referral-weight')
    if (
      edge.issuedBlock >= input.cutoffBlock ||
      edge.validFrom > input.cutoffTimestamp ||
      edge.validUntil <= input.cutoffTimestamp
    )
      fail('inactive-at-cutoff')
    if (edge.revokedAt !== null) fail('revoked-edge')
    if (edge.supersededBy !== null) fail('superseded-edge')
    // A zero digest is intentionally allowed: evidence mutability is provenance that consumers
    // must surface, not permission to silently remove an otherwise valid referral from the graph.
    assertBytes32(edge.evidenceDigest, 'invalid-evidence-digest')
    const pair = `${edge.issuerLineageId}:${edge.subjectLineageId}`
    if (pairs.has(pair)) fail('duplicate-referral-pair')
    pairs.add(pair)
    const spend = (issuerSpend.get(edge.issuerLineageId) ?? 0n) + edge.weight
    if (spend > GRAPH_REPUTATION_SCALE) fail('referral-budget-exceeded')
    issuerSpend.set(edge.issuerLineageId, spend)
  }
}

export const encodeGraphReputationInput = (raw: GraphReputationInput) => {
  const input = canonicalInput(raw)
  validateInput(input)
  const writer = new ByteWriter()
  writer.ascii('TGRP')
  writer.uint(BigInt(input.version), 2)
  writer.uint(GRAPH_REPUTATION_SCALE, 8)
  writer.uint(GRAPH_REPUTATION_LAMBDA, 8)
  writer.uint(BigInt(GRAPH_REPUTATION_ITERATIONS), 2)
  writer.uint(input.chainId, 8)
  writer.hex(input.registry, 20)
  writer.hex(input.scopeHash, 32)
  writer.uint(input.cutoffBlock, 8)
  writer.uint(input.finalizedBlock, 8)
  writer.uint(input.cutoffTimestamp, 8)
  writer.uint(BigInt(input.roots.length), 2)
  writer.uint(BigInt(input.nodes.length), 2)
  writer.uint(BigInt(input.edges.length), 4)
  for (const root of input.roots) {
    writer.hex(root.lineageId, 32)
    writer.uint(root.weight, 8)
  }
  for (const node of input.nodes) {
    writer.hex(node.lineageId, 32)
    writer.hex(node.configurationId, 32)
    writer.hex(node.epochId, 32)
    writer.hex(node.familyId, 32)
    writer.hex(node.methodId, 32)
    writer.hex(node.controller, 20)
    writer.hex(node.authority, 20)
    writer.uint(node.createdAt, 8)
    writer.uint(node.epochAcceptedBlock, 8)
    writer.uint(node.epochPublishedBlock, 8)
  }
  for (const edge of input.edges) {
    writer.hex(edge.endorsementId, 32)
    writer.hex(edge.issuerLineageId, 32)
    writer.hex(edge.subjectLineageId, 32)
    writer.hex(edge.issuerConfigurationId, 32)
    writer.hex(edge.subjectConfigurationId, 32)
    writer.hex(edge.scopeHash, 32)
    writer.uint(edge.weight, 8)
    writer.uint(edge.validFrom, 8)
    writer.uint(edge.validUntil, 8)
    writer.uint(edge.issuedBlock, 8)
    writer.hex(edge.evidenceDigest, 32)
    writer.uint(edge.revokedAt ?? 0n, 8)
    writer.hex(edge.supersededBy ?? zeroHash, 32)
  }
  return writer.finish()
}

const strongestPaths = (
  input: ReturnType<typeof canonicalInput>,
  outgoing: Array<Array<{ edge: GraphReputationEdge; to: number }>>,
  nodeIndex: Map<Hex, number>
) => {
  const paths = new Map<Hex, GraphReputationPath[]>()
  for (const root of input.roots) {
    const best = new Map<number, GraphReputationPath>()
    const rootIndex = nodeIndex.get(root.lineageId)!
    best.set(rootIndex, {
      rootLineageId: root.lineageId,
      lineageIds: [root.lineageId],
      endorsementIds: [],
      strength: root.weight,
    })
    for (let depth = 0; depth < GRAPH_REPUTATION_MAX_PATH_DEPTH; depth++) {
      let changed = false
      for (const [from, path] of [...best]) {
        if (path.endorsementIds.length !== depth) continue
        for (const { edge, to } of outgoing[from]!) {
          if (path.lineageIds.includes(edge.subjectLineageId)) continue
          const candidate: GraphReputationPath = {
            rootLineageId: root.lineageId,
            lineageIds: [...path.lineageIds, edge.subjectLineageId],
            endorsementIds: [...path.endorsementIds, edge.endorsementId],
            strength: (path.strength * edge.weight) / GRAPH_REPUTATION_SCALE,
          }
          const previous = best.get(to)
          const candidateKey = candidate.endorsementIds.join(':')
          const previousKey = previous?.endorsementIds.join(':') ?? ''
          if (
            !previous ||
            candidate.strength > previous.strength ||
            (candidate.strength === previous.strength &&
              compareKey(candidateKey, previousKey) < 0)
          ) {
            best.set(to, candidate)
            changed = true
          }
        }
      }
      if (!changed) break
    }
    for (const [index, path] of best) {
      const lineageId = input.nodes[index]!.lineageId
      paths.set(lineageId, [...(paths.get(lineageId) ?? []), path])
    }
  }
  return paths
}

export const graphReputationL1 = (
  left: GraphReputationResult,
  right: GraphReputationResult
) => {
  const leftById = new Map(
    left.scores.map((entry) => [entry.lineageId, entry.score])
  )
  const rightById = new Map(
    right.scores.map((entry) => [entry.lineageId, entry.score])
  )
  return [...new Set([...leftById.keys(), ...rightById.keys()])].reduce(
    (sum, lineageId) => {
      const leftScore = leftById.get(lineageId) ?? 0n
      const rightScore = rightById.get(lineageId) ?? 0n
      return (
        sum +
        (leftScore >= rightScore
          ? leftScore - rightScore
          : rightScore - leftScore)
      )
    },
    0n
  )
}

export const computeGraphReputation = (
  raw: GraphReputationInput
): GraphReputationResult => {
  const input = canonicalInput(raw)
  const encodedInput = encodeGraphReputationInput(input)
  const inputCommitment = keccak256(bytesToHex(encodedInput))
  const nodeIndex = new Map(
    input.nodes.map((node, index) => [node.lineageId, index])
  )
  const rootIndex = new Map(
    input.roots.map((root, index) => [root.lineageId, index])
  )
  const outgoing = input.nodes.map(
    () => [] as Array<{ edge: GraphReputationEdge; to: number }>
  )
  const spent = new Map<Hex, bigint>()
  for (const edge of input.edges) {
    const from = nodeIndex.get(edge.issuerLineageId)!
    outgoing[from]!.push({ edge, to: nodeIndex.get(edge.subjectLineageId)! })
    spent.set(
      edge.issuerLineageId,
      (spent.get(edge.issuerLineageId) ?? 0n) + edge.weight
    )
  }

  let state = input.nodes.map(() => input.roots.map(() => 0n))
  for (const root of input.roots) {
    state[nodeIndex.get(root.lineageId)!]![rootIndex.get(root.lineageId)!] =
      root.weight
  }
  const teleport = hamilton(
    GRAPH_REPUTATION_SCALE - GRAPH_REPUTATION_LAMBDA,
    input.roots.map((root, index) => ({
      key: root.lineageId,
      weight: root.weight,
      data: index,
    }))
  )
  let residual = GRAPH_REPUTATION_SCALE
  for (
    let iteration = 0;
    iteration < GRAPH_REPUTATION_ITERATIONS;
    iteration++
  ) {
    const next = input.nodes.map(() => input.roots.map(() => 0n))
    for (const allocation of teleport) {
      const root = input.roots[allocation.data]!
      const rootState = next[nodeIndex.get(root.lineageId)!]!
      rootState[allocation.data] =
        rootState[allocation.data]! + allocation.allocation
    }
    const cells: HamiltonEntry<{ node: number; root: number }>[] = []
    for (let node = 0; node < input.nodes.length; node++) {
      for (let root = 0; root < input.roots.length; root++) {
        const weight = state[node]![root]!
        if (weight > 0n)
          cells.push({
            key: `${input.nodes[node]!.lineageId}:${input.roots[root]!.lineageId}`,
            weight,
            data: { node, root },
          })
      }
    }
    for (const cell of hamilton(GRAPH_REPUTATION_LAMBDA, cells)) {
      const row = outgoing[cell.data.node]!
      const rowSpend = row.reduce((sum, item) => sum + item.edge.weight, 0n)
      const routes: HamiltonEntry<
        { type: 'edge'; to: number } | { type: 'prior' }
      >[] = row.map(({ edge, to }) => ({
        key: `e:${edge.subjectLineageId}:${edge.endorsementId}`,
        weight: edge.weight,
        data: { type: 'edge', to },
      }))
      if (rowSpend < GRAPH_REPUTATION_SCALE)
        routes.push({
          key: 'p',
          weight: GRAPH_REPUTATION_SCALE - rowSpend,
          data: { type: 'prior' },
        })
      for (const routed of hamilton(cell.allocation, routes)) {
        if (routed.data.type === 'edge') {
          const subjectState = next[routed.data.to]!
          subjectState[cell.data.root] =
            subjectState[cell.data.root]! + routed.allocation
          continue
        }
        if (routed.allocation === 0n) continue
        for (const returned of hamilton(
          routed.allocation,
          input.roots.map((root, index) => ({
            key: root.lineageId,
            weight: root.weight,
            data: index,
          }))
        )) {
          const root = input.roots[returned.data]!
          const rootState = next[nodeIndex.get(root.lineageId)!]!
          rootState[returned.data] =
            rootState[returned.data]! + returned.allocation
        }
      }
    }
    const before = state.map((row) =>
      row.reduce((sum, value) => sum + value, 0n)
    )
    const after = next.map((row) => row.reduce((sum, value) => sum + value, 0n))
    residual = after.reduce((sum, value, index) => {
      const previous = before[index]!
      return sum + (value >= previous ? value - previous : previous - value)
    }, 0n)
    state = next
  }

  const nodeScores = state.map((row) =>
    row.reduce((sum, value) => sum + value, 0n)
  )
  if (
    nodeScores.reduce((sum, value) => sum + value, 0n) !==
    GRAPH_REPUTATION_SCALE
  )
    fail('mass-not-conserved')
  const ranks = [...input.nodes.keys()].sort((left, right) =>
    nodeScores[left] === nodeScores[right]
      ? compareKey(input.nodes[left]!.lineageId, input.nodes[right]!.lineageId)
      : nodeScores[left]! > nodeScores[right]!
        ? -1
        : 1
  )
  const rankByIndex = new Map(ranks.map((index, rank) => [index, rank + 1]))
  const familyMass = new Map<Hex, bigint>()
  for (let index = 0; index < input.nodes.length; index++) {
    const family = input.nodes[index]!.familyId
    familyMass.set(family, (familyMass.get(family) ?? 0n) + nodeScores[index]!)
  }
  const families = [...familyMass]
    .sort(([left], [right]) => compareKey(left, right))
    .map(([familyId, mass]) => ({ familyId, mass }))
  const paths = strongestPaths(input, outgoing, nodeIndex)
  const scores = input.nodes.map((node, index) => ({
    lineageId: node.lineageId,
    score: nodeScores[index]!,
    rank: rankByIndex.get(index)!,
    familyId: node.familyId,
    familyMass: familyMass.get(node.familyId)!,
    rootIngress: input.roots.map((root, rootPosition) => ({
      rootLineageId: root.lineageId,
      mass: state[index]![rootPosition]!,
    })),
    paths: (paths.get(node.lineageId) ?? []).sort((left, right) =>
      compareKey(left.rootLineageId, right.rootLineageId)
    ),
  }))

  const writer = new ByteWriter()
  writer.ascii('TGRR')
  writer.uint(BigInt(GRAPH_REPUTATION_VERSION), 2)
  writer.hex(inputCommitment, 32)
  writer.uint(BigInt(GRAPH_REPUTATION_ITERATIONS), 2)
  writer.uint(residual, 8)
  writer.uint(residual <= GRAPH_REPUTATION_ERROR_BOUND ? 1n : 0n, 1)
  writer.uint(BigInt(scores.length), 2)
  writer.uint(BigInt(input.roots.length), 2)
  writer.uint(BigInt(families.length), 2)
  for (const score of scores) {
    writer.hex(score.lineageId, 32)
    writer.uint(score.score, 8)
    writer.uint(BigInt(score.rank), 4)
    writer.hex(score.familyId, 32)
    writer.uint(score.familyMass, 8)
    for (const ingress of score.rootIngress) writer.uint(ingress.mass, 8)
  }
  for (const family of families) {
    writer.hex(family.familyId, 32)
    writer.uint(family.mass, 8)
  }
  const resultCommitment = keccak256(bytesToHex(writer.finish()))
  return {
    inputCommitment,
    resultCommitment,
    iterations: GRAPH_REPUTATION_ITERATIONS,
    residual,
    converged: residual <= GRAPH_REPUTATION_ERROR_BOUND,
    scores,
    families,
    matrix: input.nodes.map((node, index) => ({
      issuerLineageId: node.lineageId,
      spent: spent.get(node.lineageId) ?? 0n,
      unused: GRAPH_REPUTATION_SCALE - (spent.get(node.lineageId) ?? 0n),
      referrals: outgoing[index]!.map(({ edge }) => ({
        endorsementId: edge.endorsementId,
        subjectLineageId: edge.subjectLineageId,
        weight: edge.weight,
        validUntil: edge.validUntil,
      })),
    })),
  }
}
