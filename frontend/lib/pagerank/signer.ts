//! Safe signer-sync selection: derive the Safe owner set + threshold from the governance weights.
//! Mirrors `pagerank_core::signer`.
//!
//! This is the signer-sync analogue of `compute`: it runs the exact same fixed-point Trust-Aware
//! PageRank (so the selection is bound to the same `(acc, leafCount, paramsHash)` commitment as the
//! root producer), then applies a deterministic top-N selection rule. It is float-free and
//! deterministic so the SP1 guest, host, and browser all agree byte-for-byte.

import { type Hex } from 'viem'

import { compute } from './compute'
import { selectionParamsHash, signerJournalDigest } from './encode'
import { signerSetRoot } from './merkle'
import {
  type GuestInput,
  type SelectionParams,
  type SignerComputeResult,
  type SignerInput,
  type SignerJournal,
} from './types'

/** `ceil(a / b)` for `b > 0`. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/** Numeric address comparison (compare as bigints of the 20-byte value), matching Rust `Address` ordering. */
const cmpAddr = (a: Hex, b: Hex): number => {
  const av = BigInt(a)
  const bv = BigInt(b)
  return av < bv ? -1 : av > bv ? 1 : 0
}

/**
 * Deterministically select the Safe owner set and threshold from the scored accounts.
 * Mirrors `pagerank_core::signer::select_signers`:
 *   1. filter to `value > 0`, rank by **value descending, then address ascending** (a total order),
 *   2. take the top `topN`,
 *   3. return the chosen addresses **sorted ascending** (the canonical order committed by the root),
 *   4. `threshold = clamp(ceil(targetThresholdBps * n / 10000), minThreshold, n)`, floored at 1.
 *
 * If no account has a positive score the set is empty and the threshold is 0.
 */
export const selectSigners = (
  scores: Array<[Hex, bigint]>,
  sp: SelectionParams
): { signers: Hex[]; threshold: bigint } => {
  const ranked = scores.filter(([, v]) => v !== 0n)
  // value desc, then address asc.
  ranked.sort((a, b) => {
    if (a[1] > b[1]) return -1
    if (a[1] < b[1]) return 1
    return cmpAddr(a[0], b[0])
  })
  const truncated = ranked.slice(0, sp.topN)

  const chosen = truncated.map(([a]) => a)
  chosen.sort(cmpAddr)

  const n = BigInt(chosen.length)
  if (n === 0n) {
    return { signers: chosen, threshold: 0n }
  }
  let threshold = ceilDiv(BigInt(sp.targetThresholdBps) * n, 10_000n)
  if (threshold < BigInt(sp.minThreshold)) {
    threshold = BigInt(sp.minThreshold)
  }
  if (threshold > n) {
    threshold = n
  }
  if (threshold < 1n) {
    threshold = 1n
  }
  return { signers: chosen, threshold }
}

/**
 * Run the full signer-sync pipeline: folded edges + params + selection → signer journal + owner set.
 * Deterministic and float-free. Mirrors `pagerank_core::signer::compute_signers`.
 */
export const computeSigners = (input: SignerInput): SignerComputeResult => {
  // Reuse the canonical root computation so the scores (and acc/leafCount/paramsHash) are
  // byte-identical to what the root producer proves for the same checkpoint.
  const base = compute({
    edges: input.edges,
    params: input.params,
  } as GuestInput)

  const selectionHash = selectionParamsHash(input.selection)
  const { signers, threshold: targetThreshold } = selectSigners(base.scores, input.selection)
  const setRoot = signerSetRoot(signers)

  const journal: SignerJournal = {
    acc: base.journal.acc,
    leafCount: base.journal.leafCount,
    paramsHash: base.journal.paramsHash,
    selectionParamsHash: selectionHash,
    signerSetRoot: setRoot,
    targetThreshold,
  }
  return { journal, signers, targetThreshold }
}

/** The signer journal digest the on-chain `SignerSyncZkModule` binds. Re-exported for convenience. */
export { signerJournalDigest }
