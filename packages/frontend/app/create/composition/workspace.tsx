'use client'

import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  type Address,
  type Hex,
  formatEther,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseEther,
  parseEventLogs,
  zeroAddress,
} from 'viem'
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
} from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Switch } from '@/components/Switch'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useAuthorityProfile } from '@/hooks/useAuthorityProfile'
import {
  CompositionApiUnavailableError,
  type CompositionCandidate,
  type CompositionInstance,
  type CompositionPolicy,
  type SourceEligibility,
  classifySourceEligibility,
  fetchCompositionCandidates,
  fetchCompositionOverview,
  fetchCompositionSource,
  requireCompatibleCandidate,
} from '@/lib/composition/api'
import {
  compositionAdapterPayload,
  compositionCreateArgs,
  compositionCreatePayload,
  compositionGovernedCreatePayload,
  compositionMetadataDigest,
  compositionProposalPayload,
  compositionSourceAdapterFactoryAbi,
  compositionSourceAdapters,
  compositionSourceSnapshotAbi,
  compositionVaultAbi,
  governedTrustComposeFactoryAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from '@/lib/composition/contracts'
import {
  COMPOSITION_OUTPUT_KIND,
  type CompositionConfig,
  type CompositionPreview,
  type CompositionSource,
  DEFAULT_COMPOSITION_SCOPE,
  MAX_SOURCE_AGE_BLOCKS,
  V1_COMPOSITION_BOUNDS,
  compositionSimplex,
  computeCompositionPreview,
  exactEqualWeights,
  formatWeightPercent,
  parseWeightPercent,
} from '@/lib/composition/core'
import {
  type CompositionQuote,
  compositionPreflight,
} from '@/lib/composition/preflight'
import { anchorCompositionPreview } from '@/lib/composition/workflow'
import { APIS, TRUST_COMPOSE_CONFIG } from '@/lib/config'
import { parseErrorMessage } from '@/lib/error'
import { DISABLED_SIGNER_SYNC, describeSeconds } from '@/lib/governed-wrapper'
import {
  DEFAULT_MAX_PER_ROOT_USD,
  type InitialProvingPolicy,
  initialPolicyForCreation,
  initialPolicyProblem,
  parseVaultUsd,
} from '@/lib/proving-prepay'
import { txToast } from '@/lib/tx'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'

import {
  type NetworkMetadata,
  describeBlocks,
  metadataFingerprint,
  nameProblem,
} from '../model'
import {
  EMPTY_NETWORK_PROFILE,
  type NetworkProfile,
  NetworkProfileFields,
  hasNetworkProfile,
  networkProfileProblem,
} from '../NetworkProfileFields'
import { pinMetadata } from '../pin'

type Mode = 'create' | 'rotate'

const factory = (TRUST_COMPOSE_CONFIG?.factory || '') as Address
const factoryAvailable = isAddress(factory, { strict: false })
const governedFactory = (TRUST_COMPOSE_CONFIG?.governedFactory || '') as Address
const governedAvailable = isAddress(governedFactory, { strict: false })
const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`
const randomWord = (): Hex => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const rebalance = (sources: CompositionSource[]) => {
  if (sources.length < 2)
    return sources.map((source) => ({ ...source, weight: 0n }))
  const weights = exactEqualWeights(sources.map((source) => source.sourceId))
  return sources.map((source) => ({
    ...source,
    weight: weights.get(source.sourceId)!,
  }))
}

export const CompositionWorkspace = ({
  settingsInstanceId,
}: {
  settingsInstanceId?: Hex
} = {}) => {
  const { address, isConnected } = useAccount()
  const targetChainId = getTargetChainId()
  const chainId = useChainId()
  const publicClient = usePublicClient({ chainId: targetChainId })
  const { switchChain, isPending: switchingChain } = useSwitchChain()
  const mode: Mode = settingsInstanceId ? 'rotate' : 'create'
  const [catalog, setCatalog] = useState<CompositionCandidate[]>([])
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([])
  // Keyed by lowercase snapshot address. Read from the chain, not the indexer: eligibility is an
  // on-chain fact (provenanceEnabled + state count) and the picker must say up front why a
  // candidate is not selectable instead of erroring after a click.
  const [eligibility, setEligibility] = useState<
    Record<string, SourceEligibility>
  >({})
  const [apiUnavailable, setApiUnavailable] = useState(false)
  const [sources, setSources] = useState<CompositionSource[]>([])
  const [loadingSource, setLoadingSource] = useState<Hex | null>(null)
  const [name, setName] = useState('')
  const [profile, setProfile] = useState<NetworkProfile>(EMPTY_NETWORK_PROFILE)
  const [pinnedMetadata, setPinnedMetadata] = useState<{
    uri: string
    fingerprint: string
  } | null>(null)
  const [outputPool, setOutputPool] = useState('1000000000000000000000000')
  const [epochLength, setEpochLength] = useState('0')
  const [salt] = useState<Hex>(randomWord)
  // Creation-time features (GOAL M4/M5). The fund and governance are structural: they can only
  // be chosen here, so both are explicit switches rather than hidden defaults.
  const [withFund, setWithFund] = useState(false)
  const [fundToken, setFundToken] = useState<'eth' | 'other'>('eth')
  const [fundTokenAddress, setFundTokenAddress] = useState('')
  const [withGovernance, setWithGovernance] = useState(false)
  const [prepayEth, setPrepayEth] = useState('')
  const [maxPerRootUsd, setMaxPerRootUsd] = useState(DEFAULT_MAX_PER_ROOT_USD)
  const [instanceId] = useState(settingsInstanceId ?? '')
  const [instance, setInstance] = useState<CompositionInstance | null>(null)
  const [policies, setPolicies] = useState<CompositionPolicy[]>([])
  const [preview, setPreview] = useState<CompositionPreview | null>(null)
  const [previewConfig, setPreviewConfig] = useState<CompositionConfig | null>(
    null
  )
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [simulatedPayloadHash, setSimulatedPayloadHash] = useState<Hex | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [transactionProblem, setTransactionProblem] = useState<string | null>(
    null
  )
  const [billingProblem, setBillingProblem] = useState<string | null>(null)
  const [success, setSuccess] = useState<{
    message: string
    instanceId?: Hex
    safe?: Hex
  } | null>(null)

  const { data: sourceAdapterFactory } = useReadContract({
    address: factoryAvailable ? factory : zeroAddress,
    abi: trustComposeFactoryAbi,
    functionName: 'SOURCE_ADAPTER_FACTORY',
    query: { enabled: factoryAvailable },
  })
  const { data: vault } = useReadContract({
    address: factoryAvailable ? factory : zeroAddress,
    abi: trustComposeFactoryAbi,
    functionName: 'VAULT',
    query: { enabled: factoryAvailable },
  })
  const { data: epochFloor } = useReadContract({
    address: factoryAvailable ? factory : zeroAddress,
    abi: trustComposeFactoryAbi,
    functionName: 'EPOCH_FLOOR',
    query: { enabled: factoryAvailable },
  })
  // The timelock the base factory installs on every policy rotation, for the compounded-delay
  // copy in the governance section: under governance a rotation waits through voting, execution,
  // AND this.
  const { data: policyActivationDelay } = useReadContract({
    address: factoryAvailable ? factory : zeroAddress,
    abi: trustComposeFactoryAbi,
    functionName: 'POLICY_ACTIVATION_DELAY',
    query: { enabled: factoryAvailable },
  })
  // The wrapper's live governance profile, checked the way the main wizard's review screen checks
  // it: creation with governance is disabled unless the sealed-authority profile reads back sound.
  const authority = useAuthorityProfile(
    governedAvailable ? governedFactory : undefined
  )
  const vaultAddress = vault as Address | undefined
  const vaultAvailable = !!vaultAddress && vaultAddress !== zeroAddress
  const {
    data: instanceVaultAccount,
    isLoading: instanceVaultAccountLoading,
    refetch: refetchInstanceVaultAccount,
  } = useReadContract({
    address: vaultAvailable ? vaultAddress : zeroAddress,
    abi: compositionVaultAbi,
    functionName: 'accountOf',
    args: [settingsInstanceId ?? (`0x${'00'.repeat(32)}` as Hex)],
    query: { enabled: vaultAvailable && !!settingsInstanceId },
  })
  const {
    data: instanceVaultPolicy,
    isLoading: instanceVaultPolicyLoading,
    refetch: refetchInstanceVaultPolicy,
  } = useReadContract({
    address: vaultAvailable ? vaultAddress : zeroAddress,
    abi: compositionVaultAbi,
    functionName: 'policyOf',
    args: [settingsInstanceId ?? (`0x${'00'.repeat(32)}` as Hex)],
    query: { enabled: vaultAvailable && !!settingsInstanceId },
  })
  const { data: conservativeFee } = useReadContract({
    address: vaultAvailable ? vaultAddress : zeroAddress,
    abi: compositionVaultAbi,
    functionName: 'feePerRootUsd',
    args: [
      '0xf21b8f73c590106e82fb255eb77cb874c0610b9db9e2ea9c2be36eda57b44102',
      3,
    ],
    query: { enabled: vaultAvailable },
  })

  const active = policies.find((policy) => policy.status === 'active')
  const pending = policies.find((policy) => policy.status === 'pending')
  const wrongChain = isConnected && chainId !== targetChainId
  const instanceVaultEth = instanceVaultAccount?.[2] ?? 0n
  const instanceMaxPerRootUsd = instanceVaultPolicy?.[1] ?? 0n
  const paidRefreshesEnabled = instanceMaxPerRootUsd > 0n
  const instanceBillingLoading =
    instanceVaultAccountLoading || instanceVaultPolicyLoading
  const canManageBilling =
    !!address &&
    !!instance?.admin &&
    address.toLowerCase() === instance.admin.toLowerCase()

  const quote: CompositionQuote = useMemo(
    () => ({
      available: vaultAvailable && conservativeFee !== undefined,
      kind: 'conservative-band',
      feeUsd:
        conservativeFee === undefined ? null : (conservativeFee as bigint),
      gasUsd: null,
      payableUsd:
        conservativeFee === undefined ? null : (conservativeFee as bigint),
      eligible: null,
      reason: vaultAvailable
        ? conservativeFee === undefined
          ? 'The conservative trust-compose band-3 fee could not be read.'
          : null
        : 'This factory has no proving vault.',
      cadence: `Epoch length ${epochLength || '0'} blocks; factory floor ${String(epochFloor ?? 'unknown')} blocks. Every required source must be available at capture.`,
    }),
    [conservativeFee, epochFloor, epochLength, vaultAvailable]
  )

  const invalidate = (reason?: string) => {
    setPreview(null)
    setPreviewConfig(null)
    setPreviewError(reason ?? null)
    setSimulatedPayloadHash(null)
    setSuccess(null)
  }

  const loadCatalog = async () => {
    setProblem(null)
    try {
      const result = await fetchCompositionCandidates(APIS.ponder)
      setCatalog(result.candidates)
      setCatalogWarnings(result.warnings)
      setApiUnavailable(false)
    } catch (error) {
      if (error instanceof CompositionApiUnavailableError) {
        setApiUnavailable(true)
        setCatalog([])
        return
      }
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    void loadCatalog()
  }, [])

  useEffect(() => {
    if (!settingsInstanceId) return
    let cancelled = false
    setBusy(true)
    fetchCompositionOverview(APIS.ponder, settingsInstanceId)
      .then((overview) => {
        if (cancelled) return
        setInstance(overview.instance)
        setPolicies(overview.policies)
        setApiUnavailable(false)
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof CompositionApiUnavailableError)
          setApiUnavailable(true)
        setProblem(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [settingsInstanceId])

  // A read failure degrades to 'unknown' (candidate stays clickable; the selection path still
  // verifies) so an RPC hiccup never blanks the whole picker.
  useEffect(() => {
    if (!publicClient || catalog.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        catalog.map(async (candidate): Promise<[string, SourceEligibility]> => {
          try {
            const [provenanceOn, stateCount] = await Promise.all([
              publicClient.readContract({
                address: candidate.snapshot,
                abi: compositionSourceSnapshotAbi,
                functionName: 'provenanceEnabled',
              }),
              publicClient.readContract({
                address: candidate.snapshot,
                abi: compositionSourceSnapshotAbi,
                functionName: 'getStateCount',
              }),
            ])
            return [
              candidate.snapshot.toLowerCase(),
              classifySourceEligibility(provenanceOn, stateCount),
            ]
          } catch {
            return [
              candidate.snapshot.toLowerCase(),
              { status: 'unknown', detail: null },
            ]
          }
        })
      )
      if (!cancelled) setEligibility(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [catalog, publicClient])

  const setSelected = (next: CompositionSource[], reason?: string) => {
    setSources(next)
    invalidate(reason)
  }

  const toggleCandidate = async (candidate: CompositionCandidate) => {
    const existing = sources.find(
      (source) => source.instanceId === candidate.instanceId
    )
    if (existing) {
      setSelected(
        rebalance(
          sources.filter((source) => source.instanceId !== candidate.instanceId)
        ),
        'Source selection changed; rebuild the exact preview.'
      )
      return
    }
    if (!publicClient) return setProblem('Target-chain RPC is unavailable.')
    const switchingProgram =
      sources.length > 0 &&
      candidate.chainId === sources[0]!.chainId.toString() &&
      candidate.programId.toLowerCase() !== sources[0]!.programId.toLowerCase()
    const retainedSources = switchingProgram ? [] : sources
    setLoadingSource(candidate.instanceId)
    setProblem(null)
    try {
      requireCompatibleCandidate(
        candidate,
        retainedSources.map((source) => ({
          ...candidate,
          instanceId: source.instanceId,
          chainId: source.chainId.toString(),
          snapshot: source.snapshot,
          programId: source.programId,
        }))
      )
      const provenanceEnabled = await publicClient.readContract({
        address: candidate.snapshot,
        abi: compositionSourceSnapshotAbi,
        functionName: 'provenanceEnabled',
      })
      const count = await publicClient.readContract({
        address: candidate.snapshot,
        abi: compositionSourceSnapshotAbi,
        functionName: 'getStateCount',
      })
      if (count === 0n)
        throw new Error(`${candidate.name} has no accepted output yet.`)
      const stateIndex = count - 1n
      const [state, provenance] = await Promise.all([
        publicClient.readContract({
          address: candidate.snapshot,
          abi: compositionSourceSnapshotAbi,
          functionName: 'getStateAtIndex',
          args: [stateIndex],
        }),
        publicClient.readContract({
          address: candidate.snapshot,
          abi: compositionSourceSnapshotAbi,
          functionName: 'getStateProvenance',
          args: [stateIndex],
        }),
      ])
      const loaded = await fetchCompositionSource({
        api: APIS.ponder,
        candidate,
        chain: {
          provenanceEnabled,
          stateIndex,
          checkpointId: provenance.checkpointId,
          acceptedAtBlock: provenance.acceptedAtBlock,
          freezeBlock: state.blockNumber,
          outputRoot: state.root,
          blobSha256: state.ipfsHash,
          cid: state.ipfsHashCid,
          totalValue: state.totalValue,
          verifier: provenance.verifier,
          paramsHash: provenance.paramsHash,
        },
      })
      loaded.maxAgeBlocks = MAX_SOURCE_AGE_BLOCKS
      setSelected(
        rebalance([...retainedSources, loaded]),
        switchingProgram
          ? `Switched to ${candidate.programName} sources. Add at least one more graph of this score type.`
          : undefined
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingSource(null)
    }
  }

  const updateSource = (sourceId: Hex, update: Partial<CompositionSource>) => {
    const adapterChanged = update.familyId !== undefined
    setSelected(
      sources.map((source) =>
        source.sourceId === sourceId
          ? {
              ...source,
              ...update,
              ...(adapterChanged ? { adapter: null } : {}),
            }
          : source
      ),
      'A governed source field changed; rebuild the exact preview.'
    )
  }

  const buildPreview = async () => {
    setProblem(null)
    setPreviewError(null)
    setBusy(true)
    try {
      if (!publicClient) throw new Error('Target-chain RPC is unavailable.')
      const captureBlock = await publicClient.getBlockNumber()
      const next: CompositionConfig = {
        chainId: BigInt(targetChainId),
        captureBlock,
        scopeHash: DEFAULT_COMPOSITION_SCOPE,
        admittedProgramId:
          sources[0]?.programId ?? (`0x${'00'.repeat(32)}` as Hex),
        outputPool: BigInt(outputPool),
        bounds: V1_COMPOSITION_BOUNDS,
        sources: structuredClone(sources),
      }
      const exact = computeCompositionPreview(next)
      setPreview(exact)
      setPreviewConfig(next)
      setSimulatedPayloadHash(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPreviewError(message)
      setProblem(message)
    } finally {
      setBusy(false)
    }
  }

  const deployAdapters = async (requestedSources: CompositionSource[]) => {
    if (!sourceAdapterFactory || !isAddress(sourceAdapterFactory)) {
      return setProblem(
        'The configured factory did not expose a source-adapter factory.'
      )
    }
    const missing = requestedSources.filter((source) => !source.adapter)
    if (missing.length === 0) return
    setBusy(true)
    setProblem(null)
    try {
      // Keep each successful adapter if the wallet rejects a later source. These are necessarily
      // separate factory transactions today, so a partial run should resume at the first missing
      // source instead of making the user deploy duplicates.
      for (const [index, source] of missing.entries()) {
        const [receipt] = await txToast({
          tx: {
            address: sourceAdapterFactory,
            abi: compositionSourceAdapterFactoryAbi,
            functionName: 'create',
            args: [
              source.registry,
              source.instanceId,
              source.sourceId,
              source.familyId,
              COMPOSITION_OUTPUT_KIND,
              source.deploymentProvenance,
            ],
          },
          successMessage: `Source ${index + 1} of ${missing.length} prepared: ${source.name}.`,
          confirmations: index < missing.length - 1 ? 1 : undefined,
        })
        // Topic-keyed like every other receipt scan here (the adapter factory is called directly
        // today, but event-shape matching survives any future wrapping).
        const [adapterEvent] = parseEventLogs({
          abi: compositionSourceAdapterFactoryAbi,
          eventName: 'SourceAdapterCreated',
          logs: receipt.logs,
        })
        const adapter: Address | null = adapterEvent?.args.adapter ?? null
        if (!adapter) {
          throw new Error(
            `Adapter receipt for ${source.name} did not contain SourceAdapterCreated.`
          )
        }
        setSources((current) =>
          current.map((item) =>
            item.sourceId === source.sourceId ? { ...item, adapter } : item
          )
        )
        setPreviewConfig((current) =>
          current
            ? {
                ...current,
                sources: current.sources.map((item) =>
                  item.sourceId === source.sourceId
                    ? { ...item, adapter }
                    : item
                ),
              }
            : null
        )
        setSimulatedPayloadHash(null)
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const loadRotation = async () => {
    setProblem(null)
    if (!isHex(instanceId) || instanceId.length !== 66) {
      return setProblem(
        'Choose a composition from the list, or paste its 32-byte instance ID.'
      )
    }
    setBusy(true)
    try {
      const overview = await fetchCompositionOverview(APIS.ponder, instanceId)
      setInstance(overview.instance)
      setPolicies(overview.policies)
      setApiUnavailable(false)
    } catch (error) {
      if (error instanceof CompositionApiUnavailableError)
        setApiUnavailable(true)
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const fundIssue: string | null =
    withFund && !withGovernance
      ? 'A shared fund must be owned by an initialized Safe. Turn on Create with governance, or create without a fund.'
      : withFund && fundToken === 'other'
        ? !fundTokenAddress.trim()
          ? 'Paste the address of the token you plan to pay out.'
          : !isAddress(fundTokenAddress.trim(), { strict: false })
            ? "That doesn't look like a token address."
            : null
        : null

  // The optional refresh prepayment rides as transaction value in both creation paths. The
  // governed wrapper installs the policy atomically. A wallet-owned creation follows the factory
  // transaction with a second, explicit setPolicy transaction from its constitutional admin.
  const prepayIssue: string | null = (() => {
    const trimmed = prepayEth.trim()
    if (!trimmed) return null
    if (!vaultAvailable) {
      return 'Refresh prepayment is not available on this deployment.'
    }
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
      return 'Enter an amount like 0.5, or leave it blank.'
    }
    if (Number(trimmed) === 0) {
      return 'Leave it blank rather than entering zero.'
    }
    return initialPolicyProblem(prepayEth, maxPerRootUsd)
  })()
  const prepayWei =
    prepayEth.trim() && !prepayIssue ? parseEther(prepayEth.trim()) : 0n
  const effectiveEpoch = useMemo(() => {
    const requested = BigInt(epochLength || '0')
    const floor = (epochFloor as bigint | undefined) ?? 0n
    return requested < floor ? floor : requested
  }, [epochFloor, epochLength])
  const initialPolicy = useMemo<InitialProvingPolicy | null>(() => {
    try {
      return initialPolicyForCreation(prepayWei, effectiveEpoch, maxPerRootUsd)
    } catch {
      return null
    }
  }, [effectiveEpoch, maxPerRootUsd, prepayWei])

  const governanceIssue: string | null = !withGovernance
    ? null
    : !governedAvailable
      ? 'Create with governance is not available on this deployment.'
      : !authority.loading && !authority.valid
        ? 'The configured governed factory does not expose the sealed guard, member-delay, and 14-day recovery profile this app requires, so creating with governance is disabled here.'
        : null

  const metadata = useMemo<NetworkMetadata>(
    () => ({
      name: name.trim(),
      description: profile.description.trim(),
      criteria: profile.criteria.trim(),
      image: profile.image.trim(),
      applicationUrl: profile.applicationUrl.trim(),
    }),
    [name, profile]
  )
  const metadataKey = metadataFingerprint(metadata)
  const metadataURI =
    pinnedMetadata?.fingerprint === metadataKey ? pinnedMetadata.uri : ''
  const metadataIssue = nameProblem(name) || networkProfileProblem(profile)

  const updateProfile = (patch: Partial<NetworkProfile>) => {
    setProfile((current) => ({ ...current, ...patch }))
    setSimulatedPayloadHash(null)
  }

  const ensureMetadataURI = async () => {
    if (metadataIssue) throw new Error(metadataIssue)
    if (!hasNetworkProfile(profile)) return ''
    if (pinnedMetadata?.fingerprint === metadataKey) return pinnedMetadata.uri
    const { uri } = await pinMetadata(metadata)
    setPinnedMetadata({ uri, fingerprint: metadataKey })
    return uri
  }

  const createFields = {
    name,
    metadataURI,
    // Under governance the wrapper replaces the admin with the new DAO Safe; keeping zero here
    // makes it impossible to mistake the connected wallet for the lasting authority.
    admin: withGovernance
      ? zeroAddress
      : address
        ? getAddress(address)
        : zeroAddress,
    epochLength: BigInt(epochLength || '0'),
    withDistributor: withFund,
    distributorToken:
      withFund &&
      fundToken === 'other' &&
      isAddress(fundTokenAddress.trim(), { strict: false })
        ? (fundTokenAddress.trim().toLowerCase() as Address)
        : zeroAddress,
    salt,
  }

  const payload = useMemo(() => {
    if (!preview || !previewConfig) return null
    try {
      if (mode !== 'create') {
        return compositionProposalPayload(previewConfig, preview)
      }
      if (withGovernance) {
        return initialPolicy
          ? compositionGovernedCreatePayload(
              createFields,
              previewConfig,
              preview,
              initialPolicy
            )
          : null
      }
      return compositionCreatePayload(createFields, previewConfig, preview)
    } catch {
      return null
    }
  }, [
    address,
    epochLength,
    fundToken,
    fundTokenAddress,
    initialPolicy,
    metadataURI,
    mode,
    name,
    preview,
    previewConfig,
    salt,
    withFund,
    withGovernance,
  ])

  const preflight = useMemo(() => {
    if (!preview || !previewConfig) return null
    return compositionPreflight({
      config: previewConfig,
      preview,
      previewError,
      quote: prepayWei > 0n ? quote : null,
      stage: 'sign',
    })
  }, [prepayWei, preview, previewConfig, previewError, quote])

  const missingAdapters =
    previewConfig?.sources.filter((source) => !source.adapter) ?? []
  const transactionBlockers = [
    mode === 'create' ? metadataIssue : null,
    fundIssue,
    prepayIssue,
    governanceIssue,
    mode === 'create' && withGovernance && authority.loading
      ? 'The governance safety profile is still loading.'
      : null,
  ].filter((value): value is string => !!value)
  if (
    preview &&
    previewConfig &&
    missingAdapters.length === 0 &&
    transactionBlockers.length === 0 &&
    !payload
  ) {
    transactionBlockers.push(
      'The exact transaction payload could not be built. Rebuild the preview and try again.'
    )
  }
  const readyToSimulate =
    !!payload && !preflight?.blocked && transactionBlockers.length === 0

  const assertPreviewSourcesCurrent = async () => {
    if (!publicClient || !previewConfig) return
    for (const source of previewConfig.sources) {
      const count = await publicClient.readContract({
        address: source.snapshot,
        abi: compositionSourceSnapshotAbi,
        functionName: 'getStateCount',
      })
      if (count === 0n || count - 1n !== source.stateIndex) {
        invalidate(
          `${source.name} accepted a new checkpoint after preview. Reload the source and review the new output.`
        )
        throw new Error(
          `${source.name} changed after preview; the reviewed payload was invalidated.`
        )
      }
      const [state, provenance] = await Promise.all([
        publicClient.readContract({
          address: source.snapshot,
          abi: compositionSourceSnapshotAbi,
          functionName: 'getStateAtIndex',
          args: [source.stateIndex],
        }),
        publicClient.readContract({
          address: source.snapshot,
          abi: compositionSourceSnapshotAbi,
          functionName: 'getStateProvenance',
          args: [source.stateIndex],
        }),
      ])
      if (
        state.root.toLowerCase() !== source.outputRoot.toLowerCase() ||
        state.ipfsHash.toLowerCase() !== source.blobSha256.toLowerCase() ||
        provenance.checkpointId !== source.checkpointId ||
        provenance.paramsHash.toLowerCase() !== source.paramsHash.toLowerCase()
      ) {
        invalidate(
          `${source.name} onchain provenance changed after preview. Reload and review it again.`
        )
        throw new Error(
          `${source.name} provenance no longer matches the reviewed preview.`
        )
      }
    }
  }

  const configurePaidRefreshes = async (
    targetInstanceId: Hex,
    policy: InitialProvingPolicy
  ) => {
    if (!publicClient || !address) throw new Error('Connect a wallet first.')
    if (!vaultAvailable || !vaultAddress) {
      throw new Error('This deployment has no proving vault.')
    }
    await publicClient.simulateContract({
      account: address,
      address: vaultAddress,
      abi: compositionVaultAbi,
      functionName: 'setPolicy',
      args: [
        targetInstanceId,
        policy.minPaidIntervalBlocks,
        policy.maxPerRootUsd,
      ],
    })
    await txToast({
      tx: {
        address: vaultAddress,
        abi: compositionVaultAbi,
        functionName: 'setPolicy',
        args: [
          targetInstanceId,
          policy.minPaidIntervalBlocks,
          policy.maxPerRootUsd,
        ],
      },
      successMessage: 'Paid score refreshes enabled.',
    })
  }

  const simulate = async () => {
    setProblem(null)
    setTransactionProblem(null)
    setBusy(true)
    try {
      if (!publicClient || !address) throw new Error('Connect a wallet first.')
      if (wrongChain) throw new Error('Switch to the target chain first.')
      if (!preview || !previewConfig || !payload)
        throw new Error('Build the exact preview first.')
      if (preflight?.blocked)
        throw new Error('Resolve every blocking preflight item first.')
      await assertPreviewSourcesCurrent()
      if (mode === 'create') {
        const exactCreateFields = {
          ...createFields,
          metadataURI: await ensureMetadataURI(),
        }
        const exactPayload = withGovernance
          ? initialPolicy
            ? compositionGovernedCreatePayload(
                exactCreateFields,
                previewConfig,
                preview,
                initialPolicy
              )
            : null
          : compositionCreatePayload(exactCreateFields, previewConfig, preview)
        if (!exactPayload)
          throw new Error('Fix the refresh prepayment fields first.')
        if (!factoryAvailable)
          throw new Error('No trust-compose factory is configured.')
        if (fundIssue || prepayIssue || governanceIssue)
          throw new Error(fundIssue ?? prepayIssue ?? governanceIssue ?? '')
        if (withGovernance) {
          if (!initialPolicy)
            throw new Error('Fix the refresh prepayment fields first.')
          await publicClient.simulateContract({
            account: address,
            address: governedFactory,
            abi: governedTrustComposeFactoryAbi,
            functionName: 'createGovernedInstance',
            args: [
              compositionCreateArgs(exactCreateFields, previewConfig, preview),
              initialPolicy,
              DISABLED_SIGNER_SYNC,
            ],
            ...(prepayWei > 0n ? { value: prepayWei } : {}),
          })
        } else {
          await publicClient.simulateContract({
            account: address,
            address: factory,
            abi: trustComposeFactoryAbi,
            functionName: 'createInstance',
            args: [
              compositionCreateArgs(exactCreateFields, previewConfig, preview),
            ],
            ...(prepayWei > 0n ? { value: prepayWei } : {}),
          })
        }
        setSimulatedPayloadHash(keccak256(exactPayload))
      } else {
        if (!active) throw new Error('Load an active composition policy first.')
        if (pending)
          throw new Error('Cancel or activate the pending policy first.')
        const adapters = compositionSourceAdapters(previewConfig.sources)
        await publicClient.simulateContract({
          account: address,
          address: active.controller,
          abi: trustComposeParamsControllerAbi,
          functionName: 'proposePolicy',
          args: [
            preview.policyManifest,
            adapters,
            compositionMetadataDigest(preview, adapters),
          ],
        })
        setSimulatedPayloadHash(keccak256(payload))
      }
    } catch (error) {
      setTransactionProblem(parseErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const sign = async () => {
    setProblem(null)
    setTransactionProblem(null)
    setBusy(true)
    try {
      if (!preview || !previewConfig || !payload)
        throw new Error('Build the exact preview first.')
      await assertPreviewSourcesCurrent()
      if (keccak256(payload) !== simulatedPayloadHash) {
        throw new Error(
          'The exact payload changed; simulate it again before signing.'
        )
      }
      if (mode === 'create') {
        const [receipt] = await txToast({
          tx: withGovernance
            ? ({
                address: governedFactory,
                abi: governedTrustComposeFactoryAbi,
                functionName: 'createGovernedInstance',
                args: [
                  compositionCreateArgs(createFields, previewConfig, preview),
                  initialPolicy!,
                  DISABLED_SIGNER_SYNC,
                ],
                ...(prepayWei > 0n ? { value: prepayWei } : {}),
              } as any)
            : {
                address: factory,
                abi: trustComposeFactoryAbi,
                functionName: 'createInstance',
                args: [
                  compositionCreateArgs(createFields, previewConfig, preview),
                ],
                ...(prepayWei > 0n ? { value: prepayWei } : {}),
              },
          successMessage: withGovernance
            ? 'Composition created; its Safe holds it from the first block.'
            : 'Composition created.',
        })
        // One receipt-scanning path for both creation lanes, keyed by event topic rather than by
        // emitting address: under the governed wrapper the BASE factory emits the creation event
        // and the new Safe is the creator, so address filtering would find nothing.
        const [createdEvent] = parseEventLogs({
          abi: trustComposeFactoryAbi,
          eventName: 'TrustComposeInstanceCreated',
          logs: receipt.logs,
        })
        const [governedEvent] = parseEventLogs({
          abi: governedTrustComposeFactoryAbi,
          eventName: 'GovernedInstanceCreated',
          logs: receipt.logs,
        })
        const created = createdEvent?.args.instanceId
        setSuccess({
          message: created
            ? prepayWei > 0n && !withGovernance
              ? 'Composition created and funded. Approve the second transaction to let the proving operator spend that balance on score refreshes.'
              : 'Creation confirmed. The composed network will appear after indexing.'
            : `Creation confirmed in ${receipt.transactionHash}.`,
          instanceId: created,
          safe: governedEvent?.args.safe,
        })
        if (created) {
          localStorage.setItem(
            `trustgraphs:composition-preview:${created.toLowerCase()}`,
            JSON.stringify(anchorCompositionPreview(preview))
          )
        }
        if (prepayWei > 0n && !withGovernance) {
          if (!created || !initialPolicy) {
            throw new Error(
              'The composition was created and funded, but its paid-refresh policy could not be prepared. Open its settings to enable paid refreshes.'
            )
          }
          try {
            await configurePaidRefreshes(created, initialPolicy)
            setSuccess({
              message:
                'Composition created, funded, and enabled for paid score refreshes. It may take a moment to appear while the indexer catches up.',
              instanceId: created,
            })
          } catch (policyError) {
            setTransactionProblem(
              `The composition was created and the ETH is safe in its proving tank, but paid refreshes are still disabled because the second transaction did not complete: ${parseErrorMessage(policyError)} Open the composition settings to finish enabling them.`
            )
          }
        }
      } else {
        if (!active) throw new Error('Load an active composition policy first.')
        const adapters = compositionSourceAdapters(previewConfig.sources)
        await txToast({
          tx: {
            address: active.controller,
            abi: trustComposeParamsControllerAbi,
            functionName: 'proposePolicy',
            args: [
              preview.policyManifest,
              adapters,
              compositionMetadataDigest(preview, adapters),
            ],
          },
          successMessage:
            'Composition policy proposed; the timelock is running.',
        })
        setSuccess({
          message:
            'Pending policy proposed. Reload to inspect its receipt and ready time.',
        })
        if (instance) {
          localStorage.setItem(
            `trustgraphs:composition-preview:${instance.id.toLowerCase()}`,
            JSON.stringify(anchorCompositionPreview(preview))
          )
        }
        await loadRotation()
      }
    } catch (error) {
      // A wallet refusal is intentionally non-destructive: the exact simulation remains reusable.
      setTransactionProblem(parseErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const pendingAction = async (kind: 'cancel' | 'activate') => {
    if (!pending) return
    setBusy(true)
    setProblem(null)
    try {
      if (kind === 'activate') {
        if (!pending.policyManifest || pending.availability !== 'available') {
          throw new Error(
            'The exact pending manifest/adapters are unavailable; activation is blocked.'
          )
        }
        if (
          BigInt(pending.readyAt ?? '0') > BigInt(Math.floor(Date.now() / 1000))
        ) {
          throw new Error('The policy activation timelock has not elapsed.')
        }
        await txToast({
          tx: {
            address: pending.controller,
            abi: trustComposeParamsControllerAbi,
            functionName: 'activatePolicy',
            args: [
              BigInt(pending.version),
              pending.policyManifest,
              pending.adapters,
            ],
          },
          successMessage: `Composition policy ${pending.version} activated.`,
        })
      } else {
        await txToast({
          tx: {
            address: pending.controller,
            abi: trustComposeParamsControllerAbi,
            functionName: 'cancelPolicy',
          },
          successMessage: `Composition policy ${pending.version} cancelled.`,
        })
      }
      await loadRotation()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updatePaidRefreshPolicy = async () => {
    if (!settingsInstanceId || !instance) return
    setBillingProblem(null)
    setBusy(true)
    try {
      const issue = initialPolicyProblem('1', maxPerRootUsd)
      if (issue) throw new Error(issue)
      const cap = parseVaultUsd(maxPerRootUsd)
      if (!cap) throw new Error('Set a nonzero maximum per refresh.')
      const interval = BigInt(instance.epochLength)
      await configurePaidRefreshes(settingsInstanceId, {
        minPaidIntervalBlocks: interval,
        maxPerRootUsd: cap,
      })
      await Promise.all([
        refetchInstanceVaultAccount(),
        refetchInstanceVaultPolicy(),
      ])
      setSuccess({
        message: 'Paid score refreshes are enabled for this composition.',
        instanceId: settingsInstanceId,
      })
    } catch (error) {
      setBillingProblem(parseErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const simplex =
    preview && previewConfig ? compositionSimplex(previewConfig, 20) : []

  return (
    <main className="max-w-6xl space-y-8" aria-labelledby="composition-title">
      <header className="space-y-3">
        <h1 id="composition-title" className="text-2xl">
          {mode === 'create' ? 'Create composed graph' : 'Composition settings'}
        </h1>
        <p className="max-w-4xl text-sm text-muted-foreground">
          {mode === 'create'
            ? 'Blend two or more proved Trustgraph score distributions. Choose the influence of each source, review the result, then create it.'
            : 'Review the current source policy, manage a pending change, or propose a new source mix.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={loadCatalog}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh sources
          </Button>
        </div>
      </header>

      {apiUnavailable && (
        <Card type="outline" size="md">
          <p className="text-sm">
            Composition indexing is not available on this rolling deployment.
            Existing network workflows are unaffected; source selection and
            signing stay disabled.
          </p>
        </Card>
      )}
      {catalogWarnings.map((warning) => (
        <p key={warning} className="text-sm text-amber-700">
          {warning}
        </p>
      ))}
      {problem && (
        <Card type="outline" size="sm" className="border-destructive">
          <p
            role="alert"
            className="break-words text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {problem}
          </p>
        </Card>
      )}
      {success && (
        <Card type="accent" size="sm">
          <p className="text-sm">
            <CheckCircle2 className="mr-2 inline h-4 w-4" />
            {success.message}
          </p>
          {success.instanceId && (
            <Link
              className="text-sm underline"
              href={`/compositions/${success.instanceId}`}
            >
              Open composed network
            </Link>
          )}
          {success.safe && (
            <div className="mt-2 space-y-1">
              <p className="text-sm text-muted-foreground">
                Its DAO Safe, the shared account that owns the composition and
                its fund from the first block:
              </p>
              <CopyableText text={success.safe} alwaysShowCopyIcon />
            </div>
          )}
        </Card>
      )}

      {mode === 'rotate' && (
        <Card type="outline" size="md" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">
                {instance?.name ?? 'Current composition'}
              </h2>
              <p className="font-mono text-xs text-muted-foreground">
                {instanceId}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={loadRotation}
              disabled={busy}
            >
              Refresh policy history
            </Button>
          </div>
          {instance && (
            <p className="text-sm">
              {instance.name} · controller {short(instance.controller ?? '')} ·
              current v{instance.currentVersion}
            </p>
          )}
          {pending && (
            <div className="space-y-2 rounded border p-3 text-sm">
              <p>
                Pending v{pending.version} · ready{' '}
                {pending.readyAt
                  ? new Date(Number(pending.readyAt) * 1000).toLocaleString()
                  : 'unknown'}{' '}
                · {pending.availability}
              </p>
              <p className="font-mono text-xs">proposal {pending.proposalId}</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => pendingAction('cancel')}
                  disabled={busy}
                >
                  Cancel pending
                </Button>
                <Button
                  type="button"
                  onClick={() => pendingAction('activate')}
                  disabled={busy || pending.availability !== 'available'}
                >
                  Activate exact preimage
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {mode === 'rotate' && instance && (
        <Card type="outline" size="md" className="space-y-4">
          <div>
            <h2 className="font-medium">Score refresh payments</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The proving tank has {formatEther(instanceVaultEth)} ETH. A
              spending policy must also be enabled before an operator can use
              it.
            </p>
          </div>
          <div className="rounded border p-3 text-sm">
            {instanceBillingLoading ? (
              <p className="text-muted-foreground">
                Reading the proving balance and policy…
              </p>
            ) : paidRefreshesEnabled ? (
              <p className="text-emerald-700">
                Paid refreshes are enabled. The current maximum is $
                {(Number(instanceMaxPerRootUsd) / 100_000_000).toLocaleString()}{' '}
                per refresh.
              </p>
            ) : instanceVaultEth > 0n ? (
              <p className="text-amber-700">
                This composition is funded, but paid refreshes are disabled. The
                operator cannot spend the deposited ETH until you enable a
                per-refresh limit below.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Paid refreshes are disabled and the proving tank is empty.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="composition-settings-max-refresh"
            >
              Maximum per score refresh
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm opacity-60">$</span>
              <Input
                id="composition-settings-max-refresh"
                className="w-32"
                inputMode="decimal"
                value={maxPerRootUsd}
                onChange={(event) => setMaxPerRootUsd(event.target.value)}
              />
              <span className="text-sm opacity-60">
                USD · no more often than every {instance.epochLength} blocks
              </span>
            </div>
          </div>
          {billingProblem && (
            <p
              role="alert"
              className="break-words text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {billingProblem}
            </p>
          )}
          {!isConnected ? (
            <WalletConnectionButton />
          ) : wrongChain ? (
            <Button
              type="button"
              disabled={switchingChain}
              onClick={() => switchChain({ chainId: targetChainId })}
            >
              Switch to {getTargetChainConfig().name}
            </Button>
          ) : canManageBilling ? (
            <Button
              type="button"
              onClick={updatePaidRefreshPolicy}
              disabled={busy || !!initialPolicyProblem('1', maxPerRootUsd)}
            >
              {paidRefreshesEnabled
                ? 'Update refresh spending limit'
                : 'Enable paid score refreshes'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              This action must be sent by the composition admin{' '}
              <span className="font-mono">{instance.admin}</span>.
            </p>
          )}
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="source-heading">
        <div>
          <h2 id="source-heading" className="text-lg font-medium">
            1. Compatible same-chain sources
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose 2–8 graphs from the same chain and score type. Standard and
            weighted-score graphs are both supported; V1 keeps their source
            types in separate compositions.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {catalog.map((candidate) => {
            const selected = sources.some(
              (source) => source.instanceId === candidate.instanceId
            )
            const differentChain =
              sources.length > 0 &&
              candidate.chainId !== sources[0]!.chainId.toString()
            const differentProgram =
              sources.length > 0 &&
              candidate.programId.toLowerCase() !==
                sources[0]!.programId.toLowerCase()
            const sourceEligibility =
              eligibility[candidate.snapshot.toLowerCase()]
            const ineligible =
              sourceEligibility !== undefined &&
              sourceEligibility.status !== 'ready' &&
              sourceEligibility.status !== 'unknown'
            return (
              <Card
                key={candidate.instanceId}
                type={selected ? 'accent' : 'outline'}
                size="sm"
                className="space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{candidate.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {candidate.programName} · chain {candidate.chainId}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={selected ? 'default' : 'outline'}
                    disabled={
                      !!loadingSource ||
                      (!selected &&
                        (differentChain ||
                          ineligible ||
                          (!differentProgram && sources.length >= 8)))
                    }
                    onClick={() => toggleCandidate(candidate)}
                  >
                    {loadingSource === candidate.instanceId ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : selected ? (
                      'Remove'
                    ) : differentProgram ? (
                      'Use this score type'
                    ) : (
                      'Add'
                    )}
                  </Button>
                </div>
                <p className="break-all font-mono text-xs">
                  {candidate.snapshot}
                </p>
                {!selected && sourceEligibility?.detail && (
                  <p className="text-xs text-muted-foreground">
                    {sourceEligibility.detail}
                  </p>
                )}
                {!selected && differentProgram && !differentChain && (
                  <p className="text-xs text-muted-foreground">
                    This graph is compatible, but it uses{' '}
                    {candidate.programName} scores. Selecting it starts a
                    composition of that score type and clears the current source
                    selection.
                  </p>
                )}
              </Card>
            )
          })}
          {!apiUnavailable && catalog.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No compatible proved address allocations were returned.
            </p>
          )}
        </div>
      </section>

      {sources.length > 0 && (
        <section className="space-y-3" aria-labelledby="policy-heading">
          <h2 id="policy-heading" className="text-lg font-medium">
            2. Governed policy and exact quotas
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {sources.map((source) => (
              <Card
                key={source.sourceId}
                type="outline"
                size="sm"
                className="space-y-3"
              >
                <div>
                  <h3 className="text-sm font-medium">{source.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    state {source.stateIndex.toString()} · accepted block{' '}
                    {source.freezeBlock.toString()} · {source.entries.length}{' '}
                    accounts
                  </p>
                </div>
                <label className="block text-xs">
                  Policy weight (%)
                  <Input
                    value={
                      source.weight ? formatWeightPercent(source.weight) : ''
                    }
                    onChange={(event) => {
                      try {
                        updateSource(source.sourceId, {
                          weight: parseWeightPercent(event.target.value),
                        })
                      } catch {
                        invalidate(
                          'Enter a positive percentage with at most 16 decimals.'
                        )
                      }
                    }}
                  />
                </label>
                <label className="block text-xs">
                  Publisher/controller family (governed label)
                  <Input
                    value={source.familyId}
                    onChange={(event) =>
                      isHex(event.target.value) &&
                      event.target.value.length === 66 &&
                      updateSource(source.sourceId, {
                        familyId: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="block text-xs">
                  Maximum source age (blocks)
                  <Input
                    type="number"
                    min="1"
                    max={MAX_SOURCE_AGE_BLOCKS.toString()}
                    value={source.maxAgeBlocks.toString()}
                    onChange={(event) =>
                      updateSource(source.sourceId, {
                        maxAgeBlocks: BigInt(event.target.value || '0'),
                      })
                    }
                  />
                </label>
                <p className="break-all font-mono text-xs">
                  review digest {source.deploymentProvenance}
                </p>
                {source.adapter ? (
                  <p className="text-xs text-emerald-700">
                    Authenticated adapter {short(source.adapter)}
                  </p>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !sourceAdapterFactory}
                    onClick={() => deployAdapters([source])}
                  >
                    Prepare this source
                  </Button>
                )}
              </Card>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              Output allocation pool
              <Input
                inputMode="numeric"
                value={outputPool}
                onChange={(event) => {
                  setOutputPool(event.target.value)
                  invalidate()
                }}
              />
            </label>
            <label className="text-sm">
              Epoch length (blocks)
              <Input
                inputMode="numeric"
                value={epochLength}
                onChange={(event) => {
                  setEpochLength(event.target.value)
                  setSimulatedPayloadHash(null)
                }}
              />
            </label>
            {mode === 'create' && (
              <label className="text-sm">
                Name
                <Input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setSimulatedPayloadHash(null)
                  }}
                />
                {nameProblem(name) && (
                  <p className="mt-1 text-xs text-destructive">
                    {nameProblem(name)}
                  </p>
                )}
              </label>
            )}
          </div>
          {mode === 'create' && (
            <Card type="outline" size="md" className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">Graph profile</h3>
                <p className="text-xs text-muted-foreground">
                  Help people understand the composed graph before they rely on
                  its scores.
                </p>
              </div>
              <NetworkProfileFields
                idPrefix="composition-profile"
                value={profile}
                onChange={updateProfile}
              />
              {metadataURI && (
                <p className="break-all text-xs text-emerald-700">
                  Profile saved as {metadataURI}
                </p>
              )}
            </Card>
          )}

          {mode === 'create' && (
            <Card type="outline" size="md" className="space-y-4">
              <div className="flex flex-row items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Add a shared fund</p>
                  <p className="text-xs text-muted-foreground max-w-xl">
                    A shared fund lets your community put money in one place and
                    split it by the composed scores. Anyone can top it up, and
                    each member claims their own share. Skip this if you only
                    want the scoreboard.
                  </p>
                </div>
                <Switch
                  size="md"
                  enabled={withFund}
                  readOnly={!governedAvailable}
                  onClick={() => {
                    if (!governedAvailable) return
                    const next = !withFund
                    setWithFund(next)
                    if (next) setWithGovernance(true)
                    setSimulatedPayloadHash(null)
                    setTransactionProblem(null)
                  }}
                />
              </div>
              {!governedAvailable && (
                <p className="text-xs text-muted-foreground">
                  A shared fund requires the governed factory to create its Safe
                  owner, and governance is not available on this deployment.
                </p>
              )}
              {withFund && (
                <div className="space-y-3 border-t border-border pt-3">
                  <p className="text-sm">What do you expect to pay out?</p>
                  <div className="flex flex-row flex-wrap gap-2">
                    <Button
                      type="button"
                      variant={fundToken === 'eth' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setFundToken('eth')
                        setSimulatedPayloadHash(null)
                      }}
                    >
                      ETH
                    </Button>
                    <Button
                      type="button"
                      variant={fundToken === 'other' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setFundToken('other')
                        setSimulatedPayloadHash(null)
                      }}
                    >
                      Another token
                    </Button>
                  </div>
                  {fundToken === 'other' && (
                    <Input
                      aria-label="Token address"
                      placeholder="0x..."
                      className="max-w-md font-mono text-xs"
                      value={fundTokenAddress}
                      onChange={(event) => {
                        setFundTokenAddress(event.target.value)
                        setSimulatedPayloadHash(null)
                      }}
                    />
                  )}
                  {fundIssue && (
                    <p className="text-xs text-destructive" role="alert">
                      {fundIssue}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    This only decides what the payout screen shows first. The
                    fund holds anything and can pay out something else later.
                    The new DAO Safe owns the fund, so payouts happen through
                    member governance.
                  </p>
                </div>
              )}
              {!withFund && (
                <p className="text-xs text-muted-foreground">
                  {withGovernance
                    ? 'The composition Safe can attach a shared fund later, though this workspace does not offer that button yet.'
                    : 'A wallet-owned composition cannot attach this shared fund later. Turn on governance now if the composition needs one.'}
                </p>
              )}
            </Card>
          )}

          {mode === 'create' && (
            <Card type="outline" size="md" className="space-y-4">
              <div className="flex flex-row items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Create with governance</p>
                  <p className="text-xs text-muted-foreground max-w-xl">
                    Hand the new composition to a DAO Safe instead of your
                    wallet. A Safe is a shared onchain account; one is created
                    for you in the same transaction and owns the composition
                    from the first block. Your wallet becomes the Safe&apos;s
                    only recorded owner, but a permanently sealed guard disables
                    owner-signed transactions: members direct the Safe through
                    delayed voting, and your wallet keeps only a slow, visible
                    recovery role.
                  </p>
                </div>
                <Switch
                  size="md"
                  enabled={withGovernance}
                  readOnly={!governedAvailable || (withFund && withGovernance)}
                  onClick={() => {
                    if (!governedAvailable || (withFund && withGovernance))
                      return
                    setWithGovernance(!withGovernance)
                    setSimulatedPayloadHash(null)
                    setTransactionProblem(null)
                  }}
                />
              </div>
              {withFund && (
                <p className="text-xs text-muted-foreground">
                  Governance is required while a shared fund is selected: the
                  fund&apos;s owner must be an initialized Safe.
                </p>
              )}
              {!governedAvailable && (
                <p className="text-xs text-muted-foreground">
                  Create with governance is not available on this deployment, so
                  a composition created here is owned by your wallet.
                </p>
              )}
              {withGovernance && (
                <div className="space-y-3 border-t border-border pt-3 text-sm">
                  {authority.valid ? (
                    <>
                      <p>
                        Member voting, read live from the governed factory:{' '}
                        {describeBlocks(authority.memberVotingDelay ?? 0n)}{' '}
                        before voting starts, then{' '}
                        {describeBlocks(authority.memberVotingPeriod ?? 0n)} to
                        vote and{' '}
                        {describeBlocks(authority.memberExecutionDelay ?? 0n)}{' '}
                        before the Safe executes a passed proposal.
                      </p>
                      <p>
                        Recovery: your wallet may publish one exact Safe action
                        but cannot execute it early. Anyone may execute it after{' '}
                        {describeSeconds(authority.recoveryDelay)}, and the
                        member-governed Safe can cancel it or replace the
                        proposer.
                      </p>
                      <p>
                        Policy rotations take longer under governance: a
                        proposed rotation must first pass a member vote (the
                        delays above), and the composition&apos;s own activation
                        timelock of{' '}
                        {describeSeconds(
                          policyActivationDelay as number | undefined
                        )}{' '}
                        runs after that before the new policy applies.
                      </p>
                    </>
                  ) : authority.loading ? (
                    <p className="text-muted-foreground">
                      Reading the live voting profile…
                    </p>
                  ) : (
                    <p className="text-destructive" role="alert">
                      {governanceIssue}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Score-selected Safe signers are not offered for
                    compositions: the only signer verifier today proves the
                    standard trust-graph pipeline.
                  </p>
                </div>
              )}
            </Card>
          )}

          {mode === 'create' && (
            <Card type="outline" size="md" className="space-y-3">
              <div>
                <p className="text-sm font-medium">
                  Pay for score refreshes up front?
                </p>
                <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                  Optional. The ETH goes into this composition&apos;s proving
                  tank and can pay for future score refreshes.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  className="w-32"
                  inputMode="decimal"
                  placeholder="0.5"
                  aria-label="Refresh prepayment in ETH"
                  value={prepayEth}
                  onChange={(event) => {
                    setPrepayEth(event.target.value)
                    setSimulatedPayloadHash(null)
                  }}
                />
                <span className="text-sm opacity-60">ETH (optional)</span>
              </div>
              {prepayEth.trim() && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor="composition-max-refresh"
                    >
                      Maximum per refresh
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm opacity-60">$</span>
                      <Input
                        id="composition-max-refresh"
                        className="w-32"
                        inputMode="decimal"
                        value={maxPerRootUsd}
                        onChange={(event) => {
                          setMaxPerRootUsd(event.target.value)
                          setSimulatedPayloadHash(null)
                        }}
                      />
                      <span className="text-sm opacity-60">USD</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      Paid no more often than
                    </div>
                    <div className="text-sm">
                      every {effectiveEpoch.toLocaleString()} blocks
                    </div>
                  </div>
                </div>
              )}
              {prepayIssue && (
                <p className="text-xs text-destructive" role="alert">
                  {prepayIssue}
                </p>
              )}
              {prepayEth.trim() && !prepayIssue && (
                <p className="text-xs text-muted-foreground">
                  {withGovernance
                    ? 'The simulation checks the proving price and installs this spending policy atomically with creation.'
                    : 'Creation deposits the ETH first, then your wallet asks for a second transaction to enable this spending policy. If you stop after creation, the ETH remains safe and you can finish in composition settings.'}
                </p>
              )}
            </Card>
          )}

          <Button
            type="button"
            onClick={buildPreview}
            disabled={busy || sources.length < 2}
          >
            {busy ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Build byte-exact preview
          </Button>
        </section>
      )}

      {preview && previewConfig && (
        <section className="space-y-4" aria-labelledby="preview-heading">
          <h2 id="preview-heading" className="text-lg font-medium">
            3. Attribution, disagreement, and sensitivity
          </h2>
          <div className="grid gap-3 md:grid-cols-4">
            {[
              ['Output root', preview.outputRoot],
              ['Policy TGCP SHA-256', preview.policyManifestSha256],
              ['Capture TGCM SHA-256', preview.captureManifestSha256],
              ['Output CID', preview.outputCid],
            ].map(([label, value]) => (
              <Card key={label} type="outline" size="sm">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="break-all font-mono text-xs">{value}</p>
              </Card>
            ))}
          </div>
          <Card type="outline" size="md" className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Exact quota</th>
                  <th>Raw total (not influence)</th>
                </tr>
              </thead>
              <tbody>
                {preview.sourceAllocations.map((allocation) => {
                  const source = previewConfig.sources.find(
                    (item) => item.sourceId === allocation.sourceId
                  )!
                  return (
                    <tr key={allocation.sourceId}>
                      <td>{source.name}</td>
                      <td>{allocation.quota.toString()}</td>
                      <td>{source.totalValue.toString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
          <div className="grid gap-3 md:grid-cols-3">
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">Support coverage</p>
              <p>{(preview.metrics.supportCoverage * 100).toFixed(2)}%</p>
            </Card>
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">
                Largest output share
              </p>
              <p>{(preview.metrics.largestShare * 100).toFixed(2)}%</p>
            </Card>
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">
                Work / conservative quote
              </p>
              <p>
                band {preview.work.band} · measured{' '}
                {preview.work.measuredCycles.toLocaleString()} cycles · band-3
                fee {quote.feeUsd?.toString() ?? 'unavailable'} USD-fixed units
              </p>
            </Card>
          </div>
          <Card type="outline" size="md" className="overflow-x-auto">
            <h3 className="mb-2 text-sm font-medium">
              Pairwise support/correlation/disagreement
            </h3>
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Overlap</th>
                  <th>Correlation</th>
                  <th>Disagreement</th>
                </tr>
              </thead>
              <tbody>
                {preview.metrics.pairwise.map((pair) => (
                  <tr key={`${pair.left}:${pair.right}`}>
                    <td>
                      {short(pair.left)} / {short(pair.right)}
                    </td>
                    <td>
                      {pair.overlapAccounts}/{pair.unionAccounts}
                    </td>
                    <td>{pair.correlation.toFixed(4)}</td>
                    <td>{(pair.disagreement * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card type="outline" size="md" className="overflow-x-auto">
            <h3 className="mb-2 text-sm font-medium">
              Per-account exact attribution
            </h3>
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Source</th>
                  <th>Exact contribution</th>
                  <th>Rounding delta numerator</th>
                </tr>
              </thead>
              <tbody>
                {preview.attribution.slice(0, 200).map((row) => (
                  <tr key={`${row.sourceId}:${row.account}`}>
                    <td className="font-mono">{short(row.account)}</td>
                    <td className="font-mono">{short(row.sourceId)}</td>
                    <td>{row.exactValue.toString()}</td>
                    <td>{row.roundingDeltaNumerator.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.attribution.length > 200 && (
              <p className="mt-2 text-xs">
                Showing 200 of {preview.attribution.length}; the durable epoch
                bundle retains all rows.
              </p>
            )}
          </Card>
          {simplex.length > 0 && (
            <Card type="outline" size="md" className="overflow-x-auto">
              <h3 className="mb-2 text-sm font-medium">
                A/B/C simplex sensitivity (20% grid)
              </h3>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>A/B/C</th>
                    <th>Top account</th>
                    <th>Changed top-five positions</th>
                  </tr>
                </thead>
                <tbody>
                  {simplex.map((sample) => (
                    <tr key={sample.weights.join('-')}>
                      <td>{sample.weights.join(' / ')}</td>
                      <td className="font-mono">
                        {short(sample.topAccounts[0]!)}
                      </td>
                      <td>{sample.changedTopAccounts.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}

      {preview && previewConfig && preflight && (
        <section className="space-y-4" aria-labelledby="preflight-heading">
          <h2 id="preflight-heading" className="text-lg font-medium">
            4. Final checks
          </h2>
          <div className="space-y-2">
            {preflight.issues
              .filter(
                (issue) =>
                  issue.level !== 'info' && issue.code !== 'adapter-required'
              )
              .map((issue, index) => (
                <Card
                  key={`${issue.code}:${index}`}
                  type="outline"
                  size="sm"
                  className={issue.blocks ? 'border-destructive' : ''}
                >
                  <div className="flex gap-2">
                    {issue.blocks ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{issue.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {issue.detail} {issue.action}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            {missingAdapters.length === 0 && transactionBlockers.length > 0 && (
              <Card type="outline" size="sm" className="border-destructive">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                  <div>
                    <p className="text-sm font-medium">
                      Finish the required creation details
                    </p>
                    <ul className="list-disc pl-4 text-xs text-muted-foreground">
                      {transactionBlockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </Card>
            )}
            {!preflight.blocked &&
              missingAdapters.length === 0 &&
              transactionBlockers.length === 0 && (
                <Card type="outline" size="sm">
                  <p className="text-sm text-emerald-700">
                    Ready to simulate the exact transaction.
                  </p>
                </Card>
              )}
          </div>
          {payload && (
            <p className="break-all font-mono text-xs text-muted-foreground">
              Exact transaction payload {keccak256(payload)}
            </p>
          )}
          {transactionProblem && (
            <Card type="outline" size="sm" className="border-destructive">
              <div className="flex min-w-0 gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Couldn&apos;t continue</p>
                  <p
                    role="alert"
                    className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {transactionProblem}
                  </p>
                </div>
              </div>
            </Card>
          )}
          {wrongChain ? (
            <Button
              type="button"
              disabled={switchingChain}
              onClick={() => switchChain({ chainId: targetChainId })}
            >
              Switch to {getTargetChainConfig().name}
            </Button>
          ) : !isConnected ? (
            <WalletConnectionButton />
          ) : missingAdapters.length > 0 ? (
            <Card type="outline" size="sm" className="space-y-3">
              <div>
                <p className="text-sm font-medium">Prepare selected sources</p>
                <p className="text-xs text-muted-foreground">
                  Each graph needs a one-time authentication contract before a
                  composition can use it. You&apos;ll approve{' '}
                  {missingAdapters.length} setup transaction
                  {missingAdapters.length === 1 ? '' : 's'}; successful sources
                  stay prepared if you stop partway through.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => deployAdapters(missingAdapters)}
                disabled={busy || !sourceAdapterFactory}
              >
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : null}
                Prepare {missingAdapters.length} source
                {missingAdapters.length === 1 ? '' : 's'}
              </Button>
              {!sourceAdapterFactory && (
                <p className="text-xs text-destructive">
                  This deployment has no source-adapter factory configured, so
                  composition creation is unavailable on this chain.
                </p>
              )}
            </Card>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={simulate}
                disabled={busy || !readyToSimulate}
              >
                Simulate exact payload
              </Button>
              <Button
                type="button"
                onClick={sign}
                disabled={busy || !simulatedPayloadHash || !payload}
              >
                {mode === 'create'
                  ? withGovernance
                    ? 'Create the composition with its Safe'
                    : 'Create composed graph'
                  : 'Propose timelocked rotation'}
              </Button>
              {readyToSimulate && !simulatedPayloadHash && (
                <p className="basis-full text-xs text-muted-foreground">
                  Simulation is the required final check before creation is
                  enabled.
                </p>
              )}
            </div>
          )}
          {simulatedPayloadHash && (
            <p className="text-sm text-emerald-700">
              Simulation passed for payload {short(simulatedPayloadHash)}.
              Wallet rejection does not discard it; any edit does.
            </p>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Source adapter calldata preview:{' '}
        {sources[0]
          ? short(compositionAdapterPayload(sources[0]))
          : 'select a source'}
        . This screen never imports raw edges, transfers weighted-prior state,
        or substitutes a missing required distribution.
      </p>
    </main>
  )
}
