'use client'

import { ArrowRight, Check, Clock3, WalletCards } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { NetworkHeader } from '@/components/NetworkHeader'
import { PendingClaimRecovery } from '@/components/PendingClaimRecovery'
import { SectionHeading } from '@/components/SectionHeading'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import { useClaimProgress } from '@/hooks/useClaimProgress'
import {
  type ClaimSource,
  type Reward,
  type RewardState,
  useDistributionRewards,
} from '@/hooks/useDistributionRewards'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import {
  distributionClosed,
  formatFinancialAmount,
} from '@/lib/financial-state'
import type { NetworkTab } from '@/lib/network-nav'
import { txToast } from '@/lib/tx'
import { ContributionsNetwork, Network } from '@/lib/types'
import { realAddress } from '@/lib/utils'

import { DistributePage } from '../distribute/component'

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
  const {
    targetChainId,
    targetChain,
    wrongChain,
    switchToTarget,
    switchingTarget,
    switchError,
  } = useApplicationChain()
  const publicClient = usePublicClient({ chainId: targetChainId })
  const claimProgress = useClaimProgress(address)
  const [now, setNow] = useState<number | null>(null)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claimingAll, setClaimingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<string | null>(null)

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1_000))
    tick()
    const timer = setInterval(tick, 15_000)
    return () => clearInterval(timer)
  }, [])

  const networkDistributor = realAddress(
    network.contracts.merkleFundDistributor
  )
  const networkSource = networkDistributor
    ? {
        id: 'network' as const,
        title: 'Network rewards',
        description: `Funds allocated using the ${network.name} trust scores captured when each reward pool was created.`,
        href: '#fund-rewards',
        linkLabel: 'Funding and history',
        distributor: networkDistributor,
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
  const progressSources = sources.map((source) => ({
    ...source,
    rewards: source.rewards.map((reward): Reward => {
      const progress = claimProgress.get(
        reward.source.distributor,
        reward.distribution.id
      )
      return progress && reward.status !== 'claimed'
        ? {
            ...reward,
            status: progress.status === 'confirmed' ? 'claimed' : 'pending',
            transactionHash: progress.hash,
          }
        : reward
    }),
  }))
  const rewards = progressSources.flatMap((source) => source.rewards)
  const pending = rewards.filter((reward) => reward.status === 'available')
  const available = pending.filter(
    (reward) =>
      !sources.find((source) => source.source.id === reward.source.id)?.paused
  )
  const rewardHistory = rewards.filter(
    (reward) => reward.status !== 'none'
  ).length
  const isLoading =
    sources.some((source) => source.loading) ||
    (isConnected && !claimProgress.ready)
  const hasUnverified = sources.some(
    (source) =>
      source.readState !== 'ready' || source.proofError || source.metadataError
  )
  const retryRewards = () => sources.forEach((source) => source.retry())

  const rewardKey = (reward: Reward) =>
    `${reward.source.id}:${reward.distribution.id.toString()}`

  const transactionFor = async (reward: Reward) => {
    if (wrongChain)
      throw new Error(`Switch to ${targetChain.name} before claiming.`)
    if (
      reward.status !== 'available' ||
      distributionClosed(reward.distribution, Math.floor(Date.now() / 1_000)) ||
      !claimProgress.ready ||
      claimProgress.get(reward.source.distributor, reward.distribution.id)
    )
      throw new Error(
        'This reward is not ready to claim. Refresh its status first.'
      )
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
        account: address,
        chainId: targetChainId,
        abi: merkleFundDistributorAbi,
        address: reward.source.distributor,
        functionName: 'claim' as const,
        args,
        gas: (gas * 120n) / 100n,
      },
      successMessage: `${reward.source.title} claimed!`,
      onTransactionSent: (hash: Hex) =>
        claimProgress.submitted(
          reward.source.distributor,
          reward.distribution.id,
          hash
        ),
    }
  }

  const claimReward = async (reward: Reward) => {
    setError(null)
    setClaiming(rewardKey(reward))
    try {
      const [receipt] = await txToast(await transactionFor(reward))
      claimProgress.confirmed(
        reward.source.distributor,
        reward.distribution.id,
        receipt.transactionHash
      )
      retryRewards()
    } catch (claimError) {
      claimProgress.failed(
        reward.source.distributor,
        reward.distribution.id,
        claimError
      )
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
      for (const [index, reward] of available.entries()) {
        setBatchProgress(
          `Claim ${index + 1} of ${available.length}: confirm this transaction in your wallet.`
        )
        let receipt
        try {
          ;[receipt] = await txToast(await transactionFor(reward))
        } catch (claimError) {
          claimProgress.failed(
            reward.source.distributor,
            reward.distribution.id,
            claimError
          )
          throw claimError
        }
        claimProgress.confirmed(
          reward.source.distributor,
          reward.distribution.id,
          receipt.transactionHash
        )
        setBatchProgress(
          `${index + 1} of ${available.length} claims confirmed.`
        )
      }
      retryRewards()
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
          ) : hasUnverified ? (
            <div className="space-y-3" role="status">
              <p className="tg-display text-3xl">Some rewards need checking</p>
              <p className="text-sm text-text-muted">
                We could not verify every reward source. Previously loaded
                amounts may be out of date; unverified rewards cannot be
                claimed.
              </p>
              <Button variant="outline" onClick={retryRewards}>
                Retry rewards
              </Button>
            </div>
          ) : rewards.some((reward) => reward.status === 'pending') &&
            pending.length === 0 ? (
            <div className="space-y-2">
              <p className="tg-display text-3xl">
                Claims awaiting confirmation
              </p>
              <p className="text-sm text-text-muted">
                Check their transaction status below if your wallet cancelled or
                replaced a claim.
              </p>
            </div>
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
            variant="default"
            size="lg"
            className="w-full md:w-auto"
            onClick={claimAll}
            disabled={wrongChain || claimingAll || claiming !== null}
          >
            {claimingAll
              ? 'Claiming rewards…'
              : `Claim all ${available.length}`}
          </Button>
        )}
      </section>

      {wrongChain && (
        <Card type="outline" size="md" className="space-y-3">
          <p>
            Rewards are shown for {targetChain.name}. Switch your wallet to
            claim them.
          </p>
          <Button
            onClick={() => void switchToTarget()}
            disabled={switchingTarget}
          >
            Switch to {targetChain.name}
          </Button>
          {switchError && (
            <p role="alert" className="text-error">
              {switchError}
            </p>
          )}
        </Card>
      )}
      {batchProgress && (
        <p role="status" className="text-sm">
          {batchProgress}
        </p>
      )}
      {error && (
        <Card type="outline" size="md" className="border-error text-error">
          <p className="text-sm">{error}</p>
        </Card>
      )}

      <div className="grid gap-10 lg:grid-cols-2 lg:gap-8">
        {progressSources.map((source) => (
          <ClaimSourceSection
            key={source.source.id}
            state={source}
            connected={isConnected}
            claiming={claiming}
            claimingAll={claimingAll}
            rewardKey={rewardKey}
            onClaim={claimReward}
            wrongChain={wrongChain}
            explorerUrl={targetChain.blockExplorers?.default.url}
            progress={claimProgress}
          />
        ))}
      </div>

      {isConnected && !isLoading && !hasUnverified && rewardHistory === 0 && (
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
  wrongChain,
  explorerUrl,
  progress,
}: {
  state: RewardState & { source: ClaimSource }
  connected: boolean
  claiming: string | null
  claimingAll: boolean
  rewardKey: (reward: Reward) => string
  onClaim: (reward: Reward) => void
  wrongChain: boolean
  explorerUrl?: string
  progress: ReturnType<typeof useClaimProgress>
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

      {connected &&
        (state.readState === 'error' || state.readState === 'stale') && (
          <div role="status" className="space-y-3 text-sm">
            <p>
              {state.readState === 'stale'
                ? 'This source could not be refreshed. Previously loaded data is shown below.'
                : 'This reward source could not be checked.'}
            </p>
            <Button size="sm" variant="outline" onClick={state.retry}>
              Retry source
            </Button>
          </div>
        )}
      {!connected ? (
        <Card type="outline" size="lg" className="min-h-36">
          <WalletCards className="mb-4 h-5 w-5 text-text-muted" />
          <p className="text-sm text-text-muted">
            Connect a wallet to reveal rewards from this source.
          </p>
        </Card>
      ) : state.loading ? (
        <p role="status" className="text-sm text-text-muted">
          Checking rewards and payout proofs…
        </p>
      ) : state.readState !== 'ready' &&
        visibleRewards.length === 0 ? null : visibleRewards.length === 0 ? (
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
                      {formatFinancialAmount(
                        reward.amount,
                        reward.status === 'unknown' ? undefined : metadata
                      )}
                    </p>
                    <RewardStatus
                      status={reward.status}
                      paused={state.paused}
                    />
                  </div>
                  {reward.transactionHash && explorerUrl && (
                    <a
                      href={`${explorerUrl}/tx/${reward.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline"
                    >
                      View claim transaction
                    </a>
                  )}
                  <p className="text-xs text-text-muted">
                    Distribution #{(reward.distribution.id + 1n).toString()}{' '}
                    <span aria-hidden="true">·</span>{' '}
                    {new Date(
                      Number(reward.distribution.timestamp) * 1_000
                    ).toLocaleDateString()}
                  </p>
                </div>

                {reward.status === 'pending' && reward.transactionHash && (
                  <PendingClaimRecovery
                    key={reward.transactionHash}
                    progress={progress}
                    distributor={reward.source.distributor}
                    id={reward.distribution.id}
                    hash={reward.transactionHash}
                    onRefresh={state.retry}
                    disabled={claimingAll || claiming !== null}
                  />
                )}
                {reward.status === 'available' && (
                  <Button
                    variant="default"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => onClaim(reward)}
                    disabled={
                      wrongChain ||
                      state.readState !== 'ready' ||
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

      {state.metadataError && (
        <p role="status" className="text-xs text-warn">
          Some token details could not be verified.{' '}
          <button className="underline" onClick={state.retry}>
            Retry token details
          </button>
        </p>
      )}
      {state.proofError && connected && (
        <p role="status" className="text-xs text-warn">
          Some payout proofs could not be verified. Recheck them before claiming
          these rewards.{' '}
          <button className="underline" onClick={state.retry}>
            Retry proof data
          </button>
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
  if (status === 'unknown')
    return <span className="text-xs text-warn">Not verified</span>
  if (status === 'pending')
    return (
      <span className="text-xs text-text-muted">
        Claim sent · waiting for confirmation
      </span>
    )
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
