'use client'

import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Radio,
} from 'lucide-react'
import type { ReactNode } from 'react'
import {
  type Hex,
  formatUnits,
  keccak256,
  stringToBytes,
  zeroAddress,
} from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'

import { Address } from '@/components/Address'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { NetworkHeader } from '@/components/NetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import { StatisticCard } from '@/components/StatisticCard'
import { useNetwork } from '@/contexts/NetworkContext'
import type { InstanceParamsJson, InstanceRow } from '@/lib/catalog'
import { CONTRACT_CONFIG, PROVING_VAULT } from '@/lib/config'
import {
  anchorRegistryAbi,
  easIndexerResolverAbi,
  merkleFundDistributorAbi,
  merkleGovModuleAbi,
  merkleSnapshotAbi,
  trustGraphFactoryAbi,
} from '@/lib/contract-abis'
import {
  type PublicOperatorAction,
  operatorStatusQuery,
} from '@/lib/operator-status'
import {
  erc20MetadataReadAbi,
  priceFeedReadAbi,
  provingVaultReadAbi,
} from '@/lib/settings-contracts'
import { realAddress } from '@/lib/utils'
import { getTargetChainConfig } from '@/lib/wagmi'
import { ponderQueries } from '@/queries/ponder'

const TRUST_GRAPH_PROGRAM = keccak256(stringToBytes('trust-graph'))

type ReadResult = { status?: string; result?: unknown }

const readResult = (reads: readonly ReadResult[] | undefined, index: number) =>
  reads?.[index]?.status === 'success' ? reads[index].result : undefined

const tupleValue = (tuple: unknown, name: string, index: number): unknown => {
  if (Array.isArray(tuple)) return tuple[index]
  if (tuple && typeof tuple === 'object') {
    return (
      (tuple as Record<string, unknown>)[name] ?? Object.values(tuple)[index]
    )
  }
  return undefined
}

const asBigInt = (value: unknown): bigint | undefined =>
  typeof value === 'bigint' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number'
    ? value
    : typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const comma = (value: bigint | number | string | undefined) => {
  if (value === undefined) return '—'
  try {
    return BigInt(value).toLocaleString('en-US')
  } catch {
    return String(value)
  }
}

const units = (value: bigint | undefined, decimals: number, maxPlaces = 4) => {
  if (value === undefined) return '—'
  const formatted = formatUnits(value, decimals)
  const [whole, fraction = ''] = formatted.split('.')
  const clipped = fraction.slice(0, maxPlaces).replace(/0+$/, '')
  return `${BigInt(whole).toLocaleString('en-US')}${clipped ? `.${clipped}` : ''}`
}

const usd = (value: bigint | undefined) =>
  value === undefined ? '—' : `$${units(value, 8, 2)}`

const duration = (seconds: number | bigint | undefined) => {
  if (seconds === undefined) return '—'
  const value = Number(seconds)
  if (!Number.isFinite(value)) return '—'
  if (value < 60) return `${Math.max(0, Math.round(value))} seconds`
  if (value < 3_600) return `${Math.round(value / 60)} minutes`
  if (value < 86_400) return `${Math.round(value / 3_600)} hours`
  if (value < 604_800) return `${Math.round(value / 86_400)} days`
  return `${(value / 604_800).toFixed(value < 6_048_000 ? 1 : 0)} weeks`
}

const timestamp = (seconds: string | number | bigint | null | undefined) => {
  if (seconds === null || seconds === undefined || seconds === '0') return '—'
  const value = Number(seconds)
  if (!Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value * 1_000))
}

const ratio = (raw: string | undefined, scale: string | undefined) => {
  if (!raw || !scale) return '—'
  const numerator = BigInt(raw)
  const denominator = BigInt(scale)
  if (denominator === 0n) return raw
  const whole = numerator / denominator
  const fraction = ((numerator % denominator) * 1_000_000n) / denominator
  const suffix = fraction.toString().padStart(6, '0').replace(/0+$/, '')
  return `${whole}${suffix ? `.${suffix}` : ''}`
}

const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? '—' : value ? 'Yes' : 'No'

const sameHex = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

const quoteReasons = [
  'Eligible',
  'No funded account',
  'Billing policy disabled',
  'Paid cadence has not elapsed',
  'Insufficient balance',
  'Program or size is not priced',
  'Withdrawal pending',
]

const claimReasons = quoteReasons

const actionLabel = (action: PublicOperatorAction | null | undefined) => {
  if (!action) return 'No decision reported'
  const checkpoint =
    action.checkpointId === null ? '' : ` checkpoint ${action.checkpointId}`
  switch (action.action) {
    case 'idle':
      return action.reason
        ? `Idle — ${action.reason.replaceAll('_', ' ')}`
        : 'Idle'
    case 'trigger':
      return 'Freezing the next checkpoint'
    case 'await_finality':
      return `Waiting for checkpoint finality${checkpoint}`
    case 'prove':
      return `Requesting proof for${checkpoint}`
    case 'submit':
      return `Submitting proof for${checkpoint}`
    case 'hold':
      return `Held — ${(action.reason || 'operator policy').replaceAll('_', ' ')}`
    case 'skip':
      return `Skipped — ${(action.reason || 'unsupported').replaceAll('_', ' ')}`
  }
}

const StatusPill = ({
  tone,
  children,
}: {
  tone: 'good' | 'warn' | 'muted'
  children: ReactNode
}) => (
  <span
    className={
      tone === 'good'
        ? 'inline-flex items-center gap-1.5 border border-success/40 bg-success-soft px-2 py-1 text-xs text-success'
        : tone === 'warn'
          ? 'inline-flex items-center gap-1.5 border border-error/40 bg-error-soft px-2 py-1 text-xs text-error'
          : 'inline-flex items-center gap-1.5 border border-border bg-surface-2 px-2 py-1 text-xs text-muted-foreground'
    }
  >
    {children}
  </span>
)

const SettingRow = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,1.2fr)] sm:gap-5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-sm tabular-nums">{children}</dd>
  </div>
)

