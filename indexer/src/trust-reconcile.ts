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
