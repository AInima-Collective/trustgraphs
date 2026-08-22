//! Browser simulation adapter: turn indexed attestations + a network config into the canonical
//! fixed-point PageRank result. This is what the UI calls for "what-if" previews so the numbers it
//! shows match, byte-for-byte, what the zk guest would commit for the same inputs.
//!
//! PARITY TIER: lane-1-only callers remain reduced. Hybrid callers may pass strict-lane raw edges
//! only after independently fetching and validating the complete supported envelope profile. The
//! browser still does not reproduce the anchor accumulator journal fields, so the resulting
//! journal remains lane-1-shaped — the
//! lane-2 anchor fields (`anchorAcc`, `anchorCount`, `skippedDigest`) come back as the zero
//! accumulator here (see `compute.ts`). The lane-2 `Params` fields ARE threaded through because
//! `paramsHash` hashes all 17 param fields; leaving them out would mismatch an on-chain lane-2
//! `paramsHash`. To check the on-chain lane-2 accumulator, read `AnchorRegistry.anchorAcc()/
//! anchorCount()` or the `MerkleSnapshot.AnchorsCheckpointed` event — those are NOT reproduced here.

import { type Hex, concat } from 'viem'

import { compute } from './compute'
import { buildTree, outputLeaf, proofFor } from './merkle'
import { type Journal, type Params, type RawEdge } from './types'
import { wordU256 } from './words'

const S = 10n ** 18n

/** Convert a JS float to a fixed-point bigint at scale 1e18 (rounded at 1e-9 precision). */
export const toFp = (x: number): bigint =>
  BigInt(Math.round(x * 1e9)) * 10n ** 9n

export interface SimAttestation {
  attester: Hex
  recipient: Hex
  uid: Hex
  /** Fold-order timestamp (block.timestamp). */
  time: bigint
  /** Decoded confidence (integer weight). */
  confidence: number
  /** Whether this attestation is revoked (excluded from the graph, like the canonical reconcile). */
  revoked?: boolean
  /** Effective on-chain revoke time, when revoked. */
  revocationTime?: bigint
}

export interface SimConfig {
  dampingFactor: number
  trustMultiplier: number
  trustShare: number
  trustDecay: number
  maxIterations: number
  minWeight: number
  maxWeight: number
  trustedSeeds: Hex[]
  /** The reward pool to distribute (points). */
  pointsPool: bigint
  /** Lane-2 (envelope-0) accepted EIP-712 domain separators. Empty/absent = lane 2 disabled. */
  envelope0DomainSeparators?: Hex[]
  /** Lane-2 Rule-Φ staleness horizon in seconds. */
  lane2MaxHeadAge?: number
  /** The instance's `EASIndexerResolver` — one of the two params-schema v2 domain separators. */
  accumulator: Hex
  /** The chain the instance lives on — the other params-schema v2 domain separator. */
  chainId: bigint
  /** The instance's vouching schema UID. Omitted = zero (a preview with no on-chain schema). */
  schemaUid?: Hex
}

export interface SimResult {
  /** `{ lowercased address -> value }` for scored accounts. */
  results: Record<string, bigint>
  outputRoot: Hex
  ipfsHash: Hex
  cid: string
  totalValue: bigint
  /** Score rows plus locally generated sibling paths against `outputRoot`. */
  entries: Array<{ account: Hex; value: bigint; proof: Hex[] }>
  /**
   * The full journal-v2 the recompute produced (lane-1-only: `anchorAcc`/`anchorCount`/
   * `skippedDigest` are the zero accumulator here — see the file header). Callers comparing against
   * on-chain state can check `acc`/`leafCount`/`paramsHash`/`outputRoot`/`ipfsHash`/`cidDigest`/
   * `totalValue` directly; lane-2 fields must be read from the chain (AnchorRegistry / events).
   */
  journal: Journal
}

