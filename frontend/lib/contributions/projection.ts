export interface ContributionProjection {
  claimUid: string
  /** Proven or optimistically recomputed S(c), fixed point. */
  scoreFp: bigint
  /** Exact basis-point allocation used by the stacked bar. */
  shareBps: bigint
  /** Raw pool-token units if the round settled at these scores. */
  payout: bigint
}

/**
 * Split the displayed pool by audited claim scores with integer-only arithmetic. The ordering and
 * remainder rule are deterministic, so the bar, card labels, and parity guard share one result.
 */
export const projectContributionPool = (
  scores: Iterable<readonly [string, bigint | string]>,
  pool: bigint | string
): ContributionProjection[] => {
  const entries = Array.from(scores, ([claimUid, score]) => ({
    claimUid: claimUid.toLowerCase(),
    scoreFp: BigInt(score),
  }))
    .filter((entry) => entry.scoreFp > 0n)
    .sort((a, b) =>
      a.scoreFp === b.scoreFp
        ? a.claimUid < b.claimUid
          ? -1
          : a.claimUid > b.claimUid
            ? 1
            : 0
        : a.scoreFp > b.scoreFp
          ? -1
          : 1
    )
  const totalScore = entries.reduce((sum, entry) => sum + entry.scoreFp, 0n)
  if (totalScore === 0n) return []

  const totalPool = BigInt(pool)
  let payoutRemaining = totalPool
  let basisPointsRemaining = 10_000n
  return entries.map((entry, index) => {
    const isLast = index === entries.length - 1
    const payout = isLast
      ? payoutRemaining
      : (totalPool * entry.scoreFp) / totalScore
    const shareBps = isLast
      ? basisPointsRemaining
      : (10_000n * entry.scoreFp) / totalScore
    payoutRemaining -= payout
    basisPointsRemaining -= shareBps
    return { ...entry, payout, shareBps }
  })
}
