//! Fixed-point Trust-Aware PageRank. A structural port of `pagerank_core::pagerank` (scores scaled
//! by S), with all arithmetic in integer `bigint`.

import { type Hex } from 'viem'

import { checkedAdd, fpDiv, fpMul } from './fixed'
import { type Graph } from './reconcile'
import { type Params, hasTrustEnabled } from './types'
import { cmpHex } from './words'

const isSeed = (seeds: Set<string>, a: string): boolean => seeds.has(a)

/**
 * Initial scores (scaled by S). No trust ⇒ uniform `S/n`. With trust, seeds share
 * `trustShare` and only reachable non-seeds share the remainder.
 */
const initializeScores = (
  nodes: string[],
  p: Params,
  seeds: Set<string>,
  reachable: Map<string, bigint> | null
): Map<string, bigint> => {
  const n = nodes.length
  const s = p.precisionScale
  const out = new Map<string, bigint>()
  if (n === 0) return out

  if (!hasTrustEnabled(p)) {
    const init = s / BigInt(n)
    for (const node of nodes) out.set(node, init)
    return out
  }

  const trustedCount = seeds.size
  const regularCount = reachable
    ? Array.from(reachable.keys()).filter((node) => !isSeed(seeds, node))
        .length
    : 0
  const trustedTotal = p.trustShareFp
  const regularTotal = s - p.trustShareFp
  const trustedScore =
    trustedCount > 0 ? trustedTotal / BigInt(trustedCount) : 0n
  const regularScore =
    regularCount > 0 ? regularTotal / BigInt(regularCount) : 0n
  for (const node of nodes) {
    out.set(
      node,
      isSeed(seeds, node)
        ? trustedScore
        : reachable?.has(node)
          ? regularScore
          : 0n
    )
  }
  return out
}

/** Multi-source BFS carrying the exact fixed-point decay along each shortest-path frontier. */
const bfsDecays = (
  graph: Graph,
  seeds: Set<string>,
  baseFp: bigint,
  scale: bigint
): Map<string, bigint> => {
  const decays = new Map<string, bigint>()
  const queue: string[] = []
  const sortedSeeds = Array.from(seeds).sort((a, b) =>
    cmpHex(a as Hex, b as Hex)
  )
  for (const seed of sortedSeeds) {
    decays.set(seed, scale)
    queue.push(seed)
  }
  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    if (current === undefined) break
    const parentDecay = decays.get(current)
    if (parentDecay === undefined) continue
    const edges = graph.outgoing.get(current)
    if (edges) {
      let childDecay: bigint | undefined
      const neighbors = Array.from(edges.keys()).sort((a, b) =>
        cmpHex(a as Hex, b as Hex)
      )
      for (const neighbor of neighbors) {
        if (!decays.has(neighbor)) {
          childDecay ??= fpMul(parentDecay, baseFp, scale)
          decays.set(neighbor, childDecay)
          queue.push(neighbor)
        }
      }
    }
  }
  return decays
}

const assertEdgeClosure = (graph: Graph, rankNodes: string[]): void => {
  const nodes = new Set(rankNodes)
  for (const [source, row] of graph.outgoing) {
    if (!nodes.has(source)) {
      throw new Error('rank: edge source missing from node set')
    }
    for (const target of row.keys()) {
      if (!nodes.has(target)) {
        throw new Error('rank: edge target missing from node set')
      }
    }
  }
}

const normalize = (
  scores: Map<string, bigint>,
  scale: bigint,
  reachable: Map<string, bigint> | null
): void => {
  let total = 0n
  for (const value of scores.values()) {
    total = checkedAdd(total, value, 'rank: score total')
  }
  if (total !== 0n) {
    for (const [node, value] of scores) {
      scores.set(node, fpDiv(value, total, scale))
    }
  }
  if (scores.size === 0) return

  let normalizedTotal = 0n
  for (const value of scores.values()) {
    normalizedTotal = checkedAdd(
      normalizedTotal,
      value,
      'rank: normalized score total'
    )
  }
  if (normalizedTotal > scale) {
    throw new Error('rank: normalized score total exceeded precision scale')
  }
  const remainder = scale - normalizedTotal
  if (remainder === 0n) return

  const recipient =
    Array.from(scores).find(([, value]) => value !== 0n)?.[0] ??
    Array.from(reachable?.keys() ?? []).find((node) => scores.has(node)) ??
    scores.keys().next().value
  if (recipient === undefined) {
    throw new Error('rank: nonempty score map lost its first node')
  }
  scores.set(
    recipient,
    checkedAdd(
      scores.get(recipient)!,
      remainder,
      'rank: normalization remainder'
    )
  )
}

