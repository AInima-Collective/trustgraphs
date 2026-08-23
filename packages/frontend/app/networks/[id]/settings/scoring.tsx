'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  History,
  Plus,
  Trash2,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  isAddress,
  keccak256,
  parseAbiItem,
  stringToBytes,
  zeroAddress,
} from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from 'wagmi'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import { Address as AddressView } from '@/components/Address'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { Modal } from '@/components/Modal'
import { ProposalActionList } from '@/components/ProposalActionList'
import { ScoringGraphPreview } from '@/components/ScoringGraphPreview'
import { SectionHeading } from '@/components/SectionHeading'
import { useNetwork } from '@/contexts/NetworkContext'
import { useGovernance } from '@/hooks/useGovernance'
import type { InstanceRow } from '@/lib/catalog'
import { merkleGovModuleAbi, merkleSnapshotAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import { saveGovernancePrefill } from '@/lib/governance-prefill'
import { paramsHash } from '@/lib/pagerank/encode'
import type { Params, RawEdge } from '@/lib/pagerank/types'
import {
  type ParameterAction,
  ZERO_BYTES32,
  buildParameterActions,
  cloneParams,
  diffParams,
  formatFixed,
  paramsDiscoveryAbi,
  paramsFingerprint,
  paramsFromChain,
  paramsFromJson,
  paramsToContract,
  paramsToJson,
  parseFixed,
  safeReadAbi,
  signerParamsAbi,
  timelockAbi,
  trustgraphsParamsControllerAbi,
  validateParamsUpdate,
} from '@/lib/scoring-params'
import { previewScoringChange } from '@/lib/scoring-preview'
import { txToast } from '@/lib/tx'
import { cn, realAddress } from '@/lib/utils'
import { ponderQueries } from '@/queries/ponder'

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

const sameHex = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

const shortHash = (hash: string | undefined) =>
  hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : '—'

const timeLabel = (seconds: string | bigint | null | undefined) => {
  if (!seconds) return 'History unavailable'
  const value = Number(seconds)
  if (!Number.isFinite(value)) return 'History unavailable'
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value * 1_000))
}

const timelockCancelledEvent = parseAbiItem(
  'event Cancelled(bytes32 indexed id)'
)

const transactionRecoveryMessage = (error: unknown, action: string) => {
  const record =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : undefined
  const cause =
    record?.cause && typeof record.cause === 'object'
      ? (record.cause as Record<string, unknown>)
      : undefined
  const detail = [
    error instanceof Error ? error.message : String(error),
    record?.shortMessage,
    record?.details,
    cause?.message,
    cause?.shortMessage,
    record?.code,
    cause?.code,
  ]
    .filter((value) => value !== undefined)
    .join(' ')
    .toLowerCase()

  if (
    detail.includes('user rejected') ||
    detail.includes('user denied') ||
    detail.includes('code 4001') ||
    detail.includes('code: 4001') ||
    record?.code === 4001 ||
    cause?.code === 4001
  ) {
    return `Wallet rejected the ${action} transaction. Nothing changed in that transaction; review the draft and retry when ready.`
  }
  if (
    detail.includes('transaction replaced') ||
    detail.includes('transaction was replaced') ||
    detail.includes('transaction was cancelled') ||
    detail.includes('transaction was canceled') ||
    detail.includes('replacement transaction') ||
    detail.includes('replaced transaction') ||
    detail.includes('reason: cancelled') ||
    detail.includes('reason: canceled')
  ) {
    return `The wallet replaced or cancelled the ${action} transaction. Refresh the on-chain operation state before retrying because the replacement may have completed.`
  }

  return `${parseErrorMessage(error)} Refresh the on-chain state before retrying the ${action} transaction.`
}

const FieldRow = ({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) => (
  <div className="grid min-w-0 gap-1 border-b border-border py-3 last:border-0 sm:grid-cols-[minmax(9rem,0.75fr)_minmax(0,1.25fr)] sm:gap-4">
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      {hint && <p className="mt-1 text-xs text-text-subtle">{hint}</p>}
    </div>
    <div className="min-w-0 text-sm sm:text-right">{children}</div>
  </div>
)

const ParamCard = ({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) => (
  <Card type="detail" size="md" className="min-w-0">
    <h3 className="text-sm font-semibold">{title}</h3>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">
      {description}
    </p>
    <div className="mt-3">{children}</div>
  </Card>
)

const Status = ({
  tone,
  children,
}: {
  tone: 'good' | 'warn' | 'muted'
  children: ReactNode
}) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 border px-2 py-1 text-xs',
      tone === 'good' && 'border-success/40 bg-success-soft text-success',
      tone === 'warn' && 'border-error/40 bg-error-soft text-error',
      tone === 'muted' && 'border-border bg-surface-2 text-muted-foreground'
    )}
  >
    {children}
  </span>
)

const paramsDraftKey = (instanceId: string) =>
  `trustgraph:scoring-draft:${instanceId}`

type SeedDraft = { input: string; resolved: Address | null }

type DraftFields = {
  damping: string
  tolerance: string
  maxIterations: string
  minWeight: string
  maxWeight: string
  trustShare: string
  trustDecay: string
  totalPool: string
  seeds: SeedDraft[]
}

type StoredDraft = {
  parentHash: Hex
  fields: DraftFields
  rationale: string
  evidenceURI: string
}

const fieldsFromParams = (params: Params): DraftFields => ({
  damping: formatFixed(params.dampingFp, params.precisionScale),
  tolerance: formatFixed(params.toleranceFp, params.precisionScale),
  maxIterations: String(params.maxIterations),
  minWeight: formatFixed(params.minWeightFp, params.precisionScale),
  maxWeight: formatFixed(params.maxWeightFp, params.precisionScale),
  trustShare: formatFixed(params.trustShareFp, params.precisionScale),
  trustDecay: formatFixed(params.trustDecayFp, params.precisionScale),
  totalPool: formatFixed(params.totalPool, params.precisionScale),
  seeds: params.trustedSeeds.map((seed) => ({
    input: seed,
    resolved: seed as Address,
  })),
})

const paramsFromFields = (
  fields: DraftFields,
  current: Params
): { params?: Params; errors: Record<string, string> } => {
  const errors: Record<string, string> = {}
  const next = cloneParams(current)
  const fixed = [
    ['damping', 'dampingFp'],
    ['tolerance', 'toleranceFp'],
    ['minWeight', 'minWeightFp'],
    ['maxWeight', 'maxWeightFp'],
    ['trustShare', 'trustShareFp'],
    ['trustDecay', 'trustDecayFp'],
    ['totalPool', 'totalPool'],
  ] as const
  for (const [formKey, paramsKey] of fixed) {
    try {
      next[paramsKey] = parseFixed(fields[formKey], current.precisionScale)
    } catch (error) {
      errors[formKey] = error instanceof Error ? error.message : 'Invalid value'
    }
  }
  if (!/^\d+$/.test(fields.maxIterations.trim())) {
    errors.maxIterations = 'Enter a whole number.'
  } else {
    next.maxIterations = Number(fields.maxIterations)
  }
  if (fields.seeds.some((seed) => !seed.resolved)) {
    errors.trustedSeeds = 'Resolve every address or ENS name before continuing.'
  } else {
    next.trustedSeeds = fields.seeds.map(
      (seed) => seed.resolved!.toLowerCase() as Hex
    )
  }
  return Object.keys(errors).length ? { errors } : { params: next, errors }
}

type Authority =
  | { kind: 'direct'; owner: Address; canAct: boolean }
  | {
      kind: 'safe-governance'
      owner: Address
      owners: Address[]
      threshold: bigint
      canAct: boolean
    }
  | {
      kind: 'safe-export'
      owner: Address
      owners: Address[]
      threshold: bigint
      canAct: false
    }
  | {
      kind: 'timelock'
      owner: Address
      minDelay: bigint
      canPropose: boolean
      canExecute: boolean
      permissionlessExecutor: boolean
    }
  | { kind: 'contract'; owner: Address; canAct: false }
  | { kind: 'unavailable'; owner?: Address; canAct: false }

