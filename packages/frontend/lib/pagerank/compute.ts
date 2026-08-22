//! Top-level canonical computation: folded edges + params → journal + artifacts. The single function
//! the browser calls to reproduce, byte-for-byte, what the SP1 guest commits. Mirrors
//! `pagerank_core::compute`.

import { type Hex, keccak256, stringToBytes } from 'viem'

import { canonicalBlob, cidV1Raw, digestToHex, sha256Utf8 } from './cid'
import { distributePoints } from './distribute'
import {
  accumulate,
  journalDigest as encodeJournalDigest,
  paramsHash,
} from './encode'
import { merkleRoot, outputLeaf } from './merkle'
import { calculateDetailed } from './pagerank'
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
  const rank = calculateDetailed(graph, input.params)
  const scoresFp = rank.scores
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

  // Journal v3, lane-1-only shape: no lane-2 anchors in this input, so the empty lane is the
  // zero accumulator (mirrors pagerank_core::compute::compute). The two v3 words pass straight
  // through from the input; absent, both are zero (no bounty, no domain).
  const ZERO = `0x${'00'.repeat(32)}` as Hex
  const ZERO_ADDR = `0x${'00'.repeat(20)}` as Hex
  const journal: Journal = {
    acc,
    leafCount,
    anchorAcc: ZERO,
    anchorCount: 0n,
    paramsHash: pHash,
    outputRoot,
    ipfsHash,
    cidDigest,
    totalValue,
    skippedDigest: ZERO,
    recipient: input.binding?.recipient ?? ZERO_ADDR,
    instanceDomain: input.binding?.instanceDomain ?? ZERO,
  }

  return {
    journal,
    scores: assigned,
    blob,
    cid,
    rankDiagnostics: {
      iterations: rank.iterations,
      converged: rank.converged,
    },
  }
}

/** The journal digest the on-chain verifier binds. */
export const journalDigest = (j: Journal): Hex => encodeJournalDigest(j)
