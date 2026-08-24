'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, Clock3, WalletCards } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Hex, erc20Abi, formatUnits, zeroAddress } from 'viem'
import { useAccount, usePublicClient, useReadContracts } from 'wagmi'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { NetworkHeader } from '@/components/NetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { contributionsQueries } from '@/lib/contributions-api'
import { parseErrorMessage } from '@/lib/error'
import type { NetworkTab } from '@/lib/network-nav'
import { txToast } from '@/lib/tx'
import { ContributionsNetwork, Network } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { isHexEqual } from '@/lib/utils'
import { merkleFundDistribution } from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { DistributePage } from '../distribute/component'

type Distribution = typeof merkleFundDistribution.$inferSelect
type MerkleEntry = { value: string; proof: string[] }

type ClaimSource = {
  id: 'network' | 'contributions'
  title: string
  description: string
  href: string
  linkLabel: string
  distributor: Hex
  snapshot: Hex
}

type Reward = {
  source: ClaimSource
  distribution: Distribution
  entry: MerkleEntry | null
  amount: bigint
  claimedAmount: bigint
  status: 'available' | 'claimed' | 'expired' | 'swept' | 'none'
}

const compactToken = (token: string) =>
  `${token.slice(0, 6)}…${token.slice(-4)}`

const formatAmount = (
  value: bigint,
  decimals: number,
  symbol: string
): string => {
  const [whole, rawFraction = ''] = formatUnits(value, decimals).split('.')
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = rawFraction.replace(/0+$/, '').slice(0, 4)

  if (value > 0n && groupedWhole === '0' && rawFraction && !fraction) {
    return `<0.0001 ${symbol}`
  }

  return `${groupedWhole}${fraction ? `.${fraction}` : ''} ${symbol}`
}

