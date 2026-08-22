'use client'

import { queryOptions, useQuery } from '@tanstack/react-query'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'

import { APIS } from '@/lib/config'
import {
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
} from '@/lib/score-program'
import {
  PENDING_ECHO_TTL_MS,
  clearPendingEchoesAtom,
  pendingEchoesAtom,
} from '@/state/score-updates'

/**
 * `GET /network/:snapshot/status` — the pending-score state the app shows between "attestation
 * saved" and "scores updated". Derived from chain events alone (the indexer's trigger + proof
 * rows), so it is the same for every viewer regardless of whose operator does the proving.
 */
export type ScoreUpdateStatus = {
  scoreProgram: ScoreProgramProvenance
  /** The last landed update, or null before a network's first root. */
  lastUpdate: {
    root: string
    /** Unix seconds of the block that landed the root. */
    timestamp: number
    blockNumber: string
    checkpointId: string | null
  } | null
  /** Set while inputs are frozen and a proof is being computed (or owed). */
  recounting: { checkpointId: string; since: number } | null
  /** Attestations the served scores do not include yet; null when unknowable. */
  pendingAttestations: number | null
}

export const scoreUpdatesQuery = (snapshot: string) =>
  queryOptions({
    queryKey: ['scoreUpdates', snapshot.toLowerCase()],
    queryFn: async (): Promise<ScoreUpdateStatus> => {
      const response = await fetch(`${APIS.ponder}/network/${snapshot}/status`)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch score update status: ${response.status}`
        )
      }
      const data = (await response.json()) as ScoreUpdateStatus
      const scoreProgram = parseScoreProgramProvenance(data.scoreProgram)
      if (
        scoreProgram.programName !== 'trust-graph' &&
        scoreProgram.programName !== 'trust-graph-weighted'
      ) {
        throw new Error(
          `${scoreProgram.programName} is not a vouch-network status response`
        )
      }
      return { ...data, scoreProgram }
    },
    // The whole point is watching a roughly-90-second pipeline move; the page's 10s data cadence
    // would let the chip skip straight past "recounting".
    refetchInterval: 5_000,
  })

/** 3:41 PM today, or Jun 5, 3:41 PM across days. */
export const formatUpdateTime = (unixSeconds: number) => {
  const date = new Date(unixSeconds * 1000)
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })}, ${time}`
}

/**
 * The status endpoint plus this browser's local echoes: an attestation sent moments ago counts in
 * `pendingCount` immediately, without waiting out Ponder's finality window.
 */
export const useScoreUpdates = (snapshot: string | undefined) => {
  const query = useQuery({
    ...scoreUpdatesQuery(snapshot ?? ''),
    enabled: !!snapshot,
  })

  const echoes = useAtomValue(pendingEchoesAtom)
  const clearEchoes = useSetAtom(clearPendingEchoesAtom)
  const ownEchoes = (echoes[snapshot?.toLowerCase() ?? ''] ?? []).filter(
    (at) => Date.now() - at < PENDING_ECHO_TTL_MS
  )

  // When the server's pending count rises, the indexer has caught up with whatever the echoes
  // were standing in for — drop them rather than double-count. (An echo raced by someone else's
  // attestation can briefly over-count by one; the next movement corrects it.)
  const serverPending = query.data?.pendingAttestations ?? null
  const previousServerPendingRef = useRef<number | null>(null)
  useEffect(() => {
    if (serverPending === null || !snapshot) return
    const previous = previousServerPendingRef.current
    previousServerPendingRef.current = serverPending
    if (previous !== null && serverPending > previous) {
      clearEchoes(snapshot)
    }
  }, [serverPending, snapshot, clearEchoes])

  const pendingCount =
    serverPending === null && ownEchoes.length === 0
      ? null
      : (serverPending ?? 0) + ownEchoes.length

  return {
    status: query.data,
    isLoading: query.isLoading,
    pendingCount,
    /** Whether any of the pending attestations are this browser's own. */
    hasOwnPending: ownEchoes.length > 0,
  }
}
