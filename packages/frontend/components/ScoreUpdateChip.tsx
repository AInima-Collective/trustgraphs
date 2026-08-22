'use client'

import { useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { useNetworkIfAvailable } from '@/contexts/NetworkContext'
import { formatUpdateTime, useScoreUpdates } from '@/hooks/useScoreUpdates'
import { cn, formatTimeAgo } from '@/lib/utils'
import { clearPendingEchoesAtom } from '@/state/score-updates'

import { Popup } from './Popup'

/**
 * The network's score-update state, as a quiet chip beside the page title.
 *
 * Scores here are published in verified batches, so between an attestation landing and its scores
 * arriving there is a real minutes-long window. This chip is where that window lives in the UI:
 * "N new attestations" while folds queue, "recounting scores" while a checkpoint is frozen and
 * proving, a brief "scores updated" flash (plus a toast, plus a data refresh) when the root lands.
 * Clicking it opens the plain-language explanation; the proof talk stays in here, one click deep,
 * never on the surface.
 */
export const ScoreUpdateChip = ({
  snapshot,
  className,
}: {
  snapshot: string | undefined
  className?: string
}) => {
  const { status, pendingCount, hasOwnPending } = useScoreUpdates(snapshot)
  const clearEchoes = useSetAtom(clearPendingEchoesAtom)
  const network = useNetworkIfAvailable()
  const refresh = network?.refresh

  const [flashing, setFlashing] = useState(false)
  const lastRootRef = useRef<string | null>(null)
  // Read inside the effect without retriggering it: whether the just-landed update contained one
  // of this browser's own attestations only matters at the moment the root changes.
  const hasOwnPendingRef = useRef(false)
  hasOwnPendingRef.current = hasOwnPending

  const root = status?.lastUpdate?.root ?? null
  useEffect(() => {
    if (!root || !snapshot) return
    if (lastRootRef.current === null) {
      // First observation is a baseline, not a landing — no fanfare for old news.
      lastRootRef.current = root
      return
    }
    if (root === lastRootRef.current) return
    lastRootRef.current = root

    // A new update landed while the user is looking: close the loop. One toast even though the
    // trust and round roots land seconds apart — this chip watches only the trust snapshot.
    toast.success(
      hasOwnPendingRef.current
        ? 'Scores updated. Your attestation is now counted.'
        : 'Scores updated.'
    )
    clearEchoes(snapshot)
    refresh?.()
    setFlashing(true)
    const timeout = setTimeout(() => setFlashing(false), 6_000)
    return () => clearTimeout(timeout)
  }, [root, snapshot, clearEchoes, refresh])

  // Nothing to say about a network with no updates, no frozen checkpoint and no pending folds.
  if (!status || (!status.lastUpdate && !status.recounting && !pendingCount)) {
    return null
  }

  const label = flashing
    ? 'scores updated'
    : status.recounting
      ? 'recounting scores…'
      : pendingCount
        ? `${pendingCount} new attestation${pendingCount === 1 ? '' : 's'}`
        : status.lastUpdate
          ? `updated ${formatTimeAgo(status.lastUpdate.timestamp * 1000)}`
          : 'first update pending'

  const glyph = flashing ? (
    <span aria-hidden>✓</span>
  ) : status.recounting ? (
    <span aria-hidden className="animate-pulse">
      ◉
    </span>
  ) : (
    <span aria-hidden>●</span>
  )

  return (
    <Popup
      position="left"
      popupLabel="Score updates"
      trigger={{
        type: 'custom',
        Renderer: ({ onClick, open }) => (
          <button
            type="button"
            onClick={onClick}
            className={cn(
              'inline-flex cursor-pointer items-center gap-2 border border-border bg-surface px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors',
              open ? 'text-text' : 'text-text-muted hover:text-text',
              className
            )}
          >
            {glyph}
            <span>{label}</span>
          </button>
        ),
      }}
    >
      <div className="max-w-xs space-y-3 text-sm">
        <p>
          Attestations are saved to the network right away. Scores recount in
          batches: each update is checked before it is published.
        </p>

        <div className="space-y-1 font-mono text-xs">
          <div className="flex flex-row justify-between gap-6">
            <span className="text-text-muted">LAST UPDATE</span>
            <span>
              {status.lastUpdate
                ? formatUpdateTime(status.lastUpdate.timestamp)
                : 'none yet'}
            </span>
          </div>
          {pendingCount !== null && (
            <div className="flex flex-row justify-between gap-6">
              <span className="text-text-muted">NEW SINCE</span>
              <span>
                {pendingCount} attestation{pendingCount === 1 ? '' : 's'}
              </span>
            </div>
          )}
          <div className="flex flex-row justify-between gap-6">
            <span className="text-text-muted">STATUS</span>
            <span>
              {status.recounting
                ? 'recounting now…'
                : pendingCount
                  ? 'waiting for the next update'
                  : 'up to date'}
            </span>
          </div>
        </div>

        <p className="text-xs text-text-muted">
          Each update comes with a proof that the scores were computed correctly
          from every attestation.
        </p>
      </div>
    </Popup>
  )
}
