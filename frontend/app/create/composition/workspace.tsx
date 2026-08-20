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
  fetchCompositionCandidates,
  fetchCompositionInstances,
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
  compositionSourceSnapshotAbi,
  compositionVaultAbi,
  governedTrustComposeFactoryAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from '@/lib/composition/contracts'
import {
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
  COMPOSITION_TRUTH_COPY,
  type CompositionQuote,
  compositionPreflight,
} from '@/lib/composition/preflight'
import { anchorCompositionPreview } from '@/lib/composition/workflow'
import { APIS, TRUST_COMPOSE_CONFIG } from '@/lib/config'
import { DISABLED_SIGNER_SYNC, describeSeconds } from '@/lib/governed-wrapper'
import {
  DEFAULT_MAX_PER_ROOT_USD,
  type InitialProvingPolicy,
  initialPolicyForCreation,
  initialPolicyProblem,
} from '@/lib/proving-prepay'
import { txToast } from '@/lib/tx'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'

import { describeBlocks } from '../model'

type Mode = 'create' | 'rotate'

const factory = (TRUST_COMPOSE_CONFIG?.factory || '') as Address
const factoryAvailable = isAddress(factory, { strict: false })
const governedFactory = (TRUST_COMPOSE_CONFIG?.governedFactory ||
  '') as Address
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

