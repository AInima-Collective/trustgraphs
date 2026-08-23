//! Top-level canonical computation for the contributions program: trust edges + contribution
//! records + params → journal + artifacts. Mirrors `contributions_core::compute`.
//!
//! **Stage 1 — reputation.** The pagerank port's Trust-Aware PageRank over the vouch graph,
//! algorithm untouched (imported from `../pagerank`, never forked), producing `rep(r)`
//! normalized to sum = S.
//!
//! **Stage 2 — rep-weighted budgeted valuation** (see `stage2.ts`) after the eligibility
//! filters (see `eligibility.ts`), then the carve-out combine, integer distribution over the
//! pool, output merkle root, canonical blob/CID, and the reused journal v2.
//!
//! No React/browser imports — pure TS + viem hashing; the indexer (M3) imports this module.

import { type Hex, keccak256, stringToBytes } from 'viem'

import { type Eligibility, eligibility } from './eligibility'
import { paramsHash } from './params'
import { type LiveState, reconcile } from './reconcile'
import { type Stage2, stage2 } from './stage2'
import { type ContributionsInput, type ContributionsParams } from './types'
import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from '../pagerank/cid'
import { distributePoints } from '../pagerank/distribute'
import {
  accumulate,
  journalDigest as encodeJournalDigest,
  journalEncoded,
} from '../pagerank/encode'
import { merkleRoot, outputLeaf } from '../pagerank/merkle'
import { calculate } from '../pagerank/pagerank'
import { buildGraph } from '../pagerank/reconcile'
import {
  type Journal,
  type Params as PagerankParams,
  type RawEdge,
} from '../pagerank/types'
import { ZERO_HASH, cmpHex } from '../pagerank/words'

const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as const

/**
 * The `pagerank` port's `Params` twin driving stage 1 (only the fields the trust pipeline
 * reads; the trust program's own params-hash fields are irrelevant here — the contributions
 * program pins its OWN 21-word `paramsHash`). Mirrors `compute::trust_params`.
 */
const trustParams = (p: ContributionsParams): PagerankParams => ({
  dampingFp: p.dampingFp,
  toleranceFp: p.toleranceFp,
  maxIterations: p.maxIterations,
  minWeightFp: p.minWeightFp,
  maxWeightFp: p.maxWeightFp,
  trustShareFp: p.trustShareFp,
  trustDecayFp: p.trustDecayFp,
  trustedSeeds: p.trustedSeeds,
  totalPool: p.totalPool,
  precisionScale: p.precisionScale,
  schemaUid: ZERO_HASH,
  weightFieldIndex: p.weightFieldIndex,
  envelope0DomainSeparators: [],
  lane2MaxHeadAge: 0,
  // The trust program's params-schema v2 domain separators; inert here for the same reason
  // `schemaUid` is (this twin never hashes). Mirrors `compute::trust_params`.
  accumulator: ZERO_ADDRESS,
  chainId: 0n,
})

/**
 * Stage-1 reputation: the trust program's exact pipeline (reconcile → Trust-Aware PageRank),
 * driven by the mirrored rep params. Returns normalized scores (sum ≈ S, lowercase-address
 * keyed) for every node. Mirrors `compute::reputation`.
 */
export const reputation = (
  trustEdges: RawEdge[],
  p: ContributionsParams
): Map<string, bigint> => {
  const tp = trustParams(p)
  return calculate(buildGraph(trustEdges, tp), tp)
}

/** Full result of a canonical contributions computation. Mirrors `ComputeResult` + audit views. */
export interface ContributionsResult {
  journal: Journal
  /** `[account, value]` for accounts with `value > 0`, sorted ascending by address. */
  scores: Array<[Hex, bigint]>
  /** The canonical JSON blob string (what `ipfsHash`/`cid` commit to). */
  blob: string
  /** The CIDv1 (raw, sha2-256) string. */
  cid: string
  // --- audit views (the indexer's display surface; not journal-committed) ---
  /** Stage-1 reputation, lowercase-address keyed, scaled by S. */
  reputation: Map<string, bigint>
  /** S(c) per lowercase claim uid, scaled by S. */
  claimScores: Map<string, bigint>
  /** The eligibility partition (incl. per-valuation skip reasons). */
  eligibility: Eligibility
  /** The full stage-2 intermediate weights. */
  stage2: Stage2
  /** The reconciled live state (claims / responses / valuations). */
  liveState: LiveState
}

/** Run the full pipeline. Deterministic and float-free. Mirrors `compute::compute`. */
export const computeContributions = (
  input: ContributionsInput
): ContributionsResult => {
  const p = input.params

  // 1. Reproduce both chain-pinned input commitments (identical leaf/fold ABI).
  const { acc, leafCount } = accumulate(input.trustEdges) // slot A: trust
  const { acc: anchorAcc, leafCount: anchorCount } = accumulate(input.records) // slot B: contributions

  // 2. The governance-pinned params commitment (21-word tuple).
  const pHash = paramsHash(p)

  // 3. Stage 1: reputation over the vouch graph (trust pipeline, untouched).
  const rep = reputation(input.trustEdges, p)

  // 4. Reconcile the record log and apply the eligibility filters.
  const state = reconcile(input.records, p)
  const elig = eligibility(state, rep, p)

  // 5. Stage 2: budgeted rep-weighted valuation + carve-out.
  const st2 = stage2(state, rep, elig, p)
  const weights: Array<[Hex, bigint]> = []
  for (const [a, v] of st2.combinedWeights) {
    if (v !== 0n) weights.push([a as Hex, v])
  }
  weights.sort((a, b) => cmpHex(a[0], b[0]))

  // 6. Quantize to the integer pool allocation; sort ascending by address for the
  //    blob + tree determinism.
  const { assigned, totalValue } = distributePoints(weights, trustParams(p))
  assigned.sort((a, b) => cmpHex(a[0], b[0]))

  // 7. Output root (OZ standard tree, address-domain leaves) + canonical blob + CID.
  const leaves = assigned.map(([a, v]) => outputLeaf(a, v))
  const outputRoot = merkleRoot(leaves)
  const blob = canonicalBlob(assigned)
  const digest = sha256Utf8(blob)
  const ipfsHash = digestToHex(digest)
  const cid = cidV1Raw(digest)
  const cidDigest = keccak256(stringToBytes(cid))

  // Journal v3 reused unmodified: slot A = trust, slot B = contributions;
  // skippedDigest = 0 in v1 (skips are derivable from committed inputs — INTERFACES.md §4);
  // the two v3 words pass straight through from the input.
  const journal: Journal = {
    acc,
    leafCount,
    anchorAcc,
    anchorCount,
    paramsHash: pHash,
    outputRoot,
    ipfsHash,
    cidDigest,
    totalValue,
    skippedDigest: ZERO_HASH,
    recipient: input.binding?.recipient ?? ZERO_ADDRESS,
    instanceDomain: input.binding?.instanceDomain ?? ZERO_HASH,
  }

  return {
    journal,
    scores: assigned,
    blob,
    cid,
    reputation: rep,
    claimScores: st2.claimScores,
    eligibility: elig,
    stage2: st2,
    liveState: state,
  }
}

/** The ABI-encoded journal-v2 tuple (reused unmodified from the trust program). */
export { journalEncoded }

/** The journal digest the on-chain verifier binds. */
export const journalDigest = (j: Journal): Hex => encodeJournalDigest(j)
