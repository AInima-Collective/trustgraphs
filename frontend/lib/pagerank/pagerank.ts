//! Fixed-point Trust-Aware PageRank. A structural port of `pagerank_core::pagerank` (scores scaled
//! by S), with all arithmetic in integer `bigint`.

import { type Hex } from 'viem'

import { fpDiv, fpMul } from './fixed'
import { type Graph } from './reconcile'
import { type Params, hasTrustEnabled } from './types'
import { cmpHex } from './words'

const isSeed = (seeds: Set<string>, a: string): boolean => seeds.has(a)

/**
 * Initial scores (scaled by S). No trust ⇒ uniform `S/n`. Trust ⇒ seeds share `trustShare`,
 * regulars share `1 - trustShare`. Counts follow the legacy convention exactly.
 */
const initializeScores = (
  graph: Graph,
  p: Params,
  seeds: Set<string>
): Map<string, bigint> => {
  const n = graph.nodes.length
  const s = p.precisionScale
  const out = new Map<string, bigint>()
  if (n === 0) return out

  if (!hasTrustEnabled(p)) {
    const init = s / BigInt(n)
    for (const node of graph.nodes) out.set(node.toLowerCase(), init)
    return out
  }

  const trustedCount = p.trustedSeeds.length
  const regularCount = Math.max(0, n - trustedCount)
  const trustedTotal = p.trustShareFp
  const regularTotal = s - p.trustShareFp
  const trustedScore =
    trustedCount > 0 ? trustedTotal / BigInt(trustedCount) : 0n
  const regularScore =
    regularCount > 0 ? regularTotal / BigInt(regularCount) : 0n
  for (const node of graph.nodes) {
    const key = node.toLowerCase()
    out.set(key, isSeed(seeds, key) ? trustedScore : regularScore)
  }
  return out
}

/**
 * Multi-source BFS shortest distances from the trusted seeds (deterministic: seeds processed in
 * sorted order, neighbours in address order). Mirrors `calculate_trust_distances`.
 */
const bfsDistances = (
  graph: Graph,
  seeds: Set<string>
): Map<string, number> => {
  const distances = new Map<string, number>()
  const queue: string[] = []
  const sortedSeeds = Array.from(seeds).sort((a, b) =>
    cmpHex(a as Hex, b as Hex)
  )
  for (const seed of sortedSeeds) {
    distances.set(seed, 0)
    queue.push(seed)
  }
  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    const d = distances.get(current)!
    const edges = graph.outgoing.get(current)
    if (edges) {
      const neighbors = Array.from(edges.keys()).sort((a, b) =>
        cmpHex(a as Hex, b as Hex)
      )
      for (const neighbor of neighbors) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, d + 1)
          queue.push(neighbor)
        }
      }
    }
  }
  return distances
}

/** `baseFp ^ dist` in fixed point (iterative). `dist == 0 ⇒ S` (1.0). */
const decayPow = (baseFp: bigint, dist: number, s: bigint): bigint => {
  let r = s
  for (let i = 0; i < dist; i++) {
    r = fpMul(r, baseFp, s)
  }
  return r
}

export type RankResult = {
  scores: Map<string, bigint>
  iterations: number
  converged: boolean
}

/** Compute scores plus the iteration result used by the parameter-change preview. */
export const calculateDetailed = (graph: Graph, p: Params): RankResult => {
  const n = graph.nodes.length
  if (n === 0) return { scores: new Map(), iterations: 0, converged: true }

  const s = p.precisionScale
  const seeds = new Set<string>(p.trustedSeeds.map((a) => a.toLowerCase()))

  const initial = initializeScores(graph, p, seeds)
  let current = new Map(initial)

  const distances = hasTrustEnabled(p) ? bfsDistances(graph, seeds) : null

  const baseTeleport = s - p.dampingFp // (1 - d) * S

  let iterations = 0
  let converged = false
  for (let iteration = 0; iteration < p.maxIterations; iteration++) {
    const newScores = new Map<string, bigint>()
    let maxDelta = 0n

    for (const recipientHex of graph.nodes) {
      const recipient = recipientHex.toLowerCase()
      // teleportation base: (1 - d) * initial[recipient]
      let newScore = fpMul(baseTeleport, initial.get(recipient)!, s)

      // isolated (unreachable) nodes get only the base score.
      if (distances && !distances.has(recipient)) {
        newScores.set(recipient, newScore)
        continue
      }

      for (const attesterHex of graph.nodes) {
        const attester = attesterHex.toLowerCase()
        if (attester === recipient) continue
        const edges = graph.outgoing.get(attester)
        if (!edges) continue

        // Filter out self-loops and zero-weight edges for the outgoing-weight normalization.
        let totalBase = 0n
        let toRecipient: bigint | null = null
        for (const [target, w] of edges) {
          if (target === attester || w === 0n) continue
          totalBase += w
          if (target === recipient) toRecipient = w
        }
        if (totalBase === 0n) continue
        if (toRecipient === null) continue
        const baseW = toRecipient

        // effective weight (trust multiplier for trusted attesters)
        const eff = isSeed(seeds, attester)
          ? fpMul(baseW, p.trustMultiplierFp, s)
          : baseW

        // trust decay by distance-from-seed of the attester
        let decay: bigint
        if (distances) {
          const dist = distances.get(attester)
          decay = dist === undefined ? 0n : decayPow(p.trustDecayFp, dist, s)
        } else {
          decay = s // trust disabled ⇒ 1.0
        }

        // contribution = current[attester] * (eff / totalBase) * decay
        const ratio = fpDiv(eff, totalBase, s)
        let contribution = fpMul(current.get(attester)!, ratio, s)
        contribution = fpMul(contribution, decay, s)
        newScore += fpMul(p.dampingFp, contribution, s)
      }

      const prev = current.get(recipient)!
      const delta = newScore > prev ? newScore - prev : prev - newScore
      if (delta > maxDelta) maxDelta = delta
      newScores.set(recipient, newScore)
    }

    current = newScores
    iterations = iteration + 1

    if (maxDelta < p.toleranceFp) {
      converged = true
      break
    }
  }

  // Normalize to sum S.
  let total = 0n
  for (const v of current.values()) total += v
  if (total !== 0n) {
    for (const [k, v] of current) current.set(k, fpDiv(v, total, s))
  }
  return { scores: current, iterations, converged }
}

/** Consensus-facing compatibility wrapper. */
export const calculate = (graph: Graph, p: Params): Map<string, bigint> =>
  calculateDetailed(graph, p).scores
