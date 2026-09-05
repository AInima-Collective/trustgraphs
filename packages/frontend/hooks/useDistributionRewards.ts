'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type Hex, zeroAddress } from 'viem'

import { useTokenMetadata } from '@/hooks/useTokenMetadata'
import { contributionsQueries } from '@/lib/contributions-api'
import { financialProofReady, financialReadState } from '@/lib/financial-state'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { merkleFundDistribution } from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

type Distribution = typeof merkleFundDistribution.$inferSelect
type MerkleEntry = { value: string; proof: string[] }

export type ClaimSource = {
  id: 'network' | 'contributions'
  title: string
  description: string
  href: string
  linkLabel: string
  distributor: Hex
  snapshot: Hex
}

export type Reward = {
  source: ClaimSource
  distribution: Distribution
  entry: MerkleEntry | null
  amount: bigint
  claimedAmount: bigint
  status:
    | 'available'
    | 'claimed'
    | 'expired'
    | 'swept'
    | 'none'
    | 'unknown'
    | 'pending'
  transactionHash?: Hex
}

export const useDistributionRewards = ({
  source,
  account,
  now,
}: {
  source?: ClaimSource
  account?: Hex
  now: number | null
}) => {
  const distributor = source?.distributor ?? zeroAddress
  const snapshot = source?.snapshot ?? zeroAddress
  const enabled = !!source

  const distributionsQuery = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributions(distributor),
    enabled,
  })

  const { data: distributions = [] } = distributionsQuery
  const claimsQuery = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributionClaims({
      distributor,
      account,
    }),
    enabled: enabled && !!account,
  })

  const { data: claims = [] } = claimsQuery
  const distributorQuery = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributor(distributor),
    enabled,
  })

  const distributorState = distributorQuery.data
  const requiredReads = financialReadState([
    distributionsQuery,
    distributorQuery,
    ...(account ? [claimsQuery] : []),
  ])
  const readState =
    requiredReads === 'ready' && !distributorState ? 'error' : requiredReads

  // The generic merkle endpoint is the normal proof source for both program
  // types. Contributions also expose a current-round payout bundle; keep it as
  // a fallback so an indexer rollout cannot strand an otherwise claimable
  // reward just because one of the two equivalent read routes is lagging.
  const latestSnapshotQuery = usePonderQuery({
    queryFn: ponderQueryFns.getLatestMerkleSnapshot(snapshot),
    enabled: source?.id === 'contributions',
  })
  const latestSnapshot = latestSnapshotQuery.data
  const payoutOptions = contributionsQueries.payout(snapshot, account)
  const payoutBundleQuery = useQuery({
    ...payoutOptions,
    enabled:
      source?.id === 'contributions' &&
      !!account &&
      payoutOptions.enabled !== false,
  })

  const roots = useMemo(
    () => Array.from(new Set(distributions.map(({ root }) => root))),
    [distributions]
  )
  const entryQueries = useQueries({
    queries: roots.map((root) => ({
      ...ponderQueries.merkleTreeEntry({ snapshot, root, account }),
      enabled: enabled && !!account,
    })),
  })
  const entries = useMemo(() => {
    const byRoot = new Map<string, MerkleEntry>()
    roots.forEach((root, index) => {
      const entry = entryQueries[index]?.data
      if (entry) byRoot.set(root, entry)
    })
    if (
      latestSnapshot?.root &&
      payoutBundleQuery.data &&
      !byRoot.has(latestSnapshot.root)
    ) {
      byRoot.set(latestSnapshot.root, {
        value: payoutBundleQuery.data.value,
        proof: payoutBundleQuery.data.proof,
      })
    }
    return byRoot
  }, [entryQueries, latestSnapshot?.root, payoutBundleQuery.data, roots])

  const claimedByDistribution = useMemo(() => {
    const byDistribution = new Map<bigint, bigint>()
    for (const claim of claims) {
      byDistribution.set(claim.distributionIndex, claim.amount)
    }
    return byDistribution
  }, [claims])

  const tokenMetadata = useTokenMetadata(
    distributions.map(({ token }) => token)
  )

  const rewards = useMemo<Reward[]>(() => {
    if (!source) return []

    return distributions.map((distribution) => {
      const proofQuery = entryQueries[roots.indexOf(distribution.root)]
      const entry = entries.get(distribution.root) ?? null
      const fallbackReady =
        source.id === 'contributions' &&
        financialProofReady(latestSnapshotQuery) &&
        financialProofReady(payoutBundleQuery) &&
        !!payoutBundleQuery.data &&
        latestSnapshot?.root === distribution.root
      const proofReady = fallbackReady || financialProofReady(proofQuery)
      const claimedAmount = claimedByDistribution.get(distribution.id) ?? 0n
      const share = entry
        ? distribution.totalMerkleValue === 0n
          ? 0n
          : ((distribution.amountFunded - distribution.feeAmount) *
              BigInt(entry.value)) /
            distribution.totalMerkleValue
        : 0n
      const amount = claimedAmount > 0n ? claimedAmount : share
      const expired =
        now !== null &&
        distribution.claimDeadline > 0n &&
        BigInt(now) > distribution.claimDeadline

      return {
        source,
        distribution,
        entry,
        amount,
        claimedAmount,
        status:
          readState !== 'ready' ||
          tokenMetadata.state(distribution.token) !== 'ready' ||
          !proofReady ||
          (distribution.claimDeadline > 0n && now === null)
            ? 'unknown'
            : claimedAmount > 0n
              ? 'claimed'
              : distribution.sweptAmount > 0n
                ? 'swept'
                : expired
                  ? 'expired'
                  : share > 0n
                    ? 'available'
                    : 'none',
      }
    })
  }, [
    claimedByDistribution,
    distributions,
    entries,
    now,
    source,
    readState,
    tokenMetadata,
    entryQueries,
    roots,
    latestSnapshotQuery.isError,
    payoutBundleQuery.isError,
    payoutBundleQuery.data,
    latestSnapshot?.root,
  ])

  return {
    source,
    rewards,
    readState,
    historyState: financialReadState([distributionsQuery]),
    distributorState,
    distributorReadState: financialReadState([distributorQuery]),
    paused: distributorState?.paused === true,
    loading:
      readState === 'loading' ||
      (!!account && entryQueries.some((query) => query.isPending)) ||
      distributions.some(
        ({ token }) => tokenMetadata.state(token) === 'loading'
      ),
    proofError: entryQueries.some((query) => query.isError),
    metadataError: distributions.some(({ token }) =>
      ['error', 'stale'].includes(tokenMetadata.state(token))
    ),
    tokenLabel: tokenMetadata.get,
    retry: () => {
      void Promise.allSettled([
        distributionsQuery.refetch(),
        distributorQuery.refetch(),
        ...(source?.id === 'contributions'
          ? [latestSnapshotQuery.refetch()]
          : []),
        ...(account
          ? [
              claimsQuery.refetch(),
              ...entryQueries.map((query) => query.refetch()),
            ]
          : []),
        ...(distributions.some(({ token }) => token !== zeroAddress)
          ? [tokenMetadata.refetch()]
          : []),
        ...(source?.id === 'contributions' && account
          ? [payoutBundleQuery.refetch()]
          : []),
      ])
    },
  }
}

export type RewardState = ReturnType<typeof useDistributionRewards>
