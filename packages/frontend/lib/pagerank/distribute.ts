//! Full-precision Hamilton allocation, matching `pagerank_core::distribute`.

import { type Hex } from 'viem'

import { checkedAdd } from './fixed'
import { type Params } from './types'
import { cmpBig, cmpHex } from './words'

/** Exact proportional floors plus largest remainders; ties use ascending keys. */
export const distributePoints = (
  scoresFp: Array<[Hex, bigint]>,
  p: Params
): { assigned: Array<[Hex, bigint]>; totalValue: bigint } => {
  const scores = scoresFp
    .filter(([, value]) => value > 0n)
    .sort((a, b) => cmpHex(a[0], b[0]))
  if (
    scores.some(
      ([key], index) => index > 0 && cmpHex(key, scores[index - 1]![0]) === 0
    )
  ) {
    throw new Error('duplicate allocation key')
  }
  if (scores.length === 0 || p.totalPool === 0n)
    return { assigned: [], totalValue: 0n }
  const total = scores.reduce(
    (sum, [, value]) => checkedAdd(sum, value, 'allocation score sum'),
    0n
  )
  const rows = scores.map(([key, score]) => {
    const product = score * p.totalPool
    return { key, value: product / total, remainder: product % total }
  })
  const floors = rows.reduce((sum, row) => sum + row.value, 0n)
  const missing = p.totalPool - floors
  if (missing < 0n || missing >= BigInt(rows.length))
    throw new Error('invalid Hamilton remainder')
  const order = rows
    .map((_, index) => index)
    .sort(
      (a, b) =>
        cmpBig(rows[b]!.remainder, rows[a]!.remainder) ||
        cmpHex(rows[a]!.key, rows[b]!.key)
    )
  for (const index of order.slice(0, Number(missing))) rows[index]!.value += 1n
  const assigned: Array<[Hex, bigint]> = rows
    .filter((row) => row.value > 0n)
    .map(({ key, value }) => [key, value])
  return { assigned, totalValue: p.totalPool }
}