export type RankResult = {
  scores: Map<string, bigint>
  iterations: number
  converged: boolean
}

/** Compute scores plus the iteration result used by the parameter-change preview. */
export const calculateDetailed = (graph: Graph, p: Params): RankResult => {
  const s = p.precisionScale
  const seeds = new Set<string>(p.trustedSeeds.map((a) => a.toLowerCase()))
  const rankNodes = Array.from(
    new Set([...graph.nodes.map((node) => node.toLowerCase()), ...seeds])
  ).sort((a, b) => cmpHex(a as Hex, b as Hex))
  const n = rankNodes.length
  if (n === 0) return { scores: new Map(), iterations: 0, converged: true }

  assertEdgeClosure(graph, rankNodes)

  const decays = hasTrustEnabled(p)
    ? bfsDecays(graph, seeds, p.trustDecayFp, s)
    : null
  const initial = initializeScores(rankNodes, p, seeds, decays)
  let current = new Map(initial)

  // Preserve the pull kernel's zero-iteration boundary: no iterative precompute is evaluated.
  if (p.maxIterations === 0) {
    normalize(current, s, decays)
    return { scores: current, iterations: 0, converged: false }
  }

  // Normalize every outgoing row once. Unreachable targets are excluded because the pull kernel
  // gives them teleport only and skips them before evaluating an edge ratio.
  const ratios = new Map<string, Array<[string, bigint]>>()
  for (const attester of rankNodes) {
    const edges = graph.outgoing.get(attester)
    if (!edges) continue

    let totalBase = 0n
    for (const [target, weight] of edges) {
      if (target === attester || weight === 0n) continue
      totalBase = checkedAdd(totalBase, weight, 'rank: outgoing-weight sum')
    }
    if (totalBase === 0n) continue

    const row: Array<[string, bigint]> = []
    for (const [target, baseWeight] of edges) {
      if (target === attester || baseWeight === 0n) continue
      if (decays && !decays.has(target)) continue
      row.push([target, fpDiv(baseWeight, totalBase, s)])
    }
    if (row.length > 0) ratios.set(attester, row)
  }

  const baseTeleport = s - p.dampingFp // (1 - d) * S
  const teleport = new Map<string, bigint>()
  for (const node of rankNodes) {
    teleport.set(node, fpMul(baseTeleport, initial.get(node)!, s))
  }

  let iterations = 0
  let converged = false
  for (let iteration = 0; iteration < p.maxIterations; iteration++) {
    const newScores = new Map(teleport)

    // Source order matches Rust's BTree/node order and the old pull kernel's addition order.
    for (const attester of rankNodes) {
      const row = ratios.get(attester)
      if (!row) continue
      const decay = decays ? (decays.get(attester) ?? 0n) : s
      for (const [recipient, ratio] of row) {
        let contribution = fpMul(current.get(attester)!, ratio, s)
        contribution = fpMul(contribution, decay, s)
        newScores.set(
          recipient,
          checkedAdd(
            newScores.get(recipient)!,
            fpMul(p.dampingFp, contribution, s),
            'rank: accumulated score'
          )
        )
      }
    }

    let iterationTotal = 0n
    for (const value of newScores.values()) {
      iterationTotal = checkedAdd(
        iterationTotal,
        value,
        'rank: iteration score total'
      )
    }
    if (iterationTotal > s) {
      throw new Error('rank: total standing exceeded precision scale')
    }

    let maxDelta = 0n
    for (const recipient of rankNodes) {
      // Consensus-critical: unreachable accounts do not participate in convergence.
      if (decays && !decays.has(recipient)) continue
      const newScore = newScores.get(recipient)!
      const prev = current.get(recipient)!
      const delta = newScore > prev ? newScore - prev : prev - newScore
      if (delta > maxDelta) maxDelta = delta
    }

    current = newScores
    iterations = iteration + 1

    if (maxDelta < p.toleranceFp) {
      converged = true
      break
    }
  }

  normalize(current, s, decays)
  return { scores: current, iterations, converged }
}

/** Consensus-facing compatibility wrapper. */
export const calculate = (graph: Graph, p: Params): Map<string, bigint> =>
  calculateDetailed(graph, p).scores
