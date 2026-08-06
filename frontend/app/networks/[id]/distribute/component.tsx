'use client'

import { useQuery } from '@tanstack/react-query'
import { Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Hex,
  erc20Abi,
  formatUnits,
  isAddressEqual,
  parseEther,
  parseUnits,
} from 'viem'
import { useAccount, usePublicClient, useReadContracts } from 'wagmi'

import { Address } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { NetworkHeader } from '@/components/NetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/Select'
import { StatisticCard } from '@/components/StatisticCard'
import { Column, Table } from '@/components/Table'
import { useNetwork } from '@/contexts/NetworkContext'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import { txToast } from '@/lib/tx'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { formatBigNumber } from '@/lib/utils'
import { merkleFundDistribution } from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

type DistributionRow = typeof merkleFundDistribution.$inferSelect

export const DistributePage = () => {
  const { network } = useNetwork()

  const { address: connectedAddress, isConnected } = useAccount()
  const publicClient = usePublicClient()

  const [isDistributing, setIsDistributing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state for creating a distribution
  const [tokenType, setTokenType] = useState<'native' | 'erc20'>('native')
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')

  const merkleFundDistributorAddress = (network.contracts
    .merkleFundDistributor || '') as Hex

  // Query distributions from ponder
  const { data: distributions = [], isLoading: isLoadingDistributions } =
    usePonderQuery({
      queryFn: ponderQueryFns.getFundDistributions(
        merkleFundDistributorAddress
      ),
      enabled: !!merkleFundDistributorAddress,
    })

  // Query the latest merkle snapshot to get the root
  const { data: latestMerkleSnapshot } = usePonderQuery({
    queryFn: ponderQueryFns.getLatestMerkleSnapshot(
      network.contracts.merkleSnapshot
    ),
  })

  // Query the full merkle tree using the latest root (for create distribution)
  const { data: latestMerkleTree, isLoading: isLoadingMerkleTree } = useQuery({
    ...ponderQueries.merkleTree({
      snapshot: network.contracts.merkleSnapshot,
      root: latestMerkleSnapshot?.root,
    }),
    enabled: !!latestMerkleSnapshot?.root,
  })

  // Query distributor state from ponder
  const { data: distributorState } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributor(merkleFundDistributorAddress),
    enabled: !!merkleFundDistributorAddress,
  })

  const allowlistEnabled = distributorState?.allowlistEnabled
  const feePercentage = distributorState?.feePercentage
    ? Number(distributorState.feePercentage) * 100
    : undefined
  const isPaused = distributorState?.paused

  // Check if user is allowed to distribute
  const isAllowlisted = useMemo(() => {
    if (!connectedAddress || !distributorState?.allowlist) return false
    return distributorState.allowlist.some((addr) =>
      isAddressEqual(addr, connectedAddress)
    )
  }, [connectedAddress, distributorState?.allowlist])

  const canDistribute = !allowlistEnabled || isAllowlisted

  // Read ERC20 token info if an address is provided
  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContracts({
    contracts:
      tokenType === 'erc20' && tokenAddress
        ? [
            {
              address: tokenAddress as Hex,
              abi: erc20Abi,
              functionName: 'symbol',
            },
            {
              address: tokenAddress as Hex,
              abi: erc20Abi,
              functionName: 'decimals',
            },
            {
              address: tokenAddress as Hex,
              abi: erc20Abi,
              functionName: 'allowance',
              args: connectedAddress
                ? [connectedAddress, merkleFundDistributorAddress]
                : undefined,
            },
          ]
        : [],
    query: {
      enabled:
        tokenType === 'erc20' &&
        tokenAddress.length === 42 &&
        !!connectedAddress &&
        !!merkleFundDistributorAddress,
    },
  })

  const tokenSymbol = tokenInfo?.[0]?.result as string | undefined
  const tokenDecimals = (tokenInfo?.[1]?.result as number | undefined) ?? 18
  const tokenAllowance = tokenInfo?.[2]?.result as bigint | undefined

  // Calculate if approval is needed
  const parsedAmount = useMemo(() => {
    try {
      if (!amount) return 0n
      return tokenType === 'native'
        ? parseEther(amount)
        : parseUnits(amount, tokenDecimals)
    } catch {
      return 0n
    }
  }, [amount, tokenType, tokenDecimals])

  const needsApproval =
    tokenType === 'erc20' &&
    parsedAmount > 0n &&
    (tokenAllowance ?? 0n) < parsedAmount

  // Approve ERC20 tokens
  const handleApprove = async () => {
    if (!connectedAddress || !publicClient || !merkleFundDistributorAddress)
      return

    setError(null)
    setIsDistributing(true)

    try {
      const gasEstimate = await publicClient.estimateContractGas({
        address: tokenAddress as Hex,
        abi: erc20Abi,
        functionName: 'approve',
        args: [merkleFundDistributorAddress, parsedAmount],
        account: connectedAddress,
      })

      await txToast({
        tx: {
          address: tokenAddress as Hex,
          abi: erc20Abi,
          functionName: 'approve',
          args: [merkleFundDistributorAddress, parsedAmount],
          gas: (gasEstimate * 120n) / 100n,
        },
        successMessage: 'Token approval successful!',
      })
        .then(() => {
          refetchTokenInfo()
        })
        .catch(() => {})
    } catch (err) {
      console.error('Approval error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsDistributing(false)
    }
  }

  // Create a new distribution
  const handleDistribute = async () => {
    if (
      !connectedAddress ||
      !publicClient ||
      !merkleFundDistributorAddress ||
      !latestMerkleTree?.tree
    )
      return

    setError(null)
    setIsDistributing(true)

    try {
      const token =
        tokenType === 'native'
          ? '0x0000000000000000000000000000000000000000'
          : tokenAddress
      const expectedRoot = latestMerkleTree.tree.root as Hex
      const gasEstimate = await publicClient.estimateContractGas({
        abi: merkleFundDistributorAbi,
        address: merkleFundDistributorAddress,
        functionName: 'distribute',
        args: [token as Hex, parsedAmount, expectedRoot],
        account: connectedAddress,
        ...(tokenType === 'native' ? { value: parsedAmount } : {}),
      })

      await txToast({
        tx: {
          abi: merkleFundDistributorAbi,
          address: merkleFundDistributorAddress,
          functionName: 'distribute',
          args: [token as Hex, parsedAmount, expectedRoot],
          gas: (gasEstimate * 120n) / 100n,
          ...(tokenType === 'native' ? { value: parsedAmount } : {}),
        } as any,
        successMessage: 'Distribution created successfully!',
      })
        .then(() => {
          // Reset form
          setAmount('')
          setTokenAddress('')
        })
        .catch(() => {})
    } catch (err) {
      console.error('Distribution error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsDistributing(false)
    }
  }

  // Format token amount
  const formatTokenAmount = (
    tokenAmount: bigint,
    token: Hex,
    decimals: number = 18
  ) => {
    const isNative = token === '0x0000000000000000000000000000000000000000'
    return `${formatUnits(tokenAmount, decimals)} ${
      isNative ? 'ETH' : 'tokens'
    }`
  }

  // Table columns for distributions
  const distributionColumns: Column<DistributionRow>[] = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      accessor: (row) => Number(row.id),
      render: (row) => `#${(row.id + 1n).toString()}`,
    },
    {
      key: 'distributor',
      header: 'DISTRIBUTOR',
      sortable: false,
      render: (row) => (
        <Address address={row.distributor} displayMode="truncated" />
      ),
    },
    {
      key: 'token',
      header: 'TOKEN',
      sortable: false,
      render: (row) =>
        row.token === '0x0000000000000000000000000000000000000000' ? (
          'ETH'
        ) : (
          <Address address={row.token} displayMode="truncated" />
        ),
    },
    {
      key: 'amount',
      header: 'FUNDED',
      sortable: true,
      accessor: (row) => Number(row.amountFunded),
      render: (row) => formatTokenAmount(row.amountFunded, row.token),
    },
    {
      key: 'distributed',
      header: 'CLAIMED',
      sortable: true,
      accessor: (row) => Number(row.amountDistributed),
      render: (row) => formatTokenAmount(row.amountDistributed, row.token),
    },
    {
      key: 'timestamp',
      header: 'DATE',
      sortable: true,
      accessor: (row) => Number(row.timestamp),
      render: (row) =>
        new Date(Number(row.timestamp) * 1000).toLocaleDateString(),
    },
  ]

  const isLoading = isLoadingDistributions || isLoadingMerkleTree

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col items-start gap-4">
        <BreadcrumbRenderer
          className="mb-2"
          fallback={{
            title: 'Network',
            route: `/networks/${network.id}`,
          }}
        />

        <NetworkHeader network={network} className="w-full" />

        <p className="text-muted-foreground text-sm">
          Create and review funds shared according to a proven trust-score
          snapshot. Members collect their rewards from the Claims tab.
        </p>
      </div>

      {/* Statistics */}
      <div className="border-y border-border py-8 space-y-6">
        <SectionHeading>Distribution statistics</SectionHeading>
        <div className="flex flex-row gap-4 flex-wrap">
          <StatisticCard
            title="TOTAL DISTRIBUTIONS"
            tooltip="The total number of fund distributions created for this network."
            value={isLoading ? '...' : distributions.length.toString()}
          />
        </div>
      </div>

      {/* Create Distribution Section */}
      {isConnected && canDistribute && !isPaused && (
        <Card type="accent" size="lg" className="space-y-6">
          <div>
            <SectionHeading>Create distribution</SectionHeading>
            <p className="text-sm text-muted-foreground mt-1">
              Fund a new distribution for network members. Funds will be
              instantly claimable by all current members at their current trust
              score weights. Future network graph updates will not retroactively
              apply to this distribution.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>Token Type</Label>
              <Select
                value={tokenType}
                onValueChange={(v) => setTokenType(v as 'native' | 'erc20')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">Native ETH</SelectItem>
                  <SelectItem value="erc20">ERC20 Token</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {tokenType === 'erc20' && (
              <div className="space-y-2">
                <Label>Token Address</Label>
                <Input
                  placeholder="0x..."
                  value={tokenAddress}
                  onChange={(e) => setTokenAddress(e.target.value)}
                />
                {tokenSymbol && (
                  <p className="text-xs text-muted-foreground">
                    Token: {tokenSymbol}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {feePercentage !== undefined && parsedAmount > 0n && (
                <p className="text-xs text-muted-foreground">
                  Fee:{' '}
                  {formatBigNumber(
                    (parsedAmount * BigInt(feePercentage)) / BigInt(100),
                    18,
                    true
                  )}{' '}
                  {tokenType === 'native' ? 'ETH' : tokenSymbol || 'tokens'}
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="text-error text-sm bg-error-soft dark:bg-error-soft p-3 rounded-md">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            {needsApproval ? (
              <Button
                onClick={handleApprove}
                disabled={isDistributing || !parsedAmount}
              >
                {isDistributing ? 'Approving...' : 'Approve Tokens'}
              </Button>
            ) : (
              <Button
                onClick={handleDistribute}
                disabled={
                  isDistributing || !parsedAmount || !latestMerkleTree?.tree
                }
              >
                {isDistributing
                  ? 'Creating Distribution...'
                  : 'Create Distribution'}
              </Button>
            )}
          </div>

          <div className="space-y-2">
            {latestMerkleTree?.tree ? (
              <p className="text-xs text-muted-foreground">
                Distribution will use merkle root:{' '}
                <CopyableText
                  text={latestMerkleTree.tree.root}
                  className="text-xs text-muted-foreground"
                  truncate
                  truncateEnds={[8, 6]}
                  alwaysShowCopyIcon
                />
              </p>
            ) : (
              <p className="text-xs text-warn">
                Distribution is disabled because the network graph does not yet
                exist. Once attestations are made and the graph is computed, you
                will be able to create distributions.
              </p>
            )}

            {feePercentage !== undefined && (
              <p className="text-xs text-muted-foreground">
                A {feePercentage.toFixed(2)}% fee will be deducted from the
                distribution amount.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Connect Wallet Prompt */}
      {!isConnected && (
        <Card type="outline" size="lg" className="text-center space-y-4">
          <Wallet className="w-12 h-12 mx-auto text-muted-foreground" />
          <h2 className="font-bold">Connect Your Wallet</h2>
          <p className="text-muted-foreground">
            Connect your wallet to create a distribution. You can review past
            distributions without connecting.
          </p>
        </Card>
      )}

      {/* Paused message */}
      {isPaused && (
        <Card
          type="outline"
          size="lg"
          className="text-center space-y-4 border-warn"
        >
          <h2 className="font-bold text-warn">Contract Paused</h2>
          <p className="text-muted-foreground">
            The fund distributor contract is currently paused. New distributions
            are temporarily disabled.
          </p>
        </Card>
      )}

      {/* Distributions Table */}
      <div className="space-y-6">
        <SectionHeading>Distributions</SectionHeading>

        {isLoading && (
          <div className="text-center py-8">
            <div className="text-sm text-muted-foreground">
              Loading distributions...
            </div>
          </div>
        )}

        {!isLoading && distributions.length === 0 && (
          <Card type="outline" size="lg" className="text-center">
            <p className="text-muted-foreground">
              No distributions have been created for this network yet.
            </p>
          </Card>
        )}

        {!isLoading && distributions.length > 0 && (
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
