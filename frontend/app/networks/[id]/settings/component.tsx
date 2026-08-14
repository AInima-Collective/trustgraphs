'use client'

import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Radio,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useMemo, useState } from 'react'
import {
  type Hex,
  erc20Abi,
  formatUnits,
  keccak256,
  parseEther,
  parseUnits,
  stringToBytes,
  zeroAddress,
} from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from 'wagmi'

import { Address } from '@/components/Address'
import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { InfoTooltip } from '@/components/InfoTooltip'
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
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useNetwork } from '@/contexts/NetworkContext'
import type { InstanceRow } from '@/lib/catalog'
import { CONTRACT_CONFIG, PROVING_VAULT } from '@/lib/config'
import {
  anchorRegistryAbi,
  easIndexerResolverAbi,
  governedTrustgraphsFactoryAbi,
  merkleFundDistributorAbi,
  merkleGovModuleAbi,
  merkleSnapshotAbi,
  trustgraphsFactoryAbi,
} from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import { contributionsRoundsFor } from '@/lib/network-nav'
import {
  type PublicOperatorAction,
  operatorStatusQuery,
} from '@/lib/operator-status'
import {
  delayedRecoveryModuleReadAbi,
  erc20MetadataReadAbi,
  gnosisSafeAuthorityReadAbi,
  priceFeedReadAbi,
  provingVaultReadAbi,
  safeExecutionGuardReadAbi,
} from '@/lib/settings-contracts'
import { txToast } from '@/lib/tx'
import { cn, realAddress } from '@/lib/utils'
import { getTargetChainConfig } from '@/lib/wagmi'
import { ponderQueries } from '@/queries/ponder'

import { ScoringAccessCard, ScoringSettings } from './scoring'
import { SETTINGS_TABS, type SettingsTab } from './tabs'

const TRUSTGRAPH_PROGRAM = keccak256(stringToBytes('trust-graph'))
const CONSTITUTIONAL_ROLE = keccak256(stringToBytes('CONSTITUTIONAL_ROLE'))
const OPERATIONAL_ROLE = keccak256(stringToBytes('OPERATIONAL_ROLE'))
const SAFE_GUARD_STORAGE_SLOT =
  0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001' as Hex

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

const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? '—' : value ? 'Yes' : 'No'

const sameHex = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

const storageAddress = (value: unknown) => {
  const encoded = asString(value)
  if (!encoded || encoded.length < 42) return undefined
  return realAddress(`0x${encoded.slice(-40)}`)
}

const quoteReasons = [
  'Eligible',
  'No funded account',
  'Billing policy disabled',
  'Paid cadence has not elapsed',
  'Insufficient balance',
  'Program or size is not priced',
  'Withdrawal pending',
  'Checkpoint already paid',
  'Price feed unavailable',
]

const claimReasons = quoteReasons

