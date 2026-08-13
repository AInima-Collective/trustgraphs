/** Minimal TanStack Query surface used by the polling policy. */
export type PollingQuery = object & {
  state: {
    data: unknown
    dataUpdateCount: number
    errorUpdateCount: number
    status: 'error' | 'pending' | 'success'
  }
}

export type IndexerPollingOptions = {
  /** Normal interval for a query that is returning usable data. */
  baseMs: number
  /** Longest delay while an indexer read is missing or failing. */
  maxMs?: number
  /** Stop timer polling after this many consecutive missing/error results. */
  stopAfter?: number
}

type PollingState = {
  dataUpdateCount: number
  errorUpdateCount: number
  unhealthyStreak: number
}

/**
 * Build a bounded polling policy for indexer reads.
 *
 * A 404 mapped to `null` is an ordinary "not indexed yet" result, while a thrown request error
 * means the endpoint is unhealthy. Neither should hammer the same endpoint forever. Healthy data
 * keeps the normal cadence; missing/error results back off exponentially and then suspend timer
 * polling. Window focus, network reconnect and explicit `refetch()` can still revive a suspended
 * query, and a subsequent healthy result resets the streak.
 */
export const createIndexerPollingPolicy = ({
  baseMs,
  maxMs = baseMs * 8,
  stopAfter = 3,
}: IndexerPollingOptions) => {
  const states = new WeakMap<object, PollingState>()

  return (query: PollingQuery): number | false => {
    const { state } = query
    if (state.status === 'pending') return baseMs

    const previous = states.get(query)
    const resultChanged =
      !previous ||
      previous.dataUpdateCount !== state.dataUpdateCount ||
      previous.errorUpdateCount !== state.errorUpdateCount

    let unhealthyStreak = previous?.unhealthyStreak ?? 0
    if (resultChanged) {
      unhealthyStreak =
        state.status === 'error' ||
        state.data === null ||
        state.data === undefined
          ? unhealthyStreak + 1
          : 0
      states.set(query, {
        dataUpdateCount: state.dataUpdateCount,
        errorUpdateCount: state.errorUpdateCount,
        unhealthyStreak,
      })
    }

    if (unhealthyStreak >= stopAfter) return false
    if (unhealthyStreak === 0) return baseMs
    return Math.min(baseMs * 2 ** unhealthyStreak, maxMs)
  }
}

/** Indexer reads treat absence as state, not as a reason for an automatic retry burst. */
export const ROUTINE_INDEXER_QUERY_OPTIONS = {
  retry: false,
} as const
