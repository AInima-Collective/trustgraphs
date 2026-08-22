/** One trust-graph accumulator record, with the fields needed for canonical pair reconciliation. */
export type FoldedVouch = {
  kind: number
  attester: string
  recipient: string
  uid: string
  blockNumber: bigint
  logIndex: number
}

/**
 * Return the current attest record for every live `(attester, recipient)` pair.
 *
 * This mirrors `pagerank_core::reconcile`: fold position breaks ordering ties, a revoke clears only
 * the UID currently occupying the pair, and a cleared pair never falls back to an older record.
 */
export const currentVouches = <T extends FoldedVouch>(records: T[]): T[] => {
  const ordered = [...records].sort((a, b) => {
    if (a.blockNumber < b.blockNumber) return -1
    if (a.blockNumber > b.blockNumber) return 1
    return a.logIndex - b.logIndex
  })

  const current = new Map<string, T>()
  for (const record of ordered) {
    const pair = `${record.attester.toLowerCase()}:${record.recipient.toLowerCase()}`
    if (record.kind === 0) {
      current.set(pair, record)
    } else if (
      record.kind === 1 &&
      current.get(pair)?.uid.toLowerCase() === record.uid.toLowerCase()
    ) {
      current.delete(pair)
    }
  }
  return [...current.values()]
}

/** One cross-lane mutation in the guest's canonical total order. */
export type TimedVouch = {
  kind: number
  attester: string
  recipient: string
  uid: string
  timestamp: bigint
  /** Lane 0 (on-chain EAS) precedes lane 1 (strict off-chain EAS) on equal timestamps. */
  sourceLane: 0 | 1
  /** Fold position inside that lane. */
  sourceOrder: bigint
  /** In-log entry position; zero for lane 0. */
  sourceSuborder: number
}

/**
 * Return the live cross-lane vouch for every pair using the exact guest ordering:
 * `(effective timestamp, source lane, source fold, in-log position)`.
 *
 * Revoke mutations remain in this input. Removing them before reconciliation is the historical
 * resurrection bug this helper exists to prevent.
 */
export const currentTimedVouches = <T extends TimedVouch>(
  records: T[]
): T[] => {
  const ordered = [...records].sort((a, b) => {
    if (a.timestamp < b.timestamp) return -1
    if (a.timestamp > b.timestamp) return 1
    if (a.sourceLane !== b.sourceLane) return a.sourceLane - b.sourceLane
    if (a.sourceOrder < b.sourceOrder) return -1
    if (a.sourceOrder > b.sourceOrder) return 1
    return a.sourceSuborder - b.sourceSuborder
  })

  const current = new Map<string, T>()
  for (const record of ordered) {
    const pair = `${record.attester.toLowerCase()}:${record.recipient.toLowerCase()}`
    if (record.kind === 0) {
      current.set(pair, record)
    } else if (
      record.kind === 1 &&
      current.get(pair)?.uid.toLowerCase() === record.uid.toLowerCase()
    ) {
      current.delete(pair)
    }
  }
  return [...current.values()]
}
