'use client'

import { formatUpdateTime, useScoreUpdates } from '@/hooks/useScoreUpdates'
import { cn } from '@/lib/utils'

/**
 * The honesty line under score listings. Scores are a published batch, not a live value, so date
 * them — and when attestations have landed since, say so instead of passing the numbers off as
 * current. Same data as the header chip, kept to one quiet mono line.
 */
export const ScoresAsOf = ({
  snapshot,
  className,
}: {
  snapshot: string | undefined
  className?: string
}) => {
  const { status, pendingCount } = useScoreUpdates(snapshot)
  if (!status?.lastUpdate) return null

  const suffix = status.recounting
    ? ' · recounting…'
    : pendingCount
      ? ` · ${pendingCount} new since`
      : ''

  return (
    <span className={cn('font-mono text-xs text-text-muted', className)}>
      Scores as of {formatUpdateTime(status.lastUpdate.timestamp)}
      {suffix}
    </span>
  )
}
