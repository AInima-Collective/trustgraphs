'use client'

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Hex, erc20Abi, isAddress, isAddressEqual, zeroAddress } from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from 'wagmi'

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
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useNetworkIfAvailable } from '@/contexts/NetworkContext'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import { useTokenMetadata } from '@/hooks/useTokenMetadata'
import { merkleFundDistributorAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import {
  contractReadState,
  financialReadState,
  formatFinancialAmount,
  parseFinancialAmount,
} from '@/lib/financial-state'
import {
  distributeArgs as buildDistributeArgs,
  fundingTermsAbi,
  quotedFee,
} from '@/lib/funding-terms'
import { txToast } from '@/lib/tx'
import type { Network } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { merkleFundDistribution } from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

type DistributionRow = typeof merkleFundDistribution.$inferSelect

export const DistributePage = ({
  embedded = false,
  defaultOpen = false,
  network: networkOverride,
}: {
  embedded?: boolean
  defaultOpen?: boolean
  network?: Network
}) => {
  const networkContext = useNetworkIfAvailable()
  const network = networkOverride ?? networkContext?.network
  if (!network) {
    throw new Error('DistributePage requires a network')
  }

  const { address: connectedAddress, isConnected } = useAccount()
  const {
    targetChainId,
    targetChain,
    wrongChain,
    switchToTarget,
    switchingTarget,
    switchError,
  } = useApplicationChain()
  const publicClient = usePublicClient({ chainId: targetChainId })

  const [isDistributing, setIsDistributing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fundOpen, setFundOpen] = useState(defaultOpen)

  // Form state for creating a distribution
  const [tokenType, setTokenType] = useState<'native' | 'erc20'>('native')
  const [tokenAddress, setTokenAddress] = useState('')
  const [amount, setAmount] = useState('')

  const merkleFundDistributorAddress = (network.contracts
    .merkleFundDistributor || '') as Hex

  // Query distributions from ponder
  const distributionsQuery = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributions(merkleFundDistributorAddress),
    enabled: !!merkleFundDistributorAddress,
  })

  const { data: distributions = [] } = distributionsQuery

  // Query the latest merkle snapshot to get the root
  const latestSnapshotQuery = usePonderQuery({
    queryFn: ponderQueryFns.getLatestMerkleSnapshot(
      network.contracts.merkleSnapshot
    ),
  })

  const latestMerkleSnapshot = latestSnapshotQuery.data

  // Query the full merkle tree using the latest root (for create distribution)
  const treeQuery = useQuery({
    ...ponderQueries.merkleTree({
      snapshot: network.contracts.merkleSnapshot,
      root: latestMerkleSnapshot?.root,
    }),
    enabled: !!latestMerkleSnapshot?.root,
  })

  const latestMerkleTree = treeQuery.data

  // Query distributor state from ponder
  const distributorQuery = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributor(merkleFundDistributorAddress),
    enabled: !!merkleFundDistributorAddress,
  })

  const distributorState = distributorQuery.data

  // Fee terms come from the chain, not the indexer: these are the numbers the funder is shown
  // AND the numbers `distribute` is bound to, so a rounded or stale copy would either mis-state
  // the fee or revert a legitimate round.
  const feeTermsRead = {
    address: merkleFundDistributorAddress as Hex,
    abi: fundingTermsAbi,
    chainId: targetChainId,
    query: { enabled: !!merkleFundDistributorAddress },
  } as const
  const feePercentageQuery = useReadContract({
    ...feeTermsRead,
    functionName: 'feePercentage',
  })
  const feeRangeQuery = useReadContract({
    ...feeTermsRead,
    functionName: 'FEE_RANGE',
  })
  const feeRecipientQuery = useReadContract({
    ...feeTermsRead,
    functionName: 'feeRecipient',
  })
  const feePercentageRaw = feePercentageQuery.data
  const feeRange = feeRangeQuery.data
  const feeRecipient = feeRecipientQuery.data
  const feePercentage =
    feePercentageRaw !== undefined && feeRange
      ? (Number(feePercentageRaw) / Number(feeRange)) * 100
      : undefined

  const allowlistEnabled = distributorState?.allowlistEnabled
  const isPaused = distributorState?.paused

  // Check if user is allowed to distribute
  const isAllowlisted = useMemo(() => {
    if (!connectedAddress || !distributorState?.allowlist) return false
    return distributorState.allowlist.some((addr) =>
      isAddressEqual(addr, connectedAddress)
    )
  }, [connectedAddress, distributorState?.allowlist])

  const canDistribute = !allowlistEnabled || isAllowlisted

  const selectedToken =
    tokenType === 'native' ? zeroAddress : tokenAddress.trim()
  const validToken =
    isAddress(selectedToken) &&
    (tokenType === 'native' || selectedToken.toLowerCase() !== zeroAddress)
  const tokenMetadata = useTokenMetadata([
    ...distributions.map((distribution) => distribution.token),
    selectedToken,
  ])
  const selectedMetadata = tokenMetadata.get(selectedToken)
  const tokenSymbol = selectedMetadata?.symbol
  const tokenInfoQuery = useReadContracts({
    contracts:
      validToken && tokenType === 'erc20' && connectedAddress
        ? [
            {
              address: selectedToken as Hex,
              chainId: targetChainId,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [connectedAddress, merkleFundDistributorAddress],
            },
            {
              address: selectedToken as Hex,
              chainId: targetChainId,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [connectedAddress],
            },
          ]
        : [],
    query: {
      enabled:
        validToken &&
        tokenType === 'erc20' &&
        !!connectedAddress &&
        !!merkleFundDistributorAddress,
    },
  })
  const tokenAllowance = tokenInfoQuery.data?.[0]?.result as bigint | undefined
  const tokenBalance = tokenInfoQuery.data?.[1]?.result as bigint | undefined
  const parsed = parseFinancialAmount(amount, selectedMetadata?.decimals)
  const parsedAmount = parsed.amount ?? 0n
  const feeState = financialReadState([
    feePercentageQuery,
    feeRangeQuery,
    feeRecipientQuery,
  ])
  const proofState = financialReadState([
    latestSnapshotQuery,
    ...(latestMerkleSnapshot?.root ? [treeQuery] : []),
  ])
  const distributorStatus = financialReadState([distributorQuery])
  const fundingProblem = !isConnected
    ? 'Connect a wallet to fund rewards.'
    : wrongChain
      ? `Switch to ${targetChain.name} to fund rewards.`
      : !validToken
        ? 'Enter a valid token address.'
        : tokenMetadata.state(selectedToken) === 'loading'
          ? 'Loading token details…'
          : tokenMetadata.state(selectedToken) !== 'ready'
            ? 'Token details could not be verified. Retry before funding.'
            : feeState === 'loading'
              ? 'Loading the current fee…'
              : feeState !== 'ready' || !feeRange || !feeRecipient
                ? 'The current fee could not be verified. Retry before funding.'
                : proofState === 'loading'
                  ? 'Loading the latest proven scores…'
                  : proofState !== 'ready'
                    ? 'The latest proven scores could not be loaded. Retry before funding.'
                    : !latestMerkleTree?.tree
                      ? 'Funding opens after the network’s first proven scores are published.'
                      : distributorStatus === 'loading'
                        ? 'Checking funding access…'
                        : distributorStatus !== 'ready' || !distributorState
                          ? 'Funding access could not be verified. Retry before funding.'
                          : isPaused
                            ? 'Reward funding is paused.'
                            : !canDistribute
                              ? 'This wallet is not allowed to fund this network.'
                              : tokenType === 'erc20' &&
                                  contractReadState(tokenInfoQuery, 2) ===
                                    'loading'
                                ? 'Checking token balance and approval…'
                                : tokenType === 'erc20' &&
                                    contractReadState(tokenInfoQuery, 2) !==
                                      'ready'
                                  ? 'Token balance and approval could not be verified. Retry before funding.'
                                  : tokenType === 'erc20' &&
                                      tokenBalance !== undefined &&
                                      parsedAmount > tokenBalance
                                    ? 'The amount exceeds your token balance.'
                                    : null
  const retryFunding = () => {
    void Promise.allSettled([
      latestSnapshotQuery.refetch(),
      distributorQuery.refetch(),
      feePercentageQuery.refetch(),
      feeRangeQuery.refetch(),
      feeRecipientQuery.refetch(),
      ...(latestMerkleSnapshot?.root ? [treeQuery.refetch()] : []),
      ...(validToken && tokenType === 'erc20'
        ? [tokenMetadata.refetch(), tokenInfoQuery.refetch()]
        : []),
    ])
  }

  // Exactly what `distribute` will charge, computed the way the contract computes it.
  const feeAmount =
    feePercentageRaw !== undefined && feeRange
      ? quotedFee(parsedAmount, feePercentageRaw, feeRange)
      : undefined

  const needsApproval =
    tokenType === 'erc20' &&
    parsedAmount > 0n &&
    (tokenAllowance ?? 0n) < parsedAmount

  // Approve ERC20 tokens
  const handleApprove = async () => {
    if (
      fundingProblem ||
      !parsed.amount ||
      !connectedAddress ||
      !publicClient ||
      !merkleFundDistributorAddress
    ) {
      setError(
        fundingProblem ?? parsed.error ?? 'Enter an amount before approving.'
      )
      return
    }

    setError(null)
    setIsDistributing(true)

    try {
      const gasEstimate = await publicClient.estimateContractGas({
        address: selectedToken as Hex,
        abi: erc20Abi,
        functionName: 'approve',
        args: [merkleFundDistributorAddress, parsedAmount],
        account: connectedAddress,
      })

      await txToast({
        tx: {
          account: connectedAddress,
          chainId: targetChainId,
          address: selectedToken as Hex,
          abi: erc20Abi,
          functionName: 'approve',
          args: [merkleFundDistributorAddress, parsedAmount],
          gas: (gasEstimate * 120n) / 100n,
        },
        successMessage: 'Token approval successful!',
      })
      await tokenInfoQuery.refetch()
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
      !!fundingProblem ||
      !parsed.amount ||
      !connectedAddress ||
      !publicClient ||
      !merkleFundDistributorAddress ||
      !latestMerkleTree?.tree ||
      feeAmount === undefined ||
      !feeRecipient
    ) {
      setError(
        fundingProblem ??
          parsed.error ??
          'Funding details are not ready. Retry the checks.'
      )
      return
    }

    setError(null)
    setIsDistributing(true)

    try {
      const token =
        tokenType === 'native'
          ? '0x0000000000000000000000000000000000000000'
          : selectedToken
      // Every guard `distribute` takes, pinned to what this screen showed the funder: the root,
      // the payout denominator that root committed, the fee, and who receives it.
      const expectedRoot = latestMerkleTree.tree.root as Hex
      const distributeArgs = buildDistributeArgs({
        token: token as Hex,
        amount: parsedAmount,
        expectedRoot,
        expectedTotalMerkleValue: BigInt(latestMerkleTree.tree.totalValue),
        claimDeadline: 0n, // claims stay open; the round is never sweepable
        feePercentage: feePercentageRaw!,
        feeRange: feeRange!,
        feeRecipient,
      })
      const gasEstimate = await publicClient.estimateContractGas({
        abi: merkleFundDistributorAbi,
        address: merkleFundDistributorAddress,
        functionName: 'distribute',
        args: distributeArgs,
        account: connectedAddress,
        ...(tokenType === 'native' ? { value: parsedAmount } : {}),
      })

      await txToast({
        tx: {
          account: connectedAddress,
          chainId: targetChainId,
          abi: merkleFundDistributorAbi,
          address: merkleFundDistributorAddress,
          functionName: 'distribute',
          args: distributeArgs,
          gas: (gasEstimate * 120n) / 100n,
          ...(tokenType === 'native' ? { value: parsedAmount } : {}),
        } as any,
        successMessage: 'Network rewards funded.',
      })
      setAmount('')
      void distributionsQuery.refetch()
    } catch (err) {
      console.error('Distribution error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsDistributing(false)
    }
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
      header: 'FUNDED BY',
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
      render: (row) =>
        formatFinancialAmount(row.amountFunded, tokenMetadata.get(row.token)),
    },
    {
      key: 'distributed',
      header: 'CLAIMED',
      sortable: true,
      accessor: (row) => Number(row.amountDistributed),
      render: (row) =>
        formatFinancialAmount(
          row.amountDistributed,
          tokenMetadata.get(row.token)
        ),
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

  const historyState = financialReadState([distributionsQuery])
  const isLoading = historyState === 'loading'

  const content = (
    <>
      {/* Header */}
      {!embedded && (
        <div className="flex flex-col items-start gap-4">
          <BreadcrumbRenderer className="mb-2" />

          <NetworkHeader network={network} className="w-full" />

          <p className="text-muted-foreground text-sm">
            Fund rewards allocated according to a proven trust-score snapshot.
          </p>
        </div>
      )}

      {/* Statistics */}
      <div className="border-y border-border py-8 space-y-6">
        <SectionHeading>Funding statistics</SectionHeading>
        <div className="flex flex-row gap-4 flex-wrap">
          <StatisticCard
            title="TOTAL REWARD POOLS"
            tooltip="The total number of fund distributions created for this network."
            value={
              historyState === 'ready'
                ? distributions.length.toString()
                : historyState === 'loading'
                  ? '…'
                  : 'Unavailable'
            }
          />
        </div>
      </div>

      {/* Create Distribution Section */}
      {isConnected && (
        <Card type="accent" size="lg" className="space-y-6">
          <div>
            <SectionHeading>Fund network rewards</SectionHeading>
            <p className="text-sm text-muted-foreground mt-1">
              Allocate a new reward pool to current network members. The current
              proven trust scores fix each member&apos;s share; later graph
              updates will not change this pool.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="reward-token-type">Token type</Label>
              <Select
                value={tokenType}
                onValueChange={(v) => setTokenType(v as 'native' | 'erc20')}
              >
                <SelectTrigger id="reward-token-type" disabled={isDistributing}>
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
                <Label htmlFor="reward-token-address">Token address</Label>
                <Input
                  id="reward-token-address"
                  disabled={isDistributing}
                  aria-invalid={!!tokenAddress && !validToken}
                  aria-describedby="reward-funding-status"
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
              <Label htmlFor="reward-funding-amount">Amount</Label>
              <Input
                id="reward-funding-amount"
                inputMode="decimal"
                disabled={isDistributing}
                aria-invalid={!!parsed.error}
                aria-describedby="reward-funding-amount-error reward-funding-status"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {parsed.error && (
                <p
                  id="reward-funding-amount-error"
                  role="alert"
                  className="text-xs text-error"
                >
                  {parsed.error}
                </p>
              )}
              {feeState === 'ready' &&
                selectedMetadata &&
                feeAmount !== undefined &&
                parsedAmount > 0n && (
                  <p className="text-xs text-muted-foreground">
                    Fee: {formatFinancialAmount(feeAmount, selectedMetadata)}
                    {' · '}Members receive{' '}
                    {formatFinancialAmount(
                      parsedAmount - feeAmount,
                      selectedMetadata
                    )}
                  </p>
                )}
            </div>
          </div>

          <div
            id="reward-funding-status"
            role="status"
            className="space-y-2 text-sm text-muted-foreground"
          >
            {fundingProblem && <p>{fundingProblem}</p>}
            {wrongChain ? (
              <Button
                onClick={() => void switchToTarget()}
                disabled={switchingTarget}
                variant="outline"
              >
                Switch to {targetChain.name}
              </Button>
            ) : (
              fundingProblem && (
                <Button
                  onClick={retryFunding}
                  variant="outline"
                  size="sm"
                  disabled={isDistributing}
                >
                  Retry checks
                </Button>
              )
            )}
            {switchError && <p className="text-error">{switchError}</p>}
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
                disabled={isDistributing || !!fundingProblem || !parsed.amount}
              >
                {isDistributing ? 'Approving...' : 'Approve Tokens'}
              </Button>
            ) : (
              <Button
                onClick={handleDistribute}
                disabled={isDistributing || !!fundingProblem || !parsed.amount}
              >
                {isDistributing ? 'Funding Rewards...' : 'Fund Rewards'}
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
            ) : null}

            {feeState === 'ready' && feePercentage !== undefined && (
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
            Connect your wallet to fund rewards. You can review funding history
            without connecting.
          </p>
          <WalletConnectionButton />
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
            Reward funding is currently paused. Existing allocations remain
            recorded.
          </p>
        </Card>
      )}

      {/* Distributions Table */}
      <div className="space-y-6">
        <SectionHeading>Funding history</SectionHeading>

        {isLoading && (
          <div className="text-center py-8">
            <div className="text-sm text-muted-foreground">
              Loading funding history...
            </div>
          </div>
        )}

        {(historyState === 'error' || historyState === 'stale') && (
          <Card type="outline" size="md" className="space-y-3" role="status">
            <p>
              {historyState === 'stale'
                ? 'Funding history could not be refreshed. Previously loaded pools are shown below.'
                : 'Funding history could not be loaded.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void distributionsQuery.refetch()}
              disabled={distributionsQuery.isFetching}
            >
              Retry history
            </Button>
          </Card>
        )}
        {distributions.some(
          (row) => tokenMetadata.state(row.token) !== 'ready'
        ) && (
          <div
            className="space-y-2 text-sm text-muted-foreground"
            role="status"
          >
            <p>
              Some token details are unavailable. Amounts are shown only when
              their decimal precision is known.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void tokenMetadata.refetch()}
              disabled={tokenMetadata.isFetching}
            >
              Retry token details
            </Button>
          </div>
        )}
        {historyState === 'ready' && distributions.length === 0 && (
          <Card type="outline" size="lg" className="text-center">
            <p className="text-muted-foreground">
              No reward pools have been funded for this network yet.
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
    </>
  )

  if (embedded) {
    return (
      <details
        id="fund-rewards"
        open={fundOpen}
        onToggle={(event) => setFundOpen(event.currentTarget.open)}
        className="group scroll-mt-6 border-y border-hairline"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
          <span>Fund network rewards</span>
          <ChevronDown
            className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="flex flex-col gap-8 border-t border-hairline py-8">
          <div className="max-w-3xl space-y-2">
            <h3 className="text-xl font-semibold">Fund network rewards</h3>
            <p className="text-sm leading-relaxed text-text-muted">
              Add a reward pool using the latest proven trust scores. Funding
              creates a fixed allocation immediately; it is not a general
              network donation.
            </p>
          </div>
          {content}
        </div>
      </details>
    )
  }

  return <div className="flex flex-col gap-8">{content}</div>
}
