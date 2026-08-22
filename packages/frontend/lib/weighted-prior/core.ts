//! TypeScript mirror of `crates/weighted-prior-core`.

import {
  type Hex,
  bytesToHex,
  concat,
  hexToBytes,
  keccak256,
  sha256,
  stringToBytes,
  toHex,
} from 'viem'

import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from '../pagerank/cid'
import { accumulate, decodeWeight, journalEncoded } from '../pagerank/encode'
import { merkleRoot, outputLeaf } from '../pagerank/merkle'
import { type Binding, type Journal, type RawEdge } from '../pagerank/types'
import {
  ZERO_ADDRESS,
  ZERO_HASH,
  cmpBig,
  cmpHex,
  wordAddr,
  wordU256,
  wordU32,
  wordU64,
} from '../pagerank/words'

export const SCALE = 1_000_000_000_000_000_000n
export const MAX_PRIOR_ENTRIES = 2_048

export interface RawPriorEntry {
  account: Hex
  weight: string
}

export interface PriorEntry {
  account: Hex
  weight: bigint
}

export interface Params {
  version: number
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeight: bigint
  maxWeight: bigint
  priorRoot: Hex
  priorCount: number
  manifestSha256: Hex
  schemaUid: Hex
  weightFieldIndex: number
  accumulator: Hex
  chainId: bigint
}

export interface GuestInput {
  edges: RawEdge[]
  params: Params
  manifest: Hex
  binding?: Binding
}

export interface ComputeResult {
  journal: Journal
  scores: Array<[Hex, bigint]>
  blob: string
  cid: string
  iterations: number
}

interface Graph {
  nodes: Hex[]
  outgoing: Map<string, Map<string, bigint>>
}

const canonicalAddress = (address: Hex): Hex => address.toLowerCase() as Hex

const parseDecimal = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$/.test(value)) {
    throw new Error(`non-canonical positive decimal: ${value}`)
  }
  const [whole, fractional = ''] = value.split('.')
  const parsed =
    BigInt(whole) * SCALE + BigInt(fractional.padEnd(18, '0') || '0')
  if (parsed === 0n) throw new Error('zero prior weight')
  return parsed
}

export const apportion = (
  items: Array<[Hex, bigint]>,
  budget: bigint,
  denominator: bigint
): Map<Hex, bigint> => {
  if (items.length === 0 || denominator <= 0n)
    throw new Error('invalid apportionment')
  const seen = new Set<string>()
  let sum = 0n
  const rows = items.map(([rawAccount, numerator]) => {
    const account = canonicalAddress(rawAccount)
    if (seen.has(account)) throw new Error('duplicate apportionment account')
    seen.add(account)
    sum += numerator
    const product = numerator * budget
    return {
      account,
      value: product / denominator,
      remainder: product % denominator,
    }
  })
  if (sum !== denominator) throw new Error('apportionment denominator mismatch')
  let missing = budget - rows.reduce((total, row) => total + row.value, 0n)
  rows.sort((a, b) => {
    const remainder = cmpBig(b.remainder, a.remainder)
    return remainder !== 0 ? remainder : cmpHex(a.account, b.account)
  })
  for (const row of rows) {
    if (missing === 0n) break
    row.value++
    missing--
  }
  if (missing !== 0n) throw new Error('invalid Hamilton remainder')
  rows.sort((a, b) => cmpHex(a.account, b.account))
  return new Map(rows.map((row) => [row.account, row.value]))
}

export const normalize = (raw: RawPriorEntry[]): PriorEntry[] => {
  if (raw.length === 0 || raw.length > MAX_PRIOR_ENTRIES)
    throw new Error('invalid prior count')
  const parsed = raw
    .map(
      (entry) =>
        [canonicalAddress(entry.account), parseDecimal(entry.weight)] as [
          Hex,
          bigint,
        ]
    )
    .sort((a, b) => cmpHex(a[0], b[0]))
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i][0] === ZERO_ADDRESS) throw new Error('zero prior account')
    if (i > 0 && parsed[i - 1][0] === parsed[i][0])
      throw new Error('duplicate prior account')
  }
  const total = parsed.reduce((sum, [, value]) => sum + value, 0n)
  const apportioned = apportion(parsed, SCALE, total)
  return parsed.map(([account]) => {
    const weight = apportioned.get(account)!
    if (weight === 0n) throw new Error('positive prior normalized to zero')
    return { account, weight }
  })
}

export const priorLeaf = (entry: PriorEntry): Hex =>
  keccak256(concat([wordAddr(entry.account), wordU256(entry.weight)]))