const useControllerState = ({
  instance,
  instanceId,
  factoryAddress,
  snapshotAddress,
  liveParamsHash,
}: {
  instance: InstanceRow | null
  instanceId: string
  factoryAddress?: Address
  snapshotAddress: Address
  liveParamsHash?: Hex
}) => {
  const knownController = realAddress(
    instance?.contracts.trustgraphsParamsController
  )
  const { data: factoryRegistry } = useReadContract({
    address: factoryAddress,
    abi: paramsDiscoveryAbi,
    functionName: 'INSTANCE_REGISTRY',
    query: { enabled: !knownController && !!factoryAddress && !!instanceId },
  })
  const { data: discoveredController } = useReadContract({
    address: factoryRegistry as Address | undefined,
    abi: paramsDiscoveryAbi,
    functionName: 'paramsAuthority',
    args: [instanceId as Hex],
    query: {
      enabled:
        !knownController &&
        !!factoryRegistry &&
        /^0x[0-9a-fA-F]{64}$/.test(instanceId),
    },
  })
  const controllerAddress =
    knownController ?? realAddress(discoveredController as string | undefined)

  const {
    data: controllerReads,
    isLoading,
    isError,
    refetch,
  } = useReadContracts({
    contracts: controllerAddress
      ? [
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'getCurrentParams' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'currentParamsHash' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'version' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'owner' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'pendingOwner' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'instanceId' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'snapshot' as const,
          },
          {
            address: controllerAddress,
            abi: trustgraphsParamsControllerAbi,
            functionName: 'registry' as const,
          },
        ]
      : [],
    query: {
      enabled: !!controllerAddress,
      refetchInterval: 10_000,
    },
  })

  const tuple = readResult(controllerReads, 0)
  const controllerHash = readResult(controllerReads, 1) as Hex | undefined
  const version = readResult(controllerReads, 2) as bigint | undefined
  const owner = realAddress(
    readResult(controllerReads, 3) as string | undefined
  )
  const pendingOwner = realAddress(
    readResult(controllerReads, 4) as string | undefined
  )
  const controllerInstanceId = readResult(controllerReads, 5) as Hex | undefined
  const controllerSnapshot = readResult(controllerReads, 6) as
    | Address
    | undefined
  const controllerRegistry = readResult(controllerReads, 7) as
    | Address
    | undefined

  const { data: registeredAuthority } = useReadContract({
    address: controllerRegistry,
    abi: paramsDiscoveryAbi,
    functionName: 'paramsAuthority',
    args: [instanceId as Hex],
    query: {
      enabled: !!controllerRegistry && /^0x[0-9a-fA-F]{64}$/.test(instanceId),
      refetchInterval: 10_000,
    },
  })

  const parsed = useMemo(() => {
    if (!tuple) return { params: undefined, error: undefined }
    try {
      return { params: paramsFromChain(tuple), error: undefined }
    } catch (error) {
      return {
        params: undefined,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [tuple])
  const computedHash = parsed.params ? paramsHash(parsed.params) : undefined
  const consistencyError = !controllerAddress
    ? undefined
    : (parsed.error ??
      (!parsed.params
        ? isError
          ? 'The controller could not be read from RPC.'
          : undefined
        : !sameHex(computedHash, controllerHash)
          ? 'The controller tuple does not reproduce its current hash.'
          : liveParamsHash && !sameHex(controllerHash, liveParamsHash)
            ? 'The controller and snapshot disagree on the current hash.'
            : controllerInstanceId && !sameHex(controllerInstanceId, instanceId)
              ? 'The controller is associated with a different instance.'
              : controllerSnapshot &&
                  !sameHex(controllerSnapshot, snapshotAddress)
                ? 'The controller is associated with a different snapshot.'
                : registeredAuthority &&
                    !sameHex(registeredAuthority as string, controllerAddress)
                  ? 'The registry names a different parameter authority.'
                  : undefined))

  return {
    controllerAddress,
    params: consistencyError ? undefined : parsed.params,
    computedHash,
    controllerHash,
    version,
    owner,
    pendingOwner,
    controllerRegistry,
    registeredAuthority: registeredAuthority as Address | undefined,
    consistencyError,
    isLoading,
    refetch,
  }
}

const useAuthority = ({
  owner,
  connectedAddress,
  governanceAddress,
  governanceCanPropose,
}: {
  owner?: Address
  connectedAddress?: Address
  governanceAddress?: Address
  governanceCanPropose: boolean
}) => {
  const publicClient = usePublicClient()
  return useQuery({
    queryKey: [
      'scoring-authority',
      owner,
      connectedAddress,
      governanceAddress,
      governanceCanPropose,
    ],
    queryFn: async (): Promise<Authority> => {
      if (!publicClient || !owner) return { kind: 'unavailable', canAct: false }
      const code = await publicClient.getCode({ address: owner })
      if (!code || code === '0x') {
        return {
          kind: 'direct',
          owner,
          canAct: sameHex(owner, connectedAddress),
        }
      }

      try {
        const [proposerRole, executorRole, minDelay] = await Promise.all([
          publicClient.readContract({
            address: owner,
            abi: timelockAbi,
            functionName: 'PROPOSER_ROLE',
          }),
          publicClient.readContract({
            address: owner,
            abi: timelockAbi,
            functionName: 'EXECUTOR_ROLE',
          }),
          publicClient.readContract({
            address: owner,
            abi: timelockAbi,
            functionName: 'getMinDelay',
          }),
        ])
        const canPropose = connectedAddress
          ? await publicClient.readContract({
              address: owner,
              abi: timelockAbi,
              functionName: 'hasRole',
              args: [proposerRole, connectedAddress],
            })
          : false
        const permissionlessExecutor = await publicClient.readContract({
          address: owner,
          abi: timelockAbi,
          functionName: 'hasRole',
          args: [executorRole, zeroAddress],
        })
        const connectedExecutor = connectedAddress
          ? await publicClient.readContract({
              address: owner,
              abi: timelockAbi,
              functionName: 'hasRole',
              args: [executorRole, connectedAddress],
            })
          : false
        return {
          kind: 'timelock',
          owner,
          minDelay,
          canPropose,
          canExecute: permissionlessExecutor || connectedExecutor,
          permissionlessExecutor,
        }
      } catch {
        // Not an OpenZeppelin TimelockController; continue with Safe detection.
      }

      try {
        const [owners, threshold] = await Promise.all([
          publicClient.readContract({
            address: owner,
            abi: safeReadAbi,
            functionName: 'getOwners',
          }),
          publicClient.readContract({
            address: owner,
            abi: safeReadAbi,
            functionName: 'getThreshold',
          }),
        ])
        let governanceOwnsPath = false
        if (governanceAddress) {
          try {
            const target = await publicClient.readContract({
              address: governanceAddress,
              abi: merkleGovModuleAbi,
              functionName: 'target',
            })
            governanceOwnsPath = sameHex(target, owner)
          } catch {
            governanceOwnsPath = false
          }
        }
        return governanceOwnsPath
          ? {
              kind: 'safe-governance',
              owner,
              owners: [...owners],
              threshold,
              canAct: governanceCanPropose,
            }
          : {
              kind: 'safe-export',
              owner,
              owners: [...owners],
              threshold,
              canAct: false,
            }
      } catch {
        return { kind: 'contract', owner, canAct: false }
      }
    },
    enabled: !!publicClient && !!owner,
    staleTime: 15_000,
  })
}

const authorityLabel = (authority: Authority | undefined) => {
  switch (authority?.kind) {
    case 'direct':
      return authority.canAct ? 'Direct owner (you)' : 'Direct owner'
    case 'safe-governance':
      return 'Safe through Merkle governance'
    case 'safe-export':
      return 'Safe (external proposal flow)'
    case 'timelock':
      return `Operational timelock · ${authority.minDelay.toString()}s minimum delay`
    case 'contract':
      return 'Contract-controlled authority'
    default:
      return 'Checking authority…'
  }
}

const InputField = ({
  id,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  hint?: string
}) => (
  <div className="min-w-0 space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Input
      id={id}
      className="h-11"
      inputMode="decimal"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-invalid={!!error}
      aria-describedby={error || hint ? `${id}-help` : undefined}
    />
    {(error || hint) && (
      <p
        id={`${id}-help`}
        className={cn(
          'text-xs',
          error ? 'text-error' : 'text-muted-foreground'
        )}
      >
        {error ?? hint}
      </p>
    )}
  </div>
)

const CurrentParameterCards = ({ params }: { params: Params }) => (
  <div className="grid min-w-0 gap-4 lg:grid-cols-2">
    <ParamCard
      title="Trusted accounts"
      description="Where inherited trust starts and how strongly it propagates."
    >
      <FieldRow label="Trusted accounts">
        <span>{params.trustedSeeds.length}</span>
      </FieldRow>
      <FieldRow label="Starting share">
        {formatFixed(params.trustShareFp, params.precisionScale)}
      </FieldRow>
      <FieldRow label="Distance decay">
        {formatFixed(params.trustDecayFp, params.precisionScale)}
      </FieldRow>
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">
          Show trusted addresses
        </summary>
        <div className="space-y-2">
          {params.trustedSeeds.map((seed) => (
            <div key={seed} className="min-w-0 break-all font-mono text-xs">
              {seed}
            </div>
          ))}
        </div>
      </details>
    </ParamCard>

    <ParamCard
      title="Vouch influence"
      description="How graph links contribute and which decoded weights are accepted."
    >
      <FieldRow label="Damping">
        {formatFixed(params.dampingFp, params.precisionScale)}
      </FieldRow>
      <FieldRow label="Minimum weight">
        {formatFixed(params.minWeightFp, params.precisionScale)}
      </FieldRow>
      <FieldRow label="Maximum weight">
        {formatFixed(params.maxWeightFp, params.precisionScale)}
      </FieldRow>
    </ParamCard>

    <ParamCard
      title="Computation"
      description="The score supply and deterministic convergence bounds used by the guest."
    >
      <FieldRow label="Points pool">
        {formatFixed(params.totalPool, params.precisionScale)}
      </FieldRow>
      <FieldRow label="Tolerance">
        {formatFixed(params.toleranceFp, params.precisionScale)}
      </FieldRow>
      <FieldRow label="Maximum iterations">{params.maxIterations}</FieldRow>
    </ParamCard>

    <ParamCard
      title="Fixed identity"
      description="These fields define the instance and guest input format. They require a constitutional migration, not a scoring edit."
    >
      <details>
        <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium">
          Show read-only identity
        </summary>
        <FieldRow label="Schema UID">
          <span className="break-all font-mono text-xs">
            {params.schemaUid}
          </span>
        </FieldRow>
        <FieldRow label="Accumulator">
          <span className="break-all font-mono text-xs">
            {params.accumulator}
          </span>
        </FieldRow>
        <FieldRow label="Chain ID">
          {BigInt(params.chainId).toString()}
        </FieldRow>
        <FieldRow label="Precision scale">
          {params.precisionScale.toString()}
        </FieldRow>
        <FieldRow label="Weight field index">
          {params.weightFieldIndex}
        </FieldRow>
        <FieldRow label="Lane 2">
          {(params.envelope0DomainSeparators?.length ?? 0) === 0
            ? 'Disabled'
            : 'Configured'}
        </FieldRow>
      </details>
    </ParamCard>
  </div>
)

const VersionHistory = ({ instanceId }: { instanceId: string }) => {
  const history = useQuery(ponderQueries.parameterHistory(instanceId))
  if (history.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>
  }
  if (history.isError || !history.data) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-sm text-muted-foreground">
        History is unavailable from the indexer. The current tuple above still
        comes directly from the controller.
      </div>
    )
  }
  if (history.data.versions.length === 0) {
    return <p className="text-sm text-muted-foreground">No versions indexed.</p>
  }

  const ascending = [...history.data.versions].sort(
    (a, b) => Number(a.version) - Number(b.version)
  )
  return (
    <div className="space-y-3">
      {[...ascending].reverse().map((version) => {
        const prior = ascending.find(
          (candidate) =>
            BigInt(candidate.version) === BigInt(version.version) - 1n
        )
        const diffs = prior
          ? diffParams(
              paramsFromJson(prior.params),
              paramsFromJson(version.params)
            )
          : []
        return (
          <details
            key={`${version.version}:${version.executedTxHash}`}
            className="min-w-0 border border-border bg-surface"
          >
            <summary className="grid min-h-11 cursor-pointer gap-2 p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center">
              <span className="font-medium">Version {version.version}</span>
              <span className="text-xs text-muted-foreground">
                {version.state === 'current-unpinned'
                  ? 'Executed, awaiting checkpoint'
                  : version.state === 'active'
                    ? 'Active at latest pinned version'
                    : version.state === 'inconsistent'
                      ? 'Inconsistent — ignored'
                      : 'Superseded prospectively'}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {shortHash(version.paramsHash)}
              </span>
            </summary>
            <div className="min-w-0 space-y-4 border-t border-border p-4">
              {!version.valid && (
                <p className="border border-error/40 bg-error-soft p-3 text-xs text-error">
                  {version.invalidReason ||
                    'This event failed consistency checks.'}
                </p>
              )}
              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">Executed by</p>
                  <AddressView address={version.executor} displayMode="auto" />
                </div>
                <div>
                  <p className="text-muted-foreground">Executed</p>
                  <p>{timeLabel(version.executedTimestamp)}</p>
                  <p className="text-muted-foreground">
                    Block {version.executedAtBlock}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">First checkpoint</p>
                  <p>{version.firstCheckpoint ?? 'Not pinned yet'}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground">Evidence</p>
                  {version.evidenceURI ? (
                    <a
                      href={version.evidenceURI}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all underline underline-offset-4"
                    >
                      {version.evidenceURI}
                    </a>
                  ) : (
                    'None published'
                  )}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium">
                  {prior ? 'Field-level change' : 'Initial configuration'}
                </p>
                {diffs.length ? (
                  <div className="space-y-2">
                    {diffs.map((diff) => (
                      <div
                        key={diff.field}
                        className="grid min-w-0 gap-1 border-l-2 border-border pl-3 text-xs sm:grid-cols-[10rem_1fr]"
                      >
                        <span className="font-medium">{diff.label}</span>
                        <span className="min-w-0 break-words text-muted-foreground">
                          {diff.before} → {diff.after}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Version 1 established the tuple; no settled root was changed
                    retroactively.
                  </p>
                )}
              </div>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">
                  Exact tuple and provenance
                </summary>
                <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-all bg-surface-2 p-3 text-xs">
                  {JSON.stringify(version.params, null, 2)}
                </pre>
                <p className="mt-2 break-all font-mono text-xs">
                  Transaction: {version.executedTxHash}
                </p>
              </details>
            </div>
          </details>
        )
      })}
    </div>
  )
}

const safeBundleDownload = (
  safe: Address,
  chainId: bigint,
  actions: ParameterAction[],
  name: string
) => {
  const bundle = {
    version: '1.0',
    chainId: chainId.toString(),
    createdAt: Date.now(),
    meta: {
      name,
      description: 'Trustgraphs scoring parameter update',
      txBuilderVersion: '1.18.0',
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: '',
      checksum: '',
    },
    transactions: actions.map((action) => ({
      to: action.target,
      value: action.value,
      data: action.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  }
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `trustgraph-scoring-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
}

const proposalBundleDownload = ({
  networkName,
  chainId,
  parentHash,
  proposedHash,
  title,
  description,
  actions,
}: {
  networkName: string
  chainId: bigint
  parentHash: Hex
  proposedHash: Hex
  title: string
  description: string
  actions: ParameterAction[]
}) => {
  const bundle = {
    schema: 'trustgraph.scoring-proposal.v1',
    network: networkName,
    chainId: chainId.toString(),
    parentHash,
    proposedHash,
    generatedAt: new Date().toISOString(),
    proposal: {
      title,
      description,
      targets: actions.map((action) => action.target),
      values: actions.map((action) => action.value),
      calldatas: actions.map((action) => action.data),
      operations: actions.map((action) => action.operation),
      actionDescriptions: actions.map((action) => action.description),
    },
    actions: actions.map((action, index) => ({
      order: index + 1,
      contract: action.contractName,
      function: action.functionSignature,
      target: action.target,
      value: action.value,
      operation: 'CALL',
      calldata: action.data,
      calldataDigest: keccak256(action.data),
      description: action.description,
    })),
  }
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `trustgraph-${networkName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-scoring-proposal.json`
  link.click()
  URL.revokeObjectURL(url)
}

const LiveScoringSettings = ({
  instance,
  factoryAddress,
  liveParamsHash,
  checkpointCount,
}: {
  instance: InstanceRow | null
  factoryAddress?: Address
  liveParamsHash?: Hex
  checkpointCount?: bigint
}) => {
  const router = useRouter()
  const queryClient = useQueryClient()
  const publicClient = usePublicClient()
  const { address: connectedAddress } = useAccount()
  const { network } = useNetwork()
  const governance = useGovernance()
  const instanceId = network.instanceId ?? instance?.id ?? ''
  const snapshotAddress = network.contracts.merkleSnapshot
  const resolverAddress = network.contracts.easIndexerResolver
  const governanceAddress = realAddress(network.contracts.merkleGovModule)
  const controller = useControllerState({
    instance,
    instanceId,
    factoryAddress,
    snapshotAddress,
    liveParamsHash,
  })
  const authority = useAuthority({
    owner: controller.owner,
    connectedAddress,
    governanceAddress,
    governanceCanPropose: governance.canCreateProposal,
  })

  const companionAddress = network.safeZodiacSignerSync.enabled
    ? realAddress(network.contracts.safe?.signerSyncManager)
    : undefined
  const { data: companionReads, refetch: refetchCompanion } = useReadContracts({
    contracts: companionAddress
      ? [
          {
            address: companionAddress,
            abi: signerParamsAbi,
            functionName: 'paramsHash' as const,
          },
          {
            address: companionAddress,
            abi: signerParamsAbi,
            functionName: 'paramsAuthority' as const,
          },
        ]
      : [],
    query: { enabled: !!companionAddress, refetchInterval: 10_000 },
  })
  const companionHash = readResult(companionReads, 0) as Hex | undefined
  const companionAuthority = realAddress(
    readResult(companionReads, 1) as string | undefined
  )
  const companionAuthorityConsistent =
    !companionAddress || sameHex(companionAuthority, controller.owner)
  const companionConsistent =
    !companionAddress ||
    (sameHex(companionHash, controller.controllerHash) &&
      companionAuthorityConsistent)

  // Activation happens at trigger/pinning, not proof settlement. The most recent accumulator
  // checkpoint is therefore the truthful direct-RPC boundary even while its proof is in flight.
  const checkpointId =
    checkpointCount !== undefined && checkpointCount > 0n
      ? (checkpointCount - 1n).toString()
      : ''
  const { data: pinnedReads } = useReadContracts({
    contracts: checkpointId
      ? [
          {
            address: snapshotAddress,
            abi: merkleSnapshotAbi,
            functionName: 'checkpointParamsHash' as const,
            args: [BigInt(checkpointId)],
          },
          {
            address: resolverAddress,
            abi: [
              {
                type: 'function',
                name: 'getCheckpoint',
                stateMutability: 'view',
                inputs: [
                  { name: 'id', internalType: 'uint256', type: 'uint256' },
                ],
                outputs: [
                  {
                    name: '',
                    internalType: 'struct IAttestationAccumulator.Checkpoint',
                    type: 'tuple',
                    components: [
                      { name: 'acc', internalType: 'bytes32', type: 'bytes32' },
                      {
                        name: 'leafCount',
                        internalType: 'uint64',
                        type: 'uint64',
                      },
                      {
                        name: 'blockNumber',
                        internalType: 'uint64',
                        type: 'uint64',
                      },
                    ],
                  },
                ],
              },
            ] as const,
            functionName: 'getCheckpoint' as const,
            args: [BigInt(checkpointId)],
          },
        ]
      : [],
    query: { enabled: !!checkpointId },
  })
  const pinnedHash = readResult(pinnedReads, 0) as Hex | undefined
  const checkpointTuple = readResult(pinnedReads, 1)
  const checkpointAcc = tupleValue(checkpointTuple, 'acc', 0) as Hex | undefined
  const checkpointLeafCount = tupleValue(checkpointTuple, 'leafCount', 1) as
    | bigint
    | undefined

  const history = useQuery(ponderQueries.parameterHistory(instanceId))
  const indexedCurrent = history.data?.versions.find(
    (version) => version.version === controller.version?.toString()
  )
  const currentState = sameHex(pinnedHash, controller.controllerHash)
    ? 'active'
    : 'current-unpinned'

  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [parentHash, setParentHash] = useState<Hex | undefined>()
  const [fields, setFields] = useState<DraftFields | undefined>()
  const [rationale, setRationale] = useState('')
  const [evidenceURI, setEvidenceURI] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const openEditor = useCallback(() => {
    if (!controller.params || !controller.controllerHash) return
    let stored: StoredDraft | null = null
    try {
      const raw = window.localStorage.getItem(paramsDraftKey(instanceId))
      stored = raw ? (JSON.parse(raw) as StoredDraft) : null
    } catch {
      stored = null
    }
    setParentHash(stored?.parentHash ?? controller.controllerHash)
    setFields(stored?.fields ?? fieldsFromParams(controller.params))
    setRationale(stored?.rationale ?? '')
    setEvidenceURI(stored?.evidenceURI ?? '')
    setReviewing(false)
    setActionError(null)
    setEditing(true)
  }, [controller.params, controller.controllerHash, instanceId])

  const parsedDraft = useMemo(
    () =>
      fields && controller.params
        ? paramsFromFields(fields, controller.params)
        : { errors: {} },
    [fields, controller.params]
  )
  const proposed = parsedDraft.params
  const proposedHash = proposed ? paramsHash(proposed) : undefined
  const companionReadyForDraft =
    !companionAddress ||
    (companionAuthorityConsistent &&
      (sameHex(companionHash, controller.controllerHash) ||
        sameHex(companionHash, proposedHash)))
  const envelope =
    proposed && controller.params
      ? validateParamsUpdate(
          proposed,
          controller.params,
          controller.controllerHash
        )
      : { valid: false, errors: {} }
  const draftErrors = { ...parsedDraft.errors, ...envelope.errors }
  const staleParent =
    !!parentHash &&
    !!controller.controllerHash &&
    !sameHex(parentHash, controller.controllerHash)
  const changedSeedSet = proposed
    ? proposed.trustedSeeds.join(',').toLowerCase() !==
      controller.params?.trustedSeeds.join(',').toLowerCase()
    : false

  useEffect(() => {
    if (!editing || !fields || !parentHash) return
    const record: StoredDraft = {
      parentHash,
      fields,
      rationale,
      evidenceURI,
    }
    window.localStorage.setItem(
      paramsDraftKey(instanceId),
      JSON.stringify(record)
    )
  }, [editing, evidenceURI, fields, instanceId, parentHash, rationale])

  useEffect(() => {
    if (!editing) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    const captureLinks = (event: MouseEvent) => {
      const target = event.target
      const link =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>('a[href]')
          : null
      if (
        link &&
        !window.confirm('Leave this scoring draft? It is saved locally.')
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', captureLinks, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', captureLinks, true)
    }
  }, [editing])

  const checkpointInputs = useQuery(
    ponderQueries.checkpointInputs(snapshotAddress, checkpointId)
  )
  const edges = useMemo<RawEdge[] | undefined>(() => {
    if (!checkpointInputs.data) return undefined
    return checkpointInputs.data.inputs.map((input) => ({
      kind: input.kind,
      attester: input.attester,
      recipient: input.recipient,
      uid: input.uid,
      data: input.data,
      blockTimestamp: BigInt(input.blockTimestamp),
    }))
  }, [checkpointInputs.data])
  const preview = useMemo(() => {
    if (!edges || !controller.params || !proposed) return undefined
    try {
      return previewScoringChange({
        edges,
        current: controller.params,
        proposed,
        ...(network.safeZodiacSignerSync.enabled
          ? {
              signerSelection: {
                topN: network.safeZodiacSignerSync.topNSigners,
                minThreshold: network.safeZodiacSignerSync.minThreshold,
                targetThresholdBps: Math.round(
                  network.safeZodiacSignerSync.targetThreshold * 10_000
                ),
                maxInactiveBlocks: BigInt(
                  network.safeZodiacSignerSync.maxInactiveBlocks ?? '151200'
                ),
                minActivityWitnesses:
                  network.safeZodiacSignerSync.minActivityWitnesses ?? 2,
              },
            }
          : {}),
      })
    } catch (error) {
      console.error('Scoring preview failed', error)
      return undefined
    }
  }, [controller.params, edges, network.safeZodiacSignerSync, proposed])
  const previewConsistent =
    !!preview &&
    sameHex(preview.inputAcc, checkpointAcc) &&
    preview.inputCount === checkpointLeafCount

  const preflight = useQuery({
    queryKey: [
      'scoring-preflight',
      controller.controllerAddress,
      proposedHash,
      evidenceURI,
      companionAddress,
      companionAuthority,
    ],
    queryFn: async () => {
      if (
        !publicClient ||
        !controller.controllerAddress ||
        !controller.owner ||
        !proposed ||
        !proposedHash
      ) {
        throw new Error('The controller preflight is unavailable.')
      }
      if (companionAddress) {
        if (!companionAuthority) {
          throw new Error('The signer companion authority could not be read.')
        }
        await publicClient.simulateContract({
          address: companionAddress,
          abi: signerParamsAbi,
          functionName: 'setParamsHash',
          args: [proposedHash],
          account: companionAuthority,
        })
      }
      await publicClient.simulateContract({
        address: controller.controllerAddress,
        abi: trustgraphsParamsControllerAbi,
        functionName: 'updateParams',
        args: [paramsToContract(proposed), evidenceURI],
        account: controller.owner,
      })
      return true
    },
    enabled:
      envelope.valid &&
      !staleParent &&
      companionReadyForDraft &&
      !!publicClient &&
      !!controller.owner &&
      !!proposedHash,
    retry: false,
  })

  const actions = useMemo(
    () =>
      controller.controllerAddress && proposed
        ? buildParameterActions({
            controller: controller.controllerAddress,
            proposed,
            evidenceURI,
            ...(companionAddress ? { signerCompanion: companionAddress } : {}),
          })
        : [],
    [companionAddress, controller.controllerAddress, evidenceURI, proposed]
  )
  const proposedDiffs = useMemo(
    () =>
      controller.params && proposed
        ? diffParams(controller.params, proposed)
        : [],
    [controller.params, proposed]
  )
  const proposalTitle = `Update ${network.name} scoring parameters`
  const proposalDescription = `${rationale.trim()}\n\nParent hash: ${parentHash ?? 'Unavailable'}\nProposed hash: ${proposedHash ?? 'Unavailable'}\n\n${proposedDiffs
    .map((diff) => `${diff.label}: ${diff.before} → ${diff.after}`)
    .join('\n')}`
  const proposalActions = useMemo(
    () =>
      actions.map((action) => ({
        ...action,
        description:
          action.target === controller.controllerAddress
            ? `Publish scoring update: ${proposedDiffs.map((diff) => diff.label).join(', ')}`
            : action.description,
      })),
    [actions, controller.controllerAddress, proposedDiffs]
  )
  const operationSalt = useMemo(
    () =>
      proposedHash && parentHash
        ? keccak256(
            stringToBytes(
              `${instanceId}:${parentHash}:${proposedHash}:${evidenceURI}`
            )
          )
        : ZERO_BYTES32,
    [evidenceURI, instanceId, parentHash, proposedHash]
  )
  const timelockState = useQuery({
    queryKey: [
      'scoring-timelock-operation',
      authority.data?.kind === 'timelock' ? authority.data.owner : '',
      operationSalt,
      actions.map((action) => action.data).join(':'),
    ],
    queryFn: async () => {
      const route = authority.data
      if (!publicClient || route?.kind !== 'timelock') return null
      const targets = actions.map((action) => action.target)
      const values = actions.map(() => 0n)
      const payloads = actions.map((action) => action.data)
      const id = await publicClient.readContract({
        address: route.owner,
        abi: timelockAbi,
        functionName: 'hashOperationBatch',
        args: [targets, values, payloads, ZERO_BYTES32, operationSalt],
      })
      const timestamp = await publicClient.readContract({
        address: route.owner,
        abi: timelockAbi,
        functionName: 'getTimestamp',
        args: [id],
      })
      let cancelled: boolean | null = false
      if (timestamp === 0n) {
        try {
          const cancellations = await publicClient.getLogs({
            address: route.owner,
            event: timelockCancelledEvent,
            args: { id },
            fromBlock: 0n,
          })
          cancelled = cancellations.length > 0
        } catch {
          // Some RPC providers restrict historical log ranges. Keep the operation usable,
          // but avoid claiming it has never been cancelled when history is unavailable.
          cancelled = null
        }
      }
      return { id, timestamp, cancelled }
    },
    enabled:
      authority.data?.kind === 'timelock' && actions.length > 0 && reviewing,
    refetchInterval: 10_000,
  })

  const closeEditor = () => {
    if (
      window.confirm('Close this draft? It will remain saved on this device.')
    ) {
      setEditing(false)
    }
  }

  const clearDraft = () => {
    window.localStorage.removeItem(paramsDraftKey(instanceId))
    setEditing(false)
  }

  const applyDirect = async () => {
    if (
      !controller.controllerAddress ||
      !connectedAddress ||
      !proposed ||
      !proposedHash ||
      staleParent
    ) {
      return
    }
    setApplying(true)
    setActionError(null)
    let companionCompleted =
      !!companionAddress && sameHex(companionHash, proposedHash)
    try {
      if (companionAddress && !companionCompleted) {
        await txToast({
          tx: {
            address: companionAddress,
            abi: signerParamsAbi,
            functionName: 'setParamsHash',
            args: [proposedHash],
          },
          successMessage:
            'Signer configuration updated. Continuing with scoring…',
        })
        companionCompleted = true
        await refetchCompanion()
      }
      await txToast({
        tx: {
          address: controller.controllerAddress,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'updateParams',
          args: [paramsToContract(proposed), evidenceURI],
        },
        successMessage:
          'Parameter version executed; awaiting its first checkpoint.',
      })
      await controller.refetch()
      await queryClient.invalidateQueries({
        queryKey: ['ponder', 'parameterHistory', instanceId],
      })
      clearDraft()
    } catch (error) {
      setActionError(
        `${transactionRecoveryMessage(error, 'parameter update')}${companionCompleted ? ' The signer leg is complete; resume the controller leg with this same draft.' : ''}`
      )
    } finally {
      setApplying(false)
    }
  }

  const createGovernanceProposal = () => {
    if (!proposedHash || !parentHash) return
    const fingerprint = paramsFingerprint(proposed!)
    saveGovernancePrefill({
      networkId: network.id,
      fingerprint,
      parentHash,
      proposedHash,
      title: proposalTitle,
      description: proposalDescription,
      actions: proposalActions,
      createdAt: Date.now(),
    })
    router.push(
      `/networks/${network.id}/governance?new=1&scoringDraft=${fingerprint}`
    )
  }

  const scheduleTimelock = async () => {
    const route = authority.data
    if (route?.kind !== 'timelock') return
    setApplying(true)
    setActionError(null)
    try {
      await txToast({
        tx: {
          address: route.owner,
          abi: timelockAbi,
          functionName: 'scheduleBatch',
          args: [
            actions.map((action) => action.target),
            actions.map(() => 0n),
            actions.map((action) => action.data),
            ZERO_BYTES32,
            operationSalt,
            route.minDelay,
          ],
        },
        successMessage: 'Parameter update scheduled.',
      })
      await timelockState.refetch()
    } catch (error) {
      setActionError(transactionRecoveryMessage(error, 'timelock scheduling'))
    } finally {
      setApplying(false)
    }
  }

  const executeTimelock = async () => {
    const route = authority.data
    if (route?.kind !== 'timelock') return
    setApplying(true)
    setActionError(null)
    try {
      await txToast({
        tx: {
          address: route.owner,
          abi: timelockAbi,
          functionName: 'executeBatch',
          args: [
            actions.map((action) => action.target),
            actions.map(() => 0n),
            actions.map((action) => action.data),
            ZERO_BYTES32,
            operationSalt,
          ],
        },
        successMessage: 'Scheduled parameter version executed.',
      })
      await controller.refetch()
      await timelockState.refetch()
      await queryClient.invalidateQueries({
        queryKey: ['ponder', 'parameterHistory', instanceId],
      })
      clearDraft()
    } catch (error) {
      setActionError(transactionRecoveryMessage(error, 'timelock execution'))
    } finally {
      setApplying(false)
    }
  }

  if (!controller.controllerAddress) {
    return (
      <section className="space-y-5">
        <SectionHeading n="03">Scoring parameters</SectionHeading>
        <div className="border border-border bg-surface p-5">
          <Status tone="muted">Legacy parameter control</Status>
          <h2 className="mt-4 text-lg font-semibold">
            This network has no typed parameter controller.
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Its snapshot exposes only a raw hash, so the app cannot prove the
            complete live tuple or offer a safe editor. Creation-time values may
            be inspected below, but they are not labelled current if the live
            hash has moved. A constitutional migration is required.
          </p>
          {instance?.params && (
            <details className="mt-4">
              <summary className="min-h-11 cursor-pointer py-3 text-sm">
                Show creation-time tuple
              </summary>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-surface-2 p-3 text-xs">
                {JSON.stringify(instance.params, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </section>
    )
  }

  if (
    controller.consistencyError ||
    (!controller.params && !controller.isLoading)
  ) {
    return (
      <section className="space-y-5">
        <SectionHeading n="03">Scoring parameters</SectionHeading>
        <div className="border border-error/50 bg-error-soft p-5 text-error">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Current configuration is
            inconsistent
          </div>
          <p className="mt-2 text-sm">
            {controller.consistencyError ||
              'The complete controller tuple could not be read.'}
          </p>
          <p className="mt-2 text-xs">
            Editing and proving must fail closed until controller, snapshot, and
            registry agree.
          </p>
        </div>
      </section>
    )
  }

  if (!controller.params || !controller.controllerHash) {
    return (
      <section className="space-y-5">
        <SectionHeading n="03">Scoring parameters</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Reading the current tuple directly from the controller…
        </p>
      </section>
    )
  }

  const route = authority.data
  const scheduledAt = timelockState.data?.timestamp ?? 0n
  const ready =
    scheduledAt > 1n && scheduledAt <= BigInt(Math.floor(Date.now() / 1_000))
  const preflightReady = envelope.valid && preflight.isSuccess && !staleParent
  const reviewAllowed =
    preflightReady && rationale.trim().length > 0 && previewConsistent
  const noAuthorityAction =
    !route ||
    route.kind === 'unavailable' ||
    route.kind === 'contract' ||
    (route.kind === 'direct' && !route.canAct) ||
    (route.kind === 'timelock' &&
      !route.canPropose &&
      !(ready && route.canExecute))

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <SectionHeading n="03">Current scoring configuration</SectionHeading>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Read directly from the typed controller. This is the complete tuple
            the next checkpoint will pin.
          </p>
        </div>
        <Button onClick={openEditor} size="lg" className="w-full sm:w-auto">
          Propose changes
        </Button>
      </div>

      <Card type="primary" size="md" className="min-w-0">
        <div className="grid gap-4 md:grid-cols-[auto_1fr_auto] md:items-center">
          <div>
            <p className="tg-label">Version</p>
            <p className="mt-1 text-3xl tabular-nums">
              {controller.version?.toString() ?? '—'}
            </p>
          </div>
          <div className="min-w-0">
            <p className="tg-label">Live hash</p>
            <CopyableText
              text={controller.controllerHash}
              truncateOnMobile
              alwaysShowCopyIcon
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Executed {timeLabel(indexedCurrent?.executedTimestamp)}
            </p>
          </div>
          <div className="md:text-right">
            {currentState === 'active' ? (
              <Status tone="good">
                <CheckCircle2 className="h-3.5 w-3.5" /> Active from checkpoint{' '}
                {indexedCurrent?.firstCheckpoint ?? checkpointId}
              </Status>
            ) : (
              <Status tone="warn">
                <History className="h-3.5 w-3.5" /> Executed, awaiting next
                checkpoint
              </Status>
            )}
            <p className="mt-2 max-w-xs text-xs text-muted-foreground">
              Execution is prospective. Already frozen checkpoints and settled
              roots keep their original parameter hash.
            </p>
          </div>
        </div>
      </Card>

      {!companionConsistent && (
        <div className="border border-error/50 bg-error-soft p-4 text-sm text-error">
          The signer-sync companion does not share both the controller hash and
          its narrow parameter authority. A change cannot be reported complete
          until both consumers agree.
        </div>
      )}

      <CurrentParameterCards params={controller.params} />

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Version history</h2>
        <p className="text-sm text-muted-foreground">
          Append-only execution and activation history. A rollback publishes a
          new version; it never rewrites a past root.
        </p>
        <VersionHistory instanceId={instanceId} />
      </div>

      <details className="min-w-0 border border-border bg-surface px-5 py-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
          Advanced: exact current tuple and authority
        </summary>
        <div className="space-y-3 pb-3 text-xs">
          <p>
            Controller:{' '}
            <span className="break-all font-mono">
              {controller.controllerAddress}
            </span>
          </p>
          <p>
            Owner:{' '}
            <span className="break-all font-mono">{controller.owner}</span>
          </p>
          <p>Control path: {authorityLabel(route)}</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-surface-2 p-3">
            {JSON.stringify(paramsToJson(controller.params), null, 2)}
          </pre>
        </div>
      </details>

      <Modal
        isOpen={editing}
        onClose={closeEditor}
        title={reviewing ? 'Review scoring change' : 'Draft scoring change'}
        className="max-w-5xl"
        contentClassName="p-4 sm:p-6"
      >
        {fields && (
          <div className="min-w-0 space-y-6">
            {staleParent && (
              <div className="border border-error/50 bg-error-soft p-4 text-sm text-error">
                This draft began from {shortHash(parentHash)}, but the
                controller is now {shortHash(controller.controllerHash)}. Review
                the newer tuple and start a fresh draft; this one cannot be
                submitted.
              </div>
            )}

            {!reviewing ? (
              <>
                <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                  <div className="min-w-0 space-y-5">
                    <div>
                      <h3 className="font-semibold">Trusted accounts</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Seeds define where inherited trust begins. Removing one
                        is deliberately conspicuous because it can move the
                        entire graph.
                      </p>
                    </div>
                    <div className="space-y-3">
                      {fields.seeds.map((seed, index) => (
                        <div
                          key={`${index}:${seed.input}`}
                          className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem] gap-2"
                        >
                          <AccountIdentifierInput
                            value={seed.input}
                            className="h-11 font-mono"
                            placeholder="0x… or name.eth"
                            onChange={(event) => {
                              const seeds = [...fields.seeds]
                              seeds[index] = {
                                input: event.target.value,
                                resolved: isAddress(event.target.value)
                                  ? (event.target.value as Address)
                                  : null,
                              }
                              setFields({ ...fields, seeds })
                            }}
                            onResolvedAddressChange={(resolved) => {
                              setFields((current) => {
                                if (!current) return current
                                const seeds = [...current.seeds]
                                const existing = seeds[index]
                                if (
                                  !existing ||
                                  existing.resolved === resolved
                                ) {
                                  return current
                                }
                                seeds[index] = { ...existing, resolved }
                                return { ...current, seeds }
                              })
                            }}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghostDestructive"
                            className="h-11 w-11"
                            aria-label={`Remove trusted account ${index + 1}`}
                            onClick={() =>
                              setFields({
                                ...fields,
                                seeds: fields.seeds.filter(
                                  (_, seedIndex) => seedIndex !== index
                                ),
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      onClick={() =>
                        setFields({
                          ...fields,
                          seeds: [
                            ...fields.seeds,
                            { input: '', resolved: null },
                          ],
                        })
                      }
                    >
                      <Plus /> Add trusted account
                    </Button>
                    {draftErrors.trustedSeeds && (
                      <p className="text-xs text-error" role="alert">
                        {draftErrors.trustedSeeds}
                      </p>
                    )}
                    {changedSeedSet && (
                      <p className="border border-error/40 bg-error-soft p-3 text-xs text-error">
                        Elevated impact: this changes where trust starts. The
                        preview below must be available before review.
                      </p>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <InputField
                        id="trust-share"
                        label="Starting share"
                        value={fields.trustShare}
                        onChange={(trustShare) =>
                          setFields({ ...fields, trustShare })
                        }
                        error={
                          draftErrors.trustShare ?? draftErrors.trustShareFp
                        }
                      />
                      <InputField
                        id="trust-decay"
                        label="Distance decay"
                        value={fields.trustDecay}
                        onChange={(trustDecay) =>
                          setFields({ ...fields, trustDecay })
                        }
                        error={
                          draftErrors.trustDecay ?? draftErrors.trustDecayFp
                        }
                      />
                    </div>
                  </div>

                  <div className="min-w-0 space-y-6">
                    <div className="space-y-4">
                      <div>
                        <h3 className="font-semibold">Vouch influence</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Damping controls how much standing follows vouches on
                          each iteration.
                        </p>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <InputField
                          id="damping"
                          label="Damping"
                          value={fields.damping}
                          onChange={(damping) =>
                            setFields({ ...fields, damping })
                          }
                          error={draftErrors.damping ?? draftErrors.dampingFp}
                        />
                        <InputField
                          id="minimum-weight"
                          label="Minimum vouch weight"
                          value={fields.minWeight}
                          onChange={(minWeight) =>
                            setFields({ ...fields, minWeight })
                          }
                          error={draftErrors.minWeight ?? draftErrors.weights}
                        />
                        <InputField
                          id="maximum-weight"
                          label="Maximum vouch weight"
                          value={fields.maxWeight}
                          onChange={(maxWeight) =>
                            setFields({ ...fields, maxWeight })
                          }
                          error={draftErrors.maxWeight ?? draftErrors.weights}
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <h3 className="font-semibold">Computation</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Human units are converted once to the exact 1e18
                          fixed-point tuple.
                        </p>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <InputField
                          id="points-pool"
                          label="Points pool"
                          value={fields.totalPool}
                          onChange={(totalPool) =>
                            setFields({ ...fields, totalPool })
                          }
                          error={draftErrors.totalPool}
                        />
                        <InputField
                          id="tolerance"
                          label="Convergence tolerance"
                          value={fields.tolerance}
                          onChange={(tolerance) =>
                            setFields({ ...fields, tolerance })
                          }
                          error={
                            draftErrors.tolerance ?? draftErrors.toleranceFp
                          }
                        />
                        <InputField
                          id="max-iterations"
                          label="Maximum iterations"
                          value={fields.maxIterations}
                          onChange={(maxIterations) =>
                            setFields({ ...fields, maxIterations })
                          }
                          error={draftErrors.maxIterations}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="change-rationale">Rationale</Label>
                    <textarea
                      id="change-rationale"
                      className="min-h-28 w-full border border-input bg-surface p-3 text-sm focus:border-ink focus:outline-none"
                      value={rationale}
                      onChange={(event) => setRationale(event.target.value)}
                      placeholder="What should the community understand about this change?"
                    />
                    {!rationale.trim() && (
                      <p className="text-xs text-muted-foreground">
                        Required before review.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="evidence-uri">
                      Evidence URI (optional)
                    </Label>
                    <Input
                      id="evidence-uri"
                      className="h-11"
                      value={evidenceURI}
                      onChange={(event) => setEvidenceURI(event.target.value)}
                      placeholder="ipfs://… or https://…"
                    />
                    <p className="text-xs text-muted-foreground">
                      Supporting rationale or a preview artifact. The full tuple
                      remains on-chain even if this URI disappears.
                    </p>
                  </div>
                </div>

                <div className="border border-border bg-surface-2 p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    {!envelope.valid ? (
                      <Status tone="warn">Client validation incomplete</Status>
                    ) : preflight.isFetching ? (
                      <Status tone="muted">
                        Simulating controller update…
                      </Status>
                    ) : preflight.isSuccess ? (
                      <Status tone="good">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Contract
                        preflight passed
                      </Status>
                    ) : preflight.isError ? (
                      <Status tone="warn">Contract preflight failed</Status>
                    ) : (
                      <Status tone="muted">Waiting for valid fields</Status>
                    )}
                    {proposedHash && (
                      <span className="font-mono text-xs">
                        Proposed {shortHash(proposedHash)}
                      </span>
                    )}
                  </div>
                  {preflight.error && (
                    <p className="mt-2 text-xs text-error">
                      {parseErrorMessage(preflight.error)}
                    </p>
                  )}
                </div>

                <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    onClick={clearDraft}
                  >
                    Discard draft
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    disabled={!reviewAllowed}
                    onClick={() => setReviewing(true)}
                  >
                    Review change <ChevronRight />
                  </Button>
                </div>
              </>
            ) : (
              <div className="min-w-0 space-y-6">
                {preview && controller.params && proposed && (
                  <ScoringGraphPreview
                    preview={preview}
                    currentSeeds={controller.params.trustedSeeds}
                    proposedSeeds={proposed.trustedSeeds}
                  />
                )}

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Card type="detail" size="md">
                    <p className="tg-label">Gain / lose / unchanged</p>
                    <p className="mt-2 text-xl tabular-nums">
                      {preview?.gained} / {preview?.lost} / {preview?.unchanged}
                    </p>
                  </Card>
                  <Card type="detail" size="md">
                    <p className="tg-label">Trusted score mass</p>
                    <p className="mt-2 text-xl tabular-nums">
                      {((preview?.currentTrustedMassBps ?? 0) / 100).toFixed(2)}
                      %{' → '}
                      {((preview?.proposedTrustedMassBps ?? 0) / 100).toFixed(
                        2
                      )}
                      %
                    </p>
                  </Card>
                  <Card type="detail" size="md">
                    <p className="tg-label">Top-10 concentration</p>
                    <p className="mt-2 text-xl tabular-nums">
                      {((preview?.currentTopTenMassBps ?? 0) / 100).toFixed(2)}%
                      {' → '}
                      {((preview?.proposedTopTenMassBps ?? 0) / 100).toFixed(2)}
                      %
                    </p>
                  </Card>
                  <Card type="detail" size="md">
                    <p className="tg-label">Convergence</p>
                    <p className="mt-2 text-sm">
                      Current{' '}
                      {preview?.currentConverged ? 'converged' : 'hit cap'} in{' '}
                      {preview?.currentIterations} iterations
                    </p>
                    <p className="text-sm">
                      Proposed{' '}
                      {preview?.proposedConverged ? 'converged' : 'hit cap'} in{' '}
                      {preview?.proposedIterations} iterations
                    </p>
                  </Card>
                </div>

                <div className="border border-border bg-surface-2 p-4 text-sm">
                  <p className="font-medium">
                    Preview over checkpoint {checkpointId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Input cutoff block{' '}
                    {checkpointInputs.data?.cutoff.blockNumber}, log{' '}
                    {checkpointInputs.data?.cutoff.logIndex};{' '}
                    {preview?.inputCount.toString()} folded records. The
                    recomputed accumulator matches the chain checkpoint.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    This is evidence, not a promise. It does not alter an
                    already-funded reward distribution, settled root, or
                    contribution round.
                  </p>
                </div>

                {preview?.signerChange && (
                  <div className="border border-border p-4 text-sm">
                    <p className="font-medium">Signer-sync outcome</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {preview.signerChange.changed
                        ? `The top signer set or threshold changes (${preview.signerChange.currentThreshold} → ${preview.signerChange.proposedThreshold}).`
                        : 'The top signer set and target threshold do not change.'}
                    </p>
                  </div>
                )}

                <details className="border border-border">
                  <summary className="min-h-11 cursor-pointer p-4 text-sm font-medium">
                    Account-level score diff (largest movers)
                  </summary>
                  <div className="overflow-x-auto border-t border-border">
                    <table className="w-full min-w-[38rem] text-left text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="p-3">Account</th>
                          <th className="p-3">Current</th>
                          <th className="p-3">Proposed</th>
                          <th className="p-3">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview?.largestMovers.map((move) => (
                          <tr
                            key={move.account}
                            className="border-t border-border"
                          >
                            <td className="p-3 font-mono">{move.account}</td>
                            <td className="p-3">{move.current.toString()}</td>
                            <td className="p-3">{move.proposed.toString()}</td>
                            <td className="p-3">{move.delta.toString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>

                <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                  <Card type="detail" size="md" className="min-w-0">
                    <p className="font-medium">Bound review</p>
                    <FieldRow label="Parent hash">
                      <span className="break-all font-mono text-xs">
                        {parentHash}
                      </span>
                    </FieldRow>
                    <FieldRow label="Proposed hash">
                      <span className="break-all font-mono text-xs">
                        {proposedHash}
                      </span>
                    </FieldRow>
                    <FieldRow label="Draft fingerprint">
                      <span className="break-all font-mono text-xs">
                        {proposed && paramsFingerprint(proposed)}
                      </span>
                    </FieldRow>
                    <FieldRow label="Evidence URI">
                      <span className="break-all text-xs">
                        {evidenceURI || 'None'}
                      </span>
                    </FieldRow>
                    <p className="mt-3 whitespace-pre-wrap text-xs text-muted-foreground">
                      {rationale}
                    </p>
                  </Card>
                  <Card type="detail" size="md" className="min-w-0">
                    <p className="font-medium">Proposal execution plan</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Execution path: {authorityLabel(route)}. If approved,
                      these calls run in this exact order. The signer companion
                      is synchronized first; the controller publishes the new
                      version last.
                    </p>
                    <ProposalActionList
                      actions={actions}
                      proposalDescription={proposalDescription}
                      className="mt-4"
                    />
                    {parentHash && proposedHash && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4 w-full"
                        onClick={() =>
                          proposalBundleDownload({
                            networkName: network.name,
                            chainId: BigInt(controller.params!.chainId),
                            parentHash,
                            proposedHash,
                            title: proposalTitle,
                            description: proposalDescription,
                            actions: proposalActions,
                          })
                        }
                      >
                        <Download /> Download proposal JSON
                      </Button>
                    )}
                  </Card>
                </div>

                {route?.kind === 'timelock' && timelockState.data && (
                  <div className="border border-border bg-surface-2 p-4 text-xs">
                    <p className="font-medium">Timelock operation</p>
                    <p className="mt-1 break-all font-mono">
                      {timelockState.data.id}
                    </p>
                    <p className="mt-2 text-muted-foreground">
                      {scheduledAt === 0n
                        ? timelockState.data.cancelled === true
                          ? 'Cancelled. Schedule this operation again to restart its delay.'
                          : timelockState.data.cancelled === false
                            ? 'Not scheduled.'
                            : 'Not scheduled; cancellation history is unavailable from this RPC.'
                        : scheduledAt === 1n
                          ? 'Executed.'
                          : `Ready ${timeLabel(scheduledAt)}. Executor is ${route.permissionlessExecutor ? 'permissionless' : 'role-restricted'}.`}
                    </p>
                  </div>
                )}

                {actionError && (
                  <div
                    className="border border-error/50 bg-error-soft p-4 text-sm text-error"
                    role="alert"
                  >
                    {actionError}
                  </div>
                )}

                <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={() => setReviewing(false)}
                  >
                    Back to edit
                  </Button>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    {route?.kind === 'direct' && route.canAct && (
                      <Button
                        type="button"
                        size="lg"
                        disabled={
                          applying || !preflightReady || !companionReadyForDraft
                        }
                        onClick={applyDirect}
                      >
                        {applying ? 'Applying…' : 'Apply parameter update'}
                      </Button>
                    )}
                    {route?.kind === 'safe-governance' && (
                      <Button
                        type="button"
                        size="lg"
                        onClick={createGovernanceProposal}
                      >
                        {route.canAct
                          ? 'Create DAO proposal'
                          : 'Prepare DAO proposal'}
                      </Button>
                    )}
                    {route?.kind === 'timelock' &&
                      scheduledAt <= 1n &&
                      route.canPropose && (
                        <Button
                          type="button"
                          size="lg"
                          disabled={applying}
                          onClick={scheduleTimelock}
                        >
                          {applying
                            ? 'Scheduling…'
                            : 'Schedule parameter update'}
                        </Button>
                      )}
                    {route?.kind === 'timelock' &&
                      ready &&
                      route.canExecute && (
                        <Button
                          type="button"
                          size="lg"
                          disabled={applying}
                          onClick={executeTimelock}
                        >
                          {applying ? 'Executing…' : 'Execute scheduled update'}
                        </Button>
                      )}
                    {route?.kind === 'safe-export' && (
                      <Button
                        type="button"
                        size="lg"
                        onClick={() =>
                          safeBundleDownload(
                            route.owner,
                            BigInt(controller.params!.chainId),
                            actions,
                            `${network.name} scoring update`
                          )
                        }
                      >
                        <Download /> Export Safe transaction bundle
                      </Button>
                    )}
                    {noAuthorityAction && (
                      <Button
                        type="button"
                        size="lg"
                        variant="outline"
                        disabled={!parentHash || !proposedHash}
                        onClick={() =>
                          parentHash &&
                          proposedHash &&
                          proposalBundleDownload({
                            networkName: network.name,
                            chainId: BigInt(controller.params!.chainId),
                            parentHash,
                            proposedHash,
                            title: proposalTitle,
                            description: proposalDescription,
                            actions: proposalActions,
                          })
                        }
                      >
                        <Download /> Download action bundle
                      </Button>
                    )}
                  </div>
                </div>
                {route?.kind === 'safe-governance' && !route.canAct && (
                  <p className="border border-border bg-surface-2 p-3 text-xs text-muted-foreground">
                    The DAO controls this scoring controller, so the proposal
                    draft is executable. This wallet does not currently have
                    indexed voting power; you can still prepare and copy the
                    complete proposal, then connect an eligible member wallet to
                    submit it.
                  </p>
                )}
                {route && noAuthorityAction && (
                  <p className="text-xs text-muted-foreground">
                    {route.kind === 'direct'
                      ? `The controller is directly owned by ${controller.owner}. That owner must apply the update, or explicitly transfer controller ownership to the DAO's Safe before a DAO proposal can execute it.`
                      : route.kind === 'timelock'
                        ? `This wallet is not a proposer or ready executor for the operational timelock at ${route.owner}. Share the downloaded calls with an authorized proposer.`
                        : `The controller owner is ${controller.owner}, but the app cannot identify an executable proposal route for it. The downloaded bundle is for review; verify the owner's contract path before submission.`}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </section>
  )
}

const REVIEW_SCORING_STATES = [
  'current',
  'awaiting-checkpoint',
  'active',
  'stale',
  'invalid',
  'unauthorized',
  'safe',
  'timelock',
] as const
type ReviewScoringState = (typeof REVIEW_SCORING_STATES)[number]

const reviewParams: Params = {
  dampingFp: 850_000_000_000_000_000n,
  toleranceFp: 1_000_000_000_000n,
  maxIterations: 100,
  minWeightFp: 1_000_000_000_000_000_000n,
  maxWeightFp: 100_000_000_000_000_000_000n,
  trustShareFp: 500_000_000_000_000_000n,
  trustDecayFp: 800_000_000_000_000_000n,
  trustedSeeds: [
    '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  ],
  totalPool: 5_000_000_000_000_000_000_000_000_000n,
  precisionScale: 1_000_000_000_000_000_000n,
  schemaUid: `0x${'31'.repeat(32)}` as Hex,
  weightFieldIndex: 1,
  envelope0DomainSeparators: [],
  lane2MaxHeadAge: 0n,
  accumulator: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  chainId: 31_337n,
}

const reviewAccounts = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
] as const satisfies readonly Hex[]

const reviewEdge = (
  source: number,
  target: number,
  index: number,
  confidence: bigint
): RawEdge => ({
  kind: 0,
  attester: reviewAccounts[source]!,
  recipient: reviewAccounts[target]!,
  uid: `0x${index.toString(16).padStart(64, '0')}` as Hex,
  blockTimestamp: 1_700_000_000n + BigInt(index),
  data: encodeAbiParameters(
    [{ type: 'string' }, { type: 'uint256' }],
    ['Review fixture', confidence]
  ),
})

const reviewEdges: RawEdge[] = [
  reviewEdge(0, 1, 1, 95n),
  reviewEdge(0, 2, 2, 65n),
  reviewEdge(1, 3, 3, 85n),
  reviewEdge(2, 1, 4, 75n),
  reviewEdge(3, 0, 5, 80n),
  reviewEdge(4, 5, 6, 60n),
  reviewEdge(5, 0, 7, 70n),
  reviewEdge(6, 3, 8, 55n),
  reviewEdge(7, 2, 9, 88n),
  reviewEdge(1, 4, 10, 50n),
  reviewEdge(2, 6, 11, 68n),
  reviewEdge(3, 7, 12, 72n),
]

const ScoringReviewFixture = () => {
  const [state, setState] = useState<ReviewScoringState>('current')
  useEffect(() => {
    const requested = window.localStorage.getItem('tg-review-scoring-state')
    if (
      requested &&
      REVIEW_SCORING_STATES.includes(requested as ReviewScoringState)
    ) {
      setState(requested as ReviewScoringState)
    }
  }, [])

  const lifecycle =
    state === 'awaiting-checkpoint'
      ? 'Executed, awaiting checkpoint'
      : state === 'active'
        ? 'Active at checkpoint 18'
        : 'Current scoring configuration'
  const reviewState = [
    'stale',
    'invalid',
    'unauthorized',
    'safe',
    'timelock',
  ].includes(state)
  const proposed = cloneParams(reviewParams)
  proposed.dampingFp = 800_000_000_000_000_000n
  proposed.trustedSeeds = [
    reviewParams.trustedSeeds[0]!,
    '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  ]
  const currentHash = paramsHash(reviewParams)
  const proposedHash = paramsHash(proposed)
  const reviewPreview = previewScoringChange({
    edges: reviewEdges,
    current: reviewParams,
    proposed,
  })

  return (
    <section className="min-w-0 space-y-8" data-review-scoring-state={state}>
      <div className="space-y-2">
        <SectionHeading>Current scoring configuration</SectionHeading>
        <p className="text-sm text-muted-foreground">
          The complete tuple read from the typed controller. Changes apply
          prospectively at a checkpoint boundary.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 border border-border bg-surface-2 p-4 text-sm">
        <Status tone={state === 'awaiting-checkpoint' ? 'muted' : 'good'}>
          {lifecycle}
        </Status>
        <span>Version 2</span>
        <span className="break-all font-mono text-xs">{currentHash}</span>
      </div>
      <CurrentParameterCards params={reviewParams} />

      {reviewState ? (
        <Card type="primary" size="lg" className="min-w-0 space-y-6">
          <div>
            <p className="tg-label">Bound review</p>
            <h3 className="mt-2 text-xl font-semibold">
              Change trusted accounts and damping
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Preview over checkpoint 18 · {reviewPreview.inputCount.toString()}{' '}
              folded records ·{' '}
              {reviewPreview.proposedConverged ? 'converged' : 'hit cap'} in{' '}
              {reviewPreview.proposedIterations} iterations. This preview does
              not change settled roots or funded distributions.
            </p>
          </div>
          <ScoringGraphPreview
            preview={reviewPreview}
            currentSeeds={reviewParams.trustedSeeds}
            proposedSeeds={proposed.trustedSeeds}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Card type="detail" size="sm">
              <p className="tg-label">Gain / lose / unchanged</p>
              <p className="mt-2 text-lg">
                {reviewPreview.gained} / {reviewPreview.lost} /{' '}
                {reviewPreview.unchanged}
              </p>
            </Card>
            <Card type="detail" size="sm">
              <p className="tg-label">Trusted score mass</p>
              <p className="mt-2 text-lg">
                {(reviewPreview.currentTrustedMassBps / 100).toFixed(2)}% →{' '}
                {(reviewPreview.proposedTrustedMassBps / 100).toFixed(2)}%
              </p>
            </Card>
            <Card type="detail" size="sm">
              <p className="tg-label">Top-10 concentration</p>
              <p className="mt-2 text-lg">
                {(reviewPreview.currentTopTenMassBps / 100).toFixed(2)}% →{' '}
                {(reviewPreview.proposedTopTenMassBps / 100).toFixed(2)}%
              </p>
            </Card>
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <div className="min-w-0 border border-border p-4 text-xs">
              <p className="font-medium">Field-level change</p>
              <p className="mt-2">Damping: 0.85 → 0.8</p>
              <p className="mt-1 break-all">
                Trusted accounts: {reviewParams.trustedSeeds[1]} →{' '}
                {proposed.trustedSeeds[1]}
              </p>
              <p className="mt-3 break-all font-mono text-muted-foreground">
                Parent {currentHash}
              </p>
              <p className="mt-1 break-all font-mono text-muted-foreground">
                Proposed {proposedHash}
              </p>
            </div>
            <div className="min-w-0 border border-border p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">Proposal execution plan</p>
                <span className="border border-border px-2 py-1 text-muted-foreground">
                  CALL · 0 ETH
                </span>
              </div>
              <p className="mt-3 break-words font-mono text-sm font-medium">
                TrustgraphsParamsController.
                <wbr />
                updateParams(Params,string)
              </p>
              <p className="mt-2 text-muted-foreground">
                Publish the validated tuple as the next parameter version. If
                the DAO vote passes, its Safe executes this call automatically.
              </p>
              <p className="mt-3 text-muted-foreground">Target contract</p>
              <p className="mt-1 break-all font-mono">
                0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc
              </p>
              <p className="mt-3 min-h-11 border-t border-border py-3 text-muted-foreground">
                Inspect and copy exact calldata
              </p>
            </div>
          </div>

          {state === 'stale' && (
            <p
              className="border border-error/50 bg-error-soft p-4 text-sm text-error"
              role="alert"
            >
              Stale draft: version 3 is now current. Rebase this draft before
              asking a wallet to act; it cannot overwrite the newer tuple.
            </p>
          )}
          {state === 'invalid' && (
            <div
              className="border border-error/50 bg-error-soft p-4 text-sm text-error"
              role="alert"
            >
              <p className="font-medium">Contract validation failed</p>
              <p className="mt-1">
                Damping × trusted boost compounds beyond the guest safety bound
                at this iteration cap. Submission remains disabled.
              </p>
            </div>
          )}
          {state === 'unauthorized' && (
            <div className="border border-border bg-surface-2 p-4 text-sm">
              <p className="font-medium">No authority from this wallet</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                Controller owner 0x15d34aaf54267db7d7c367839aaf71a00a2c6a65 must
                act or transfer ownership to the DAO Safe. The exact call bundle
                remains downloadable.
              </p>
            </div>
          )}
          {state === 'safe' && (
            <div className="border border-border bg-surface-2 p-4 text-sm">
              <p className="font-medium">Safe through Merkle governance</p>
              <p className="mt-1 text-xs text-muted-foreground">
                3 owners · threshold 2. Settings prepares the typed actions;
                deliberation and execution remain in Governance.
              </p>
            </div>
          )}
          {state === 'timelock' && (
            <div className="border border-border bg-surface-2 p-4 text-sm">
              <p className="font-medium">Operational timelock</p>
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                <span>Minimum delay: 86,400 seconds</span>
                <span>Executor: permissionless</span>
                <span>State: not scheduled; not cancelled</span>
                <span>Ready time: after scheduling + delay</span>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                Operation 0x{'7a'.repeat(32)}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
            {state === 'safe' ? (
              <Button type="button" size="lg">
                Prepare DAO proposal
              </Button>
            ) : state === 'timelock' ? (
              <Button type="button" size="lg">
                Schedule parameter update
              </Button>
            ) : state === 'unauthorized' ? (
              <Button type="button" size="lg" variant="outline">
                <Download /> Download action bundle
              </Button>
            ) : (
              <Button type="button" size="lg" disabled>
                {state === 'stale'
                  ? 'Rebase required'
                  : 'Apply parameter update'}
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className="flex justify-end">
          <Button type="button" size="lg">
            Propose changes
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Version history</h3>
        <details className="border border-border bg-surface">
          <summary className="min-h-11 cursor-pointer p-4 text-sm font-medium">
            Version 2 · {lifecycle}
          </summary>
          <div className="border-t border-border p-4 text-xs text-muted-foreground">
            Executed by the controller owner. First checkpoint{' '}
            {state === 'awaiting-checkpoint' ? 'not pinned yet' : '18'}. Settled
            version-1 roots retain their original meaning.
          </div>
        </details>
      </div>
    </section>
  )
}

export const ScoringSettings = (
  props: React.ComponentProps<typeof LiveScoringSettings>
) =>
  process.env.NEXT_PUBLIC_TG_REVIEW_FIXTURES === '1' ? (
    <ScoringReviewFixture />
  ) : (
    <LiveScoringSettings {...props} />
  )

export const ScoringAccessCard = ({
  instance,
  factoryAddress,
  liveParamsHash,
}: {
  instance: InstanceRow | null
  factoryAddress?: Address
  liveParamsHash?: Hex
}) => {
  const { network } = useNetwork()
  const { address } = useAccount()
  const governance = useGovernance()
  const instanceId = network.instanceId ?? instance?.id ?? ''
  const controller = useControllerState({
    instance,
    instanceId,
    factoryAddress,
    snapshotAddress: network.contracts.merkleSnapshot,
    liveParamsHash,
  })
  const authority = useAuthority({
    owner: controller.owner,
    connectedAddress: address,
    governanceAddress: realAddress(network.contracts.merkleGovModule),
    governanceCanPropose: governance.canCreateProposal,
  })

  return (
    <Card type="detail" size="md" className="min-w-0">
      <h3 className="text-sm font-semibold">Scoring control path</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Controller ownership is the primary authority. Snapshot roles below are
        secondary diagnostics.
      </p>
      <FieldRow label="Controller">
        {controller.controllerAddress ? (
          <span className="break-all font-mono text-xs">
            {controller.controllerAddress}
          </span>
        ) : (
          'Legacy raw-hash control'
        )}
      </FieldRow>
      <FieldRow label="Controller owner">
        {controller.owner ? (
          <AddressView address={controller.owner} displayMode="auto" />
        ) : (
          '—'
        )}
      </FieldRow>
      <FieldRow label="Pending owner">
        {controller.pendingOwner ? (
          <AddressView address={controller.pendingOwner} displayMode="auto" />
        ) : (
          'None'
        )}
      </FieldRow>
      <FieldRow label="Detected route">
        {authorityLabel(authority.data)}
      </FieldRow>
      {authority.data?.kind === 'timelock' && (
        <>
          <FieldRow label="You can schedule">
            {authority.data.canPropose ? 'Yes' : 'No'}
          </FieldRow>
          <FieldRow label="You can execute">
            {authority.data.canExecute ? 'Yes' : 'No'}
          </FieldRow>
        </>
      )}
      {controller.consistencyError && (
        <p className="mt-3 text-xs text-error">{controller.consistencyError}</p>
      )}
    </Card>
  )
}
