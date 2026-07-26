'use client'

import { usePonderQuery } from '@ponder/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Hex, erc20Abi, formatUnits, parseUnits } from 'viem'
import { useAccount, usePublicClient, useReadContracts } from 'wagmi'

import { Address } from '@/components/Address'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { contributionsQueries } from '@/lib/contributions-api'
import { parseErrorMessage } from '@/lib/error'
import { txToast } from '@/lib/tx'
import { ContributionsNetwork } from '@/lib/types'
import { merkleFundDistribution } from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import {
  BackToRound,
  ContributionsNav,
  useContributionsData,
} from '../contributions-shared'

type DistributionRow = typeof merkleFundDistribution.$inferSelect

/**
 * The payout screen for a contributions round (adapted from the trust network's distribute
 * page): fund the round's payout with the pool token pinned to the proven root, and claim your
 * share with a merkle proof from the indexer's payout bundle.
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
  const { data: userClaims = [] } = usePonderQuery({
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
  const feePercentage = distributorState?.feePercentage
    ? Number(distributorState.feePercentage) * 100
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
  const { data: payoutBundle } = useQuery(
    contributionsQueries.payout(snapshotAddress, connectedAddress)
  )

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

  const formatToken = (value: bigint) =>
    `${Number(formatUnits(value, tokenDecimals)).toLocaleString(undefined, {
      maximumFractionDigits: tokenDecimals,
    })} ${tokenSymbol}`

  const handleApprove = async () => {
    if (!connectedAddress || !publicClient) return
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
    if (!connectedAddress || !publicClient || !expectedRoot) return
    setError(null)
    setIsDistributing(true)
    try {
      const gasEstimate = await publicClient.estimateContractGas({
        abi: merkleFundDistributorAbi,
        address: distributorAddress,
        functionName: 'distribute',
        args: [poolToken, parsedAmount, expectedRoot],
        account: connectedAddress,
      })
      await txToast({
        tx: {
          abi: merkleFundDistributorAbi,
          address: distributorAddress,
          functionName: 'distribute',
          args: [poolToken, parsedAmount, expectedRoot],
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

  const getClaimableAmount = useCallback(
    (distribution: DistributionRow) => {
      const entry = entryForRoot(distribution.root)
      if (!entry) return 0n
      if ((claimedByDistribution.get(distribution.id) ?? 0n) > 0n) return 0n
      const totalDistributable =
        distribution.amountFunded - distribution.feeAmount
      if (distribution.totalMerkleValue === 0n) return 0n
      return (
        (totalDistributable * BigInt(entry.value)) /
        distribution.totalMerkleValue
      )
    },
    [entryForRoot, claimedByDistribution]
  )

  const distributionColumns: Column<DistributionRow>[] = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      accessor: (row) => Number(row.id),
      render: (row) => `#${(row.id + 1n).toString()}`,
    },
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
        return claimable > 0n ? formatToken(claimable) : '—'
      },
    },
    {
      key: 'action',
      header: '',
      sortable: false,
      render: (row) => {
        const alreadyClaimed = claimedByDistribution.get(row.id)
        if (alreadyClaimed && alreadyClaimed > 0n) return ''
        const claimable = getClaimableAmount(row)
        if (claimable === 0n) return ''
        return (
          <Button
            size="xs"
            variant="brand"
            onClick={(e) => {
              e.stopPropagation()
              handleClaim(row)
            }}
            disabled={isClaiming}
          >
            {claimingDistributionId === row.id ? 'Claiming...' : 'Claim'}
          </Button>
        )
      },
    },
  ]

  return (
    <div className="space-y-8">
      <div className="space-y-4 max-w-3xl">
        <BackToRound network={network} />
        <h1 className="text-3xl font-bold">Payouts</h1>
        <p className="text-muted-foreground">
          When the round settles, its proven scores become a payout table.
          Anyone can fund a payout from that table; contributors then claim
          their share here. Your share is fixed by the proven scores — funding
          or claiming late never changes anyone&apos;s slice.
        </p>
      </div>

      <ContributionsNav network={network} />

      {isPaused && (
        <Card type="outline" size="lg" className="border-warn">
          <p className="text-sm text-warn">
            Payouts are paused right now. Funding and claiming will resume when
            the operator unpauses the contract.
          </p>
        </Card>
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      {/* Fund the round payout */}
      {isConnected && !isPaused && (
        <Card type="accent" size="lg" className="space-y-4 max-w-xl">
          <div>
            <SectionHeading>Fund the round payout</SectionHeading>
            <p className="text-sm text-muted-foreground mt-1">
              Deposit {tokenSymbol} against the round&apos;s latest proven
              scores. The deposit is locked to the exact score table shown
              below, so later score changes can&apos;t redirect it.
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
                A {feePercentage.toFixed(2)}% fee is deducted from the deposit
                before it is split.
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
        </Card>
      )}

      {!isConnected && (
        <Card type="outline" size="lg" className="text-center">
          <p className="text-muted-foreground">
            Connect your wallet to see and claim your share of the round
            payouts.
          </p>
        </Card>
      )}

      {/* Distributions table */}
      <div className="space-y-4">
        <SectionHeading>Round payouts</SectionHeading>
        {isLoadingDistributions ? (
          <p className="text-sm text-muted-foreground">Loading payouts...</p>
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
            defaultSortColumn="id"
            defaultSortDirection="desc"
            rowClassName="text-sm"
            getRowKey={(row) => row.id.toString()}
          />
        )}
      </div>
    </div>
  )
}
