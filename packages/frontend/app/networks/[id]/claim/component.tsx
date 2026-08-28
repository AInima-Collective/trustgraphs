'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Hex, erc20Abi, formatUnits, parseUnits } from 'viem'
import { useAccount, usePublicClient, useReadContracts } from 'wagmi'

import { Address } from '@/components/Address'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { NetworkHeader } from '@/components/NetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { contributionsQueries } from '@/lib/contributions-api'
import { parseErrorMessage } from '@/lib/error'
import {
  distributeArgs as buildDistributeArgs,
  fundingTermsAbi,
  latestMerkleStateAbi,
} from '@/lib/funding-terms'
import { contributionsTabs } from '@/lib/network-nav'
import { txToast } from '@/lib/tx'
import { ContributionsNetwork } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { merkleFundDistribution } from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { useContributionsData } from '../contributions-shared'

type DistributionRow = typeof merkleFundDistribution.$inferSelect

/**
 * Claim surface for a contributions round. The current contributor payout is promoted above
 * distribution history, while permissionless funding keeps the existing approve/deposit path
 * behind a disclosure at the bottom of the page.
 */
export const PayoutPage = ({ network }: { network: ContributionsNetwork }) => {
  const { address: connectedAddress, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { round, tokenSymbol, tokenDecimals } = useContributionsData(network)

  const [isDistributing, setIsDistributing] = useState(false)
  const [isClaiming, setIsClaiming] = useState(false)
  const [claimingDistributionId, setClaimingDistributionId] = useState<
    bigint | null
  >(null)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const distributorAddress = network.contracts.merkleFundDistributor
  const snapshotAddress = network.contracts.merkleSnapshot
  const poolToken = network.contracts.poolToken

  // Existing distributions for this round's distributor (generic indexer tables).
  const { data: distributions = [], isLoading: isLoadingDistributions } =
    usePonderQuery({
      queryFn: ponderQueryFns.getFundDistributions(distributorAddress),
      enabled: !!distributorAddress,
    })

  // The user's past claims.
  const { data: userClaims = [], isLoading: isLoadingUserClaims } =
    usePonderQuery({
      queryFn: ponderQueryFns.getFundDistributionClaims({
        distributor: distributorAddress,
        account: connectedAddress,
      }),
      enabled: !!distributorAddress && !!connectedAddress,
    })
  const claimedByDistribution = useMemo(() => {
    const map = new Map<bigint, bigint>()
    for (const claim of userClaims)
      map.set(claim.distributionIndex, claim.amount)
    return map
  }, [userClaims])

  // Distributor state (fee, pause, allowlist).
  const { data: distributorState } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributor(distributorAddress),
    enabled: !!distributorAddress,
  })
  // Fee terms and the payout denominator come from the chain, not the indexer: `distribute` is
  // bound to these exact values, and a rounded copy would revert a legitimate round.
  const { data: fundingTerms } = useReadContracts({
    contracts:
      distributorAddress && snapshotAddress
        ? [
            {
              address: distributorAddress,
              abi: fundingTermsAbi,
              functionName: 'feePercentage',
            },
            {
              address: distributorAddress,
              abi: fundingTermsAbi,
              functionName: 'FEE_RANGE',
            },
            {
              address: distributorAddress,
              abi: fundingTermsAbi,
              functionName: 'feeRecipient',
            },
            {
              address: snapshotAddress as Hex,
              abi: latestMerkleStateAbi,
              functionName: 'getLatestState',
            },
          ]
        : [],
  })
  const feePercentageRaw = fundingTerms?.[0]?.result as bigint | undefined
  const feeRange = fundingTerms?.[1]?.result as bigint | undefined
  const feeRecipient = fundingTerms?.[2]?.result as Hex | undefined
  const expectedTotalMerkleValue = (
    fundingTerms?.[3]?.result as { totalValue?: bigint } | undefined
  )?.totalValue
  const feePercentage =
    feePercentageRaw !== undefined && feeRange
      ? (Number(feePercentageRaw) / Number(feeRange)) * 100
      : undefined
  const isPaused = distributorState?.paused

  // The proven root new distributions are pinned to: the round API's root, falling back to the
  // latest root indexed on this instance's snapshot contract.
  const { data: latestSnapshot } = usePonderQuery({
    queryFn: ponderQueryFns.getLatestMerkleSnapshot(snapshotAddress),
    enabled: !!snapshotAddress,
  })
  const expectedRoot = (round?.root ??
    latestSnapshot?.root ??
    null) as Hex | null

  // The connected account's payout proof bundle for the current root
  // (M3 route: /contributions/:snapshot/payout/:account; mock-gated in the client module).
  const payoutBundleQuery = useQuery(
    contributionsQueries.payout(snapshotAddress, connectedAddress)
  )
  const payoutBundle = payoutBundleQuery.data

  // Per-distribution fallback: the generic merkle-entry route serves proofs for any indexed
  // root, covering distributions pinned to older roots.
  const uniqueRoots = useMemo(
    () => Array.from(new Set(distributions.map((d) => d.root))),
    [distributions]
  )
  const rootEntryQueries = useQueries({
    queries: uniqueRoots.map((root) => ({
      ...ponderQueries.merkleTreeEntry({
        snapshot: snapshotAddress,
        root,
        account: connectedAddress,
      }),
      enabled: !!connectedAddress && !!root,
    })),
  })
  const entryForRoot = useCallback(
    (root: string): { value: string; proof: string[] } | null => {
      const index = uniqueRoots.indexOf(root as Hex)
      const generic = index >= 0 ? rootEntryQueries[index]?.data : null
      if (generic) return generic
      // Fall back to the contributions payout bundle when the distribution is pinned to the
      // round's current root.
      if (
        payoutBundle &&
        expectedRoot &&
        root.toLowerCase() === expectedRoot.toLowerCase()
      ) {
        return { value: payoutBundle.value, proof: payoutBundle.proof }
      }
      return null
    },
    [uniqueRoots, rootEntryQueries, payoutBundle, expectedRoot]
  )

  // Pool token allowance/balance for the funding path.
  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContracts({
    contracts: connectedAddress
      ? [
          {
            address: poolToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [connectedAddress, distributorAddress],
          },
          {
            address: poolToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [connectedAddress],
          },
        ]
      : [],
    query: { enabled: !!connectedAddress && !!poolToken },
  })
  const allowance = (tokenInfo?.[0]?.result as bigint | undefined) ?? 0n
  const balance = tokenInfo?.[1]?.result as bigint | undefined

  const parsedAmount = useMemo(() => {
    try {
      return amount ? parseUnits(amount, tokenDecimals) : 0n
    } catch {
      return 0n
    }
  }, [amount, tokenDecimals])
  const needsApproval = parsedAmount > 0n && allowance < parsedAmount

  const formatToken = (value: bigint) => {
    const [whole, fraction] = formatUnits(value, tokenDecimals).split('.')
    const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return `${groupedWhole}${fraction ? `.${fraction}` : ''} ${tokenSymbol}`
  }

  const handleApprove = async () => {
    if (!connectedAddress || !publicClient || !poolToken) return
    setError(null)
    setIsDistributing(true)
    try {
      const gasEstimate = await publicClient.estimateContractGas({
        address: poolToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [distributorAddress, parsedAmount],
        account: connectedAddress,
      })
      await txToast({
        tx: {
          address: poolToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [distributorAddress, parsedAmount],
          gas: (gasEstimate * 120n) / 100n,
        },
        successMessage: 'Token approval successful!',
      })
      refetchTokenInfo()
    } catch (err) {
      console.error('Approval error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsDistributing(false)
    }
  }

  const handleDistribute = async () => {
    if (
      !connectedAddress ||
      !publicClient ||
      !expectedRoot ||
      !poolToken ||
      feePercentageRaw === undefined ||
      !feeRange ||
      !feeRecipient ||
      expectedTotalMerkleValue === undefined
    )
      return
    setError(null)
    setIsDistributing(true)
    try {
      // The full guard set: root, denominator, the fee this screen quoted, and its recipient.
      const distributeArgs = buildDistributeArgs({
        token: poolToken,
        amount: parsedAmount,
        expectedRoot,
        expectedTotalMerkleValue,
        claimDeadline: 0n,
        feePercentage: feePercentageRaw,
        feeRange,
        feeRecipient,
      })
      const gasEstimate = await publicClient.estimateContractGas({
        abi: merkleFundDistributorAbi,
        address: distributorAddress,
        functionName: 'distribute',
        args: distributeArgs,
        account: connectedAddress,
      })
      await txToast({
        tx: {
          abi: merkleFundDistributorAbi,
          address: distributorAddress,
          functionName: 'distribute',
          args: distributeArgs,
          gas: (gasEstimate * 120n) / 100n,
        },
        successMessage: 'Round payout funded!',
      })
      setAmount('')
    } catch (err) {
      console.error('Distribution error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsDistributing(false)
    }
  }

  const handleClaim = async (distribution: DistributionRow) => {
    if (!connectedAddress || !publicClient) return
    setError(null)
    setIsClaiming(true)
    setClaimingDistributionId(distribution.id)
    try {
      const entry = entryForRoot(distribution.root)
      if (!entry) {
        throw new Error(
          'No payout entry found for your account in this distribution'
        )
      }
      const args = [
        distribution.id,
        connectedAddress,
        BigInt(entry.value),
        entry.proof as Hex[],
      ] as const
      const gasEstimate = await publicClient.estimateContractGas({
        abi: merkleFundDistributorAbi,
        address: distributorAddress,
        functionName: 'claim',
        args,
        account: connectedAddress,
      })
      await txToast({
        tx: {
          abi: merkleFundDistributorAbi,
          address: distributorAddress,
          functionName: 'claim',
          args,
          gas: (gasEstimate * 120n) / 100n,
        },
        successMessage: 'Payout claimed!',
      })
    } catch (err) {
      console.error('Claim error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsClaiming(false)
      setClaimingDistributionId(null)
    }
  }

  const getShareAmount = useCallback(
    (distribution: DistributionRow) => {
      const entry = entryForRoot(distribution.root)
      if (!entry) return 0n
      const totalDistributable =
        distribution.amountFunded - distribution.feeAmount
      if (distribution.totalMerkleValue === 0n) return 0n
      return (
        (totalDistributable * BigInt(entry.value)) /
        distribution.totalMerkleValue
      )
    },
    [entryForRoot]
  )

  const getClaimableAmount = useCallback(
    (distribution: DistributionRow) => {
      if ((claimedByDistribution.get(distribution.id) ?? 0n) > 0n) return 0n
      return getShareAmount(distribution)
    },
    [claimedByDistribution, getShareAmount]
  )

  // The hero represents the newest distribution against the current proven score table. If the
  // round service is unavailable, the newest on-chain distribution remains a useful fallback.
  const currentDistribution = useMemo(() => {
    const currentRoot = expectedRoot?.toLowerCase()
    return (
      (currentRoot
        ? distributions.find(
            (distribution) => distribution.root.toLowerCase() === currentRoot
          )
        : undefined) ??
      distributions[0] ??
      null
    )
  }, [distributions, expectedRoot])

  const currentEntry = currentDistribution
    ? entryForRoot(currentDistribution.root)
    : null
  const currentClaimedAmount = currentDistribution
    ? (claimedByDistribution.get(currentDistribution.id) ?? 0n)
    : 0n
  const currentShareAmount = currentDistribution
    ? currentClaimedAmount > 0n
      ? currentClaimedAmount
      : getShareAmount(currentDistribution)
    : 0n
  const currentRootQuery = currentDistribution
    ? rootEntryQueries[uniqueRoots.indexOf(currentDistribution.root as Hex)]
    : undefined
  const currentUsesBundle =
    !!currentDistribution &&
    !!expectedRoot &&
    currentDistribution.root.toLowerCase() === expectedRoot.toLowerCase()
  const isLoadingCurrentEntry =
    !!connectedAddress &&
    !!currentDistribution &&
    currentClaimedAmount === 0n &&
    !currentEntry &&
    (!!currentRootQuery?.isLoading ||
      (currentUsesBundle && payoutBundleQuery.isLoading))
  const currentEntryFailed =
    currentClaimedAmount === 0n &&
    !currentEntry &&
    (!!currentRootQuery?.isError ||
      (currentUsesBundle && payoutBundleQuery.isError))

  const distributionColumns: Column<DistributionRow>[] = [
    {
      key: 'funder',
      header: 'FUNDED BY',
      sortable: false,
      render: (row) => (
        <Address address={row.distributor} displayMode="truncated" />
      ),
    },
    {
      key: 'amount',
      header: 'POOL',
      sortable: true,
      accessor: (row) => Number(row.amountFunded),
      render: (row) => formatToken(row.amountFunded),
    },
    {
      key: 'distributed',
      header: 'PAID OUT',
      sortable: true,
      accessor: (row) => Number(row.amountDistributed),
      render: (row) => formatToken(row.amountDistributed),
    },
    {
      key: 'timestamp',
      header: 'DATE',
      sortable: true,
      accessor: (row) => Number(row.timestamp),
      render: (row) =>
        new Date(Number(row.timestamp) * 1000).toLocaleDateString(),
    },
    {
      key: 'claimable',
      header: 'YOUR SHARE',
      sortable: false,
      render: (row) => {
        const alreadyClaimed = claimedByDistribution.get(row.id)
        if (alreadyClaimed && alreadyClaimed > 0n) {
          return (
            <span className="flex items-center gap-1 text-success">
              <Check className="w-4 h-4" />
              Claimed {formatToken(alreadyClaimed)}
            </span>
          )
        }
        const claimable = getClaimableAmount(row)
        return claimable > 0n ? formatToken(claimable) : 'No share'
      },
    },
    {
      key: 'action',
      header: '',
      sortable: false,
      render: (row) => {
        const alreadyClaimed = claimedByDistribution.get(row.id)
        if (alreadyClaimed && alreadyClaimed > 0n) return ''
        // The newest current payout owns the page's primary Claim button. Historical payouts
        // remain claimable from the table without duplicating that action in the usual one-row
        // case.
        if (currentDistribution?.id === row.id) return ''
        const claimable = getClaimableAmount(row)
        if (claimable === 0n) return ''
        return (
          <Button
            size="xs"
            variant="default"
            onClick={(e) => {
              e.stopPropagation()
              handleClaim(row)
            }}
            disabled={isClaiming || isPaused}
          >
            {claimingDistributionId === row.id ? 'Claiming...' : 'Claim'}
          </Button>
        )
      },
    },
  ]

  return (
    <div className="space-y-12">
      <header className="space-y-4">
        <NetworkHeader
          network={network}
          tabs={contributionsTabs(network)}
          className="w-full"
        />
        <div className="max-w-3xl space-y-2">
          <h2 className="text-2xl font-semibold">Claim your share</h2>
          <p className="text-muted-foreground">
            Your share comes from the round&apos;s proven community scores.
            Funding or claiming later never changes your portion.
          </p>
        </div>
      </header>

      {isPaused && (
        <Card type="outline" size="lg" className="border-warn">
          <p className="text-sm text-warn">
            Payouts are paused right now. Funding and claiming will resume when
            the operator unpauses the contract.
          </p>
        </Card>
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      <section
        aria-labelledby="your-share-heading"
        className="grid min-h-[18rem] gap-8 border-y border-hairline py-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <div className="min-w-0 space-y-3">
          <p id="your-share-heading" className="tg-label">
            Your share:
          </p>
          {!isConnected ? (
            <p className="max-w-xl text-text-muted">
              Connect your wallet to see your share and claim it.
            </p>
          ) : isLoadingDistributions ||
            isLoadingUserClaims ||
            isLoadingCurrentEntry ? (
            <p className="text-sm text-text-muted" aria-live="polite">
              Checking your share in the current payout.
            </p>
          ) : !currentDistribution ? (
            <div className="space-y-2">
              <p className="tg-display text-4xl tabular-nums">
                Not available yet
              </p>
              <p className="text-sm text-text-muted">
                No payout has been funded for this round yet.
              </p>
            </div>
          ) : currentEntryFailed ? (
            <div className="space-y-2">
              <p className="tg-display text-4xl tabular-nums">Unavailable</p>
              <p className="text-sm text-warn">
                Your payout entry could not be loaded. Try again when the round
                service is available.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="tg-display text-4xl tabular-nums break-words sm:text-5xl">
                {formatToken(currentShareAmount)}
              </p>
              {currentClaimedAmount > 0n ? (
                <p className="flex items-center gap-2 text-sm text-success">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Already claimed from this payout.
                </p>
              ) : currentShareAmount === 0n ? (
                <p className="text-sm text-text-muted">
                  This wallet has no share in the current payout.
                </p>
              ) : (
                <p className="text-sm text-text-muted">
                  This amount is fixed by the proven scores for this payout.
                </p>
              )}
            </div>
          )}
        </div>

        {isConnected &&
          currentDistribution &&
          currentShareAmount > 0n &&
          currentClaimedAmount === 0n &&
          !isLoadingUserClaims &&
          !isLoadingCurrentEntry &&
          !currentEntryFailed && (
            <Button
              variant="default"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => handleClaim(currentDistribution)}
              disabled={isClaiming || isPaused}
            >
              {claimingDistributionId === currentDistribution.id
                ? 'Claiming...'
                : 'Claim'}
            </Button>
          )}
      </section>

      <section className="space-y-4" aria-labelledby="payout-history-heading">
        <div id="payout-history-heading">
          <SectionHeading>Payout history</SectionHeading>
        </div>
        {isLoadingDistributions ? (
          <p className="text-sm text-muted-foreground">
            Loading payout history.
          </p>
        ) : distributions.length === 0 ? (
          <Card type="outline" size="lg" className="text-center">
            <p className="text-muted-foreground">
              No payouts have been funded for this round yet.
            </p>
          </Card>
        ) : (
          <Table
            columns={distributionColumns}
            data={distributions}
            defaultSortColumn="timestamp"
            defaultSortDirection="desc"
            rowClassName="text-sm"
            getRowKey={(row) => row.id.toString()}
          />
        )}
      </section>

      <details className="group border-y border-hairline">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
          <span>Fund this round</span>
          <ChevronDown
            className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="border-t border-hairline py-6">
          {!isConnected ? (
            <p className="text-sm text-text-muted">
              Connect your wallet to fund this round.
            </p>
          ) : isPaused ? (
            <p className="text-sm text-warn">
              Funding will resume when the operator unpauses the contract.
            </p>
          ) : (
            <div className="max-w-xl space-y-4">
              <div>
                <SectionHeading>Fund the round payout</SectionHeading>
                <p className="mt-1 text-sm text-muted-foreground">
                  Deposit {tokenSymbol} against the round&apos;s latest proven
                  scores. The deposit is locked to that exact score table, so
                  later score changes cannot redirect it.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Amount ({tokenSymbol})</Label>
                <Input
                  type="number"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {balance !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    Your balance: {formatToken(balance)}
                  </p>
                )}
                {feePercentage !== undefined && parsedAmount > 0n && (
                  <p className="text-xs text-muted-foreground">
                    A {feePercentage.toFixed(2)}% fee is deducted from the
                    deposit before it is split.
                  </p>
                )}
              </div>

              {needsApproval ? (
                <Button
                  onClick={handleApprove}
                  disabled={isDistributing || !parsedAmount}
                >
                  {isDistributing
                    ? 'Approving...'
                    : `Approve ${tokenSymbol} spending`}
                </Button>
              ) : (
                <Button
                  onClick={handleDistribute}
                  disabled={isDistributing || !parsedAmount || !expectedRoot}
                >
                  {isDistributing ? 'Funding...' : 'Fund payout'}
                </Button>
              )}

              {expectedRoot ? (
                <p className="text-xs text-muted-foreground">
                  Locked to proven score table:{' '}
                  <CopyableText
                    text={expectedRoot}
                    className="text-xs text-muted-foreground"
                    truncate
                    truncateEnds={[8, 6]}
                    alwaysShowCopyIcon
                  />
                </p>
              ) : (
                <p className="text-xs text-warn">
                  Funding is disabled until the round&apos;s first proven score
                  table lands on-chain.
                </p>
              )}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}
