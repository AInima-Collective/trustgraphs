//! Top-level canonical computation: folded edges + params → journal + artifacts. The single function
//! the browser calls to reproduce, byte-for-byte, what the SP1 guest commits. Mirrors
//! `pagerank_core::compute`.

import { keccak256, stringToBytes, type Hex } from 'viem'

import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from './cid'
import { distributePoints } from './distribute'
import { accumulate, journalDigest as encodeJournalDigest, paramsHash } from './encode'
import { merkleRoot, outputLeaf } from './merkle'
import { calculate } from './pagerank'
import { buildGraph } from './reconcile'
import { type ComputeResult, type GuestInput, type Journal } from './types'
import { cmpHex } from './words'

/** Run the full pipeline. Deterministic and float-free. */
export const compute = (input: GuestInput): ComputeResult => {
  // 1. Reproduce the chain-pinned input commitment.
  const { acc, leafCount } = accumulate(input.edges)

  // 2. Reproduce the governance-pinned params commitment.
  const pHash = paramsHash(input.params)

  // 3. Reconcile → graph → scores.
  const graph = buildGraph(input.edges, input.params)
  const scoresFp = calculate(graph, input.params)
  const filtered: Array<[Hex, bigint]> = []
  for (const [k, v] of scoresFp) {
    if (v !== 0n) filtered.push([k as Hex, v])
  }

  // 4. Distribute points; sort ascending by address for the blob + tree determinism.
  const { assigned, totalValue } = distributePoints(filtered, input.params)
  assigned.sort((a, b) => cmpHex(a[0], b[0]))

  // 5. Output merkle root (OZ standard tree; leaves match MerkleSnapshot.sol).
  const leaves = assigned.map(([a, v]) => outputLeaf(a, v))
  const outputRoot = merkleRoot(leaves)

  // 6. Canonical IPFS blob + CIDv1(raw, sha2-256).
  const blob = canonicalBlob(assigned)
  const digest = sha256Utf8(blob)
  const ipfsHash = digestToHex(digest)
  const cid = cidV1Raw(digest)
  const cidDigest = keccak256(stringToBytes(cid))

  const journal: Journal = {
    acc,
    leafCount,
    paramsHash: pHash,
    outputRoot,
    ipfsHash,
    cidDigest,
    totalValue,
  }

  return { journal, scores: assigned, blob, cid }
}

/** The journal digest the on-chain verifier binds. */
export const journalDigest = (j: Journal): Hex => encodeJournalDigest(j)