const actionLabel = (action: PublicOperatorAction | null | undefined) => {
  if (!action) return 'No decision reported'
  const checkpoint =
    action.checkpointId === null ? '' : ` checkpoint ${action.checkpointId}`
  switch (action.action) {
    case 'idle':
      if (action.reason === 'publication_backoff') {
        return `Publication retry queued for${checkpoint} · attempt ${action.attempts ?? '—'} · ${timestamp(action.retryAt)}`
      }
      return action.reason
        ? `Idle — ${action.reason.replaceAll('_', ' ')}`
        : 'Idle'
    case 'trigger':
      return 'Freezing the next checkpoint'
    case 'await_finality':
      return `Waiting for checkpoint finality${checkpoint}`
    case 'prove':
      return `Requesting proof for${checkpoint}`
    case 'publish':
      return `Publishing scores for${checkpoint}`
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
        displayMode="auto"
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

const settingsHref = (networkId: string, tab: SettingsTab) =>
  tab === 'overview'
    ? `/networks/${networkId}/settings`
    : `/networks/${networkId}/settings?tab=${tab}`

const SettingsNavigation = ({
  networkId,
  activeTab,
}: {
  networkId: string
  activeTab: SettingsTab
}) => {
  const router = useRouter()

  return (
    <>
      <div className="space-y-2 lg:hidden">
        <Label htmlFor="settings-section">Settings section</Label>
        <Select
          value={activeTab}
          onValueChange={(value) =>
            router.push(settingsHref(networkId, value as SettingsTab))
          }
        >
          <SelectTrigger id="settings-section" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_TABS.map((tab) => (
              <SelectItem key={tab.id} value={tab.id}>
                {tab.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <aside className="hidden lg:block">
        <nav aria-label="Settings sections" className="sticky top-6 space-y-1">
          <p className="tg-label px-3 pb-2">Settings</p>
          {SETTINGS_TABS.map((tab) => (
            <Link
              key={tab.id}
              href={settingsHref(networkId, tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={cn(
                'block border-l-2 px-3 py-2.5 transition-colors',
                activeTab === tab.id
                  ? 'border-primary bg-surface-2 text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground'
              )}
            >
              <span className="block text-sm font-medium">{tab.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                {tab.description}
              </span>
            </Link>
          ))}
        </nav>
      </aside>
    </>
  )
}

const SettingsMetric = ({
  title,
  tooltip,
  value,
}: {
  title: string
  tooltip: string
  value: string
}) => (
  <Card type="primary" size="sm" className="min-w-0 border-0">
    <div className="flex items-center gap-2">
      <p className="tg-label truncate">{title}</p>
      <InfoTooltip title={tooltip} />
    </div>
    <p
      className="mt-1.5 truncate text-sm font-medium tabular-nums"
      title={value}
    >
      {value}
    </p>
  </Card>
)

const TopUpProofBalance = ({
  vaultAddress,
  instanceId,
  usdcAddress,
  tokenSymbol,
  tokenDecimals,
  bindingMismatch,
  onSuccess,
}: {
  vaultAddress: Hex
  instanceId: Hex
  usdcAddress?: Hex
  tokenSymbol: string
  tokenDecimals: number
  bindingMismatch: boolean
  onSuccess: () => void
}) => {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const [asset, setAsset] = useState<'eth' | 'usdc'>(
    usdcAddress ? 'usdc' : 'eth'
  )
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: tokenReads, refetch: refetchTokenReads } = useReadContracts({
    contracts:
      asset === 'usdc' && usdcAddress && address
        ? [
            {
              address: usdcAddress,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
            },
            {
              address: usdcAddress,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [address, vaultAddress],
            },
          ]
        : [],
    query: { enabled: asset === 'usdc' && !!usdcAddress && !!address },
  })
  const tokenBalance = asBigInt(readResult(tokenReads, 0))
  const tokenAllowance = asBigInt(readResult(tokenReads, 1)) ?? 0n
  const parsedAmount = useMemo(() => {
    try {
      if (!amount) return 0n
      return asset === 'eth'
        ? parseEther(amount)
        : parseUnits(amount, tokenDecimals)
    } catch {
      return 0n
    }
  }, [amount, asset, tokenDecimals])
  const needsApproval = asset === 'usdc' && tokenAllowance < parsedAmount

  const approve = async () => {
    if (!address || !publicClient || !usdcAddress || parsedAmount === 0n) return
    setSubmitting(true)
    setError(null)
    try {
      const gas = await publicClient.estimateContractGas({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vaultAddress, parsedAmount],
        account: address,
      })
      await txToast({
        tx: {
          address: usdcAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [vaultAddress, parsedAmount],
          gas: (gas * 120n) / 100n,
        },
        successMessage: `${tokenSymbol} approved for this top-up.`,
      })
      await refetchTokenReads()
    } catch (approvalError) {
      setError(parseErrorMessage(approvalError))
    } finally {
      setSubmitting(false)
    }
  }

  const deposit = async () => {
    if (!address || !publicClient || parsedAmount === 0n) return
    setSubmitting(true)
    setError(null)
    try {
      if (asset === 'eth') {
        const gas = await publicClient.estimateContractGas({
          address: vaultAddress,
          abi: provingVaultReadAbi,
          functionName: 'depositETH',
          args: [instanceId],
          account: address,
          value: parsedAmount,
        })
        await txToast({
          tx: {
            address: vaultAddress,
            abi: provingVaultReadAbi,
            functionName: 'depositETH',
            args: [instanceId],
            value: parsedAmount,
            gas: (gas * 120n) / 100n,
          } as any,
          successMessage: 'Proof balance topped up.',
        })
      } else {
        const gas = await publicClient.estimateContractGas({
          address: vaultAddress,
          abi: provingVaultReadAbi,
          functionName: 'depositUSDC',
          args: [instanceId, parsedAmount],
          account: address,
        })
        await txToast({
          tx: {
            address: vaultAddress,
            abi: provingVaultReadAbi,
            functionName: 'depositUSDC',
            args: [instanceId, parsedAmount],
            gas: (gas * 120n) / 100n,
          },
          successMessage: 'Proof balance topped up.',
        })
      }
      setAmount('')
      await refetchTokenReads()
      onSuccess()
    } catch (depositError) {
      setError(parseErrorMessage(depositError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card id="top-up" type="accent" size="lg" className="scroll-mt-6 space-y-5">
      <div>
        <h3 className="text-base font-medium">Top up proof balance</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          This balance pays proof producers for refreshing the network&apos;s
          scores. It is separate from funds allocated to member rewards.
        </p>
      </div>

      {bindingMismatch ? (
        <p className="text-sm text-error">
          Top-up is blocked because this balance is bound to a different network
          snapshot. A constitutional administrator must migrate the account
          first.
        </p>
      ) : !isConnected ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect a wallet to add ETH or {tokenSymbol}.
          </p>
          <WalletConnectionButton />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Asset</Label>
              <Select
                value={asset}
                onValueChange={(value) => setAsset(value as 'eth' | 'usdc')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {usdcAddress && (
                    <SelectItem value="usdc">{tokenSymbol}</SelectItem>
                  )}
                  <SelectItem value="eth">ETH</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                min="0"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              {asset === 'usdc' && tokenBalance !== undefined && (
                <p className="text-xs text-muted-foreground">
                  Wallet balance: {units(tokenBalance, tokenDecimals, 2)}{' '}
                  {tokenSymbol}
                </p>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          {needsApproval ? (
            <Button
              onClick={approve}
              disabled={submitting || parsedAmount === 0n}
            >
              {submitting ? 'Approving...' : `Approve ${tokenSymbol}`}
            </Button>
          ) : (
            <Button
              onClick={deposit}
              disabled={submitting || parsedAmount === 0n}
            >
              {submitting ? 'Topping up...' : 'Top up balance'}
            </Button>
          )}
        </>
      )}
    </Card>
  )
}

export const SettingsPage = ({
  instance,
  activeTab = 'overview',
}: {
  instance: InstanceRow | null
  activeTab?: SettingsTab
}) => {
  const {
    network,
    gnosisSafe,
    merkleRoot,
    ipfsHashCid,
    timestamp: rootTimestamp,
  } = useNetwork()
  const { address: connectedAddress } = useAccount()
  const contributionRound = contributionsRoundsFor(network)[0]
  const instanceId = network.instanceId ?? instance?.id ?? ''
  const snapshotAddress = network.contracts.merkleSnapshot
  const resolverAddress = network.contracts.easIndexerResolver
  const distributorAddress = realAddress(
    network.contracts.merkleFundDistributor
  )
  const governanceAddress = realAddress(network.contracts.merkleGovModule)
  const factoryAddress =
    realAddress(instance?.factory) ||
    realAddress(CONTRACT_CONFIG.TrustgraphsFactory as string)
  const governedFactoryAddress = realAddress(
    CONTRACT_CONFIG.GovernedTrustgraphsFactory as string
  )

  const { data: recordedAuthority } = useReadContract({
    address: governedFactoryAddress as Hex,
    abi: governedTrustgraphsFactoryAbi,
    functionName: 'authorityOf',
    args: [instanceId as Hex],
    query: { enabled: !!governedFactoryAddress && !!instanceId },
  })
  const authoritySafe = realAddress(
    asString(tupleValue(recordedAuthority, 'safe', 0))
  )
  const authorityGovernance = realAddress(
    asString(tupleValue(recordedAuthority, 'governanceModule', 1))
  )
  const authorityRecovery = realAddress(
    asString(tupleValue(recordedAuthority, 'recoveryModule', 2))
  )
  const authorityGuard = realAddress(
    asString(tupleValue(recordedAuthority, 'executionGuard', 3))
  )
  const recordedRecoveryProposer = realAddress(
    asString(tupleValue(recordedAuthority, 'initialRecoveryProposer', 4))
  )
  const recordedRecoveryDelay = asBigInt(
    tupleValue(recordedAuthority, 'recoveryDelay', 5)
  )
  const hasRecordedAuthority =
    !!authoritySafe &&
    !!authorityGovernance &&
    !!authorityRecovery &&
    !!authorityGuard

  const { data: authorityReads } = useReadContracts({
    contracts: hasRecordedAuthority
      ? [
          {
            address: authorityGuard,
            abi: safeExecutionGuardReadAbi,
            functionName: 'safe',
          },
          {
            address: authorityGuard,
            abi: safeExecutionGuardReadAbi,
            functionName: 'isSealed',
          },
          {
            address: authorityRecovery,
            abi: delayedRecoveryModuleReadAbi,
            functionName: 'safe',
          },
          {
            address: authorityRecovery,
            abi: delayedRecoveryModuleReadAbi,
            functionName: 'proposer',
          },
          {
            address: authorityRecovery,
            abi: delayedRecoveryModuleReadAbi,
            functionName: 'delay',
          },
          {
            address: authoritySafe,
            abi: gnosisSafeAuthorityReadAbi,
            functionName: 'isModuleEnabled',
            args: [authorityGovernance],
          },
          {
            address: authoritySafe,
            abi: gnosisSafeAuthorityReadAbi,
            functionName: 'isModuleEnabled',
            args: [authorityRecovery],
          },
          {
            address: authoritySafe,
            abi: gnosisSafeAuthorityReadAbi,
            functionName: 'getStorageAt',
            args: [SAFE_GUARD_STORAGE_SLOT, 1n],
          },
          {
            address: authoritySafe,
            abi: gnosisSafeAuthorityReadAbi,
            functionName: 'getModulesPaginated',
            args: [SAFE_SENTINEL, 10n],
          },
        ]
      : [],
    query: { enabled: hasRecordedAuthority, refetchInterval: 30_000 },
  })
  const liveGuardSafe = realAddress(asString(readResult(authorityReads, 0)))
  const guardSealed = asBoolean(readResult(authorityReads, 1))
  const liveRecoverySafe = realAddress(asString(readResult(authorityReads, 2)))
  const liveRecoveryProposer = realAddress(
    asString(readResult(authorityReads, 3))
  )
  const liveRecoveryDelay = asBigInt(readResult(authorityReads, 4))
  const governanceModuleEnabled = asBoolean(readResult(authorityReads, 5))
  const recoveryModuleEnabled = asBoolean(readResult(authorityReads, 6))
  const installedGuard = storageAddress(readResult(authorityReads, 7))
  const enabledModulePage = readResult(authorityReads, 8)
  const enabledModules =
    (tupleValue(enabledModulePage, 'array', 0) as string[] | undefined) ?? []
  const nextModule = realAddress(
    asString(tupleValue(enabledModulePage, 'next', 1))
  )
  const exactAuthorityModules =
    enabledModules.length === 2 &&
    enabledModules.some((module) => sameHex(module, authorityGovernance)) &&
    enabledModules.some((module) => sameHex(module, authorityRecovery)) &&
    sameHex(nextModule, SAFE_SENTINEL)
  const authorityReadsComplete =
    guardSealed !== undefined &&
    governanceModuleEnabled !== undefined &&
    recoveryModuleEnabled !== undefined &&
    enabledModulePage !== undefined &&
    !!liveGuardSafe &&
    !!liveRecoverySafe &&
    !!installedGuard
  const authorityGraduated =
    hasRecordedAuthority &&
    authorityReadsComplete &&
    guardSealed === true &&
    governanceModuleEnabled === true &&
    recoveryModuleEnabled === true &&
    exactAuthorityModules &&
    sameHex(liveGuardSafe, authoritySafe) &&
    sameHex(liveRecoverySafe, authoritySafe) &&
    sameHex(installedGuard, authorityGuard) &&
    (!governanceAddress || sameHex(authorityGovernance, governanceAddress)) &&
    (!network.contracts.safe?.proxy ||
      sameHex(authoritySafe, network.contracts.safe.proxy))

  const { data: factoryVault } = useReadContract({
    address: factoryAddress as Hex,
    abi: trustgraphsFactoryAbi,
    functionName: 'VAULT',
    query: { enabled: !!factoryAddress },
  })
  const vaultAddress =
    realAddress(PROVING_VAULT) ||
    realAddress(factoryVault as string | undefined)

  const { data: snapshotReads } = useReadContracts({
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
  const latestCheckpointId =
    checkpointCount !== undefined && checkpointCount > 0n
      ? checkpointCount - 1n
      : 0n
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
          {
            address: anchorRegistry,
            abi: anchorRegistryAbi,
            functionName: 'maxTotalInputs',
          },
        ]
      : [],
    query: { enabled: !!anchorRegistry, refetchInterval: 30_000 },
  })
  const anchorAcc = asString(readResult(anchorReads, 0))
  const anchorCount = asBigInt(readResult(anchorReads, 1)) ?? 0n
  const anchorCapacity = asBigInt(readResult(anchorReads, 2))

  const {
    data: vaultReads,
    isLoading: vaultLoading,
    refetch: refetchVaultReads,
  } = useReadContracts({
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
              args: [instanceId as Hex, latestCheckpointId],
            },
            {
              address: vaultAddress,
              abi: provingVaultReadAbi,
              functionName: 'bandOf',
              args: [TRUSTGRAPH_PROGRAM, leafCount, anchorCount],
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
    args: [TRUSTGRAPH_PROGRAM, sizeBand ?? 0],
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
          {
            address: governanceAddress,
            abi: merkleGovModuleAbi,
            functionName: 'executionDelay',
          },
        ]
      : [],
    query: { enabled: !!governanceAddress },
  })

  const { data: connectedRoleReads } = useReadContracts({
    contracts: connectedAddress
      ? [
          {
            address: snapshotAddress,
            abi: merkleSnapshotAbi,
            functionName: 'hasRole',
            args: [CONSTITUTIONAL_ROLE, connectedAddress],
          },
          {
            address: snapshotAddress,
            abi: merkleSnapshotAbi,
            functionName: 'hasRole',
            args: [OPERATIONAL_ROLE, connectedAddress],
          },
        ]
      : [],
    query: { enabled: !!connectedAddress },
  })
  const connectedIsConstitutional = asBoolean(readResult(connectedRoleReads, 0))
  const connectedIsOperational = asBoolean(readResult(connectedRoleReads, 1))

  const creationHash = instance?.paramsHash ?? network.paramsHash
  const paramsMatch =
    creationHash && liveParamsHash
      ? sameHex(creationHash, liveParamsHash)
      : null
  const nextTriggerBlock =
    epochLength !== undefined &&
    epochLength > 0n &&
    lastTriggerBlock !== undefined
      ? lastTriggerBlock + epochLength
      : undefined
  const nextPaidBlock =
    policyLastPaidBlock !== undefined && policyMinInterval !== undefined
      ? policyLastPaidBlock + policyMinInterval
      : undefined
  const inputCount = leafCount + anchorCount
  const inputCapacity = anchorCapacity ?? maxPricedInputs
  const distributorPaused = asBoolean(readResult(distributorReads, 5))
  const fundingRestricted = asBoolean(readResult(distributorReads, 4))
  const distributorFee = asBigInt(readResult(distributorReads, 3))
  const attentionItems = [
    operatorStatus?.available && watched && !heartbeatFresh
      ? 'The proof-service heartbeat is stale.'
      : null,
    quoteEligible === false && vaultAddress && instanceId
      ? `Proof billing is not currently eligible: ${quoteReasons[quoteReason ?? -1] ?? 'check the billing policy'}.`
      : null,
    distributorPaused ? 'Reward funding and claims are paused.' : null,
    paramsMatch === false
      ? 'The live scoring parameter hash differs from the creation tuple.'
      : null,
    inputCapacity !== undefined && inputCount * 5n >= inputCapacity * 4n
      ? `Proof inputs have reached at least 80% of the ${comma(inputCapacity)}-input capacity.`
      : null,
    accountSnapshot &&
    accountSnapshot !== zeroAddress &&
    !sameHex(accountSnapshot, snapshotAddress)
      ? 'The proving balance is bound to a different network snapshot.'
      : null,
  ].filter((item): item is string => !!item)

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <NetworkHeader network={network} />
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Monitor this network, fund its proof service, and inspect the
          configuration enforced on-chain.
        </p>
      </div>

      <div className="grid items-start gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] xl:gap-12">
        <SettingsNavigation networkId={network.id} activeTab={activeTab} />

        <div className="min-w-0 space-y-10">
          {activeTab === 'overview' && (
            <section className="space-y-6" aria-labelledby="settings-overview">
              <div>
                <SectionHeading n="01">
                  <span id="settings-overview">Network status</span>
                </SectionHeading>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  The operational state that matters day to day. Detailed
                  policy, contracts, and audit values live in the other tabs.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-px border border-border bg-border lg:grid-cols-4">
                <SettingsMetric
                  title="LATEST SCORES"
                  tooltip="When the latest proven score table was applied on-chain."
                  value={
                    rootTimestamp ? timestamp(rootTimestamp) : 'Not proven yet'
                  }
                />
                <SettingsMetric
                  title="PROOF SERVICE"
                  tooltip="The hosted scheduler mode and its latest public heartbeat."
                  value={
                    operatorLoading
                      ? '...'
                      : heartbeatFresh
                        ? `${serviceMode} · healthy`
                        : serviceMode
                  }
                />
                <SettingsMetric
                  title="PROOF BALANCE"
                  tooltip="Funds reserved for producing score proofs, separate from member reward pools."
                  value={vaultLoading ? '...' : usd(balanceUsd)}
                />
                <SettingsMetric
                  title="REWARDS"
                  tooltip="Whether this network has a reward distributor and whether it is active."
                  value={
                    !distributorAddress
                      ? 'Not configured'
                      : distributorPaused
                        ? 'Paused'
                        : 'Active'
                  }
                />
              </div>

              {attentionItems.length > 0 ? (
                <Card type="outline" size="md" className="border-warn">
                  <h3 className="text-sm font-medium">Needs attention</h3>
                  <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                    {attentionItems.map((item) => (
                      <li key={item} className="flex gap-2">
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0 text-warn"
                          aria-hidden="true"
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : (
                <Card type="outline" size="md">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2
                      className="h-4 w-4 text-success"
                      aria-hidden="true"
                    />
                    No operational issues are visible right now.
                  </p>
                </Card>
              )}

              <div className="space-y-3">
                <SectionHeading>Quick actions</SectionHeading>
                <div className="flex flex-wrap gap-3">
                  <ButtonLink
                    href={`/networks/${network.id}/settings?tab=proofs#top-up`}
                  >
                    Top up proof balance
                  </ButtonLink>
                  {distributorAddress && (
                    <ButtonLink
                      href={`/networks/${network.id}/rewards?fund=true`}
                      variant="outline"
                    >
                      Fund member rewards
                    </ButtonLink>
                  )}
                  {contributionRound && (
                    <ButtonLink
                      href={`/networks/${network.id}/contributions`}
                      variant="outline"
                    >
                      View contribution cycle
                    </ButtonLink>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Launching a new contribution cycle will appear here once the
                  parameter bundle can be published to the prover and indexer as
                  one coordinated operation.
                </p>
              </div>
            </section>
          )}

          {activeTab === 'proofs' && (
            <section className="space-y-5">
              <SectionHeading n="01">Proof service</SectionHeading>
              <div className="grid grid-cols-2 gap-px border border-border bg-border lg:grid-cols-4">
                <SettingsMetric
                  title="SERVICE MODE"
                  tooltip="Curated networks are subsidized by the hosted operator. Community-funded networks draw from their own proving tank."
                  value={operatorLoading || tankLoading ? '...' : serviceMode}
                />
                <SettingsMetric
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
                <SettingsMetric
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
                <SettingsMetric
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
                        <AlertTriangle className="h-3.5 w-3.5" /> Heartbeat
                        stale
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
                      ? comma(
                          operatorStatus.settings?.confirmations ?? undefined
                        )
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
                  <SettingRow label="Submit failure threshold">
                    {operatorStatus?.available
                      ? `${comma(operatorStatus.settings?.submitFailureThreshold ?? undefined)} deterministic reverts`
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
                          operatorStatus.settings?.proofTimeoutSeconds ??
                            undefined
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
                          ? (operatorStatus.settings?.paidRecipient ??
                            undefined)
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
                          operatorStatus.settings?.budgetWindowSeconds ??
                            undefined
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
                  <SettingRow label="Publication durability">
                    {operatorStatus?.available && operatorStatus.settings
                      ? `${comma(operatorStatus.settings.publicationMinimum ?? undefined)} of ${comma(operatorStatus.settings.publicationTargetCount ?? undefined)} targets`
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Publication retry interval">
                    {operatorStatus?.available
                      ? duration(
                          operatorStatus.settings?.publicationRetrySeconds ??
                            undefined
                        )
                      : '—'}
                  </SettingRow>
                </SettingsCard>
              </div>
            </section>
          )}

          {activeTab === 'proofs' && (
            <section className="space-y-5">
              <SectionHeading n="02">Proof billing</SectionHeading>
              {instanceId && vaultAddress && (
                <TopUpProofBalance
                  vaultAddress={vaultAddress}
                  instanceId={instanceId as Hex}
                  usdcAddress={usdcAddress}
                  tokenSymbol={tokenSymbol}
                  tokenDecimals={tokenDecimals}
                  bindingMismatch={
                    !!accountSnapshot &&
                    accountSnapshot !== zeroAddress &&
                    !sameHex(accountSnapshot, snapshotAddress)
                  }
                  onSuccess={() => {
                    void refetchVaultReads()
                  }}
                />
              )}
              {!instanceId ? (
                <Card
                  type="accent"
                  size="md"
                  className="text-sm text-muted-foreground"
                >
                  This legacy network has no factory instance ID, so it cannot
                  have an instance-keyed proving tank. Contract settings remain
                  visible below.
                </Card>
              ) : !vaultAddress ? (
                <Card
                  type="accent"
                  size="md"
                  className="text-sm text-muted-foreground"
                >
                  This deployment has no ProvingVault configured. The network
                  may be curated or self-proved, but there is no on-chain
                  billing account to inspect.
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
          )}

          {activeTab === 'scoring' && (
            <ScoringSettings
              instance={instance}
              factoryAddress={factoryAddress as Hex | undefined}
              liveParamsHash={liveParamsHash as Hex | undefined}
              checkpointCount={checkpointCount}
            />
          )}

          {activeTab === 'advanced' && (
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
                    {epochLength === undefined
                      ? '—'
                      : `${comma(epochLength)} blocks`}
                  </SettingRow>
                  <SettingRow
                    label={
                      epochLength !== undefined && epochLength > 0n
                        ? 'Last consumed epoch boundary'
                        : 'Last trigger block'
                    }
                  >
                    {comma(lastTriggerBlock)}
                  </SettingRow>
                  <SettingRow label="Next trigger boundary">
                    {comma(nextTriggerBlock)}
                  </SettingRow>
                  <SettingRow label="Last applied checkpoint">
                    {hasAppliedCheckpoint
                      ? comma(lastAppliedCheckpoint)
                      : 'None'}
                  </SettingRow>
                  <SettingRow label="Merkle state count">
                    {comma(stateCount)}
                  </SettingRow>
                  <SettingRow label="Latest root">
                    <Hash
                      value={
                        asString(tupleValue(latestState, 'root', 2)) ??
                        merkleRoot
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
                  <SettingRow label="Live leaf count">
                    {comma(leafCount)}
                  </SettingRow>
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
                  <SettingRow label="Anchor count">
                    {comma(anchorCount)}
                  </SettingRow>
                  <SettingRow label="Anchor accumulator">
                    <Hash value={anchorAcc} />
                  </SettingRow>
                  <SettingRow label="Combined proof inputs">
                    {comma(inputCount)}
                  </SettingRow>
                  <SettingRow label="Anchor-ingress capacity">
                    {comma(inputCapacity)}
                  </SettingRow>
                  <SettingRow label="Anchor-ingress headroom">
                    {inputCapacity === undefined
                      ? '—'
                      : comma(
                          inputCount >= inputCapacity
                            ? 0n
                            : inputCapacity - inputCount
                        )}
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
          )}

          {activeTab === 'advanced' && (
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
                  <SettingRow label="Chain ID">
                    {instance?.chainId ?? '—'}
                  </SettingRow>
                  <SettingRow label="Creator">
                    {instance?.creator || network.admin ? (
                      <Address
                        address={(instance?.creator ?? network.admin)!}
                        displayMode="auto"
                      />
                    ) : (
                      '—'
                    )}
                  </SettingRow>
                  <SettingRow label="Initial admin">
                    {network.admin ? (
                      <Address address={network.admin} displayMode="auto" />
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
                    <ContractAddress
                      value={network.contracts.safe?.singleton}
                    />
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
                    <SettingRow label="Execution delay">
                      {comma(asBigInt(readResult(governanceReads, 7)))} blocks
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
          )}

          {activeTab === 'features' && (
            <section className="space-y-5" aria-labelledby="network-features">
              <div>
                <SectionHeading n="01">
                  <span id="network-features">Network features</span>
                </SectionHeading>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  Optional programs connected to this trust graph. Member-facing
                  activity stays on each feature&apos;s main page; configuration
                  and lifecycle state live here.
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <ScoringAccessCard
                  instance={instance}
                  factoryAddress={factoryAddress as Hex | undefined}
                  liveParamsHash={liveParamsHash as Hex | undefined}
                />
                <SettingsCard
                  title="Contribution cycles"
                  description="Community-scored work whose ratings are weighted by this network."
                >
                  <SettingRow label="Status">
                    {contributionRound ? 'Configured' : 'Not configured'}
                  </SettingRow>
                  <SettingRow label="Active round">
                    {contributionRound?.name ?? 'None'}
                  </SettingRow>
                  <SettingRow label="Round snapshot">
                    <ContractAddress
                      value={contributionRound?.contracts.merkleSnapshot}
                    />
                  </SettingRow>
                  <SettingRow label="Management">
                    {connectedAddress
                      ? connectedIsOperational
                        ? 'Operational access connected'
                        : 'Requires operational role'
                      : 'Connect to check access'}
                  </SettingRow>
                </SettingsCard>

                <SettingsCard
                  title="Member rewards"
                  description="Pools allocated to members using a fixed proven trust-score snapshot."
                >
                  <SettingRow label="Status">
                    {!distributorAddress
                      ? 'Not configured'
                      : distributorPaused
                        ? 'Paused'
                        : 'Active'}
                  </SettingRow>
                  <SettingRow label="Who can fund">
                    {distributorAddress
                      ? fundingRestricted
                        ? 'Allowlisted accounts'
                        : 'Anyone'
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Distribution fee">
                    {distributorFee === undefined
                      ? '—'
                      : `${units(distributorFee * 100n, 18, 4)}%`}
                  </SettingRow>
                  <SettingRow label="Distributor">
                    <ContractAddress value={distributorAddress} />
                  </SettingRow>
                  {distributorAddress && (
                    <div className="pt-4">
                      <ButtonLink
                        href={`/networks/${network.id}/rewards?fund=true`}
                        size="sm"
                      >
                        Fund rewards
                      </ButtonLink>
                    </div>
                  )}
                </SettingsCard>

                <SettingsCard
                  title="Governance"
                  description="Trust-weighted proposals executed through the configured Safe module."
                >
                  <SettingRow label="Status">
                    {governanceAddress ? 'Configured' : 'Not configured'}
                  </SettingRow>
                  <SettingRow label="Voting delay">
                    {governanceAddress
                      ? `${comma(asBigInt(readResult(governanceReads, 4)))} blocks`
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Voting period">
                    {governanceAddress
                      ? `${comma(asBigInt(readResult(governanceReads, 5)))} blocks`
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Execution delay">
                    {governanceAddress
                      ? `${comma(asBigInt(readResult(governanceReads, 7)))} blocks`
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Quorum">
                    {(() => {
                      const value = asBigInt(readResult(governanceReads, 6))
                      return value === undefined
                        ? '—'
                        : `${units(value * 100n, 18, 2)}%`
                    })()}
                  </SettingRow>
                  {governanceAddress && (
                    <div className="pt-4">
                      <ButtonLink
                        href={`/networks/${network.id}/governance`}
                        variant="outline"
                        size="sm"
                      >
                        Open governance
                      </ButtonLink>
                    </div>
                  )}
                </SettingsCard>
              </div>
            </section>
          )}

          {activeTab === 'access' && (
            <section className="space-y-5" aria-labelledby="network-access">
              <div>
                <SectionHeading n="01">
                  <span id="network-access">Access and authority</span>
                </SectionHeading>
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  Who can operate, reconfigure, or execute actions for this
                  network. Contract addresses and raw deployment data are in
                  Advanced.
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <SettingsCard
                  title="Governed authority boundary"
                  description="Live Safe, guard, and module reads—not a decentralization label."
                >
                  <SettingRow label="Graduation state">
                    {!hasRecordedAuthority ? (
                      <StatusPill tone="muted">
                        Legacy / not recorded by this governed factory
                      </StatusPill>
                    ) : !authorityReadsComplete ? (
                      <StatusPill tone="muted">
                        Checking live authority…
                      </StatusPill>
                    ) : authorityGraduated ? (
                      <StatusPill tone="good">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Graduated
                      </StatusPill>
                    ) : (
                      <StatusPill tone="warn">
                        <AlertTriangle className="h-3.5 w-3.5" /> Authority
                        mismatch — not graduated
                      </StatusPill>
                    )}
                  </SettingRow>
                  <SettingRow label="Safe">
                    <ContractAddress value={authoritySafe} />
                  </SettingRow>
                  <SettingRow label="Owners">
                    {gnosisSafe?.owners.length
                      ? gnosisSafe.owners.map((owner) => (
                          <div key={owner}>
                            <Address address={owner} displayMode="auto" />
                          </div>
                        ))
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Threshold">
                    {gnosisSafe
                      ? `${gnosisSafe.threshold} of ${gnosisSafe.owners.length}`
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Owner execution">
                    {guardSealed === undefined
                      ? '—'
                      : guardSealed
                        ? 'Disabled by sealed guard'
                        : 'OPEN — not graduated'}
                  </SettingRow>
                  <SettingRow label="Execution guard">
                    <ContractAddress value={authorityGuard} />
                  </SettingRow>
                  <SettingRow label="Installed on Safe">
                    {yesNo(
                      !!installedGuard &&
                        sameHex(installedGuard, authorityGuard)
                    )}
                  </SettingRow>
                  <SettingRow label="Member module">
                    <ContractAddress value={authorityGovernance} />
                  </SettingRow>
                  <SettingRow label="Member module enabled">
                    {yesNo(governanceModuleEnabled)}
                  </SettingRow>
                  <SettingRow label="Member vote / execution delays">
                    {comma(asBigInt(readResult(governanceReads, 4)))} +{' '}
                    {comma(asBigInt(readResult(governanceReads, 5)))} +{' '}
                    {comma(asBigInt(readResult(governanceReads, 7)))} blocks
                  </SettingRow>
                  <SettingRow label="Recovery module">
                    <ContractAddress value={authorityRecovery} />
                  </SettingRow>
                  <SettingRow label="Recovery module enabled">
                    {yesNo(recoveryModuleEnabled)}
                  </SettingRow>
                  <SettingRow label="Only recorded modules enabled">
                    {enabledModulePage === undefined
                      ? '—'
                      : yesNo(exactAuthorityModules)}
                  </SettingRow>
                  <SettingRow label="Recovery proposer">
                    <ContractAddress
                      value={liveRecoveryProposer ?? recordedRecoveryProposer}
                    />
                  </SettingRow>
                  <SettingRow label="Recovery delay">
                    {duration(liveRecoveryDelay ?? recordedRecoveryDelay)}
                  </SettingRow>
                  <SettingRow label="Protected Safe paths">
                    Settings, upgrades, withdrawals, arbitrary calls,
                    delegatecalls, batches, module changes, and guard removal
                    all require a delayed module route.
                  </SettingRow>
                </SettingsCard>

                <SettingsCard
                  title="Your access"
                  description="Roles held directly by the connected wallet on the network snapshot."
                >
                  <SettingRow label="Connected wallet">
                    {connectedAddress ? (
                      <Address address={connectedAddress} displayMode="auto" />
                    ) : (
                      'Not connected'
                    )}
                  </SettingRow>
                  <SettingRow label="Operational role">
                    {connectedAddress
                      ? yesNo(connectedIsOperational)
                      : 'Connect to check'}
                  </SettingRow>
                  <SettingRow label="Constitutional role">
                    {connectedAddress
                      ? yesNo(connectedIsConstitutional)
                      : 'Connect to check'}
                  </SettingRow>
                </SettingsCard>

                <SettingsCard
                  title="Safe and signer synchronization"
                  description="The collective execution account and the score-based signer policy attached to it."
                >
                  <SettingRow label="Safe proxy">
                    <ContractAddress value={network.contracts.safe?.proxy} />
                  </SettingRow>
                  <SettingRow label="Safe threshold">
                    {gnosisSafe
                      ? `${gnosisSafe.threshold} of ${gnosisSafe.owners.length}`
                      : '—'}
                  </SettingRow>
                  <SettingRow label="Signer sync enabled">
                    {yesNo(network.safeZodiacSignerSync.enabled)}
                  </SettingRow>
                  <SettingRow label="Top signers">
                    {network.safeZodiacSignerSync.topNSigners}
                  </SettingRow>
                </SettingsCard>

                <SettingsCard title="Feature ownership">
                  <SettingRow label="Reward distributor owner">
                    <ContractAddress
                      value={asString(readResult(distributorReads, 0))}
                    />
                  </SettingRow>
                  <SettingRow label="Pending distributor owner">
                    <ContractAddress
                      value={asString(readResult(distributorReads, 1))}
                    />
                  </SettingRow>
                  <SettingRow label="Governance module owner">
                    <ContractAddress
                      value={asString(readResult(governanceReads, 0))}
                    />
                  </SettingRow>
                  <SettingRow label="Governance execution target">
                    <ContractAddress
                      value={asString(readResult(governanceReads, 2))}
                    />
                  </SettingRow>
                </SettingsCard>

                <SettingsCard title="Instance authority">
                  <SettingRow label="Creator">
                    {instance?.creator || network.admin ? (
                      <Address
                        address={(instance?.creator ?? network.admin)!}
                        displayMode="auto"
                      />
                    ) : (
                      '—'
                    )}
                  </SettingRow>
                  <SettingRow label="Initial administrator">
                    {network.admin ? (
                      <Address address={network.admin} displayMode="auto" />
                    ) : (
                      '—'
                    )}
                  </SettingRow>
                  <SettingRow label="Snapshot">
                    <ContractAddress value={snapshotAddress} />
                  </SettingRow>
                </SettingsCard>
              </div>
            </section>
          )}

          {activeTab === 'proofs' &&
            tank &&
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
                          <Address address={deposit.from} displayMode="auto" />
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
                                {usd(
                                  BigInt(claim.feeUsd) + BigInt(claim.gasUsd)
                                )}
                              </div>
                              {claim.recipient && (
                                <div className="text-xs text-muted-foreground">
                                  Paid to{' '}
                                  <Address
                                    address={claim.recipient}
                                    displayMode="auto"
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
            <Clock3 className="h-3.5 w-3.5" /> Live values come directly from
            the chain; creation data and history come from the indexed factory
            catalog.
          </p>
        </div>
      </div>
    </div>
  )
}