const hashPair = (a: Hex, b: Hex): Hex =>
  keccak256(concat(cmpHex(a, b) <= 0 ? [a, b] : [b, a]))

const validatePrior = (entries: PriorEntry[]): void => {
  if (entries.length === 0 || entries.length > MAX_PRIOR_ENTRIES)
    throw new Error('invalid prior count')
  let total = 0n
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.account === ZERO_ADDRESS || entry.weight <= 0n)
      throw new Error('invalid prior entry')
    if (i > 0 && cmpHex(entries[i - 1].account, entry.account) >= 0) {
      throw new Error('prior not strictly address sorted')
    }
    total += entry.weight
  }
  if (total !== SCALE) throw new Error('prior sum is not 1e18')
}

export const priorRoot = (entries: PriorEntry[]): Hex => {
  validatePrior(entries)
  let level = entries.map(priorLeaf)
  while (level.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 === level.length ? level[i] : hashPair(level[i], level[i + 1])
      )
    }
    level = next
  }
  return level[0]
}

export const canonicalManifest = (
  chainId: bigint,
  entries: PriorEntry[]
): Hex => {
  validatePrior(entries)
  return concat([
    '0x54475750',
    toHex(1, { size: 2 }),
    toHex(chainId, { size: 8 }),
    toHex(entries.length, { size: 4 }),
    ...entries.flatMap((entry) => [
      entry.account,
      toHex(entry.weight, { size: 8 }),
    ]),
  ])
}

export const parseManifest = (
  manifest: Hex
): { chainId: bigint; entries: PriorEntry[] } => {
  const bytes = hexToBytes(manifest)
  if (bytes.length < 18 || bytesToHex(bytes.slice(0, 4)) !== '0x54475750') {
    throw new Error('invalid TGWP manifest header')
  }
  const read = (start: number, end: number): bigint =>
    BigInt(bytesToHex(bytes.slice(start, end)))
  if (read(4, 6) !== 1n) throw new Error('unsupported TGWP version')
  const chainId = read(6, 14)
  const count = Number(read(14, 18))
  if (
    count < 1 ||
    count > MAX_PRIOR_ENTRIES ||
    bytes.length !== 18 + count * 28
  ) {
    throw new Error('invalid TGWP count/length')
  }
  const entries: PriorEntry[] = []
  for (let i = 0; i < count; i++) {
    const start = 18 + i * 28
    entries.push({
      account: bytesToHex(bytes.slice(start, start + 20)),
      weight: read(start + 20, start + 28),
    })
  }
  validatePrior(entries)
  return { chainId, entries }
}

export const paramsEncoded = (params: Params): Hex =>
  concat([
    wordU32(params.version),
    wordU64(params.dampingFp),
    wordU64(params.toleranceFp),
    wordU32(params.maxIterations),
    wordU64(params.minWeight),
    wordU64(params.maxWeight),
    params.priorRoot,
    wordU32(params.priorCount),
    params.manifestSha256,
    params.schemaUid,
    wordU32(params.weightFieldIndex),
    wordAddr(params.accumulator),
    wordU64(params.chainId),
  ])

export const paramsHash = (params: Params): Hex =>
  keccak256(paramsEncoded(params))

const buildGraph = (edges: RawEdge[], params: Params): Graph => {
  const ordered = edges.map((edge, index) => ({ edge, index }))
  ordered.sort((a, b) => {
    const time = cmpBig(a.edge.blockTimestamp, b.edge.blockTimestamp)
    return time !== 0 ? time : a.index - b.index
  })
  const current = new Map<
    string,
    Map<string, { uid: string; weight: bigint }>
  >()
  for (const { edge } of ordered) {
    const source = canonicalAddress(edge.attester)
    const target = canonicalAddress(edge.recipient)
    if (edge.kind === 0) {
      let row = current.get(source)
      if (!row) {
        row = new Map()
        current.set(source, row)
      }
      const decoded = decodeWeight(edge.data, params.weightFieldIndex) ?? 0n
      const weight =
        decoded > params.maxWeight
          ? params.maxWeight
          : decoded < params.minWeight
            ? params.minWeight
            : decoded
      row.set(target, { uid: edge.uid.toLowerCase(), weight })
    } else if (edge.kind === 1) {
      const row = current.get(source)
      if (row?.get(target)?.uid === edge.uid.toLowerCase()) {
        row.delete(target)
        if (row.size === 0) current.delete(source)
      }
    }
  }
  const nodeSet = new Set<string>()
  const outgoing = new Map<string, Map<string, bigint>>()
  for (const [source, row] of current) {
    nodeSet.add(source)
    const weights = new Map<string, bigint>()
    for (const [target, edge] of row) {
      nodeSet.add(target)
      weights.set(target, edge.weight)
    }
    outgoing.set(source, weights)
  }
  return {
    nodes: [...nodeSet].sort((a, b) => cmpHex(a as Hex, b as Hex)) as Hex[],
    outgoing,
  }
}

