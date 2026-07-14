//! Browser-side REDUCED-TIER reproduction for the hypercerts (lane-2) program.
//!
//! Per MULTI_PROGRAM_PLATFORM §6 / OFFCHAIN_ATTESTATIONS_ZK §6, the browser does NOT re-run the full
//! lane-2 pipeline: the CAR walk and envelope-1 verification stay in-guest (server-side). What the
//! browser CAN reproduce — and what this module does — is everything downstream of the
//! envelope-verified edge set: from the indexer-served derived edges + bindings + skips + the
//! chain-state accumulators, it re-derives Trust-Aware PageRank, point distribution, the output
//! merkle root, the canonical blob/CID, the skippedDigest fold, and the full journal-v2 digest, then
//! (via the golden test) checks them against the on-chain journal.
//!
//! HONEST LABEL: this is a *reduced* parity tier. It proves the browser reproduces the guest's
//! rank→distribute→root→journal math over an edge set it takes on trust from the indexer; it does
//! NOT re-verify the atproto envelopes that produced those edges. The full guarantee is the SP1
//! proof; this tier lets a browser cheaply detect an indexer that serves an inconsistent journal.
//!
//! It REUSES the canonical pagerank TS port unchanged (`../pagerank/{pagerank,distribute,merkle,cid,
//! encode}`): PageRank/distribution are keyed by lowercase hex strings, and 32-byte nodeId hex has
//! the exact same shape as the 20-byte→32 address hex those modules already key by, so the algorithm
//! and trust semantics are byte-identical to the trust-graph instance.

import { concat, keccak256, stringToBytes, toBytes, type Hex } from 'viem'

import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from '../pagerank/cid'
import { distributePoints } from '../pagerank/distribute'
import { fold, journalDigest as encodeJournalDigest } from '../pagerank/encode'
import { merkleRoot, outputLeaf } from '../pagerank/merkle'
import { calculate } from '../pagerank/pagerank'
import { type Graph } from '../pagerank/reconcile'
import { type Journal, type Params as PagerankParams } from '../pagerank/types'
import { cmpHex, wordU256, wordU64, wordU8, ZERO_HASH } from '../pagerank/words'

// ---- indexer-served input shape ---------------------------------------------
//
// These types document the exact mapping from the indexer's hypercerts tables to what the browser
// re-derives. Every field is a value already present in the indexer (folded on-chain / decoded by the
// server-side guest run and re-served), NOT something the browser re-verifies.

/**
 * One derived, envelope-verified directed edge — a row of the indexer's `offchainEdge` table.
 * `source`/`target` are 32-byte nodeIds (actor DID nodeId `keccak256(did)` or artifact nodeId
 * `keccak256("at://did/coll/rkey")`); `weightFp` is the FINAL per-(source,target) weight (fixed-point
 * 1e18) already summed across §3 edge types by the in-guest `semantics::derive`.
 */
export interface OffchainEdge {
  source: Hex
  target: Hex
  /** Fixed-point (1e18) edge weight, as a bigint or decimal/hex string the indexer serves. */
  weightFp: bigint | string
}

/**
 * One deterministic skip — a row of the indexer's `skippedNode` table. Mirrors
 * `zk_core::anchor::SkipEntry` (rule-Φ skips + `semantics` record-level skips share this shape).
 */
export interface SkippedNode {
  nodeId: Hex
  /** Closed-enum reason (`pagerank_core::skip_reason` 1/2 or `semantics::skip_reason` 10–14). */
  reason: number
  /** Epoch at which the skip condition was observed (`0` for record-level skips). */
  epochObserved: number | bigint
}

/**
 * One verified `link.evm` binding — a row of the indexer's `binding` table. Attaches an EVM address
 * to a bound actor's DID nodeId; drives the extra v1 address leaf in the output tree.
 */
export interface Binding {
  nodeId: Hex
  address: Hex
}

/**
 * The hypercerts governance-pinned parameters the browser needs to reproduce rank + distribution +
 * `paramsHash`. Field names mirror the crate's §6.1 `Params` (camelCase). All `*Fp` fields are
 * fixed-point 1e18. `trustedSeedDids` are hashed to seed nodeIds exactly as `semantics::did_node_id`.
 */
export interface HypercertsParams {
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  trustMultiplierFp: bigint
  trustShareFp: bigint
  trustDecayFp: bigint
  precisionScale: bigint
  totalPool: bigint
  trustedSeedDids: string[]
  wFollowFp: bigint
  wBadgeFp: bigint
  wEvalFp: bigint
  wAttribFp: bigint
  ackBoostFp: bigint
  unackedAttribFp: bigint
  pdsAttestedWeightFp: bigint
  lane2MaxHeadAge: bigint
}

/**
 * The complete reduced-tier reproduction input. Everything here is served by the indexer / read from
 * chain state; the browser reproduces the journal from it and nothing else.
 */
