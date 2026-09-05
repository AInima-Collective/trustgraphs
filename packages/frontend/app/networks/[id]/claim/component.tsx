'use client'

import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Hex, erc20Abi, zeroAddress, zeroHash } from 'viem'
import { useAccount, usePublicClient, useReadContracts } from 'wagmi'

import { Address } from '@/components/Address'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { NetworkHeader } from '@/components/NetworkHeader'
import { PendingClaimRecovery } from '@/components/PendingClaimRecovery'
import { SectionHeading } from '@/components/SectionHeading'
import { type Column, Table } from '@/components/Table'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import { useClaimProgress } from '@/hooks/useClaimProgress'
import {
  type Reward,
  useDistributionRewards,
} from '@/hooks/useDistributionRewards'
import { useTokenMetadata } from '@/hooks/useTokenMetadata'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import {
  contractReadState,
  distributionClosed,
  formatFinancialAmount,
  parseFinancialAmount,
} from '@/lib/financial-state'
import {
  distributeArgs as buildDistributeArgs,
  fundingTermsAbi,
  latestMerkleStateAbi,
  quotedFee,
} from '@/lib/funding-terms'
import { contributionsTabs } from '@/lib/network-nav'
import { txToast } from '@/lib/tx'
import { type ContributionsNetwork } from '@/lib/types'