export const CompositionWorkspace = () => {
  const { address, isConnected } = useAccount()
  const targetChainId = getTargetChainId()
  const chainId = useChainId()
  const publicClient = usePublicClient({ chainId: targetChainId })
  const { switchChain, isPending: switchingChain } = useSwitchChain()
  const [mode, setMode] = useState<Mode>('create')
  const [catalog, setCatalog] = useState<CompositionCandidate[]>([])
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([])
  const [apiUnavailable, setApiUnavailable] = useState(false)
  const [sources, setSources] = useState<CompositionSource[]>([])
  const [loadingSource, setLoadingSource] = useState<Hex | null>(null)
  const [name, setName] = useState('')
  const [metadataURI, setMetadataURI] = useState('')
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
  const [instanceId, setInstanceId] = useState('')
  const [instance, setInstance] = useState<CompositionInstance | null>(null)
  const [policies, setPolicies] = useState<CompositionPolicy[]>([])
  const [rotateChoices, setRotateChoices] = useState<CompositionInstance[]>([])
  const [rotateChoicesLoading, setRotateChoicesLoading] = useState(false)
  const [preview, setPreview] = useState<CompositionPreview | null>(null)
  const [previewConfig, setPreviewConfig] = useState<CompositionConfig | null>(
    null
  )
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [simulatedPayloadHash, setSimulatedPayloadHash] = useState<Hex | null>(
    null
  )
  const [acknowledgements, setAcknowledgements] = useState<Set<string>>(
    new Set()
  )
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
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

  // Rotate mode picks the instance from the indexer's composition list instead of asking for a
  // bytes32 nobody has memorized. Unavailability degrades to the paste field, not an error.
  useEffect(() => {
    if (mode !== 'rotate') return
    const controller = new AbortController()
    setRotateChoicesLoading(true)
    fetchCompositionInstances(APIS.ponder, controller.signal)
      .then(setRotateChoices)
      .catch(() => {
        if (!controller.signal.aborted) setRotateChoices([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setRotateChoicesLoading(false)
      })
    return () => controller.abort()
  }, [mode])

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
    setLoadingSource(candidate.instanceId)
    setProblem(null)
    try {
      requireCompatibleCandidate(
        candidate,
        sources.map((source) => ({
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
      setSelected(rebalance([...sources, loaded]))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingSource(null)
    }
  }

  const updateSource = (sourceId: Hex, update: Partial<CompositionSource>) => {
    setSelected(
      sources.map((source) =>
        source.sourceId === sourceId ? { ...source, ...update } : source
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

  const deployAdapter = async (source: CompositionSource) => {
    if (!sourceAdapterFactory || !isAddress(sourceAdapterFactory)) {
      return setProblem(
        'The configured factory did not expose a source-adapter factory.'
      )
    }
    setBusy(true)
    setProblem(null)
    try {
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
            '0xf96f9891e6ddd310141c323b55c40e1ccf0fcb5560f755b3387240dee7f177a1',
            source.deploymentProvenance,
          ],
        },
        successMessage: `Authenticated adapter deployed for ${source.name}.`,
      })
      // Topic-keyed like every other receipt scan here (the adapter factory is called directly
      // today, but event-shape matching survives any future wrapping).
      const [adapterEvent] = parseEventLogs({
        abi: compositionSourceAdapterFactoryAbi,
        eventName: 'SourceAdapterCreated',
        logs: receipt.logs,
      })
      const adapter: Address | null = adapterEvent?.args.adapter ?? null
      if (!adapter)
        throw new Error('Adapter receipt did not contain SourceAdapterCreated.')
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
                item.sourceId === source.sourceId ? { ...item, adapter } : item
              ),
            }
          : null
      )
      setSimulatedPayloadHash(null)
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
    withFund && fundToken === 'other'
      ? !fundTokenAddress.trim()
        ? 'Paste the address of the token you plan to pay out.'
        : !isAddress(fundTokenAddress.trim(), { strict: false })
          ? "That doesn't look like a token address."
          : null
      : null

  // The optional refresh prepayment (governed creations only: it rides as transaction value and
  // the wrapper installs the paid policy on the new composition's proving tank atomically).
  const prepayIssue: string | null = (() => {
    if (!withGovernance) return null
    const trimmed = prepayEth.trim()
    if (!trimmed) return null
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
      return 'Enter an amount like 0.5, or leave it blank.'
    }
    if (Number(trimmed) === 0) {
      return 'Leave it blank rather than entering zero.'
    }
    return initialPolicyProblem(prepayEth, maxPerRootUsd)
  })()
  const prepayWei =
    withGovernance && prepayEth.trim() && !prepayIssue
      ? parseEther(prepayEth.trim())
      : 0n
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

  const preflight = useMemo(
    () =>
      compositionPreflight({
        config: previewConfig ?? {
          chainId: BigInt(targetChainId),
          captureBlock: 0n,
          scopeHash: DEFAULT_COMPOSITION_SCOPE,
          admittedProgramId:
            sources[0]?.programId ?? (`0x${'00'.repeat(32)}` as Hex),
          outputPool: BigInt(outputPool || '0'),
          bounds: V1_COMPOSITION_BOUNDS,
          sources,
        },
        preview,
        previewError,
        quote,
        stage: 'sign',
        acknowledgements,
      }),
    [
      acknowledgements,
      outputPool,
      preview,
      previewConfig,
      previewError,
      quote,
      sources,
      targetChainId,
    ]
  )

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

  const simulate = async () => {
    setProblem(null)
    setBusy(true)
    try {
      if (!publicClient || !address) throw new Error('Connect a wallet first.')
      if (wrongChain) throw new Error('Switch to the target chain first.')
      if (!preview || !previewConfig || !payload)
        throw new Error('Build the exact preview first.')
      if (preflight.blocked)
        throw new Error('Resolve every blocking preflight item first.')
      await assertPreviewSourcesCurrent()
      if (mode === 'create') {
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
              compositionCreateArgs(createFields, previewConfig, preview),
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
            args: [compositionCreateArgs(createFields, previewConfig, preview)],
          })
        }
      } else {
        if (!active) throw new Error('Load an active composition policy first.')
        if (pending)
          throw new Error('Cancel or activate the pending policy first.')
        await publicClient.simulateContract({
          account: address,
          address: active.controller,
          abi: trustComposeParamsControllerAbi,
          functionName: 'proposePolicy',
          args: [
            preview.policyManifest,
            previewConfig.sources.map((source) => source.adapter!),
            compositionMetadataDigest(
              preview,
              previewConfig.sources.map((source) => source.adapter!)
            ),
          ],
        })
      }
      setSimulatedPayloadHash(keccak256(payload))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const sign = async () => {
    setProblem(null)
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
              },
          successMessage: withGovernance
            ? 'Composition created; its Safe holds it from the first block.'
            : 'Governed composition instance created.',
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
            ? 'Creation confirmed. The durable provenance route will populate after indexing.'
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
      } else {
        if (!active) throw new Error('Load an active composition policy first.')
        await txToast({
          tx: {
            address: active.controller,
            abi: trustComposeParamsControllerAbi,
            functionName: 'proposePolicy',
            args: [
              preview.policyManifest,
              previewConfig.sources.map((source) => source.adapter!),
              compositionMetadataDigest(
                preview,
                previewConfig.sources.map((source) => source.adapter!)
              ),
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
      setProblem(error instanceof Error ? error.message : String(error))
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

  const simplex =
    preview && previewConfig ? compositionSimplex(previewConfig, 20) : []

  return (
    <main className="max-w-6xl space-y-8" aria-labelledby="composition-title">
      <header className="space-y-3">
        <h1 id="composition-title" className="text-2xl">
          Compose proved distributions
        </h1>
        <p className="max-w-4xl text-sm text-muted-foreground">
          {COMPOSITION_TRUTH_COPY.title}. {COMPOSITION_TRUTH_COPY.rawScale}{' '}
          {COMPOSITION_TRUTH_COPY.weights} {COMPOSITION_TRUTH_COPY.prior}
        </p>
        <Card type="outline" size="sm">
          <p className="text-sm">
            <strong>Fail-closed capture:</strong>{' '}
            {COMPOSITION_TRUTH_COPY.noFallback}
          </p>
        </Card>
        <div className="flex flex-wrap gap-2">
          {(['create', 'rotate'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              variant={mode === value ? 'default' : 'outline'}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value)
                invalidate()
              }}
            >
              {value === 'create'
                ? 'Create composition'
                : 'Rotate governed policy'}
            </Button>
          ))}
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
          <p role="alert" className="text-sm text-destructive">
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
              Open composition provenance
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
          <h2 className="font-medium">Composition to update</h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              id="composition-instance"
              aria-describedby="composition-instance-help"
              value={
                rotateChoices.some((choice) => choice.id === instanceId)
                  ? instanceId
                  : ''
              }
              onChange={(event) => setInstanceId(event.target.value)}
              disabled={rotateChoicesLoading}
              className="h-9 min-w-0 flex-1 border border-input bg-surface px-3 text-sm text-text focus:border-ink focus:outline-none"
            >
              <option value="">
                {rotateChoicesLoading
                  ? 'Loading compositions…'
                  : rotateChoices.length
                    ? 'Choose a composition…'
                    : 'No compositions available'}
              </option>
              {rotateChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name} · {short(choice.id)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              onClick={loadRotation}
              disabled={busy || !instanceId}
            >
              Load history
            </Button>
          </div>
          <Input
            value={instanceId}
            onChange={(event) => setInstanceId(event.target.value.trim())}
            placeholder="0x… or paste an instance ID instead"
            aria-label="Or paste a composition instance ID"
            aria-describedby="composition-instance-help"
            className="font-mono text-xs"
          />
          <p
            id="composition-instance-help"
            className="text-xs text-muted-foreground"
          >
            These are the compositions the indexer knows. Each one also shows
            this ID on its provenance page under{' '}
            <Link href="/compositions" className="underline underline-offset-4">
              /compositions
            </Link>
            .
          </p>
          {instanceId && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-muted-foreground">Instance ID:</span>
              <CopyableText text={instanceId} alwaysShowCopyIcon />
            </div>
          )}
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

      <section className="space-y-3" aria-labelledby="source-heading">
        <div>
          <h2 id="source-heading" className="text-lg font-medium">
            1. Compatible same-chain sources
          </h2>
          <p className="text-sm text-muted-foreground">
            V1 accepts 2–8 address allocation outputs with one identical
            authenticated program id. Raw edges and cross-program lookalikes are
            excluded.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {catalog.map((candidate) => {
            const selected = sources.some(
              (source) => source.instanceId === candidate.instanceId
            )
            const incompatible =
              sources.length > 0 &&
              (candidate.chainId !== sources[0]!.chainId.toString() ||
                candidate.programId !== sources[0]!.programId)
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
                      (!selected && (incompatible || sources.length >= 8))
                    }
                    onClick={() => toggleCandidate(candidate)}
                  >
                    {loadingSource === candidate.instanceId ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : selected ? (
                      'Remove'
                    ) : (
                      'Add'
                    )}
                  </Button>
                </div>
                <p className="break-all font-mono text-xs">
                  {candidate.snapshot}
                </p>
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
                    onClick={() => deployAdapter(source)}
                  >
                    Deploy reviewed adapter
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
              </label>
            )}
          </div>
          {mode === 'create' && (
            <label className="block text-sm">
              Metadata URI
              <Input
                value={metadataURI}
                onChange={(event) => {
                  setMetadataURI(event.target.value)
                  setSimulatedPayloadHash(null)
                }}
                placeholder="ipfs://…"
              />
            </label>
          )}

          {mode === 'create' && (
            <Card type="outline" size="md" className="space-y-4">
              <div className="flex flex-row items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Add a shared fund</p>
                  <p className="text-xs text-muted-foreground max-w-xl">
                    A shared fund lets your community put money in one place
                    and split it by the composed scores. Anyone can top it up,
                    and each member claims their own share. Skip this if you
                    only want the scoreboard.
                  </p>
                </div>
                <Switch
                  size="md"
                  enabled={withFund}
                  onClick={() => {
                    setWithFund(!withFund)
                    setSimulatedPayloadHash(null)
                  }}
                />
              </div>
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
                    fund holds anything and can pay out something else later.{' '}
                    {withGovernance
                      ? 'The new DAO Safe owns the fund, so payouts happen through member governance.'
                      : 'Your wallet owns the fund: money only moves when you send a payout, and each member claims their share themselves.'}
                  </p>
                </div>
              )}
              {!withFund && (
                <p className="text-xs text-muted-foreground">
                  Skipping this closes no doors: the composition&apos;s
                  authority can attach a fund later with the factory&apos;s
                  attachDistributor call, though this workspace does not offer
                  that button yet.
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
                    only recorded owner, but a permanently sealed guard
                    disables owner-signed transactions: members direct the
                    Safe through delayed voting, and your wallet keeps only a
                    slow, visible recovery role.
                  </p>
                </div>
                <Switch
                  size="md"
                  enabled={withGovernance}
                  readOnly={!governedAvailable}
                  onClick={() => {
                    if (!governedAvailable) return
                    setWithGovernance(!withGovernance)
                    setPrepayEth('')
                    setMaxPerRootUsd(DEFAULT_MAX_PER_ROOT_USD)
                    setSimulatedPayloadHash(null)
                  }}
                />
              </div>
              {!governedAvailable && (
                <p className="text-xs text-muted-foreground">
                  Create with governance is not available on this deployment,
                  so a composition created here is owned by your wallet.
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
                        but cannot execute it early. Anyone may execute it
                        after {describeSeconds(authority.recoveryDelay)}, and
                        the member-governed Safe can cancel it or replace the
                        proposer.
                      </p>
                      <p>
                        Policy rotations take longer under governance: a
                        proposed rotation must first pass a member vote (the
                        delays above), and the composition&apos;s own
                        activation timelock of{' '}
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

                  <div className="space-y-3 border-t border-border pt-3">
                    <p className="text-sm font-medium">
                      Pay for score refreshes up front?
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Composed scores only refresh if somebody does the work,
                      and that costs gas and proving time. Put ETH in during
                      creation to fund the first refreshes, or leave it blank.
                      The ETH lands in the new composition&apos;s proving tank,
                      and the DAO Safe controls it afterwards.
                    </p>
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
                      <span className="text-sm opacity-60">
                        ETH (optional)
                      </span>
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
                          <p className="text-xs text-muted-foreground">
                            Covers the proving fee and gas together; creation
                            is capped at $10,000.
                          </p>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">
                            Paid no more often than
                          </div>
                          <div className="text-sm">
                            every {effectiveEpoch.toLocaleString()} blocks, the
                            epoch length
                          </div>
                          <p className="text-xs text-muted-foreground">
                            This starts equal to the epoch schedule. The DAO
                            Safe can change it later.
                          </p>
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
                        Before anything is sent, the simulation checks that
                        this chain has priced the trust-compose proving band
                        (flat band 3) and that your cap covers that fee.
                        Creation is atomic: the ETH and the paid policy either
                        both land or neither does.
                      </p>
                    )}
                  </div>
                </div>
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

      {sources.length >= 2 && (
        <section className="space-y-4" aria-labelledby="preflight-heading">
          <h2 id="preflight-heading" className="text-lg font-medium">
            4. Preflight and governed receipt
          </h2>
          <div className="space-y-2">
            {preflight.issues.map((issue, index) => (
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
                    {issue.acknowledgementKey && (
                      <label className="mt-2 flex gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={acknowledgements.has(
                            issue.acknowledgementKey
                          )}
                          onChange={(event) => {
                            const next = new Set(acknowledgements)
                            event.target.checked
                              ? next.add(issue.acknowledgementKey!)
                              : next.delete(issue.acknowledgementKey!)
                            setAcknowledgements(next)
                            setSimulatedPayloadHash(null)
                          }}
                        />
                        I explicitly acknowledge this governed limitation.
                      </label>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <Card type="outline" size="sm">
            <p className="text-xs">
              Preview commitment is immutable until a source, accepted
              checkpoint, weight, family, capture block, output pool, adapter,
              or transaction field changes. The landed
              policy/capture/blob/output commitments are compared byte-for-byte
              on the durable epoch route.
            </p>
            {payload && (
              <p className="mt-2 break-all font-mono text-xs">
                payload {keccak256(payload)}
              </p>
            )}
          </Card>
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
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={simulate}
                disabled={
                  busy ||
                  !payload ||
                  preflight.blocked ||
                  !!fundIssue ||
                  !!prepayIssue ||
                  !!governanceIssue ||
                  (mode === 'create' && withGovernance && authority.loading)
                }
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
                    : 'Create governed composition'
                  : 'Propose timelocked rotation'}
              </Button>
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