export interface RecomputeInput {
  /** Envelope-verified derived edges (indexer `offchainEdge` table). */
  edges: OffchainEdge[]
  /** Deterministic skips (indexer `skippedNode` table). */
  skips: SkippedNode[]
  /** Verified `link.evm` bindings (indexer `binding` table). */
  bindings: Binding[]
  /** Governance-pinned §6.1 params. */
  params: HypercertsParams
  /** The checkpointed anchor-log accumulator the journal binds (AnchorRegistry chain state). */
  anchorAcc: Hex
  /** The checkpointed anchor count. */
  anchorCount: bigint
  /** Lane-1 accumulator — always `bytes32(0)` for the lane-2-only hypercerts program. */
  acc?: Hex
  /** Lane-1 leaf count — always `0` for the lane-2-only hypercerts program. */
  leafCount?: bigint
}

// ---- hashing helpers not already in the pagerank port -----------------------

/** `didNodeId = keccak256(utf8(did))` — mirrors `semantics::did_node_id`. */
export const didNodeId = (did: string): Hex => keccak256(toBytes(did))

/**
 * The unified nodeId output leaf: `keccak256(bytes.concat(keccak256(abi.encode(bytes32 nodeId,
 * uint256 value))))` — the nodeId twin of `merkle::output_leaf` (mirrors `compute::node_output_leaf`).
 */
export const nodeOutputLeaf = (nodeId: Hex, value: bigint): Hex =>
  keccak256(keccak256(concat([nodeId, wordU256(value)])))

/**
 * The hypercerts `seedSetRoot`: an OZ StandardMerkleTree over the SORTED seed nodeIds, leaf =
 * `keccak256(nodeId)` (one hash over the 32-byte id — the nodeId analogue of the address-seed root).
 */
export const seedSetRoot = (seedNodeIds: Hex[]): Hex => {
  const ids = [...seedNodeIds].sort(cmpHex)
  const leaves = ids.map((id) => keccak256(id))
  return merkleRoot(leaves)
}

/**
 * The hypercerts `paramsHash` — 17 static ABI words (mirrors `compute::params_hash`). Distinct from
 * the trust-graph `paramsHash`, so it lives here rather than reusing `../pagerank/encode`.
 */
export const paramsHash = (p: HypercertsParams): Hex => {
  const seedIds = p.trustedSeedDids.map(didNodeId)
  return keccak256(
    concat([
      wordU256(p.dampingFp),
      wordU256(p.toleranceFp),
      wordU256(BigInt(p.maxIterations)), // uint32, left-padded like any uintN
      wordU256(p.trustMultiplierFp),
      wordU256(p.trustShareFp),
      wordU256(p.trustDecayFp),
      wordU256(p.precisionScale),
      wordU256(p.totalPool),
      seedSetRoot(seedIds),
      wordU256(p.wFollowFp),
      wordU256(p.wBadgeFp),
      wordU256(p.wEvalFp),
      wordU256(p.wAttribFp),
      wordU256(p.ackBoostFp),
      wordU256(p.unackedAttribFp),
      wordU256(p.pdsAttestedWeightFp),
      wordU64(p.lane2MaxHeadAge),
    ])
  )
}

/** The skip-entry leaf: `keccak256(abi.encode(bytes32 nodeId, uint8 reason, uint64 epochObserved))`. */
export const skipLeaf = (e: SkippedNode): Hex =>
  keccak256(concat([e.nodeId, wordU8(e.reason), wordU64(BigInt(e.epochObserved))]))

/**
 * The `skippedDigest`: chained fold (acc₀ = 0) over skip leaves sorted ascending by
 * `(nodeId, reason, epochObserved)`. Empty set ⇒ `bytes32(0)`. Mirrors `zk_core::anchor`.
 */
export const skippedDigest = (skips: SkippedNode[]): Hex => {
  const sorted = [...skips].sort((a, b) => {
    const c = cmpHex(a.nodeId, b.nodeId)
    if (c !== 0) return c
    if (a.reason !== b.reason) return a.reason - b.reason
    const ea = BigInt(a.epochObserved)
    const eb = BigInt(b.epochObserved)
    return ea < eb ? -1 : ea > eb ? 1 : 0
  })
  let acc: Hex = ZERO_HASH
  for (const e of sorted) acc = fold(acc, skipLeaf(e))
  return acc
}

// ---- the reduced-tier reproduction ------------------------------------------

/** Full result — the reproduced journal + artifacts, mirroring `ComputeResult`. */
export interface RecomputeResult {
  journal: Journal
  /** `[nodeId, value]` for nodes with `value > 0`, sorted ascending by nodeId. */
  scores: Array<[Hex, bigint]>
  blob: string
  cid: string
}

