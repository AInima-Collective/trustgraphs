/** Votes as `TrustPool.Voted` records them; `support` is Bravo order (0 Against, 1 For, 2 Abstain). */
export type PoolCast = { proposalId: bigint; support: number; weight: bigint }

export type PoolTally = {
  against: bigint
  for: bigint
  abstain: bigint
  voters: number
}

/** The pool's own split per proposal: what its members cast, before Gitcoin-wide totals. */
export const tallyPoolCasts = (casts: PoolCast[]): Map<bigint, PoolTally> => {
  const tallies = new Map<bigint, PoolTally>()
  for (const cast of casts) {
    const tally = tallies.get(cast.proposalId) ?? {
      against: 0n,
      for: 0n,
      abstain: 0n,
      voters: 0,
    }
    const key = (['against', 'for', 'abstain'] as const)[cast.support]
    if (key) tally[key] += cast.weight
    tally.voters += 1
    tallies.set(cast.proposalId, tally)
  }
  return tallies
}