const rank = (
  graph: Graph,
  prior: PriorEntry[],
  params: Params
): { scores: Map<string, bigint>; iterations: number } => {
  const priorMap = new Map(prior.map((entry) => [entry.account, entry.weight]))
  const nodes = [...new Set([...priorMap.keys(), ...graph.nodes])].sort(
    (a, b) => cmpHex(a as Hex, b as Hex)
  ) as Hex[]
  let current = new Map(nodes.map((node) => [node, priorMap.get(node) ?? 0n]))
  for (let iteration = 1; iteration <= params.maxIterations; iteration++) {
    const sourceBudgets = apportion(
      nodes.map((node) => [node, current.get(node)!]),
      params.dampingFp,
      SCALE
    )
    const next = new Map(nodes.map((node) => [node, 0n]))
    let dangling = 0n
    for (const [source, budget] of sourceBudgets) {
      const transition = [...(graph.outgoing.get(source)?.entries() ?? [])]
        .filter(([target, weight]) => target !== source && weight > 0n)
        .map(([target, weight]) => [target as Hex, weight] as [Hex, bigint])
      if (transition.length === 0) {
        dangling += budget
        continue
      }
      const denominator = transition.reduce(
        (sum, [, weight]) => sum + weight,
        0n
      )
      for (const [target, contribution] of apportion(
        transition,
        budget,
        denominator
      )) {
        next.set(target, (next.get(target) ?? 0n) + contribution)
      }
    }
    const priorBudget = SCALE - params.dampingFp + dangling
    for (const [account, contribution] of apportion(
      prior.map((entry) => [entry.account, entry.weight]),
      priorBudget,
      SCALE
    )) {
      next.set(account, (next.get(account) ?? 0n) + contribution)
    }
    if ([...next.values()].reduce((sum, value) => sum + value, 0n) !== SCALE) {
      throw new Error('rank iteration did not conserve mass')
    }
    let maxDelta = 0n
    for (const node of nodes) {
      const previous = current.get(node)!
      const following = next.get(node)!
      const delta =
        previous > following ? previous - following : following - previous
      if (delta > maxDelta) maxDelta = delta
    }
    current = next
    if (maxDelta < params.toleranceFp)
      return { scores: current, iterations: iteration }
  }
  return { scores: current, iterations: params.maxIterations }
}

export const compute = (input: GuestInput): ComputeResult => {
  const parsed = parseManifest(input.manifest)
  if (parsed.chainId !== input.params.chainId)
    throw new Error('manifest chain mismatch')
  if (parsed.entries.length !== input.params.priorCount)
    throw new Error('manifest count mismatch')
  if (priorRoot(parsed.entries) !== input.params.priorRoot)
    throw new Error('prior root mismatch')
  if (sha256(input.manifest) !== input.params.manifestSha256)
    throw new Error('manifest digest mismatch')

  const { acc, leafCount } = accumulate(input.edges)
  const ranked = rank(
    buildGraph(input.edges, input.params),
    parsed.entries,
    input.params
  )
  const scores = [...ranked.scores.entries()]
    .filter(([, value]) => value > 0n)
    .map(([account, value]) => [account as Hex, value] as [Hex, bigint])
    .sort((a, b) => cmpHex(a[0], b[0]))
  const outputRoot = merkleRoot(
    scores.map(([account, value]) => outputLeaf(account, value))
  )
  const blob = canonicalBlob(scores)
  const digest = sha256Utf8(blob)
  const ipfsHash = digestToHex(digest)
  const cid = cidV1Raw(digest)
  const journal: Journal = {
    acc,
    leafCount,
    anchorAcc: ZERO_HASH,
    anchorCount: 0n,
    paramsHash: paramsHash(input.params),
    outputRoot,
    ipfsHash,
    cidDigest: keccak256(stringToBytes(cid)),
    totalValue: SCALE,
    skippedDigest: ZERO_HASH,
    recipient: input.binding?.recipient ?? ZERO_ADDRESS,
    instanceDomain: input.binding?.instanceDomain ?? ZERO_HASH,
  }
  journalEncoded(journal)
  return { journal, scores, blob, cid, iterations: ranked.iterations }
}
