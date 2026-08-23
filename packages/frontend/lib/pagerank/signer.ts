//! Safe signer-sync selection: derive the Safe owner set + threshold from the governance weights.
//! Mirrors `pagerank_core::signer`.
//!
//! This is the signer-sync analogue of `compute`: it runs the exact same fixed-point Trust-Aware
//! PageRank (so the selection is bound to the same `(acc, leafCount, paramsHash)` commitment as the
//! root producer), then applies a deterministic top-N selection rule. It is float-free and
//! deterministic so the SP1 guest, host, and browser all agree byte-for-byte.

import { concat, keccak256, type Hex } from 'viem'

import { compute } from './compute'
import { selectionParamsHash, signerJournalDigest } from './encode'
import { signerSetRoot } from './merkle'
import {
  type GuestInput,
  type SignerActivity,
  type SelectionParams,
  type SignerComputeResult,
  type SignerInput,
  type SignerJournal,
} from './types'
import { ZERO_HASH, wordAddr, wordU256, wordU64 } from './words'

/** `ceil(a / b)` for `b > 0`. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/** Numeric address comparison (compare as bigints of the 20-byte value), matching Rust `Address` ordering. */
const cmpAddr = (a: Hex, b: Hex): number => {
  const av = BigInt(a)
  const bv = BigInt(b)
  return av < bv ? -1 : av > bv ? 1 : 0
}

/** Mirrors `MerkleGovModule._recordDirectActivity` and Rust `fold_activity`. */
export const foldActivity = (
  previous: Hex,
  sequence: bigint,
  record: SignerActivity
): Hex =>
  keccak256(
    concat([
      previous,
      wordU64(sequence),
      wordAddr(record.account),
      wordU256(record.proposalId),
      wordU64(record.blockNumber),
    ])
  )

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
  const activity = input.activity ?? []
  const activityCheckpoint = input.activityCheckpoint ?? {
    acc: ZERO_HASH,
    count: 0n,
    blockNumber: 0n,
  }
  let activityAcc = ZERO_HASH
  const latest = new Map<Hex, bigint>()
  activity.forEach((record, index) => {
    if (record.blockNumber > activityCheckpoint.blockNumber) {
      throw new Error('activity record after checkpoint')
    }
    activityAcc = foldActivity(activityAcc, BigInt(index + 1), record)
    const account = record.account.toLowerCase() as Hex
    const previous = latest.get(account) ?? 0n
    latest.set(account, record.blockNumber > previous ? record.blockNumber : previous)
  })
  if (activityCheckpoint.count !== BigInt(activity.length)) {
    throw new Error('activity count mismatch')
  }
  if (activityCheckpoint.acc.toLowerCase() !== activityAcc.toLowerCase()) {
    throw new Error('activity accumulator mismatch')
  }

  const currentSigners = [...(input.currentSigners ?? [])].map(
    (address) => address.toLowerCase() as Hex
  )
  currentSigners.sort(cmpAddr)
  if (currentSigners.length === 0 || new Set(currentSigners).size !== currentSigners.length) {
    throw new Error('invalid current Safe owner set')
  }
  const currentThreshold = input.currentThreshold ?? 0n
  if (currentThreshold < 1n || currentThreshold > BigInt(currentSigners.length)) {
    throw new Error('invalid current Safe threshold')
  }

  const cutoff =
    activityCheckpoint.blockNumber > input.selection.maxInactiveBlocks
      ? activityCheckpoint.blockNumber - input.selection.maxInactiveBlocks
      : 0n
  const fresh = new Set(
    [...latest.entries()]
      .filter(([, block]) => block >= cutoff)
      .map(([account]) => account)
  )
  const positiveScores = new Set(
    base.scores
      .filter(([, value]) => value !== 0n)
      .map(([account]) => account.toLowerCase() as Hex)
  )
  const witnessPool = input.wasInitialized
    ? currentSigners
    : [...positiveScores]
  const witnessCount = witnessPool.filter((account) => fresh.has(account)).length
  const minimum = input.selection.minActivityWitnesses
  let activityApplied =
    activityCheckpoint.count !== 0n &&
    minimum >= 2 &&
    witnessCount >= minimum
  let chosen = activityApplied
    ? selectSigners(
        base.scores.filter(([account]) =>
          fresh.has(account.toLowerCase() as Hex)
        ),
        input.selection
      )
    : { signers: currentSigners, threshold: currentThreshold }
  if (chosen.signers.length < minimum) {
    activityApplied = false
    chosen = { signers: currentSigners, threshold: currentThreshold }
  }
  const { signers, threshold: targetThreshold } = chosen
  const setRoot = signerSetRoot(signers)

  const journal: SignerJournal = {
    acc: base.journal.acc,
    leafCount: base.journal.leafCount,
    paramsHash: base.journal.paramsHash,
    selectionParamsHash: selectionHash,
    activityAcc: activityCheckpoint.acc,
    activityCount: activityCheckpoint.count,
    activityBlock: activityCheckpoint.blockNumber,
    wasInitialized: input.wasInitialized ?? false,
    currentSignerSetRoot: signerSetRoot(currentSigners),
    currentThreshold,
    signerSetRoot: setRoot,
    targetThreshold,
    // M-3: committed verbatim; a missing value commits the zero word, which no module accepts
    // (submitSignerProof rebuilds the domain from address(this) + block.chainid).
    instanceDomain: input.instanceDomain ?? (`0x${'00'.repeat(32)}` as Hex),
  }
  return { journal, signers, targetThreshold, activityApplied }
}

/** The signer journal digest the on-chain `SignerSyncZkModule` binds. Re-exported for convenience. */
export { signerJournalDigest }