/** Build the proof-bearing rows for a canonical score set. */
export const merkleEntriesForScores = (
  scores: Array<[Hex, bigint]>
): SimResult['entries'] => {
  const leaves = scores.map(([account, value]) => ({
    account,
    value,
    leaf: outputLeaf(account, value),
  }))
  const tree = buildTree(leaves.map(({ leaf }) => leaf))

  return leaves.map(({ account, value, leaf }) => {
    const proof = proofFor(tree, leaf)
    if (!proof) {
      throw new Error(`Failed to construct simulated proof for ${account}`)
    }
    return { account, value, proof }
  })
}

/** ABI-encode `(string comment, uint256 confidence)` head so `weightFieldIndex = 1` reads the weight. */
const encodeConfidence = (confidence: number): Hex => {
  const c = BigInt(Math.max(0, Math.trunc(confidence)))
  return concat([wordU256(0n), wordU256(c)])
}

/**
 * Run the canonical fixed-point pipeline over the given attestations. Deterministic and float-free
 * past the params conversion; identical output to `crates/pagerank-core` / the zk guest.
 */
export const simulateNetwork = (
  attestations: SimAttestation[],
  cfg: SimConfig,
  independentlyVerifiedEnvelope0Edges: readonly RawEdge[] = []
): SimResult => {
  const edges: RawEdge[] = attestations.flatMap((attestation) => {
    const edge = {
      attester: attestation.attester.toLowerCase() as Hex,
      recipient: attestation.recipient.toLowerCase() as Hex,
      uid: attestation.uid,
      data: encodeConfidence(attestation.confidence),
    }
    return [
      { ...edge, kind: 0, blockTimestamp: attestation.time },
      ...(attestation.revoked
        ? [
            {
              ...edge,
              kind: 1,
              blockTimestamp:
                attestation.revocationTime &&
                attestation.revocationTime > 0n
                  ? attestation.revocationTime
                  : attestation.time,
            },
          ]
        : []),
    ]
  })

  edges.push(
    ...independentlyVerifiedEnvelope0Edges.map((edge) => ({ ...edge }))
  )

  const params: Params = {
    dampingFp: toFp(cfg.dampingFactor),
    toleranceFp: S / 1_000_000n, // 1e-6
    maxIterations: cfg.maxIterations,
    minWeightFp: toFp(cfg.minWeight),
    maxWeightFp: toFp(cfg.maxWeight),
    trustMultiplierFp: toFp(cfg.trustMultiplier),
    trustShareFp: toFp(cfg.trustShare),
    trustDecayFp: toFp(cfg.trustDecay),
    trustedSeeds: cfg.trustedSeeds.map((a) => a.toLowerCase() as Hex),
    totalPool: cfg.pointsPool,
    precisionScale: S,
    schemaUid: cfg.schemaUid ?? (`0x${'00'.repeat(32)}` as Hex),
    weightFieldIndex: 1,
    // Domain separation (params-schema v2): both fields are part of the 17-field paramsHash, so a
    // recompute that wants to match the chain must carry the instance's own accumulator + chain id.
    accumulator: cfg.accumulator,
    chainId: cfg.chainId,
    // Lane-2 params flow into paramsHash too. Omitted/undefined for lane-1-only networks,
    // which encode.paramsHash normalizes to an empty domain set + zero head-age.
    ...(cfg.envelope0DomainSeparators?.length
      ? {
          envelope0DomainSeparators: cfg.envelope0DomainSeparators.map(
            (d) => d.toLowerCase() as Hex
          ),
        }
      : {}),
    ...(cfg.lane2MaxHeadAge ? { lane2MaxHeadAge: cfg.lane2MaxHeadAge } : {}),
  }

  const r = compute({ edges, params })
  const results: Record<string, bigint> = {}
  for (const [addr, v] of r.scores) results[addr.toLowerCase()] = v

  return {
    results,
    outputRoot: r.journal.outputRoot,
    ipfsHash: r.journal.ipfsHash,
    cid: r.cid,
    totalValue: r.journal.totalValue,
    entries: merkleEntriesForScores(r.scores),
    journal: r.journal,
  }
}