const useDistributionRewards = ({
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

  const { data: distributions = [], isLoading: distributionsLoading } =
    usePonderQuery({
      queryFn: ponderQueryFns.getFundDistributions(distributor),
      enabled,
    })

  const { data: claims = [], isLoading: claimsLoading } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributionClaims({
      distributor,
      account,
    }),
    enabled: enabled && !!account,
  })

  const { data: distributorState } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributor(distributor),
    enabled,
  })

  // The generic merkle endpoint is the normal proof source for both program
  // types. Contributions also expose a current-round payout bundle; keep it as
  // a fallback so an indexer rollout cannot strand an otherwise claimable
  // reward just because one of the two equivalent read routes is lagging.
  const { data: latestSnapshot } = usePonderQuery({
    queryFn: ponderQueryFns.getLatestMerkleSnapshot(snapshot),
    enabled: source?.id === 'contributions',
  })
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

  const erc20Tokens = useMemo(
    () =>
      Array.from(
        new Set(
          distributions
            .map(({ token }) => token)
            .filter((token) => !isHexEqual(token, zeroAddress))
        )
      ),
    [distributions]
  )
  const tokenContracts = useMemo(
    () =>
      erc20Tokens.flatMap((token) => [
        {
          address: token,
          abi: erc20Abi,
          functionName: 'symbol' as const,
        },
        {
          address: token,
          abi: erc20Abi,
          functionName: 'decimals' as const,
        },
      ]),
    [erc20Tokens]
  )
  const tokenReads = useReadContracts({
    contracts: tokenContracts,
    query: { enabled: tokenContracts.length > 0 },
  })
  const tokenMetadata = useMemo(() => {
    const metadata = new Map<string, { symbol: string; decimals: number }>()
    metadata.set(zeroAddress, { symbol: 'ETH', decimals: 18 })
    erc20Tokens.forEach((token, index) => {
      const symbol = tokenReads.data?.[index * 2]?.result
      const decimals = tokenReads.data?.[index * 2 + 1]?.result
      metadata.set(token, {
        symbol: typeof symbol === 'string' ? symbol : compactToken(token),
        decimals: typeof decimals === 'number' ? decimals : 18,
      })
    })
    return metadata
  }, [erc20Tokens, tokenReads.data])

  const rewards = useMemo<Reward[]>(() => {
    if (!source) return []

    return distributions.map((distribution) => {
      const entry = entries.get(distribution.root) ?? null
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
          claimedAmount > 0n
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
  }, [claimedByDistribution, distributions, entries, now, source])

  const tokenLabel = (token: Hex) =>
    tokenMetadata.get(token) ?? { symbol: compactToken(token), decimals: 18 }

  return {
    source,
    rewards,
    paused: distributorState?.paused ?? false,
    loading:
      distributionsLoading ||
      (!!account &&
        (claimsLoading ||
          entryQueries.some((query) => query.isLoading) ||
          (source?.id === 'contributions' && payoutBundleQuery.isLoading))) ||
      tokenReads.isLoading,
    proofError: entryQueries.some((query) => query.isError),
    tokenLabel,
  }
}

type RewardState = ReturnType<typeof useDistributionRewards>

export const RewardsPage = ({
  network,
  contributionRound,
  defaultFundOpen = false,
  tabs,
}: {
  network: Network
  contributionRound?: ContributionsNetwork
  defaultFundOpen?: boolean
  tabs?: NetworkTab[]
}) => {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const [now, setNow] = useState<number | null>(null)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claimingAll, setClaimingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setNow(Math.floor(Date.now() / 1_000)), [])

  const networkSource = network.contracts.merkleFundDistributor
    ? {
        id: 'network' as const,
        title: 'Network rewards',
        description: `Funds allocated using the ${network.name} trust scores captured when each reward pool was created.`,
        href: '#fund-rewards',
        linkLabel: 'Funding and history',
        distributor: network.contracts.merkleFundDistributor,
        snapshot: network.contracts.merkleSnapshot,
      }
    : undefined
  const contributionSource = contributionRound
    ? {
        id: 'contributions' as const,
        title: 'Contribution rewards',
        description:
          'Your share of community-scored work, weighted by reputation and fixed by the proven round result.',
        href: `/networks/${network.id}/contributions`,
        linkLabel: 'View contributions',
        distributor: contributionRound.contracts.merkleFundDistributor,
        snapshot: contributionRound.contracts.merkleSnapshot,
      }
    : undefined

  const networkRewards = useDistributionRewards({
    source: networkSource,
    account: address,
    now,
  })
  const contributionRewards = useDistributionRewards({
    source: contributionSource,
    account: address,
    now,
  })
  const sources = [networkRewards, contributionRewards].filter(
    (state): state is RewardState & { source: ClaimSource } => !!state.source
  )
  const rewards = sources.flatMap((source) => source.rewards)
  const pending = rewards.filter((reward) => reward.status === 'available')
  const available = pending.filter(
    (reward) =>
      !sources.find((source) => source.source.id === reward.source.id)?.paused
  )
  const rewardHistory = rewards.filter(
    (reward) => reward.status !== 'none'
  ).length
  const isLoading = sources.some((source) => source.loading)

  const rewardKey = (reward: Reward) =>
    `${reward.source.id}:${reward.distribution.id.toString()}`

  const transactionFor = async (reward: Reward) => {
    if (!address || !publicClient || !reward.entry) {
      throw new Error('The proof for this reward is not available yet')
    }

    const args = [
      reward.distribution.id,
      address,
      BigInt(reward.entry.value),
      reward.entry.proof as Hex[],
    ] as const
    const gas = await publicClient.estimateContractGas({
      abi: merkleFundDistributorAbi,
      address: reward.source.distributor,
      functionName: 'claim',
      args,
      account: address,
    })

    return {
      tx: {
        abi: merkleFundDistributorAbi,
        address: reward.source.distributor,
        functionName: 'claim' as const,
        args,
        gas: (gas * 120n) / 100n,
      },
      successMessage: `${reward.source.title} claimed!`,
    }
  }

  const claimReward = async (reward: Reward) => {
    setError(null)
    setClaiming(rewardKey(reward))
    try {
      await txToast(await transactionFor(reward))
    } catch (claimError) {
      setError(parseErrorMessage(claimError))
    } finally {
      setClaiming(null)
    }
  }

  const claimAll = async () => {
    if (available.length === 0) return
    setError(null)
    setClaimingAll(true)
    try {
      const transactions = await Promise.all(available.map(transactionFor))
      await txToast(...transactions)
    } catch (claimError) {
      setError(parseErrorMessage(claimError))
    } finally {
      setClaimingAll(false)
    }
  }

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="space-y-6">
        <BreadcrumbRenderer />
        <NetworkHeader network={network} tabs={tabs} className="w-full" />
      </header>

      <section
        aria-labelledby="claim-summary-heading"
        className="grid min-h-64 gap-8 border-y border-hairline py-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
      >
        <div className="space-y-4">
          <p id="claim-summary-heading" className="tg-label">
            Available now
          </p>
          {!isConnected ? (
            <div className="max-w-xl space-y-4">
              <p className="tg-display text-4xl">Connect to see rewards</p>
              <p className="text-sm text-text-muted">
                Rewards are calculated for the connected wallet. Connecting does
                not submit a transaction.
              </p>
              <WalletConnectionButton />
            </div>
          ) : isLoading ? (
            <p className="text-sm text-text-muted" aria-live="polite">
              Checking every reward source…
            </p>
          ) : pending.length === 0 ? (
            <div className="space-y-2">
              <p className="tg-display text-4xl">All caught up</p>
              <p className="text-sm text-text-muted">
                No unclaimed rewards are available for this wallet.
              </p>
            </div>
          ) : available.length === 0 ? (
            <div className="space-y-2">
              <p className="tg-display text-4xl">Ready when resumed</p>
              <p className="text-sm text-text-muted">
                Your rewards are recorded, but their distributors are paused
                right now.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="tg-display text-5xl tabular-nums">
                {available.length} reward{available.length === 1 ? '' : 's'}
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-text-muted">
                {sources.map((source) => {
                  const count = source.rewards.filter(
                    (reward) => reward.status === 'available' && !source.paused
                  ).length
                  return count > 0 ? (
                    <span key={source.source.id}>
                      {count} from {source.source.title.toLowerCase()}
                    </span>
                  ) : null
                })}
              </div>
            </div>
          )}
        </div>

        {isConnected && available.length > 0 && !isLoading && (
          <Button
            variant="brand"
            size="lg"
            className="w-full md:w-auto"
            onClick={claimAll}
            disabled={claimingAll || claiming !== null}
          >
            {claimingAll
              ? 'Claiming rewards…'
              : `Claim all ${available.length}`}
          </Button>
        )}
      </section>

      {error && (
        <Card type="outline" size="md" className="border-error text-error">
          <p className="text-sm">{error}</p>
        </Card>
      )}

      <div className="grid gap-10 lg:grid-cols-2 lg:gap-8">
        {sources.map((source) => (
          <ClaimSourceSection
            key={source.source.id}
            state={source}
            connected={isConnected}
            claiming={claiming}
            claimingAll={claimingAll}
            rewardKey={rewardKey}
            onClaim={claimReward}
          />
        ))}
      </div>

      {isConnected && !isLoading && rewardHistory === 0 && (
        <p className="border-t border-hairline pt-6 text-sm text-text-muted">
          Rewards appear here as soon as a distribution is funded against a
          proven score table.
        </p>
      )}

      {network.contracts.merkleFundDistributor && (
        <DistributePage
          embedded
          defaultOpen={defaultFundOpen}
          network={network}
        />
      )}
    </div>
  )
}