/**
 * Adapt the hypercerts rank params to the pagerank port's `Params` shape. Only the rank/pool/seed
 * fields are read by `calculate`/`distributePoints`; the trust-graph-only fields
 * (`minWeightFp`/`maxWeightFp`/`schemaUid`/`weightFieldIndex`) are unused here and set to inert
 * defaults. `trustedSeeds` carries the seed NODEIDS (same hex shape the port keys by).
 */
const asRankParams = (p: HypercertsParams, seedNodeIds: Hex[]): PagerankParams => ({
  dampingFp: p.dampingFp,
  toleranceFp: p.toleranceFp,
  maxIterations: p.maxIterations,
  minWeightFp: 0n,
  maxWeightFp: 0n,
  trustMultiplierFp: p.trustMultiplierFp,
  trustShareFp: p.trustShareFp,
  trustDecayFp: p.trustDecayFp,
  trustedSeeds: seedNodeIds,
  totalPool: p.totalPool,
  precisionScale: p.precisionScale,
  schemaUid: ZERO_HASH,
  weightFieldIndex: 0,
})

/** Build the reconciled graph directly from the indexer-served derived edges (already summed). */
const graphFromEdges = (edges: OffchainEdge[]): Graph => {
  const outgoing = new Map<string, Map<string, bigint>>()
  const nodeSet = new Set<string>()
  for (const e of edges) {
    const source = e.source.toLowerCase()
    const target = e.target.toLowerCase()
    const w = BigInt(e.weightFp)
    nodeSet.add(source)
    nodeSet.add(target)
    let inner = outgoing.get(source)
    if (!inner) {
      inner = new Map<string, bigint>()
      outgoing.set(source, inner)
    }
    // Edges are pre-summed per (source, target) by the guest; sum defensively if the indexer split them.
    inner.set(target, (inner.get(target) ?? 0n) + w)
  }
  const nodes = Array.from(nodeSet).sort((a, b) => cmpHex(a as Hex, b as Hex)) as Hex[]
  return { nodes, outgoing }
}

/**
 * Reproduce the hypercerts journal from the indexer-served edge set. Deterministic and float-free;
 * reuses the exact pagerank/distribute/merkle/cid/journal port used by the trust-graph instance.
 */
export const recompute = (input: RecomputeInput): RecomputeResult => {
  const p = input.params
  const seedNodeIds = Array.from(new Set(p.trustedSeedDids.map(didNodeId))) as Hex[]
  const rankParams = asRankParams(p, seedNodeIds)

  // 1. Rank the envelope-verified edge set (the exact pagerank-core algorithm, nodeId-keyed).
  const graph = graphFromEdges(input.edges)
  const scoresFp = calculate(graph, rankParams)
  const filtered: Array<[Hex, bigint]> = []
  for (const [k, v] of scoresFp) if (v !== 0n) filtered.push([k as Hex, v])

  // 2. Distribute the pool; sort ascending by nodeId for blob + tree determinism.
  const { assigned, totalValue } = distributePoints(filtered, rankParams)
  assigned.sort((a, b) => cmpHex(a[0], b[0]))

  // 3. Output tree: unified nodeId leaves for every scored node, PLUS v1 address leaves for bound
  //    actors (address-keyed consumers work unchanged). Order is irrelevant — merkleRoot sorts.
  const bindingByNode = new Map<string, Hex>()
  for (const b of input.bindings) bindingByNode.set(b.nodeId.toLowerCase(), b.address)
  const leaves: Hex[] = assigned.map(([id, v]) => nodeOutputLeaf(id, v))
  for (const [id, v] of assigned) {
    const addr = bindingByNode.get(id.toLowerCase())
    if (addr) leaves.push(outputLeaf(addr, v))
  }
  const outputRoot = merkleRoot(leaves)

  // 4. Canonical blob + CIDv1(raw, sha2-256), nodeId-keyed.
  const blob = canonicalBlob(assigned)
  const digest = sha256Utf8(blob)
  const ipfsHash = digestToHex(digest)
  const cid = cidV1Raw(digest)
  const cidDigest = keccak256(stringToBytes(cid))

  // 5. Journal v2, lane-2-only shape (lane 1 is the zero accumulator; anchor lane from chain state).
  const journal: Journal = {
    acc: input.acc ?? ZERO_HASH,
    leafCount: input.leafCount ?? 0n,
    anchorAcc: input.anchorAcc,
    anchorCount: input.anchorCount,
    paramsHash: paramsHash(p),
    outputRoot,
    ipfsHash,
    cidDigest,
    totalValue,
    skippedDigest: skippedDigest(input.skips),
  }

  return { journal, scores: assigned, blob, cid }
}

/** The journal digest the on-chain verifier binds (reuses the canonical journal-v2 encoding). */
export const journalDigest = (j: Journal): Hex => encodeJournalDigest(j)
