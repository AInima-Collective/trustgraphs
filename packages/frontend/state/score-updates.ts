import { atom } from 'jotai'

/**
 * Attestations this browser just made, per snapshot (lowercased key), as epoch-ms timestamps.
 *
 * The indexer serves an attestation only once it is past Ponder's finality window, so for the
 * first minute or so after a vouch the server's pending count does not include it. These echoes
 * bridge that gap: the status chip adds them to the server count, and drops them the moment the
 * server count moves (the indexer caught up), when an update lands, or after a TTL — whichever
 * comes first.
 */
export const pendingEchoesAtom = atom<Record<string, number[]>>({})

/** How long an echo may stand in for the indexer before it is assumed stale. */
export const PENDING_ECHO_TTL_MS = 3 * 60 * 1000

const key = (snapshot: string) => snapshot.toLowerCase()

/** Record one just-sent attestation (or revocation) against a snapshot. */
export const bumpPendingEchoAtom = atom(null, (get, set, snapshot: string) => {
  const echoes = get(pendingEchoesAtom)
  set(pendingEchoesAtom, {
    ...echoes,
    [key(snapshot)]: [...(echoes[key(snapshot)] ?? []), Date.now()],
  })
})

/** Drop a snapshot's echoes — the server count moved, or an update landed. */
export const clearPendingEchoesAtom = atom(
  null,
  (get, set, snapshot: string) => {
    const echoes = get(pendingEchoesAtom)
    if (!echoes[key(snapshot)]?.length) return
    const { [key(snapshot)]: _dropped, ...rest } = echoes
    set(pendingEchoesAtom, rest)
  }
)