const SettingsCard = ({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) => (
  <Card type="primary" size="md" className="min-w-0">
    <div className="mb-2">
      <h3 className="text-base font-medium">{title}</h3>
      {description && (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
    </div>
    <dl>{children}</dl>
  </Card>
)

const Hash = ({ value }: { value: string | undefined }) =>
  value ? (
    <CopyableText
      text={value}
      truncate
      truncateEnds={[10, 8]}
      alwaysShowCopyIcon
    />
  ) : (
    <>—</>
  )

const ContractAddress = ({ value }: { value: string | undefined }) => {
  const address = realAddress(value)
  if (!address) return <>Not configured</>
  const explorer = getTargetChainConfig().blockExplorers?.default.url
  const explorerIsUseful = explorer && !explorer.includes('localhost')

  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <Address
        address={address}
        displayMode="truncated"
        showEns={false}
        link={false}
        showCopyIcon
      />
      {explorerIsUseful && (
        <a
          href={`${explorer}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${address} in the block explorer`}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </span>
  )
}

const ParameterCards = ({
  params,
  fallback,
}: {
  params: InstanceParamsJson | undefined
  fallback: ReturnType<typeof useNetwork>['network']
}) => {
  const scale = params?.precisionScale
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SettingsCard
        title="PageRank computation"
        description="The exact creation-time tuple committed by the factory. Fixed-point values are shown as decimals; expand the raw tuple below for audit use."
      >
        <SettingRow label="Damping factor">
          {params ? ratio(params.dampingFp, scale) : 'Unavailable'}
        </SettingRow>
        <SettingRow label="Convergence tolerance">
          {params ? ratio(params.toleranceFp, scale) : 'Unavailable'}
        </SettingRow>
        <SettingRow label="Maximum iterations">
          {params?.maxIterations ?? 'Unavailable'}
        </SettingRow>
        <SettingRow label="Minimum edge weight">
          {params
            ? ratio(params.minWeightFp, scale)
            : fallback.pagerank.minWeight}
        </SettingRow>
        <SettingRow label="Maximum edge weight">
          {params
            ? ratio(params.maxWeightFp, scale)
            : fallback.pagerank.maxWeight}
        </SettingRow>
        <SettingRow label="Total points pool">
          {params?.totalPool ?? String(fallback.pagerank.pointsPool)}
        </SettingRow>
        <SettingRow label="Precision scale">
          {params?.precisionScale ?? 'Unavailable'}
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Trust weighting"
        description="Controls how direct endorsements and inherited trust contribute to each score."
      >
        <SettingRow label="Trust multiplier">
          {params
            ? ratio(params.trustMultiplierFp, scale)
            : fallback.pagerank.trustMultiplier}
        </SettingRow>
        <SettingRow label="Trust share">
          {params
            ? ratio(params.trustShareFp, scale)
            : fallback.pagerank.trustShare}
        </SettingRow>
        <SettingRow label="Trust decay">
          {params
            ? ratio(params.trustDecayFp, scale)
            : fallback.pagerank.trustDecay}
        </SettingRow>
        <SettingRow label="Weight field index">
          {params?.weightFieldIndex ?? 'Unavailable'}
        </SettingRow>
        <SettingRow label="Lane-2 maximum head age">
          {params ? duration(BigInt(params.lane2MaxHeadAge)) : 'Disabled'}
        </SettingRow>
        <SettingRow label="Parameter chain ID">
          {params?.chainId ?? 'Unavailable'}
        </SettingRow>
        <SettingRow label="Parameter accumulator">
          <ContractAddress value={params?.accumulator} />
        </SettingRow>
      </SettingsCard>
    </div>
  )
}

export const SettingsPage = ({
  instance,
}: {
  instance: InstanceRow | null
}) => {
  const {
    network,
    gnosisSafe,
    merkleRoot,
    ipfsHashCid,
    timestamp: rootTimestamp,
  } = useNetwork()
  const instanceId = network.instanceId ?? instance?.id ?? ''
  const snapshotAddress = network.contracts.merkleSnapshot
  const resolverAddress = network.contracts.easIndexerResolver
  const distributorAddress = realAddress(
    network.contracts.merkleFundDistributor
  )
  const governanceAddress = realAddress(network.contracts.merkleGovModule)
  const factoryAddress =
    realAddress(instance?.factory) ||
    realAddress(CONTRACT_CONFIG.TrustGraphFactory as string)

  const { data: factoryVault } = useReadContract({
    address: factoryAddress as Hex,
    abi: trustGraphFactoryAbi,
    functionName: 'VAULT',
    query: { enabled: !!factoryAddress },
  })
  const vaultAddress =
    realAddress(PROVING_VAULT) ||
    realAddress(factoryVault as string | undefined)

  const { data: snapshotReads, isLoading: snapshotLoading } = useReadContracts({
    contracts: [
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'paramsHash',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'zkVerifier',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'accumulator',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'anchorRegistry',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'epochLength',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'lastTriggerBlock',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'lastAppliedCheckpoint',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'hasAppliedCheckpoint',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'getHooks',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'getStateCount',
      },
      {
        address: snapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'getLatestState',
      },
    ],
    query: { refetchInterval: 30_000 },
  })

  const liveParamsHash = asString(readResult(snapshotReads, 0))
  const zkVerifier = asString(readResult(snapshotReads, 1))
  const liveAccumulator = asString(readResult(snapshotReads, 2))
  const anchorRegistry = realAddress(asString(readResult(snapshotReads, 3)))
  const epochLength = asBigInt(readResult(snapshotReads, 4))
  const lastTriggerBlock = asBigInt(readResult(snapshotReads, 5))
  const lastAppliedCheckpoint = asBigInt(readResult(snapshotReads, 6))
  const hasAppliedCheckpoint = asBoolean(readResult(snapshotReads, 7))
  const hooks = (readResult(snapshotReads, 8) as string[] | undefined) ?? []
  const stateCount = asBigInt(readResult(snapshotReads, 9))
  const latestState = readResult(snapshotReads, 10)

  const { data: resolverReads } = useReadContracts({
    contracts: [
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'acc',
      },
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'leafCount',
      },
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'checkpointCount',
      },
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'snapshot',
      },
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'boundSchema',
      },
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'version',
      },
      {
        address: resolverAddress,
        abi: easIndexerResolverAbi,
        functionName: 'binder',
      },
    ],
    query: { refetchInterval: 30_000 },
  })
  const liveAcc = asString(readResult(resolverReads, 0))
  const leafCount = asBigInt(readResult(resolverReads, 1)) ?? 0n
  const checkpointCount = asBigInt(readResult(resolverReads, 2))
  const resolverSnapshot = asString(readResult(resolverReads, 3))
  const boundSchema = asString(readResult(resolverReads, 4))
  const resolverVersion = asString(readResult(resolverReads, 5))
  const resolverBinder = asString(readResult(resolverReads, 6))

  const { data: anchorReads } = useReadContracts({
    contracts: anchorRegistry
      ? [
          {
            address: anchorRegistry,
            abi: anchorRegistryAbi,
            functionName: 'anchorAcc',
          },
          {
            address: anchorRegistry,
            abi: anchorRegistryAbi,
            functionName: 'anchorCount',
          },
        ]
      : [],
    query: { enabled: !!anchorRegistry, refetchInterval: 30_000 },
  })
  const anchorAcc = asString(readResult(anchorReads, 0))
  const anchorCount = asBigInt(readResult(anchorReads, 1)) ?? 0n

  const { data: vaultReads, isLoading: vaultLoading } = useReadContracts({
    contracts:
      vaultAddress && instanceId
        ? [
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'accountOf',
              args: [instanceId as Hex],
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'policyOf',
              args: [instanceId as Hex],
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'pendingWithdrawalOf',
              args: [instanceId as Hex],
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'quote',
              args: [instanceId as Hex, leafCount, anchorCount],
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'bandOf',
              args: [TRUST_GRAPH_PROGRAM, leafCount, anchorCount],
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'REGISTRY',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'USDC',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'ETH_USD_FEED',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'FEED_MAX_STALENESS',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'MIN_ETH_USD',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'MAX_ETH_USD',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'MAX_PRICED_INPUTS',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'maxGasUnitsPerClaim',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'nominalGasUnits',
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'withdrawalNotice',
            },
          ]
        : [],
    query: {
      enabled: !!vaultAddress && !!instanceId,
      refetchInterval: 30_000,
    },
  })

  const vaultAccount = readResult(vaultReads, 0)
  const vaultPolicy = readResult(vaultReads, 1)
  const pendingWithdrawal = readResult(vaultReads, 2)
  const liveQuote = readResult(vaultReads, 3)
  const sizeBand = asNumber(readResult(vaultReads, 4))
  const registryAddress = asString(readResult(vaultReads, 5))
  const usdcAddress = realAddress(asString(readResult(vaultReads, 6)))
  const feedAddress = realAddress(asString(readResult(vaultReads, 7)))
  const feedMaxStaleness = asBigInt(readResult(vaultReads, 8))
  const minEthUsd = asBigInt(readResult(vaultReads, 9))
  const maxEthUsd = asBigInt(readResult(vaultReads, 10))
  const maxPricedInputs = asBigInt(readResult(vaultReads, 11))
  const maxGasUnits = asBigInt(readResult(vaultReads, 12))
  const nominalGasUnits = asBigInt(readResult(vaultReads, 13))
  const withdrawalNotice = asBigInt(readResult(vaultReads, 14))

  const { data: feeRead } = useReadContract({
    address: vaultAddress as Hex,
    abi: provingVaultReadAbi,
    functionName: 'feePerRootUsd',
    args: [TRUST_GRAPH_PROGRAM, sizeBand ?? 0],
    query: { enabled: !!vaultAddress && sizeBand !== undefined },
  })
  const feePerRoot = feeRead as bigint | undefined

  const { data: moneyReads } = useReadContracts({
    contracts: [
      ...(feedAddress
        ? [
            {
              address: feedAddress,
              abi: priceFeedReadAbi,
              functionName: 'decimals' as const,
            },
            {
              address: feedAddress,
              abi: priceFeedReadAbi,
              functionName: 'latestRoundData' as const,
            },
          ]
        : []),
      ...(usdcAddress
        ? [
            {
              address: usdcAddress,
              abi: erc20MetadataReadAbi,
              functionName: 'symbol' as const,
            },
            {
              address: usdcAddress,
              abi: erc20MetadataReadAbi,
              functionName: 'decimals' as const,
            },
          ]
        : []),
    ],
    query: { enabled: !!feedAddress || !!usdcAddress, refetchInterval: 30_000 },
  })
  const feedOffset = 0
  const tokenOffset = feedAddress ? 2 : 0
  const feedDecimals = feedAddress
    ? asNumber(readResult(moneyReads, feedOffset))
    : undefined
  const feedRound = feedAddress
    ? readResult(moneyReads, feedOffset + 1)
    : undefined
  const tokenSymbol = usdcAddress
    ? (asString(readResult(moneyReads, tokenOffset)) ?? 'USDC')
    : 'USDC'
  const tokenDecimals = usdcAddress
    ? (asNumber(readResult(moneyReads, tokenOffset + 1)) ?? 6)
    : 6

  const feedAnswer = asBigInt(tupleValue(feedRound, 'answer', 1))
  const feedUpdatedAt = asBigInt(tupleValue(feedRound, 'updatedAt', 3))
  const now = BigInt(Math.floor(Date.now() / 1_000))
  const feedFresh =
    feedAnswer !== undefined &&
    feedAnswer > 0n &&
    feedUpdatedAt !== undefined &&
    feedUpdatedAt > 0n &&
    feedUpdatedAt <= now &&
    feedMaxStaleness !== undefined &&
    now - feedUpdatedAt <= feedMaxStaleness &&
    minEthUsd !== undefined &&
    maxEthUsd !== undefined &&
    feedAnswer >= minEthUsd &&
    feedAnswer <= maxEthUsd &&
    feedDecimals === 8

  const ethBalance = asBigInt(tupleValue(vaultAccount, 'ethBalance', 2))
  const usdcBalance = asBigInt(tupleValue(vaultAccount, 'usdcBalance', 3))
  const accountSnapshot = asString(tupleValue(vaultAccount, 'snapshot', 0))
  const accountProgram = asString(tupleValue(vaultAccount, 'program', 1))
  const policyMinInterval = asBigInt(
    tupleValue(vaultPolicy, 'minPaidIntervalBlocks', 0)
  )
  const policyMaxPerRoot = asBigInt(tupleValue(vaultPolicy, 'maxPerRootUsd', 1))
  const policyLastPaidBlock = asBigInt(
    tupleValue(vaultPolicy, 'lastPaidBlock', 2)
  )
  const pendingEth = asBigInt(tupleValue(pendingWithdrawal, 'ethAmount', 0))
  const pendingUsdc = asBigInt(tupleValue(pendingWithdrawal, 'usdcAmount', 1))
  const pendingReadyAt = asBigInt(tupleValue(pendingWithdrawal, 'readyAt', 2))
  const quoteFee = asBigInt(tupleValue(liveQuote, 'feeUsd', 0))
  const quoteGas = asBigInt(tupleValue(liveQuote, 'gasUsd', 1))
  const quotePayable = asBigInt(tupleValue(liveQuote, 'payableUsd', 2))
  const quoteEligible = asBoolean(tupleValue(liveQuote, 'eligible', 3))
  const quoteReason = asNumber(tupleValue(liveQuote, 'reason', 4))

  const { data: tankData, isLoading: tankLoading } = useQuery(
    ponderQueries.provingTank(instanceId)
  )
  const tank = tankData?.funded ? tankData : null
  const { data: operatorStatus, isLoading: operatorLoading } = useQuery(
    operatorStatusQuery(instanceId)
  )

  const heartbeatAge =
    operatorStatus?.available && operatorStatus.tickAt
      ? Math.max(0, Math.floor(Date.now() / 1_000) - operatorStatus.tickAt)
      : null
  const expectedTick =
    operatorStatus?.available && operatorStatus.settings?.tickSeconds
      ? operatorStatus.settings.tickSeconds
      : 60
  const heartbeatFresh =
    heartbeatAge !== null && heartbeatAge <= Math.max(120, expectedTick * 3)
  const watched = operatorStatus?.available ? operatorStatus.instance : null
  const serviceMode = watched?.curated
    ? 'Curated'
    : operatorStatus?.available && operatorStatus.settings?.paidEnabled
      ? 'Community-funded'
      : operatorStatus?.available && watched
        ? 'Operator-funded'
        : tank
          ? 'Community-funded'
          : 'Unknown'

  let balanceUsd: bigint | undefined
  if (usdcBalance !== undefined) {
    balanceUsd = (usdcBalance * 10n ** 8n) / 10n ** BigInt(tokenDecimals)
    if (ethBalance && ethBalance > 0n) {
      balanceUsd = feedFresh
        ? balanceUsd + (ethBalance * feedAnswer!) / 10n ** 18n
        : undefined
    }
  }
  const burnSpentUsd = tank?.burn?.spentUsd
    ? BigInt(tank.burn.spentUsd)
    : undefined
  const runwaySeconds =
    balanceUsd !== undefined &&
    burnSpentUsd !== undefined &&
    burnSpentUsd > 0n &&
    tank
      ? (balanceUsd * BigInt(tank.burn.windowSeconds)) / burnSpentUsd
      : undefined

  const { data: distributorReads } = useReadContracts({
    contracts: distributorAddress
      ? [
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'owner',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'pendingOwner',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'feeRecipient',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'feePercentage',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'allowlistEnabled',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'paused',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'merkleSnapshot',
          },
          {
            address: distributorAddress,
            abi: merkleFundDistributorAbi,
            functionName: 'getAllowlistLength',
          },
        ]
      : [],
    query: { enabled: !!distributorAddress },
  })

  const { data: governanceReads } = useReadContracts({
    contracts: governanceAddress
      ? [
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'owner',
          },
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'avatar',
          },
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'target',
          },
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'merkleSnapshotContract',
          },
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'votingDelay',
          },
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'votingPeriod',
          },
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'quorum',
          },
        ]
      : [],
    query: { enabled: !!governanceAddress },
  })

  const creationHash = instance?.paramsHash ?? network.paramsHash
  const paramsMatch =
    creationHash && liveParamsHash
      ? sameHex(creationHash, liveParamsHash)
      : null
  const nextTriggerBlock =
    epochLength !== undefined && lastTriggerBlock !== undefined
      ? lastTriggerBlock + epochLength
      : undefined
  const nextPaidBlock =
    policyLastPaidBlock !== undefined && policyMinInterval !== undefined
      ? policyLastPaidBlock + policyMinInterval
      : undefined
  const inputCount = leafCount + anchorCount

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <NetworkHeader network={network} />
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Read-only contract configuration, scoring parameters, and
          proof-service billing. Live values come directly from the chain;
          creation data and history come from the indexed factory catalog.
        </p>
      </div>

      <section className="space-y-5">
        <SectionHeading n="01">Proof service</SectionHeading>
        <div className="flex flex-wrap gap-4">
          <StatisticCard
            title="SERVICE MODE"
            tooltip="Curated networks are subsidized by the hosted operator. Community-funded networks draw from their own proving tank."
            value={operatorLoading || tankLoading ? '...' : serviceMode}
          />
          <StatisticCard
            title="OPERATOR HEARTBEAT"
            tooltip="Time since the proof scheduler last completed a decision pass. Unavailable means no safe heartbeat source was configured; it does not prove the operator is down."
            value={
              operatorLoading
                ? '...'
                : !operatorStatus?.available
                  ? 'Unavailable'
                  : heartbeatAge === null
                    ? 'Unknown'
                    : heartbeatFresh
                      ? `${duration(heartbeatAge)} ago`
                      : `Stale · ${duration(heartbeatAge)}`
            }
          />
          <StatisticCard
            title="CURRENT DECISION"
            tooltip="The action selected for this network during the latest operator tick."
            value={
              operatorLoading
                ? '...'
                : operatorStatus?.available && !watched
                  ? 'Not watched'
                  : actionLabel(watched?.action)
            }
          />
          <StatisticCard
            title="ESTIMATED RUNWAY"
            tooltip="Current tank value divided by settled USD spend over the last 30 days. Hidden when there is no spend history or the ETH/USD feed cannot safely value an ETH balance."
            value={
              runwaySeconds === undefined
                ? 'Not enough data'
                : duration(runwaySeconds)
            }
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard
            title="Scheduler health"
            description="A heartbeat is operational telemetry, not a trust assumption: every submitted proof is still verified on-chain."
          >
            <SettingRow label="Status">
              {!operatorStatus?.available ? (
                <StatusPill tone="muted">
                  <Radio className="h-3.5 w-3.5" /> Telemetry unavailable
                </StatusPill>
              ) : !watched ? (
                <StatusPill tone="muted">
                  Not watched by this operator
                </StatusPill>
              ) : heartbeatFresh ? (
                <StatusPill tone="good">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Alive
                </StatusPill>
              ) : (
                <StatusPill tone="warn">
                  <AlertTriangle className="h-3.5 w-3.5" /> Heartbeat stale
                </StatusPill>
              )}
            </SettingRow>
            <SettingRow label="Latest action">
              {actionLabel(watched?.action)}
            </SettingRow>
            <SettingRow label="Operator chain head">
              {operatorStatus?.available
                ? comma(operatorStatus.headBlock ?? undefined)
                : '—'}
            </SettingRow>
            <SettingRow label="Blocks since applied root">
              {watched?.blocksSinceRoot === null ||
              watched?.blocksSinceRoot === undefined
                ? '—'
                : comma(watched.blocksSinceRoot)}
            </SettingRow>
            <SettingRow label="Last tick">
              {operatorStatus?.available
                ? timestamp(operatorStatus.tickAt)
                : '—'}
            </SettingRow>
          </SettingsCard>

          <SettingsCard
            title="Public scheduler policy"
            description="Only non-sensitive policy is published. RPC and IPFS endpoints, keys, webhooks, local paths, alerts, and journal details remain private."
          >
            <SettingRow label="Tick interval">
              {duration(
                operatorStatus?.available
                  ? (operatorStatus.settings?.tickSeconds ?? undefined)
                  : undefined
              )}
            </SettingRow>
            <SettingRow label="Minimum subsidy cadence">
              {operatorStatus?.available
                ? `${comma(operatorStatus.settings?.subsidyMinBlocks ?? undefined)} blocks`
                : '—'}
            </SettingRow>
            <SettingRow label="Finality confirmations">
              {operatorStatus?.available
                ? comma(operatorStatus.settings?.confirmations ?? undefined)
                : '—'}
            </SettingRow>
            <SettingRow label="Pins checkpoint block hash">
              {operatorStatus?.available
                ? yesNo(operatorStatus.settings?.tracksBlockHash)
                : '—'}
            </SettingRow>
            <SettingRow label="Basefee ceiling">
              {operatorStatus?.available &&
              operatorStatus.settings?.maxBasefeeGwei !== null
                ? `${operatorStatus.settings?.maxBasefeeGwei ?? '—'} gwei`
                : '—'}
            </SettingRow>
            <SettingRow label="Replacement timeout">
              {operatorStatus?.available
                ? duration(
                    operatorStatus.settings?.replacementAfterSeconds ??
                      undefined
                  )
                : '—'}
            </SettingRow>
            <SettingRow label="Simulates before send">
              {operatorStatus?.available
                ? yesNo(operatorStatus.settings?.simulateBeforeSend)
                : '—'}
            </SettingRow>
            <SettingRow label="Proof concurrency">
              {operatorStatus?.available
                ? `${operatorStatus.settings?.maxConcurrent ?? '—'} global / ${operatorStatus.settings?.maxPerInstance ?? '—'} per network`
                : '—'}
            </SettingRow>
            <SettingRow label="Proof system">
              {operatorStatus?.available && operatorStatus.settings
                ? `${operatorStatus.settings.proverBackend ?? 'unknown'}${operatorStatus.settings.groth16 ? ' · Groth16' : ''}`
                : '—'}
            </SettingRow>
            <SettingRow label="Proof timeout">
              {operatorStatus?.available
                ? duration(
                    operatorStatus.settings?.proofTimeoutSeconds ?? undefined
                  )
                : '—'}
            </SettingRow>
            <SettingRow label="Paid scheduling enabled">
              {operatorStatus?.available
                ? yesNo(operatorStatus.settings?.paidEnabled)
                : '—'}
            </SettingRow>
            <SettingRow label="Configured paid vault">
              <ContractAddress
                value={
                  operatorStatus?.available
                    ? (operatorStatus.settings?.paidVault ?? undefined)
                    : undefined
                }
              />
            </SettingRow>
            <SettingRow label="Fee recipient">
              <ContractAddress
                value={
                  operatorStatus?.available
                    ? (operatorStatus.settings?.paidRecipient ?? undefined)
                    : undefined
                }
              />
            </SettingRow>
            <SettingRow label="Per-network loss budget">
              {operatorStatus?.available &&
              operatorStatus.settings?.perInstanceUsdPerDay !== null
                ? `$${operatorStatus.settings?.perInstanceUsdPerDay ?? '—'} / day`
                : '—'}
            </SettingRow>
            <SettingRow label="Global loss budget">
              {operatorStatus?.available &&
              operatorStatus.settings?.globalUsdPerDay !== null
                ? `$${operatorStatus.settings?.globalUsdPerDay ?? '—'} / day`
                : '—'}
            </SettingRow>
            <SettingRow label="Budget window">
              {operatorStatus?.available
                ? duration(
                    operatorStatus.settings?.budgetWindowSeconds ?? undefined
                  )
                : '—'}
            </SettingRow>
            <SettingRow label="Publishes score blobs">
              {operatorStatus?.available
                ? yesNo(operatorStatus.settings?.publishesScores)
                : '—'}
            </SettingRow>
            <SettingRow label="Verifies score readback">
              {operatorStatus?.available
                ? yesNo(operatorStatus.settings?.verifiesScoreReadback)
                : '—'}
            </SettingRow>
          </SettingsCard>
        </div>
      </section>

      <section className="space-y-5">
        <SectionHeading n="02">Proof billing</SectionHeading>
        {!instanceId ? (
          <Card
            type="accent"
            size="md"
            className="text-sm text-muted-foreground"
          >
            This legacy network has no factory instance ID, so it cannot have an
            instance-keyed proving tank. Contract settings remain visible below.
          </Card>
        ) : !vaultAddress ? (
          <Card
            type="accent"
            size="md"
            className="text-sm text-muted-foreground"
          >
            This deployment has no ProvingVault configured. The network may be
            curated or self-proved, but there is no on-chain billing account to
            inspect.
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsCard
              title="Tank balance"
              description="Live balances are read from the vault. ETH is valued only while the configured 8-decimal price feed is fresh and inside its safety band."
            >
              <SettingRow label="ETH balance">
                {units(ethBalance, 18, 5)} ETH
              </SettingRow>
              <SettingRow label={`${tokenSymbol} balance`}>
                {units(usdcBalance, tokenDecimals, 2)} {tokenSymbol}
              </SettingRow>
              <SettingRow label="Current tank value">
                {usd(balanceUsd)}
              </SettingRow>
              <SettingRow label="Lifetime deposited">
                {tank
                  ? `${units(BigInt(tank.totalDepositedEth), 18, 5)} ETH · ${units(BigInt(tank.totalDepositedUsdc), tokenDecimals, 2)} ${tokenSymbol}`
                  : 'No indexed deposits'}
              </SettingRow>
              <SettingRow label="Lifetime spent">
                {tank
                  ? `${units(BigInt(tank.totalSpentEth), 18, 5)} ETH · ${units(BigInt(tank.totalSpentUsdc), tokenDecimals, 2)} ${tokenSymbol}`
                  : 'No indexed claims'}
              </SettingRow>
              <SettingRow label="30-day paid roots">
                {tank ? comma(tank.burn.rootsInWindow) : '0'}
              </SettingRow>
              <SettingRow label="30-day settled spend">
                {burnSpentUsd === undefined ? '—' : usd(burnSpentUsd)}
              </SettingRow>
              <SettingRow label="Unpaid roots since last payment">
                {tank ? tank.unpaidRootsSinceLastPayment : '0'}
              </SettingRow>
            </SettingsCard>

            <SettingsCard
              title="Current quote and policy"
              description="The same preflight quote the operator checks before spending time on a proof. USD values use 8 decimal places on-chain."
            >
              <SettingRow label="Quote status">
                {vaultLoading ? (
                  <StatusPill tone="muted">Checking…</StatusPill>
                ) : quoteEligible ? (
                  <StatusPill tone="good">Eligible</StatusPill>
                ) : (
                  <StatusPill tone="warn">
                    {quoteReasons[quoteReason ?? -1] ??
                      `Reason ${quoteReason ?? 'unknown'}`}
                  </StatusPill>
                )}
              </SettingRow>
              <SettingRow label="Proving fee">{usd(quoteFee)}</SettingRow>
              <SettingRow label="Gas reimbursement quote">
                {usd(quoteGas)}
              </SettingRow>
              <SettingRow label="Currently payable">
                {usd(quotePayable)}
              </SettingRow>
              <SettingRow label="Size band">
                {sizeBand === undefined
                  ? '—'
                  : sizeBand === 0
                    ? 'Unpriced'
                    : `Band ${sizeBand}`}
              </SettingRow>
              <SettingRow label="Published fee for this band">
                {usd(feePerRoot)}
              </SettingRow>
              <SettingRow label="Per-root cap">
                {usd(policyMaxPerRoot)}
              </SettingRow>
              <SettingRow label="Minimum paid interval">
                {policyMinInterval === undefined
                  ? '—'
                  : `${comma(policyMinInterval)} blocks`}
              </SettingRow>
              <SettingRow label="Next payable block">
                {policyLastPaidBlock === 0n
                  ? 'Any eligible block'
                  : comma(nextPaidBlock)}
              </SettingRow>
              <SettingRow label="Last payment">
                {tank?.lastPaidAt ? timestamp(tank.lastPaidAt) : 'Never'}
              </SettingRow>
            </SettingsCard>

            <SettingsCard
              title="Price and reimbursement safeguards"
              description="Global vault controls limit what a malicious hook, stale price, or oversized instance can draw."
            >
              <SettingRow label="ETH/USD feed">
                <ContractAddress value={feedAddress} />
              </SettingRow>
              <SettingRow label="Feed status">
                {feedFresh ? (
                  <StatusPill tone="good">Fresh and in range</StatusPill>
                ) : (
                  <StatusPill tone="warn">
                    Unavailable, stale, or out of range
                  </StatusPill>
                )}
              </SettingRow>
              <SettingRow label="ETH/USD answer">
                {feedAnswer === undefined ? '—' : usd(feedAnswer)}
              </SettingRow>
              <SettingRow label="Feed updated">
                {timestamp(feedUpdatedAt)}
              </SettingRow>
              <SettingRow label="Maximum feed age">
                {duration(feedMaxStaleness)}
              </SettingRow>
              <SettingRow label="Accepted ETH/USD range">
                {minEthUsd === undefined || maxEthUsd === undefined
                  ? '—'
                  : `${usd(minEthUsd)} – ${usd(maxEthUsd)}`}
              </SettingRow>
              <SettingRow label="Nominal quoted gas">
                {comma(nominalGasUnits)}
              </SettingRow>
              <SettingRow label="Maximum reimbursable gas">
                {comma(maxGasUnits)}
              </SettingRow>
              <SettingRow label="Maximum priced inputs">
                {comma(maxPricedInputs)}
              </SettingRow>
            </SettingsCard>

            <SettingsCard
              title="Account binding and withdrawal"
              description="The tank binds to one snapshot at first deposit. Withdrawals have notice, while the funds remain available for proofs until execution."
            >
              <SettingRow label="Bound snapshot">
                <ContractAddress value={accountSnapshot} />
              </SettingRow>
              <SettingRow label="Snapshot binding matches">
                {accountSnapshot && accountSnapshot !== zeroAddress
                  ? yesNo(sameHex(accountSnapshot, snapshotAddress))
                  : 'Not funded'}
              </SettingRow>
              <SettingRow label="Bound program">
                <Hash value={accountProgram} />
              </SettingRow>
              <SettingRow label="Withdrawal notice">
                {duration(withdrawalNotice)}
              </SettingRow>
              <SettingRow label="Pending ETH withdrawal">
                {units(pendingEth, 18, 5)} ETH
              </SettingRow>
              <SettingRow label={`Pending ${tokenSymbol} withdrawal`}>
                {units(pendingUsdc, tokenDecimals, 2)} {tokenSymbol}
              </SettingRow>
              <SettingRow label="Withdrawal ready">
                {pendingReadyAt && pendingReadyAt > 0n
                  ? timestamp(pendingReadyAt)
                  : 'None'}
              </SettingRow>
              <SettingRow label="Vault contract">
                <ContractAddress value={vaultAddress} />
              </SettingRow>
              <SettingRow label="Instance registry">
                <ContractAddress value={registryAddress} />
              </SettingRow>
              <SettingRow label={`${tokenSymbol} contract`}>
                <ContractAddress value={usdcAddress} />
              </SettingRow>
            </SettingsCard>
          </div>
        )}
      </section>

      <section className="space-y-5">
        <SectionHeading n="03">Scoring parameters</SectionHeading>
        <div className="flex flex-wrap items-center gap-3">
          {snapshotLoading ? (
            <StatusPill tone="muted">Checking parameter hash…</StatusPill>
          ) : paramsMatch === true ? (
            <StatusPill tone="good">
              <CheckCircle2 className="h-3.5 w-3.5" /> Creation tuple matches
              live hash
            </StatusPill>
          ) : paramsMatch === false ? (
            <StatusPill tone="warn">
              <AlertTriangle className="h-3.5 w-3.5" /> Live parameter hash has
              changed
            </StatusPill>
          ) : (
            <StatusPill tone="muted">
              Full creation tuple unavailable
            </StatusPill>
          )}
          <span className="text-xs text-muted-foreground">
            A hash mismatch means the complete live tuple was not published by
            the factory event; the values below are labeled creation-time rather
            than presented as current.
          </span>
        </div>

        <ParameterCards params={instance?.params} fallback={network} />

        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard title="Trusted seeds">
            {(
              instance?.params.trustedSeeds ?? network.pagerank.trustedSeeds
            ).map((seed, index) => (
              <SettingRow key={seed} label={`Seed ${index + 1}`}>
                <Address address={seed} displayMode="truncated" />
              </SettingRow>
            ))}
          </SettingsCard>
          <SettingsCard title="Lane-2 domains">
            {instance?.params.envelope0DomainSeparators.length ? (
              instance.params.envelope0DomainSeparators.map((domain, index) => (
                <SettingRow key={domain} label={`Domain ${index + 1}`}>
                  <Hash value={domain} />
                </SettingRow>
              ))
            ) : (
              <SettingRow label="Status">Disabled</SettingRow>
            )}
          </SettingsCard>
        </div>

        <details className="border border-border bg-surface px-5 py-4">
          <summary className="cursor-pointer text-sm font-medium">
            Show exact parameter tuple
          </summary>
          <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-muted-foreground">
            {instance?.params
              ? JSON.stringify(instance.params, null, 2)
              : 'The complete factory parameter tuple is unavailable for this network.'}
          </pre>
        </details>
      </section>

      <section className="space-y-5">
        <SectionHeading n="04">Proof and input contracts</SectionHeading>
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard title="Snapshot lifecycle">
            <SettingRow label="Live parameter hash">
              <Hash value={liveParamsHash} />
            </SettingRow>
            <SettingRow label="Creation parameter hash">
              <Hash value={creationHash} />
            </SettingRow>
            <SettingRow label="Epoch length">
              {epochLength === undefined ? '—' : `${comma(epochLength)} blocks`}
            </SettingRow>
            <SettingRow label="Last trigger block">
              {comma(lastTriggerBlock)}
            </SettingRow>
            <SettingRow label="Next trigger boundary">
              {comma(nextTriggerBlock)}
            </SettingRow>
            <SettingRow label="Last applied checkpoint">
              {hasAppliedCheckpoint ? comma(lastAppliedCheckpoint) : 'None'}
            </SettingRow>
            <SettingRow label="Merkle state count">
              {comma(stateCount)}
            </SettingRow>
            <SettingRow label="Latest root">
              <Hash
                value={
                  asString(tupleValue(latestState, 'root', 2)) ?? merkleRoot
                }
              />
            </SettingRow>
            <SettingRow label="Latest root timestamp">
              {timestamp(
                asBigInt(tupleValue(latestState, 'timestamp', 1)) ??
                  rootTimestamp
              )}
            </SettingRow>
            <SettingRow label="Latest score CID">
              {asString(tupleValue(latestState, 'ipfsHashCid', 4)) ||
                ipfsHashCid ||
                '—'}
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Attestation accumulator">
            <SettingRow label="Live leaf count">{comma(leafCount)}</SettingRow>
            <SettingRow label="Checkpoint count">
              {comma(checkpointCount)}
            </SettingRow>
            <SettingRow label="Live accumulator">
              <Hash value={liveAcc} />
            </SettingRow>
            <SettingRow label="Bound schema">
              <Hash value={boundSchema} />
            </SettingRow>
            <SettingRow label="Snapshot binding">
              <ContractAddress value={resolverSnapshot} />
            </SettingRow>
            <SettingRow label="Binding matches">
              {resolverSnapshot
                ? yesNo(sameHex(resolverSnapshot, snapshotAddress))
                : '—'}
            </SettingRow>
            <SettingRow label="Resolver version">
              {resolverVersion ?? '—'}
            </SettingRow>
            <SettingRow label="Original binder">
              <ContractAddress value={resolverBinder} />
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Lane-2 anchor input">
            <SettingRow label="Anchor registry">
              <ContractAddress value={anchorRegistry} />
            </SettingRow>
            <SettingRow label="Anchor count">{comma(anchorCount)}</SettingRow>
            <SettingRow label="Anchor accumulator">
              <Hash value={anchorAcc} />
            </SettingRow>
            <SettingRow label="Combined proof inputs">
              {comma(inputCount)}
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Verifier and hooks">
            <SettingRow label="ZK verifier">
              <ContractAddress value={zkVerifier} />
            </SettingRow>
            <SettingRow label="Snapshot accumulator">
              <ContractAddress value={liveAccumulator} />
            </SettingRow>
            <SettingRow label="Configured resolver">
              <ContractAddress value={resolverAddress} />
            </SettingRow>
            <SettingRow label="Hook count">{hooks.length}</SettingRow>
            {hooks.map((hook, index) => (
              <SettingRow key={hook} label={`Hook ${index + 1}`}>
                <ContractAddress value={hook} />
              </SettingRow>
            ))}
          </SettingsCard>
        </div>
      </section>

      <section className="space-y-5">
        <SectionHeading n="05">Contracts and authority</SectionHeading>
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard title="Core contracts">
            <SettingRow label="Merkle snapshot">
              <ContractAddress value={snapshotAddress} />
            </SettingRow>
            <SettingRow label="EAS resolver / accumulator">
              <ContractAddress value={resolverAddress} />
            </SettingRow>
            <SettingRow label="EAS">
              <ContractAddress value={CONTRACT_CONFIG.EAS as string} />
            </SettingRow>
            <SettingRow label="Schema registry">
              <ContractAddress
                value={CONTRACT_CONFIG.SchemaRegistry as string}
              />
            </SettingRow>
            <SettingRow label="Schema registrar">
              <ContractAddress
                value={CONTRACT_CONFIG.SchemaRegistrar as string}
              />
            </SettingRow>
            <SettingRow label="Factory">
              <ContractAddress value={factoryAddress} />
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Instance provenance">
            <SettingRow label="Instance ID">
              <Hash value={instanceId || undefined} />
            </SettingRow>
            <SettingRow label="Chain ID">{instance?.chainId ?? '—'}</SettingRow>
            <SettingRow label="Creator">
              {instance?.creator || network.admin ? (
                <Address
                  address={(instance?.creator ?? network.admin)!}
                  displayMode="truncated"
                />
              ) : (
                '—'
              )}
            </SettingRow>
            <SettingRow label="Initial admin">
              {network.admin ? (
                <Address address={network.admin} displayMode="truncated" />
              ) : (
                '—'
              )}
            </SettingRow>
            <SettingRow label="Created block">
              {comma(instance?.createdBlock)}
            </SettingRow>
            <SettingRow label="Created at">
              {timestamp(
                instance?.createdTimestamp ?? network.createdTimestamp
              )}
            </SettingRow>
            <SettingRow label="Creation transaction">
              <Hash value={instance?.createdTxHash} />
            </SettingRow>
            <SettingRow label="Metadata URI">
              {instance?.metadataURI || 'Not published'}
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Vouch schema">
            {network.schemas.map((schema) => (
              <div key={schema.uid}>
                <SettingRow label="Schema UID">
                  <Hash value={schema.uid} />
                </SettingRow>
                <SettingRow label="Schema">{schema.schema}</SettingRow>
                <SettingRow label="Resolver">
                  <ContractAddress value={schema.resolver} />
                </SettingRow>
                <SettingRow label="Revocable">
                  {yesNo(schema.revocable)}
                </SettingRow>
                {schema.fields.map((field) => (
                  <SettingRow
                    key={`${field.type}-${field.name}`}
                    label={field.name}
                  >
                    <code className="text-xs">{field.type}</code>
                  </SettingRow>
                ))}
              </div>
            ))}
          </SettingsCard>

          <SettingsCard title="Safe and signer synchronization">
            <SettingRow label="Safe proxy">
              <ContractAddress value={network.contracts.safe?.proxy} />
            </SettingRow>
            <SettingRow label="Safe singleton">
              <ContractAddress value={network.contracts.safe?.singleton} />
            </SettingRow>
            <SettingRow label="Safe factory">
              <ContractAddress value={network.contracts.safe?.factory} />
            </SettingRow>
            <SettingRow label="Signer-sync manager">
              <ContractAddress
                value={network.contracts.safe?.signerSyncManager}
              />
            </SettingRow>
            <SettingRow label="Signer sync enabled">
              {yesNo(network.safeZodiacSignerSync.enabled)}
            </SettingRow>
            <SettingRow label="Top signers">
              {network.safeZodiacSignerSync.topNSigners}
            </SettingRow>
            <SettingRow label="Safe threshold">
              {gnosisSafe
                ? `${gnosisSafe.threshold} of ${gnosisSafe.owners.length}`
                : '—'}
            </SettingRow>
          </SettingsCard>

          {distributorAddress && (
            <SettingsCard title="Fund distributor">
              <SettingRow label="Contract">
                <ContractAddress value={distributorAddress} />
              </SettingRow>
              <SettingRow label="Owner">
                <ContractAddress
                  value={asString(readResult(distributorReads, 0))}
                />
              </SettingRow>
              <SettingRow label="Pending owner">
                <ContractAddress
                  value={asString(readResult(distributorReads, 1))}
                />
              </SettingRow>
              <SettingRow label="Fee recipient">
                <ContractAddress
                  value={asString(readResult(distributorReads, 2))}
                />
              </SettingRow>
              <SettingRow label="Fee percentage">
                {(() => {
                  const value = asBigInt(readResult(distributorReads, 3))
                  return value === undefined
                    ? '—'
                    : `${units(value * 100n, 18, 4)}%`
                })()}
              </SettingRow>
              <SettingRow label="Allowlist enabled">
                {yesNo(asBoolean(readResult(distributorReads, 4)))}
              </SettingRow>
              <SettingRow label="Paused">
                {yesNo(asBoolean(readResult(distributorReads, 5)))}
              </SettingRow>
              <SettingRow label="Snapshot binding">
                <ContractAddress
                  value={asString(readResult(distributorReads, 6))}
                />
              </SettingRow>
              <SettingRow label="Allowlisted distributors">
                {comma(asBigInt(readResult(distributorReads, 7)))}
              </SettingRow>
              <SettingRow label="Default token">
                <ContractAddress
                  value={instance?.distributorToken ?? undefined}
                />
              </SettingRow>
            </SettingsCard>
          )}

          {governanceAddress && (
            <SettingsCard title="Governance module">
              <SettingRow label="Contract">
                <ContractAddress value={governanceAddress} />
              </SettingRow>
              <SettingRow label="Owner">
                <ContractAddress
                  value={asString(readResult(governanceReads, 0))}
                />
              </SettingRow>
              <SettingRow label="Avatar (Safe)">
                <ContractAddress
                  value={asString(readResult(governanceReads, 1))}
                />
              </SettingRow>
              <SettingRow label="Execution target">
                <ContractAddress
                  value={asString(readResult(governanceReads, 2))}
                />
              </SettingRow>
              <SettingRow label="Snapshot binding">
                <ContractAddress
                  value={asString(readResult(governanceReads, 3))}
                />
              </SettingRow>
              <SettingRow label="Voting delay">
                {comma(asBigInt(readResult(governanceReads, 4)))} blocks
              </SettingRow>
              <SettingRow label="Voting period">
                {comma(asBigInt(readResult(governanceReads, 5)))} blocks
              </SettingRow>
              <SettingRow label="Quorum">
                {(() => {
                  const value = asBigInt(readResult(governanceReads, 6))
                  return value === undefined
                    ? '—'
                    : `${units(value * 100n, 18, 2)}%`
                })()}
              </SettingRow>
            </SettingsCard>
          )}
        </div>
      </section>

      {tank &&
        ((tank.recentDeposits?.length ?? 0) > 0 ||
          (tank.recentClaims?.length ?? 0) > 0) && (
          <section className="space-y-5">
            <SectionHeading n="06">Recent billing activity</SectionHeading>
            <div className="grid gap-4 lg:grid-cols-2">
              <SettingsCard title="Deposits">
                {(tank.recentDeposits ?? []).map((deposit) => (
                  <SettingRow
                    key={deposit.id}
                    label={`${timestamp(deposit.timestamp)} · block ${deposit.blockNumber}`}
                  >
                    <div className="space-y-1">
                      <div>
                        {deposit.token.toLowerCase() === zeroAddress
                          ? `${units(BigInt(deposit.amount), 18, 5)} ETH`
                          : `${units(BigInt(deposit.amount), tokenDecimals, 2)} ${tokenSymbol}`}
                      </div>
                      <Address address={deposit.from} displayMode="truncated" />
                    </div>
                  </SettingRow>
                ))}
              </SettingsCard>

              <SettingsCard title="Proof payments">
                {(tank.recentClaims ?? []).map((claim) => (
                  <SettingRow
                    key={claim.id}
                    label={`${timestamp(claim.timestamp)} · checkpoint ${claim.checkpointId}`}
                  >
                    <div className="space-y-1">
                      {claim.skipped ? (
                        <StatusPill tone="warn">
                          {claimReasons[claim.reason] ??
                            `Skipped reason ${claim.reason}`}
                        </StatusPill>
                      ) : (
                        <>
                          <div>
                            {usd(BigInt(claim.feeUsd) + BigInt(claim.gasUsd))}
                          </div>
                          {claim.recipient && (
                            <div className="text-xs text-muted-foreground">
                              Paid to{' '}
                              <Address
                                address={claim.recipient}
                                displayMode="truncated"
                                textClassName="text-xs"
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </SettingRow>
                ))}
              </SettingsCard>
            </div>
          </section>
        )}

      <p className="flex items-center gap-2 border-t border-border pt-5 text-xs text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" /> This first version is intentionally
        read-only. Funding, policy, and withdrawal controls can be added here
        later without changing the information architecture.
      </p>
    </div>
  )
}