const ClaimSourceSection = ({
  state,
  connected,
  claiming,
  claimingAll,
  rewardKey,
  onClaim,
}: {
  state: RewardState & { source: ClaimSource }
  connected: boolean
  claiming: string | null
  claimingAll: boolean
  rewardKey: (reward: Reward) => string
  onClaim: (reward: Reward) => void
}) => {
  const visibleRewards = state.rewards.filter(
    (reward) => reward.status !== 'none'
  )
  const availableCount = visibleRewards.filter(
    (reward) => reward.status === 'available'
  ).length

  return (
    <section className="space-y-5" aria-labelledby={`${state.source.id}-title`}>
      <div className="flex min-w-0 flex-col items-start gap-3 border-b border-hairline pb-4 sm:flex-row sm:justify-between sm:gap-5">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SectionHeading>
              <span id={`${state.source.id}-title`}>{state.source.title}</span>
            </SectionHeading>
            {availableCount > 0 && connected && (
              <span className="border border-hairline-strong px-2 py-0.5 text-[10px] uppercase tracking-wider">
                {availableCount} {state.paused ? 'waiting' : 'ready'}
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed text-text-muted">
            {state.source.description}
          </p>
        </div>
        <Link
          href={state.source.href}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted underline underline-offset-4 hover:text-text"
        >
          {state.source.linkLabel}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>

      {state.paused && (
        <p className="text-sm text-warn">
          This reward source is paused. Your share remains recorded, but it
          cannot be claimed right now.
        </p>
      )}

      {!connected ? (
        <Card type="outline" size="lg" className="min-h-36">
          <WalletCards className="mb-4 h-5 w-5 text-text-muted" />
          <p className="text-sm text-text-muted">
            Connect a wallet to reveal rewards from this source.
          </p>
        </Card>
      ) : state.loading ? (
        <p className="text-sm text-text-muted">Checking this source…</p>
      ) : visibleRewards.length === 0 ? (
        <Card type="outline" size="lg" className="min-h-36">
          <p className="text-sm text-text-muted">
            No rewards from this source yet.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {visibleRewards.map((reward) => {
            const metadata = state.tokenLabel(reward.distribution.token)
            const isClaiming = claiming === rewardKey(reward)
            return (
              <Card
                key={reward.distribution.id.toString()}
                type={reward.status === 'available' ? 'accent' : 'outline'}
                size="md"
                className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="text-lg tabular-nums">
                      {formatAmount(
                        reward.amount,
                        metadata.decimals,
                        metadata.symbol
                      )}
                    </p>
                    <RewardStatus
                      status={reward.status}
                      paused={state.paused}
                    />
                  </div>
                  <p className="text-xs text-text-muted">
                    Distribution #{(reward.distribution.id + 1n).toString()}{' '}
                    <span aria-hidden="true">·</span>{' '}
                    {new Date(
                      Number(reward.distribution.timestamp) * 1_000
                    ).toLocaleDateString()}
                  </p>
                </div>

                {reward.status === 'available' && (
                  <Button
                    variant="brand"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => onClaim(reward)}
                    disabled={
                      state.paused ||
                      claimingAll ||
                      claiming !== null ||
                      !reward.entry
                    }
                  >
                    {isClaiming ? 'Claiming…' : 'Claim'}
                  </Button>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {state.proofError && connected && (
        <p className="text-xs text-warn">
          Some proof data could not be loaded. Those rewards may be missing
          until the indexer is available again.
        </p>
      )}
    </section>
  )
}

const RewardStatus = ({
  status,
  paused,
}: {
  status: Reward['status']
  paused: boolean
}) => {
  if (status === 'available') {
    return (
      <span className="tg-label-strong">{paused ? 'Paused' : 'Ready'}</span>
    )
  }
  if (status === 'claimed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        Claimed
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-muted">
      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
      {status === 'expired' ? 'Claim window closed' : 'Returned to funder'}
    </span>
  )
}
