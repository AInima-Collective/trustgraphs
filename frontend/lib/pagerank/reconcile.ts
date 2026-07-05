//! Attestation reconciliation → graph, in the canonical total order `(timestamp, fold_index)`.
//! Mirrors `pagerank_core::reconcile`.

import { type Hex } from 'viem'

import { decodeWeight } from './encode'
import { type Params, type RawEdge } from './types'
import { cmpBig, cmpHex } from './words'

/**
 * A reconciled directed graph. `nodes` is ascending by address; `outgoing` maps
 * `attester -> (recipient -> weightFp)`. Keys are lowercased addresses.
 */
export interface Graph {
  nodes: Hex[]
  outgoing: Map<string, Map<string, bigint>>
}

export const graphIsEmpty = (g: Graph): boolean => g.nodes.length === 0

/** Clamp a decoded confidence to `[minWeight, maxWeight]` in fixed point. Mirrors `weight_fp`. */
const weightFp = (edge: RawEdge, p: Params): bigint => {
  const confidence = decodeWeight(edge.data, p.weightFieldIndex) ?? 0n
  const s = p.precisionScale
  const capRaw = p.maxWeightFp / s // integer part of the max weight
  if (confidence > capRaw) {
    return p.maxWeightFp
  }
  const c = confidence * s // safe: confidence <= capRaw ⇒ c <= maxWeightFp
  if (c < p.minWeightFp) return p.minWeightFp
  if (c > p.maxWeightFp) return p.maxWeightFp
  return c
}

/** Build the reconciled graph from folded edges. Mirrors `build_graph`. */
export const buildGraph = (edges: RawEdge[], p: Params): Graph => {
  // uids that were ever revoked are excluded entirely.
  const revoked = new Set<string>()
  for (const e of edges) {
    if (e.kind === 1) revoked.add(e.uid.toLowerCase())
  }

  // Attest edges in canonical (timestamp, fold_index) order.
  const indexed = edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === 0 && !revoked.has(e.uid.toLowerCase()))
  indexed.sort((a, b) => {
    const t = cmpBig(a.e.blockTimestamp, b.e.blockTimestamp)
    return t !== 0 ? t : a.i - b.i
  })

  const outgoing = new Map<string, Map<string, bigint>>()
  const nodeSet = new Set<string>()

  for (const { e } of indexed) {
    const w = weightFp(e, p)
    const attester = e.attester.toLowerCase()
    const recipient = e.recipient.toLowerCase()
    nodeSet.add(attester)
    nodeSet.add(recipient)
    // last-write-wins: a later edge for the same (attester, recipient) overrides the weight.
    let inner = outgoing.get(attester)
    if (!inner) {
      inner = new Map<string, bigint>()
      outgoing.set(attester, inner)
    }
    inner.set(recipient, w)
  }

  const nodes = Array.from(nodeSet).sort((a, b) =>
    cmpHex(a as Hex, b as Hex)
  ) as Hex[]

  return { nodes, outgoing }
}
