//! Point distribution — the integer port of `pagerank_core::distribute`.
//!
//! Scores (scaled by S) are re-scaled to the fixed 1e6 payout quantum, sorted descending (ties broken by
//! address ascending), and paid out proportionally; the last account absorbs the remainder so the
//! total equals `totalPool` exactly.

import { type Hex } from 'viem'

import { mulDiv } from './fixed'
import { type Params } from './types'
import { cmpBig, cmpHex } from './words'

/** The fixed payout quantum: scores are scaled to `u64` by 1e6 before distribution. Consensus-frozen. */
const QUANTUM = 1_000_000n

/**
 * Distribute `totalPool` across `scoresFp` (normalized PageRank scores, scaled by S, `value > 0`).
 * Returns `{ assigned, totalValue }` where `assigned` holds only `value > 0` entries and
 * `totalValue === totalPool` whenever anything is distributed.
 */
export const distributePoints = (
  scoresFp: Array<[Hex, bigint]>,
  p: Params
): { assigned: Array<[Hex, bigint]>; totalValue: bigint } => {
  if (scoresFp.length === 0) return { assigned: [], totalValue: 0n }
  const s = p.precisionScale

  // score * 1e6 (truncating), kept as bigint.
  const scaled: Array<[Hex, bigint]> = scoresFp.map(([a, sc]) => [
    a,
    mulDiv(sc, QUANTUM, s),
  ])

  let totalScaled = 0n
  for (const [, v] of scaled) totalScaled += v
  if (totalScaled === 0n) return { assigned: [], totalValue: 0n }

  // Sort by scaled score descending, then address ascending (deterministic tie-break).
  scaled.sort((a, b) => {
    const c = cmpBig(b[1], a[1])
    return c !== 0 ? c : cmpHex(a[0], b[0])
  })

  const totalPool = p.totalPool
  let remaining = totalPool
  const assigned: Array<[Hex, bigint]> = []
  const len = scaled.length

  for (const [i, [addr, sc]] of scaled.entries()) {
    let points: bigint
    if (i === len - 1) {
      points = remaining
    } else {
      const proportional = mulDiv(sc, totalPool, totalScaled)
      points = proportional > remaining ? remaining : proportional
    }
    const actual = points > remaining ? remaining : points
    if (actual !== 0n) {
      remaining -= actual
      assigned.push([addr, actual])
    }
    if (remaining === 0n) break
  }

  let totalValue = 0n
  for (const [, v] of assigned) totalValue += v
  return { assigned, totalValue }
}