/** Standalone contribution payouts share the same verified reward reads as the network page. */
export const PayoutPage = ({ network }: { network: ContributionsNetwork }) => {
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
  const progress = useClaimProgress(address)
  const [now, setNow] = useState<number | null>(null)
  const [funding, setFunding] = useState(false)
  const [claiming, setClaiming] = useState<bigint | null>(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const distributor = network.contracts.merkleFundDistributor
  const snapshot = network.contracts.merkleSnapshot
  const poolToken = network.contracts.poolToken
  const native = poolToken?.toLowerCase() === zeroAddress

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1_000))
    tick()
    const timer = setInterval(tick, 15_000)
    return () => clearInterval(timer)
  }, [])

  const state = useDistributionRewards({
    source: {
      id: 'contributions',
      title: 'Round payout',
      description: '',
      href: `/networks/${network.id}`,
      linkLabel: 'View round',
      distributor,
      snapshot,
    },
    account: address,
    now,
  })
  const rewards = state.rewards.map((reward): Reward => {
    const recorded = progress.get(distributor, reward.distribution.id)
    return recorded && reward.status !== 'claimed'
      ? {
          ...reward,
          status: recorded.status === 'confirmed' ? 'claimed' : 'pending',
          transactionHash: recorded.hash,
        }
      : reward
  })
  const metadata = useTokenMetadata(poolToken ? [poolToken] : [])
  const poolMetadata = metadata.get(poolToken ?? '')
  const tokenName = poolMetadata?.symbol ?? 'the payout token'
  const tokenQuery = useReadContracts({
    contracts:
      address && poolToken && !native
        ? [
            {
              address: poolToken,
              chainId: targetChainId,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [address, distributor],
            },
            {
              address: poolToken,
              chainId: targetChainId,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
            },
          ]
        : [],
    query: { enabled: !!address && !!poolToken && !native },
  })
  const allowance = tokenQuery.data?.[0]?.result as bigint | undefined
  const balance = tokenQuery.data?.[1]?.result as bigint | undefined
  const termsQuery = useReadContracts({
    contracts: [
      {
        address: distributor,
        chainId: targetChainId,
        abi: fundingTermsAbi,
        functionName: 'feePercentage',
      },
      {
        address: distributor,
        chainId: targetChainId,
        abi: fundingTermsAbi,
        functionName: 'FEE_RANGE',
      },
      {
        address: distributor,
        chainId: targetChainId,
        abi: fundingTermsAbi,
        functionName: 'feeRecipient',
      },
      {
        address: snapshot,
        chainId: targetChainId,
        abi: latestMerkleStateAbi,
        functionName: 'getLatestState',
      },
    ],
  })
  const feePercentage = termsQuery.data?.[0]?.result as bigint | undefined
  const feeRange = termsQuery.data?.[1]?.result as bigint | undefined
  const feeRecipient = termsQuery.data?.[2]?.result as Hex | undefined
  const latestState = termsQuery.data?.[3]?.result as
    | { root: Hex; totalValue: bigint }
    | undefined
  const expectedRoot =
    latestState?.root && latestState.root !== zeroHash
      ? latestState.root
      : undefined
  const termsStatus = contractReadState(termsQuery, 4)
  const parsed = parseFinancialAmount(amount, poolMetadata?.decimals)
  const parsedAmount = parsed.amount ?? 0n
  const needsApproval =
    !native && allowance !== undefined && allowance < parsedAmount
  const allowed =
    !state.distributorState?.allowlistEnabled ||
    state.distributorState.allowlist?.some(
      (item) => item.toLowerCase() === address?.toLowerCase()
    )
  const fundingProblem = !isConnected
    ? 'Connect a wallet to fund this round.'
    : wrongChain
      ? `Switch to ${targetChain.name} to fund this round.`
      : metadata.state(poolToken ?? '') === 'loading'
        ? 'Loading payout token details…'
        : metadata.state(poolToken ?? '') !== 'ready'
          ? 'Payout token details could not be verified. Retry before funding.'
          : termsStatus === 'loading'
            ? 'Loading the current fee and proven scores…'
            : termsStatus !== 'ready' || !feeRange || !feeRecipient
              ? 'The fee and proven scores could not be verified. Retry before funding.'
              : !expectedRoot
                ? 'Funding opens after the round’s first proven scores are published.'
                : state.distributorReadState === 'loading'
                  ? 'Checking funding access…'
                  : state.distributorReadState !== 'ready' ||
                      !state.distributorState
                    ? 'Funding access could not be verified. Retry before funding.'
                    : state.paused
                      ? 'Funding and payouts are paused.'
                      : !allowed
                        ? 'This wallet is not allowed to fund the round.'
                        : !native &&
                            contractReadState(tokenQuery, 2) === 'loading'
                          ? 'Checking token balance and approval…'
                          : !native &&
                              contractReadState(tokenQuery, 2) !== 'ready'
                            ? 'Token balance and approval could not be verified. Retry before funding.'
                            : !native &&
                                balance !== undefined &&
                                parsedAmount > balance
                              ? 'The amount exceeds your token balance.'
                              : null
  const fee =
    feePercentage !== undefined && feeRange
      ? quotedFee(parsedAmount, feePercentage, feeRange)
      : undefined
  const retryFunding = () => {
    state.retry()
    void Promise.allSettled([
      termsQuery.refetch(),
      ...(!native ? [metadata.refetch(), tokenQuery.refetch()] : []),
    ])
  }
  const current =
    rewards.find((reward) => reward.distribution.root === expectedRoot) ??
    rewards[0]
  const loading = state.loading || (isConnected && !progress.ready)
  const unavailable = state.readState === 'error' || state.readState === 'stale'

  const fund = async () => {
    if (
      fundingProblem ||
      !parsed.amount ||
      !address ||
      !publicClient ||
      !poolToken ||
      !expectedRoot ||
      !latestState ||
      feePercentage === undefined ||
      !feeRange ||
      !feeRecipient
    ) {
      setError(
        fundingProblem ?? parsed.error ?? 'Enter an amount before funding.'
      )
      return
    }
    setFunding(true)
    setError(null)
    try {
      if (needsApproval) {
        const args = [distributor, parsed.amount] as const
        const gas = await publicClient.estimateContractGas({
          address: poolToken,
          abi: erc20Abi,
          functionName: 'approve',
          args,
          account: address,
        })
        await txToast({
          tx: {
            account: address,
            chainId: targetChainId,
            address: poolToken,
            abi: erc20Abi,
            functionName: 'approve',
            args,
            gas: (gas * 120n) / 100n,
          },
          successMessage: `${tokenName} approved for this payout.`,
        })
        await tokenQuery.refetch()
      } else {
        const args = buildDistributeArgs({
          token: poolToken,
          amount: parsed.amount,
          expectedRoot,
          expectedTotalMerkleValue: latestState.totalValue,
          claimDeadline: 0n,
          feePercentage,
          feeRange,
          feeRecipient,
        })
        const value = native ? parsed.amount : undefined
        const gas = await publicClient.estimateContractGas({
          address: distributor,
          abi: merkleFundDistributorAbi,
          functionName: 'distribute',
          args,
          account: address,
          value,
        })
        await txToast({
          tx: {
            account: address,
            chainId: targetChainId,
            address: distributor,
            abi: merkleFundDistributorAbi,
            functionName: 'distribute',
            args,
            gas: (gas * 120n) / 100n,
            value,
          },
          successMessage: 'Round payout funded.',
        })
        setAmount('')
        state.retry()
      }
    } catch (failure) {
      setError(parseErrorMessage(failure))
    } finally {
      setFunding(false)
    }
  }

  const claim = async (reward: Reward) => {
    if (
      !address ||
      !publicClient ||
      !reward.entry ||
      wrongChain ||
      state.paused ||
      state.readState !== 'ready' ||
      !progress.ready ||
      reward.status !== 'available' ||
      distributionClosed(reward.distribution, Math.floor(Date.now() / 1_000))
    ) {
      setError(
        wrongChain
          ? `Switch to ${targetChain.name} before claiming.`
          : 'This payout could not be verified. Refresh before claiming.'
      )
      return
    }
    setError(null)
    setClaiming(reward.distribution.id)
    try {
      const args = [
        reward.distribution.id,
        address,
        BigInt(reward.entry.value),
        reward.entry.proof as Hex[],
      ] as const
      const gas = await publicClient.estimateContractGas({
        address: distributor,
        abi: merkleFundDistributorAbi,
        functionName: 'claim',
        args,
        account: address,
      })
      const [receipt] = await txToast({
        tx: {
          account: address,
          chainId: targetChainId,
          address: distributor,
          abi: merkleFundDistributorAbi,
          functionName: 'claim',
          args,
          gas: (gas * 120n) / 100n,
        },
        successMessage: 'Payout claimed.',
        onTransactionSent: (hash) =>
          progress.submitted(distributor, reward.distribution.id, hash),
      })
      progress.confirmed(
        distributor,
        reward.distribution.id,
        receipt.transactionHash
      )
      state.retry()
    } catch (failure) {
      progress.failed(distributor, reward.distribution.id, failure)
      setError(parseErrorMessage(failure))
    } finally {
      setClaiming(null)
    }
  }

  const claimButton = (reward: Reward) =>
    reward.status === 'pending' && reward.transactionHash ? (
      <PendingClaimRecovery
        key={reward.transactionHash}
        progress={progress}
        distributor={distributor}
        id={reward.distribution.id}
        hash={reward.transactionHash}
        onRefresh={state.retry}
        disabled={claiming !== null}
      />
    ) : reward.status === 'available' ? (
      <Button
        onClick={() => void claim(reward)}
        disabled={
          claiming !== null ||
          state.paused ||
          wrongChain ||
          !progress.ready ||
          state.readState !== 'ready'
        }
      >
        {claiming === reward.distribution.id ? 'Claiming…' : 'Claim payout'}
      </Button>
    ) : null
  const statusText = (reward: Reward) =>
    ({
      available: state.paused ? 'Paused' : 'Ready to claim',
      claimed: 'Claimed',
      pending: 'Claim sent · waiting for confirmation',
      expired: 'Claim window closed',
      swept: 'Returned to funder',
      unknown: 'Not verified',
      none: 'No share',
    })[reward.status]
  const transactionLink = (reward: Reward) =>
    reward.transactionHash && targetChain.blockExplorers?.default.url ? (
      <a
        href={`${targetChain.blockExplorers.default.url}/tx/${reward.transactionHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs underline"
      >
        View claim transaction
      </a>
    ) : null
  const columns: Column<Reward>[] = [
    {
      key: 'funder',
      header: 'FUNDED BY',
      render: (reward) => (
        <Address
          address={reward.distribution.distributor}
          displayMode="truncated"
        />
      ),
    },
    {
      key: 'token',
      header: 'TOKEN',
      render: (reward) =>
        reward.distribution.token === zeroAddress ? (
          'ETH'
        ) : (
          <Address
            address={reward.distribution.token}
            displayMode="truncated"
          />
        ),
    },
    {
      key: 'amount',
      header: 'POOL',
      render: (reward) =>
        formatFinancialAmount(
          reward.distribution.amountFunded,
          state.tokenLabel(reward.distribution.token)
        ),
    },
    {
      key: 'paid',
      header: 'PAID OUT',
      render: (reward) =>
        formatFinancialAmount(
          reward.distribution.amountDistributed,
          state.tokenLabel(reward.distribution.token)
        ),
    },
    {
      key: 'timestamp',
      header: 'DATE',
      sortable: true,
      accessor: (reward) => Number(reward.distribution.timestamp),
      render: (reward) =>
        new Date(
          Number(reward.distribution.timestamp) * 1_000
        ).toLocaleDateString(),
    },
    {
      key: 'share',
      header: 'YOUR SHARE',
      render: (reward) =>
        !isConnected ? (
          'Connect to check'
        ) : (
          <div className="space-y-1">
            <p>{statusText(reward)}</p>
            {reward.amount > 0n && (
              <p>
                {formatFinancialAmount(
                  reward.amount,
                  state.tokenLabel(reward.distribution.token)
                )}
              </p>
            )}
            {transactionLink(reward)}
          </div>
        ),
    },
    {
      key: 'action',
      header: '',
      render: (reward) =>
        reward.distribution.id === current?.distribution.id
          ? null
          : claimButton(reward),
    },
  ]

  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <NetworkHeader network={network} tabs={contributionsTabs(network)} />
        <h2 className="text-2xl">Claim your share</h2>
        <p className="text-sm text-muted-foreground">
          Your share is fixed by the proven scores used when each payout was
          funded.
        </p>
      </header>
      {wrongChain && (
        <Card type="outline" size="md" className="space-y-3">
          <p>
            Payouts are shown for {targetChain.name}. Switch your wallet to fund
            or claim.
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
      {state.paused && (
        <p role="status" className="text-sm text-warn">
          Funding and payouts are paused. Your recorded share is unchanged.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <section
        aria-labelledby="your-share-heading"
        className="grid gap-6 border-y border-hairline py-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <div className="min-w-0 space-y-3">
          <h3 id="your-share-heading" className="tg-label">
            Your share
          </h3>
          {!isConnected ? (
            <>
              <p>Connect your wallet to see your share.</p>
              <WalletConnectionButton />
            </>
          ) : unavailable ? (
            <>
              <p className="text-xl">We couldn’t verify your payouts</p>
              <p className="text-sm text-muted-foreground">
                {state.readState === 'stale'
                  ? 'Previously loaded data is shown below. Refresh it before claiming.'
                  : 'Try the data service again to check your rewards.'}
              </p>
              <Button variant="outline" onClick={state.retry}>
                Retry payouts
              </Button>
            </>
          ) : loading ? (
            <p role="status">Checking your share…</p>
          ) : !current ? (
            <>
              <p className="text-xl">No payout funded yet</p>
              <p className="text-sm text-muted-foreground">
                Your share appears after a payout is funded for this round.
              </p>
            </>
          ) : current.status === 'unknown' ? (
            <>
              <p className="text-xl">Your share could not be verified</p>
              <p className="text-sm text-muted-foreground">
                Payout proofs or token details are unavailable. Recheck them
                before claiming.
              </p>
              <Button variant="outline" onClick={state.retry}>
                Retry payout details
              </Button>
            </>
          ) : (
            <>
              <p className="tg-display break-words text-3xl sm:text-5xl">
                {formatFinancialAmount(
                  current.amount,
                  state.tokenLabel(current.distribution.token)
                )}
              </p>
              <p className="flex items-center gap-2 text-sm">
                {current.status === 'claimed' && (
                  <Check className="h-4 w-4 text-success" aria-hidden />
                )}
                {statusText(current)}
              </p>
              {transactionLink(current)}
            </>
          )}
        </div>
        {isConnected &&
          !loading &&
          !unavailable &&
          current &&
          claimButton(current)}
      </section>
      <section className="space-y-4" aria-labelledby="payout-history-heading">
        <SectionHeading>
          <span id="payout-history-heading">Payout history</span>
        </SectionHeading>
        {state.historyState === 'loading' ? (
          <p role="status">Loading payout history…</p>
        ) : state.historyState !== 'ready' ? (
          <div role="status" className="space-y-2">
            <p>
              {state.historyState === 'stale'
                ? 'Payout history could not be refreshed. Previously loaded pools are shown below.'
                : 'Payout history could not be loaded.'}
            </p>
            <Button variant="outline" onClick={state.retry}>
              Retry history
            </Button>
          </div>
        ) : rewards.length === 0 ? (
          <p>No payouts have been funded for this round yet.</p>
        ) : null}
        {(state.metadataError || state.proofError) && (
          <div role="status" className="space-y-2 text-sm text-warn">
            <p>
              Some token or proof details could not be verified. Unverified
              payouts cannot be claimed.
            </p>
            <Button variant="outline" onClick={state.retry}>
              Retry payout details
            </Button>
          </div>
        )}
        {rewards.length > 0 && (
          <Table
            columns={columns}
            data={rewards}
            defaultSortColumn="timestamp"
            defaultSortDirection="desc"
            rowClassName="text-sm"
            getRowKey={(reward) => reward.distribution.id.toString()}
          />
        )}
      </section>
      <details className="group border-y border-hairline">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-4 text-sm">
          <span>Fund this round</span>
          <ChevronDown className="h-4 w-4" aria-hidden />
        </summary>
        <div className="max-w-xl space-y-4 border-t border-hairline py-6">
          <p className="text-sm text-muted-foreground">
            Deposit {tokenName} using the latest proven scores. Later score
            changes will not change this payout.
          </p>
          {!isConnected ? (
            <WalletConnectionButton />
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="round-funding-amount">
                  Amount ({tokenName})
                </Label>
                <Input
                  id="round-funding-amount"
                  inputMode="decimal"
                  value={amount}
                  placeholder="0.0"
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={funding}
                  aria-invalid={!!parsed.error}
                  aria-describedby="round-funding-error round-funding-status"
                />
                {parsed.error && (
                  <p
                    id="round-funding-error"
                    role="alert"
                    className="text-xs text-error"
                  >
                    {parsed.error}
                  </p>
                )}
                {balance !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    Wallet balance:{' '}
                    {formatFinancialAmount(balance, poolMetadata)}
                  </p>
                )}
                {termsStatus === 'ready' &&
                fee !== undefined &&
                parsed.amount &&
                poolMetadata ? (
                  <p className="text-xs text-muted-foreground">
                    Fee: {formatFinancialAmount(fee, poolMetadata)} · Members
                    receive{' '}
                    {formatFinancialAmount(parsed.amount - fee, poolMetadata)}
                  </p>
                ) : null}
              </div>
              <div
                id="round-funding-status"
                role="status"
                className="space-y-2 text-sm text-muted-foreground"
              >
                {fundingProblem && (
                  <>
                    <p>{fundingProblem}</p>
                    {!wrongChain && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={retryFunding}
                        disabled={funding}
                      >
                        Retry checks
                      </Button>
                    )}
                  </>
                )}
              </div>
              <Button
                onClick={() => void fund()}
                disabled={funding || !!fundingProblem || !parsed.amount}
              >
                {funding
                  ? needsApproval
                    ? 'Approving…'
                    : 'Funding…'
                  : needsApproval
                    ? `Approve ${tokenName} spending`
                    : 'Fund payout'}
              </Button>
              {expectedRoot && (
                <p className="text-xs text-muted-foreground">
                  Using proven score table:{' '}
                  <CopyableText
                    text={expectedRoot}
                    truncate
                    truncateEnds={[8, 6]}
                    alwaysShowCopyIcon
                  />
                </p>
              )}
            </>
          )}
        </div>
      </details>
    </div>
  )
}
