'use client'

import { useEffect, useRef, useState } from 'react'

import { NetworkEntry } from '@/lib/types'

/**
 * Score changes at the moment a new update lands, keyed by lowercased account.
 *
 * Scores only ever change when a root lands — the roster is otherwise static — so "some value
 * moved against the last seen values" IS the landing moment. Watching values rather than the root
 * also sidesteps the root and the roster arriving on separate polls. Deltas stay up for ten
 * seconds: long enough to catch the eye and teach cause-and-effect, short enough not to become
 * furniture.
 */
export const useScoreDeltas = (rows: NetworkEntry[], enabled: boolean) => {
  const previousRef = useRef<Map<string, bigint> | null>(null)
  const [deltas, setDeltas] = useState<Map<string, bigint> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Simulation mode rewrites values on every slider tweak; a delta there is noise. Forget the
    // real values too, so re-enabling never diffs real scores against simulated ones.
    if (!enabled) {
      previousRef.current = null
      return
    }
    if (rows.length === 0) return

    const values = new Map(
      rows.map((row) => [row.account.toLowerCase(), BigInt(row.value || '0')])
    )
    const previous = previousRef.current
    previousRef.current = values
    if (!previous) return

    const changed = new Map<string, bigint>()
    for (const [account, value] of values) {
      const before = previous.get(account) ?? 0n
      if (value !== before) changed.set(account, value - before)
    }
    if (changed.size === 0) return

    setDeltas(changed)
    // Managed through a ref, not the effect cleanup: rows change identity on every poll and ENS
    // resolve, and an effect-cleanup timer would be cancelled by the first no-op run after it.
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setDeltas(null), 10_000)
  }, [rows, enabled])

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  return deltas
}
