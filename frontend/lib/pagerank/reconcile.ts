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
  // Every event participates in the canonical order. Filtering revoked UIDs before resolving
  // duplicate pairs made `old(100) -> new(20) -> revoke(new)` resurrect `old(100)`.
  const indexed = edges.map((e, i) => ({ e, i }))
  indexed.sort((a, b) => {
    const t = cmpBig(a.e.blockTimestamp, b.e.blockTimestamp)
    return t !== 0 ? t : a.i - b.i
  })

  // Current edge per pair. The UID is retained so revoking an older, superseded attestation does
  // not clear a newer one. Deleting the current edge leaves no older edge to fall back to.
  const current = new Map<
    string,
    Map<string, { uid: string; weight: bigint }>
  >()

  for (const { e } of indexed) {
    const attester = e.attester.toLowerCase()
    const recipient = e.recipient.toLowerCase()
    if (e.kind === 0) {
      let recipients = current.get(attester)
      if (!recipients) {
        recipients = new Map()
        current.set(attester, recipients)
      }
      recipients.set(recipient, {
        uid: e.uid.toLowerCase(),
        weight: weightFp(e, p),
      })
    } else if (e.kind === 1) {
      const recipients = current.get(attester)
      if (recipients?.get(recipient)?.uid === e.uid.toLowerCase()) {
        recipients.delete(recipient)
        if (recipients.size === 0) current.delete(attester)
      }
    }
  }

  const outgoing = new Map<string, Map<string, bigint>>()
  const nodeSet = new Set<string>()

  for (const [attester, recipients] of current) {
    nodeSet.add(attester)
    const weights = new Map<string, bigint>()
    for (const [recipient, edge] of recipients) {
      nodeSet.add(recipient)
      weights.set(recipient, edge.weight)
    }
    outgoing.set(attester, weights)
  }

  const nodes = Array.from(nodeSet).sort((a, b) =>
    cmpHex(a as Hex, b as Hex)
  ) as Hex[]

  return { nodes, outgoing }
}
