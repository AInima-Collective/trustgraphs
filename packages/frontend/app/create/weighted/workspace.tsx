'use client'

import { getPublicClient } from '@wagmi/core'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  LoaderCircle,
  RotateCcw,
  Square,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  useConfig,
  usePublicClient,
  useReadContract,
  useSwitchChain,
} from 'wagmi'

import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Switch } from '@/components/Switch'
import { Textarea } from '@/components/Textarea'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useNetworks } from '@/contexts/CatalogContext'
import { useAuthorityProfile } from '@/hooks/useAuthorityProfile'
import { APIS, GOVERNED_WEIGHTED_FACTORY, WEIGHTED_FACTORY } from '@/lib/config'
import { getEnsCoinType } from '@/lib/ens-query'
import { saveGovernancePrefill } from '@/lib/governance-prefill'
import { DISABLED_SIGNER_SYNC, describeSeconds } from '@/lib/governed-wrapper'
import {
  DEFAULT_MAX_PER_ROOT_USD,
  type InitialProvingPolicy,
  initialPolicyForCreation,
  initialPolicyProblem,
} from '@/lib/proving-prepay'
import { txToast } from '@/lib/tx'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'
import {
  type WeightedApiEntry,
  type WeightedApiInstanceDetail,
  type WeightedApiVersion,
  availabilityDiagnosis,
  fetchBinarySeeds,
  fetchWeightedEntries,
  fetchWeightedInstance,
  fetchWeightedVersions,
} from '@/lib/weighted-prior/api'
import {
  governedWeightedTrustgraphsFactoryAbi,
  weightedCreateArgs,
  weightedCreatePayload,
  weightedGovernedCreatePayload,
  weightedPriorParamsControllerAbi,
  weightedRotationPayload,
  weightedTrustgraphsFactoryAbi,
} from '@/lib/weighted-prior/contracts'
import {
  SCALE,
  paramsHash as weightedParamsHash,
} from '@/lib/weighted-prior/core'
import {
  MAX_WEIGHTED_IMPORT_BYTES,
  type ResolutionAnchor,
  WeightedEnsResolutionChangedError,
  type WeightedImportArtifacts,
  WeightedImportError,
  equalWeightCsv,
  parseWeightedSource,
  percent,
  recheckWeightedSource,
  requiresEnsResolution,
  resolveAddressOnlyWeightedSource,
  resolveWeightedSource,
  weightedExportArtifacts,
} from '@/lib/weighted-prior/import'
import {
  type WeightedRotationDiff,
  weightedRotationDiff,
} from '@/lib/weighted-prior/preview'
import type {
  WeightedPreviewWorkerRequest,
  WeightedPreviewWorkerResponse,
} from '@/lib/weighted-prior/preview.worker'
import { BINARY_REDEPLOYMENT_NOTICE } from '@/lib/weighted-prior/workflow'

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

type Mode = 'create' | 'rotate' | 'redeploy'
type Format = 'csv' | 'json'

const WEIGHTED_FACTORY_ADDRESS = (WEIGHTED_FACTORY || '') as Address
const FACTORY_AVAILABLE = isAddress(WEIGHTED_FACTORY_ADDRESS, {
  strict: false,
})
const GOVERNED_WEIGHTED_FACTORY_ADDRESS = (GOVERNED_WEIGHTED_FACTORY ||
  '') as Address
const GOVERNED_AVAILABLE = isAddress(GOVERNED_WEIGHTED_FACTORY_ADDRESS, {
  strict: false,
})

const download = (name: string, body: string | Uint8Array, type: string) => {
  const blob = new Blob([body as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

const randomSalt = (): Hex => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`
const EMPTY_SOURCE = 'account,weight\n'

const activeSharesCsv = (entries: readonly WeightedApiEntry[]): string => {
  const decimal = (raw: string) => {
    const value = BigInt(raw)
    const whole = value / SCALE
    const fraction = (value % SCALE)
      .toString()
      .padStart(18, '0')
      .replace(/0+$/, '')
    return fraction ? `${whole}.${fraction}` : whole.toString()
  }
  return `account,weight\n${entries
    .map((entry) => `${entry.account},${decimal(entry.normalizedWeight)}`)
    .join('\n')}\n`
}

const rotatedParamsHash = (
  instance: WeightedApiInstanceDetail,
  artifacts: WeightedImportArtifacts
): Hex =>
  weightedParamsHash({
    version: instance.params.version,
    dampingFp: BigInt(instance.params.dampingFp),
    toleranceFp: BigInt(instance.params.toleranceFp),
    maxIterations: instance.params.maxIterations,
    minWeight: BigInt(instance.params.minWeight),
    maxWeight: BigInt(instance.params.maxWeight),
    priorRoot: artifacts.priorRoot,
    priorCount: artifacts.priorCount,
    manifestSha256: artifacts.manifestSha256,
    schemaUid: instance.params.schemaUid,
    weightFieldIndex: instance.params.weightFieldIndex,
    accumulator: instance.params.accumulator,
    chainId: BigInt(instance.params.chainId),
  })

export const WeightedPriorWorkspace = ({
  rotationInstanceId,
}: {
  rotationInstanceId?: Hex
} = {}) => {
  const administrative = !!rotationInstanceId
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const targetChainId = getTargetChainId()
  const chainId = useChainId()
  const publicClient = usePublicClient({ chainId: targetChainId })
  const { switchChain, isPending: switchingChain } = useSwitchChain()
  const [mode, setMode] = useState<Mode>(
    rotationInstanceId ? 'rotate' : 'create'
  )
  const [format, setFormat] = useState<Format>('csv')
  const [sourceText, setSourceText] = useState(EMPTY_SOURCE)
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null)
  const [artifacts, setArtifacts] = useState<WeightedImportArtifacts | null>(
    null
  )
  const [problem, setProblem] = useState<string | null>(null)
  const [fieldIssues, setFieldIssues] = useState<WeightedImportError['issues']>(
    []
  )
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    phase: string
    elapsedMs?: number
    outputRoot?: string
    iterations?: number
  } | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const workerId = useRef(0)

  const [name, setName] = useState('')
  const [profile, setProfile] = useState<NetworkProfile>(EMPTY_NETWORK_PROFILE)
  const [pinnedMetadata, setPinnedMetadata] = useState<{
    uri: string
    fingerprint: string
  } | null>(null)
  const [sourceUri, setSourceUri] = useState('')
  const [author, setAuthor] = useState('')
  const [license, setLicense] = useState('')
  const [transform, setTransform] = useState('')
  const [epochLength, setEpochLength] = useState('0')
  const [salt] = useState<Hex>(randomSalt)
  // The fund and governance are structural creation-time features: they can only
  // be chosen here, so both are explicit switches rather than hidden defaults.
  const [withFund, setWithFund] = useState(false)
  const [fundToken, setFundToken] = useState<'eth' | 'other'>('eth')
  const [fundTokenAddress, setFundTokenAddress] = useState('')
  const [withGovernance, setWithGovernance] = useState(false)
  const [prepayEth, setPrepayEth] = useState('')
  const [maxPerRootUsd, setMaxPerRootUsd] = useState(DEFAULT_MAX_PER_ROOT_USD)

  const [instanceId, setInstanceId] = useState(rotationInstanceId ?? '')
  const [versions, setVersions] = useState<WeightedApiVersion[]>([])
  const [rotationInstance, setRotationInstance] =
    useState<WeightedApiInstanceDetail | null>(null)
  const [currentEntries, setCurrentEntries] = useState<WeightedApiEntry[]>([])
  const [binaryInstanceId, setBinaryInstanceId] = useState('')
  const [gasEstimate, setGasEstimate] = useState<bigint | null>(null)
  const [simulatedPayload, setSimulatedPayload] = useState<Hex | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    instanceId: Hex | null
    txHash: Hex
    safe: Hex | null
  } | null>(null)
  const [prefilled, setPrefilled] = useState<number | null>(null)

  // The catalog is mounted app-wide and server-seeded, so the picker of standard networks costs
  // no extra request. Networks that predate the factory carry no instance id and cannot be looked
  // up by one, so they are not offered.
  const networks = useNetworks()
  const binaryChoices = useMemo(
    () =>
      networks.flatMap((network) =>
        network.instanceId
          ? [{ id: network.instanceId, name: network.name }]
          : []
      ),
    [networks]
  )

  const active = versions.find((version) => version.status === 'active')
  const pending = versions.find((version) => version.status === 'pending')
  const governedRotation = !!rotationInstance?.governance
  const { data: rotationOwner } = useReadContract({
    address: active?.controller as Address,
    abi: weightedPriorParamsControllerAbi,
    functionName: 'owner',
    query: { enabled: !!active?.controller },
  })
  const connectedOwnsController =
    !!address &&
    !!rotationOwner &&
    address.toLowerCase() === rotationOwner.toLowerCase()
  const rotationDiff: WeightedRotationDiff | null = useMemo(
    () =>
      artifacts && currentEntries.length
        ? weightedRotationDiff(
            currentEntries.map((entry) => ({
              account: entry.account,
              normalizedWeight: BigInt(entry.normalizedWeight),
            })),
            artifacts
          )
        : null,
    [artifacts, currentEntries]
  )

  const { data: epochFloor } = useReadContract({
    address: FACTORY_AVAILABLE ? WEIGHTED_FACTORY_ADDRESS : zeroAddress,
    abi: weightedTrustgraphsFactoryAbi,
    functionName: 'EPOCH_FLOOR',
    query: { enabled: FACTORY_AVAILABLE },
  })
  // The delay the base factory installs on every prior update, for the compounded-delay copy in
  // the governance section: under governance an update waits through voting, execution, AND this.
  const { data: priorActivationDelay } = useReadContract({
    address: FACTORY_AVAILABLE ? WEIGHTED_FACTORY_ADDRESS : zeroAddress,
    abi: weightedTrustgraphsFactoryAbi,
    functionName: 'PRIOR_ACTIVATION_DELAY',
    query: { enabled: FACTORY_AVAILABLE },
  })
  // The wrapper's live governance profile, checked the way the main wizard's review screen checks
  // it: creation with governance is disabled unless the sealed-authority profile reads back sound.
  const authority = useAuthorityProfile(
    GOVERNED_AVAILABLE ? GOVERNED_WEIGHTED_FACTORY_ADDRESS : undefined
  )

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
    setSimulatedPayload(null)
  }

  const ensureMetadataURI = async () => {
    if (metadataIssue) throw new Error(metadataIssue)
    if (!hasNetworkProfile(profile)) return ''
    if (pinnedMetadata?.fingerprint === metadataKey) return pinnedMetadata.uri
    const { uri } = await pinMetadata(metadata)
    setPinnedMetadata({ uri, fingerprint: metadataKey })
    return uri
  }

  const provenance = useMemo(
    () => ({ sourceUri, author, license, transform }),
    [sourceUri, author, license, transform]
  )

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

  // The optional refresh prepayment (governed creations only: it rides as transaction value and
  // the wrapper installs the paid policy on the new network's proving tank atomically).
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
    : !GOVERNED_AVAILABLE
      ? 'Create with governance is not available on this deployment.'
      : !authority.loading && !authority.valid
        ? 'The configured governed factory does not expose the sealed guard, member-delay, and 14-day recovery profile this app requires, so creating with governance is disabled here.'
        : null

  const createFields = useMemo(
    () => ({
      name,
      metadataURI,
      dampingFp: 850_000_000_000_000_000n,
      toleranceFp: 0n,
      maxIterations: 40,
      minWeight: 0n,
      maxWeight: 100n,
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
    }),
    [
      address,
      epochLength,
      fundToken,
      fundTokenAddress,
      metadataURI,
      name,
      salt,
      withFund,
      withGovernance,
    ]
  )

  const transactionPayload = useMemo(() => {
    if (!artifacts) return null
    if (mode === 'rotate') return weightedRotationPayload(artifacts)
    if (withGovernance) {
      return initialPolicy
        ? weightedGovernedCreatePayload(createFields, artifacts, initialPolicy)
        : null
    }
    return weightedCreatePayload(createFields, artifacts)
  }, [artifacts, createFields, initialPolicy, mode, withGovernance])

  const clearDerived = () => {
    workerRef.current?.terminate()
    workerRef.current = null
    setArtifacts(null)
    setPreview(null)
    setGasEstimate(null)
    setSimulatedPayload(null)
    setSuccess(null)
    setCreated(null)
    setProblem(null)
    setFieldIssues([])
  }

  const startPreview = useCallback((next: WeightedImportArtifacts) => {
    workerRef.current?.terminate()
    const worker = new Worker(
      new URL('../../../lib/weighted-prior/preview.worker.ts', import.meta.url),
      { type: 'module' }
    )
    workerRef.current = worker
    const id = ++workerId.current
    setPreview({ phase: 'Computing the exact day-zero scores…' })
    worker.onmessage = (
      message: MessageEvent<WeightedPreviewWorkerResponse>
    ) => {
      if (message.data.id !== id) return
      if (message.data.phase === 'starting') {
        setPreview({ phase: 'Exact commitments ready…' })
      } else if (message.data.phase === 'iterating') {
        setPreview({ phase: 'Running the 40 exact scoring rounds…' })
      } else if (message.data.phase === 'complete') {
        setPreview({
          phase: 'Complete',
          elapsedMs: message.data.elapsedMs,
          outputRoot: message.data.outputRoot,
          iterations: message.data.iterations,
        })
        worker.terminate()
        workerRef.current = null
      } else {
        setPreview({ phase: `Preview failed: ${message.data.error}` })
        worker.terminate()
        workerRef.current = null
      }
    }
    worker.onerror = (event) => {
      if (workerId.current !== id) return
      setPreview({ phase: `Preview failed: ${event.message}` })
      worker.terminate()
      workerRef.current = null
    }
    worker.postMessage({
      id,
      artifacts: next,
    } satisfies WeightedPreviewWorkerRequest)
  }, [])

  const ensContext = async () => {
    const client = getPublicClient(config, { chainId: 1 })
    if (!client) throw new Error('Ethereum mainnet ENS client is unavailable.')
    const block = await client.getBlock({ blockTag: 'finalized' })
    const anchor: ResolutionAnchor = {
      chainId: 1,
      blockNumber: block.number,
      blockHash: block.hash,
    }
    return {
      anchor,
      resolve: async (ensName: string, at: ResolutionAnchor) =>
        client.getEnsAddress({
          name: ensName,
          coinType: getEnsCoinType(targetChainId),
          blockNumber: at.blockNumber,
        }),
    }
  }

  const importSource = async () => {
    setBusy(true)
    setProblem(null)
    setFieldIssues([])
    setSuccess(null)
    try {
      const parsed = parseWeightedSource(
        sourceBytes ?? sourceText,
        format,
        BigInt(targetChainId)
      )
      const next = requiresEnsResolution(parsed)
        ? await (async () => {
            const { anchor, resolve } = await ensContext()
            return resolveWeightedSource(parsed, anchor, resolve, provenance)
          })()
        : await resolveAddressOnlyWeightedSource(parsed, provenance)
      setArtifacts(next)
      setGasEstimate(null)
      setSimulatedPayload(null)
      startPreview(next)
    } catch (error) {
      if (error instanceof WeightedImportError) {
        setFieldIssues(error.issues)
        setProblem('Fix the highlighted import fields and try again.')
      } else {
        setProblem(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const loadRotation = async (id: string = instanceId) => {
    if (!isHex(id) || id.length !== 66) {
      setProblem(
        'Choose a weighted network from the list, or paste its 32-byte instance ID.'
      )
      return
    }
    setBusy(true)
    setProblem(null)
    setVersions([])
    setCurrentEntries([])
    setRotationInstance(null)
    try {
      const [nextVersions, nextInstance] = await Promise.all([
        fetchWeightedVersions(APIS.ponder, id as Hex),
        fetchWeightedInstance(APIS.ponder, id as Hex),
      ])
      const nextActive = nextVersions.find(
        (version) => version.status === 'active'
      )
      if (!nextActive)
        throw new Error(
          'The indexer has no active version for that network yet. A network created moments ago appears as soon as its creation is indexed.'
        )
      setVersions(nextVersions)
      setRotationInstance(nextInstance)
      const entries =
        nextActive.availability.status === 'unavailable'
          ? []
          : await fetchWeightedEntries(
              APIS.ponder,
              id as Hex,
              nextActive.version
            )
      setCurrentEntries(entries)
      if (rotationInstanceId && sourceText === EMPTY_SOURCE && entries.length) {
        setSourceText(activeSharesCsv(entries))
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // Settings owns existing-network administration. This component receives that network's fixed
  // id when embedded there; the creation URL keeps only its create-wizard account prefill.
  useEffect(() => {
    if (rotationInstanceId) {
      setMode('rotate')
      setInstanceId(rotationInstanceId)
      void loadRotation(rotationInstanceId)
      return
    }
    const params = new URLSearchParams(window.location.search)
    const instance = params.get('instance')
    if (instance && isHex(instance) && instance.length === 66) {
      router.replace(`/networks/${instance}/settings?tab=scoring`)
      return
    }
    const accounts = (params.get('accounts') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => isAddress(value, { strict: false }))
    if (accounts.length) {
      setFormat('csv')
      setSourceBytes(null)
      setSourceText(equalWeightCsv(accounts as Hex[]))
      setPrefilled(accounts.length)
    }
    // Run once, against the URL the page opened with.
  }, [])

  /** Administration begins from the created network's Settings, never inside the create wizard. */
  const openForUpdate = (id: Hex) => {
    router.push(`/networks/${id}/settings?tab=scoring`)
  }

  const prefillBinary = async () => {
    if (!isHex(binaryInstanceId) || binaryInstanceId.length !== 66) {
      setProblem(
        'Choose a network from the list, or paste its 32-byte instance ID.'
      )
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const seeds = await fetchBinarySeeds(APIS.ponder, binaryInstanceId as Hex)
      if (!seeds.length)
        throw new Error('That binary instance has no starting accounts.')
      setFormat('csv')
      setSourceBytes(null)
      setSourceText(equalWeightCsv(seeds))
      setSourceUri(`${APIS.ponder}/instances/${binaryInstanceId}`)
      clearDerived()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const ensureFresh = async () => {
    if (!artifacts)
      throw new Error('Add and check some starting weights first.')
    if (artifacts.ensResolutions.length === 0) return artifacts
    const { anchor, resolve } = await ensContext()
    try {
      return await recheckWeightedSource(artifacts, anchor, resolve, provenance)
    } catch (error) {
      if (error instanceof WeightedEnsResolutionChangedError) {
        setArtifacts(error.rebuilt)
        setGasEstimate(null)
        setSimulatedPayload(null)
        startPreview(error.rebuilt)
      }
      throw error
    }
  }

  const simulate = async () => {
    setProblem(null)
    setBusy(true)
    try {
      if (wrongChain)
        throw new Error('Switch the wallet to the target chain first.')
      const exact = await ensureFresh()
      if (!publicClient || !address) throw new Error('Connect a wallet first.')
      const exactCreateFields =
        mode === 'rotate'
          ? createFields
          : { ...createFields, metadataURI: await ensureMetadataURI() }
      if (mode === 'rotate') {
        if (!active) throw new Error('Load an active weighted instance first.')
        if (!rotationInstance)
          throw new Error('Load the weighted network details first.')
        if (pending) {
          throw new Error(
            'Activate or cancel the existing pending version before proposing another.'
          )
        }
        if (!rotationInstance.governance && !connectedOwnsController) {
          throw new Error(
            `Only the weighted-parameters controller owner (${rotationOwner ?? 'not available'}) can propose this change.`
          )
        }
        const caller = rotationInstance.governance?.safe ?? address
        await publicClient.simulateContract({
          account: caller,
          address: active.controller as Address,
          abi: weightedPriorParamsControllerAbi,
          functionName: 'proposePrior',
          args: [exact.manifest, exact.metadataDigest],
        })
        setGasEstimate(
          await publicClient.estimateContractGas({
            account: caller,
            address: active.controller as Address,
            abi: weightedPriorParamsControllerAbi,
            functionName: 'proposePrior',
            args: [exact.manifest, exact.metadataDigest],
          })
        )
        setSimulatedPayload(keccak256(weightedRotationPayload(exact)))
      } else if (withGovernance) {
        if (governanceIssue) throw new Error(governanceIssue)
        if (fundIssue || prepayIssue)
          throw new Error(fundIssue ?? prepayIssue ?? '')
        if (!initialPolicy)
          throw new Error('Fix the refresh prepayment fields first.')
        const args = weightedCreateArgs(exactCreateFields, exact)
        const governedCall = {
          account: address,
          address: GOVERNED_WEIGHTED_FACTORY_ADDRESS,
          abi: governedWeightedTrustgraphsFactoryAbi,
          functionName: 'createGovernedInstance',
          args: [args, initialPolicy, DISABLED_SIGNER_SYNC],
          ...(prepayWei > 0n ? { value: prepayWei } : {}),
        } as const
        await publicClient.simulateContract(governedCall)
        setGasEstimate(await publicClient.estimateContractGas(governedCall))
        setSimulatedPayload(
          keccak256(
            weightedGovernedCreatePayload(
              exactCreateFields,
              exact,
              initialPolicy
            )
          )
        )
      } else {
        if (!FACTORY_AVAILABLE)
          throw new Error('No weighted factory is configured.')
        if (fundIssue) throw new Error(fundIssue)
        const args = weightedCreateArgs(exactCreateFields, exact)
        await publicClient.simulateContract({
          account: address,
          address: WEIGHTED_FACTORY_ADDRESS,
          abi: weightedTrustgraphsFactoryAbi,
          functionName: 'createInstance',
          args: [args],
        })
        setGasEstimate(
          await publicClient.estimateContractGas({
            account: address,
            address: WEIGHTED_FACTORY_ADDRESS,
            abi: weightedTrustgraphsFactoryAbi,
            functionName: 'createInstance',
            args: [args],
          })
        )
        setSimulatedPayload(
          keccak256(weightedCreatePayload(exactCreateFields, exact))
        )
      }
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
      if (wrongChain)
        throw new Error('Switch the wallet to the target chain first.')
      const exact = await ensureFresh()
      const exactPayload =
        mode === 'rotate'
          ? weightedRotationPayload(exact)
          : withGovernance
            ? initialPolicy
              ? weightedGovernedCreatePayload(
                  createFields,
                  exact,
                  initialPolicy
                )
              : null
            : weightedCreatePayload(createFields, exact)
      if (!exactPayload || keccak256(exactPayload) !== simulatedPayload) {
        throw new Error(
          'The exact payload changed. Simulate it again before signing.'
        )
      }
      if (mode === 'rotate') {
        if (!active) throw new Error('Load an active weighted instance first.')
        if (!rotationInstance)
          throw new Error('Load the weighted network details first.')
        if (pending) {
          throw new Error(
            'Activate or cancel the existing pending version before proposing another.'
          )
        }
        if (rotationInstance.governance) {
          const data = weightedRotationPayload(exact)
          const fingerprint = keccak256(data)
          const nextParamsHash = rotatedParamsHash(rotationInstance, exact)
          saveGovernancePrefill({
            networkId: rotationInstance.id,
            fingerprint,
            parentHash: active.commitments.paramsHash,
            proposedHash: nextParamsHash,
            title: 'Change weighted starting shares',
            description: `Replace the network's persistent starting-share distribution with the reviewed ${exact.priorCount}-account manifest. Vouches and ordinary score updates do not require this action.\n\nCurrent params hash: ${active.commitments.paramsHash}\nProposed params hash: ${nextParamsHash}\nPrior root: ${exact.priorRoot}\nManifest SHA-256: ${exact.manifestSha256}\n\nIf this proposal passes and the Safe executes it, the controller's separate activation delay must still elapse before anyone can activate the new version.`,
            actions: [
              {
                target: active.controller,
                value: '0',
                data,
                operation: 0,
                description: 'Propose the reviewed weighted starting shares',
                contractName: 'WeightedPriorParamsController',
                functionSignature: 'proposePrior(bytes,bytes32)',
              },
            ],
            createdAt: Date.now(),
          })
          router.push(
            `/networks/${rotationInstance.id}/governance?new=1&actionDraft=${fingerprint}`
          )
          return
        }
        if (!connectedOwnsController) {
          throw new Error(
            `Only the weighted-parameters controller owner (${rotationOwner ?? 'not available'}) can propose this change.`
          )
        }
        await txToast({
          tx: {
            address: active.controller as Address,
            abi: weightedPriorParamsControllerAbi,
            functionName: 'proposePrior',
            args: [exact.manifest, exact.metadataDigest],
          },
          successMessage:
            'Starting-share change proposed; the activation delay is now running.',
        })
        setSuccess(
          'Starting-share change proposed. It can be activated once the delay has passed; the timing shows above.'
        )
        await loadRotation()
      } else {
        const [receipt] = await txToast({
          tx: withGovernance
            ? ({
                address: GOVERNED_WEIGHTED_FACTORY_ADDRESS,
                abi: governedWeightedTrustgraphsFactoryAbi,
                functionName: 'createGovernedInstance',
                args: [
                  weightedCreateArgs(createFields, exact),
                  initialPolicy!,
                  DISABLED_SIGNER_SYNC,
                ],
                ...(prepayWei > 0n ? { value: prepayWei } : {}),
              } as any)
            : {
                address: WEIGHTED_FACTORY_ADDRESS,
                abi: weightedTrustgraphsFactoryAbi,
                functionName: 'createInstance',
                args: [weightedCreateArgs(createFields, exact)],
              },
          successMessage: withGovernance
            ? 'Weighted network created; its Safe holds it from the first block.'
            : 'Weighted network created.',
        })
        // One receipt-scanning path for both creation lanes, keyed by event topic rather than by
        // emitting address: under the governed wrapper the BASE factory emits the creation event
        // and the new Safe is the creator, so address filtering would find nothing.
        const [createdEvent] = parseEventLogs({
          abi: weightedTrustgraphsFactoryAbi,
          eventName: 'WeightedInstanceCreated',
          logs: receipt.logs,
        })
        const [governedEvent] = parseEventLogs({
          abi: governedWeightedTrustgraphsFactoryAbi,
          eventName: 'GovernedInstanceCreated',
          logs: receipt.logs,
        })
        setCreated({
          instanceId: createdEvent?.args.instanceId ?? null,
          txHash: receipt.transactionHash,
          safe: governedEvent?.args.safe ?? null,
        })
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const activate = async () => {
    if (!pending) return
    setBusy(true)
    setProblem(null)
    try {
      if (wrongChain)
        throw new Error('Switch the wallet to the target chain first.')
      if (pending.availability.status === 'unavailable') {
        throw new Error(
          'The exact bytes of the pending update cannot be recovered right now. Review them before activation.'
        )
      }
      if (
        BigInt(pending.readyAt ?? '0') > BigInt(Math.floor(Date.now() / 1000))
      ) {
        throw new Error('The activation delay has not finished yet.')
      }
      if (!publicClient || !address) throw new Error('Connect a wallet first.')
      await publicClient.simulateContract({
        account: address,
        address: pending.controller as Address,
        abi: weightedPriorParamsControllerAbi,
        functionName: 'activatePrior',
        args: [BigInt(pending.version)],
      })
      await txToast({
        tx: {
          address: pending.controller as Address,
          abi: weightedPriorParamsControllerAbi,
          functionName: 'activatePrior',
          args: [BigInt(pending.version)],
        },
        successMessage: `Version ${pending.version} is now active.`,
      })
      setSuccess(`Version ${pending.version} is active.`)
      await loadRotation()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const modeButton = (value: Mode, label: string) => (
    <Button
      type="button"
      variant={mode === value ? 'default' : 'outline'}
      aria-pressed={mode === value}
      onClick={() => {
        setMode(value)
        clearDerived()
      }}
    >
      {label}
    </Button>
  )

  const activeDiagnosis = active
    ? availabilityDiagnosis(active.availability)
    : null
  const pendingDiagnosis = pending
    ? availabilityDiagnosis(pending.availability)
    : null
  const wrongChain = isConnected && chainId !== targetChainId
  const payloadMatches =
    transactionPayload && simulatedPayload === keccak256(transactionPayload)
  const Root = administrative ? 'div' : 'main'

  return (
    <Root
      className={administrative ? 'space-y-8' : 'max-w-5xl space-y-8'}
      aria-labelledby="weighted-title"
    >
      <header className="space-y-3">
        <h1 id="weighted-title" className="text-2xl">
          {administrative ? 'Starting shares' : 'Create a weighted network'}
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          {administrative
            ? 'Review the persistent trust-anchor distribution and its version history. These shares are not a membership list: vouches bring new people into the graph and change scores without editing them. Replace the distribution only when this network deliberately changes its anchor policy.'
            : 'Choose who gets a head start and how much. Your starting accounts begin with shares of exactly the sizes you set (an account with weight 10 starts with four times the share of one with weight 2.5), and vouches still decide the final scores. Paste a list or upload a spreadsheet, check the shares, then create the network.'}
        </p>
        {!administrative && (
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Weighted creation source"
          >
            {modeButton('create', 'Enter starting shares')}
            {modeButton('redeploy', 'Copy starting accounts')}
          </div>
        )}
      </header>

      {wrongChain && (
        <Card type="outline" size="md" className="space-y-3 border-warning">
          <p className="text-sm" role="alert">
            Your wallet is on a different network. Switch to{' '}
            {getTargetChainConfig().name} before simulation or signing.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={switchingChain}
            onClick={() => switchChain({ chainId: targetChainId })}
          >
            Switch to {getTargetChainConfig().name}
          </Button>
        </Card>
      )}

      {mode === 'redeploy' && (
        <Card type="outline" size="md" className="space-y-4 border-warning">
          <div className="flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="text-sm">{BINARY_REDEPLOYMENT_NOTICE}</p>
          </div>
          <label htmlFor="binary-instance" className="text-sm font-medium">
            Network to copy starting accounts from
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              id="binary-instance"
              aria-describedby="binary-instance-help"
              value={
                binaryChoices.some((choice) => choice.id === binaryInstanceId)
                  ? binaryInstanceId
                  : ''
              }
              onChange={(event) => {
                setBinaryInstanceId(event.target.value)
                clearDerived()
              }}
              className="h-9 min-w-0 flex-1 border border-input bg-surface px-3 text-sm text-text focus:border-ink focus:outline-none"
            >
              <option value="">
                {binaryChoices.length
                  ? 'Choose a network…'
                  : 'No networks available'}
              </option>
              {binaryChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name} · {short(choice.id)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              onClick={prefillBinary}
              disabled={busy || !binaryInstanceId}
            >
              Use starting accounts
            </Button>
          </div>
          <Input
            aria-label="Or paste a network instance ID"
            aria-describedby="binary-instance-help"
            className="font-mono text-xs"
            placeholder="0x… or paste an instance ID instead"
            value={binaryInstanceId}
            onChange={(event) => {
              setBinaryInstanceId(event.target.value.trim())
              clearDerived()
            }}
          />
          <p
            id="binary-instance-help"
            className="text-xs text-muted-foreground"
          >
            These are the networks in the live{' '}
            <Link href="/networks" className="underline underline-offset-4">
              network directory
            </Link>
            . A network&apos;s ID is also in its page URL and under Settings →
            Advanced → Instance provenance.
          </p>
          {binaryInstanceId && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-muted-foreground">Instance ID:</span>
              <CopyableText text={binaryInstanceId} alwaysShowCopyIcon />
            </div>
          )}
        </Card>
      )}

      {mode === 'rotate' && (
        <Card type="outline" size="md" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">Current version</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadRotation()}
              disabled={busy || !instanceId}
            >
              Reload history
            </Button>
          </div>
          {instanceId && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-muted-foreground">Instance ID:</span>
              <CopyableText text={instanceId} alwaysShowCopyIcon />
            </div>
          )}
          {active && (
            <div className="text-sm space-y-1">
              <p>
                Active version {active.version} ·{' '}
                {active.commitments.priorCount} entries ·{' '}
                {active.availability.status}
              </p>
              <p className="font-mono text-xs">
                {active.commitments.paramsHash}
              </p>
              <p className="text-xs text-muted-foreground">
                {governedRotation
                  ? 'Changes must pass this network’s trust-weighted governance. This workspace prepares the exact Safe action; it cannot bypass the vote.'
                  : rotationOwner
                    ? `Only the controller owner ${short(rotationOwner)} can propose a change.`
                    : 'Reading the current controller owner…'}{' '}
                Once proposed, anyone may activate the reviewed version after
                its separate delay.
              </p>
            </div>
          )}
          {activeDiagnosis && (
            <p
              className={
                active?.availability.status === 'unavailable'
                  ? 'text-sm text-destructive'
                  : 'text-sm text-warning'
              }
              role="alert"
            >
              {activeDiagnosis}
            </p>
          )}
          {pending && (
            <div className="space-y-2 border-t border-border pt-3 text-sm">
              <p>
                Pending version {pending.version}; activation time{' '}
                {pending.readyAt
                  ? new Date(Number(pending.readyAt) * 1000).toLocaleString()
                  : 'unknown'}
                .
              </p>
              <p>
                Exact bytes of the pending update: {pending.availability.status}{' '}
                via {pending.availability.provenance}.
              </p>
              {pendingDiagnosis && (
                <p
                  className={
                    pending.availability.status === 'unavailable'
                      ? 'text-destructive'
                      : 'text-warning'
                  }
                  role="alert"
                >
                  {pendingDiagnosis}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={activate}
                disabled={
                  busy ||
                  wrongChain ||
                  pending.availability.status === 'unavailable'
                }
              >
                Activate after the delay
              </Button>
            </div>
          )}
        </Card>
      )}

      <section className="space-y-4" aria-labelledby="source-heading">
        <h2 id="source-heading" className="text-lg">
          {administrative
            ? '1. Enter replacement shares'
            : '1. Add starting accounts and weights'}
        </h2>
        <Card type="outline" size="md" className="space-y-4">
          {prefilled !== null && (
            <p className="text-xs text-muted-foreground" role="status">
              {prefilled} starting {prefilled === 1 ? 'account' : 'accounts'}{' '}
              came across from the create wizard, each with weight 1. Edit the
              numbers to set their sizes.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="prior-format" className="text-sm font-medium">
                Source format
              </label>
              <select
                id="prior-format"
                value={format}
                onChange={(event) => {
                  setFormat(event.target.value as Format)
                  setSourceBytes(null)
                  clearDerived()
                }}
                className="mt-1 h-9 w-full border border-input bg-surface px-3 text-sm"
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <div>
              <label htmlFor="prior-file" className="text-sm font-medium">
                Upload file (maximum{' '}
                {Math.floor(MAX_WEIGHTED_IMPORT_BYTES / 1024 / 1024)} MiB)
              </label>
              <Input
                id="prior-file"
                type="file"
                accept=".csv,.json,text/csv,application/json"
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  if (file.size > MAX_WEIGHTED_IMPORT_BYTES) {
                    clearDerived()
                    setProblem(
                      `That file exceeds the ${MAX_WEIGHTED_IMPORT_BYTES}-byte limit.`
                    )
                    return
                  }
                  const bytes = new Uint8Array(await file.arrayBuffer())
                  setSourceBytes(bytes)
                  setSourceText(new TextDecoder().decode(bytes))
                  setFormat(
                    file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'
                  )
                  clearDerived()
                }}
              />
            </div>
          </div>
          <label htmlFor="prior-source" className="text-sm font-medium">
            Starting accounts and weights
          </label>
          <Textarea
            id="prior-source"
            rows={10}
            value={sourceText}
            aria-invalid={fieldIssues.length > 0}
            aria-describedby="prior-source-help prior-errors"
            onChange={(event) => {
              setSourceText(event.target.value)
              setSourceBytes(null)
              clearDerived()
            }}
          />
          <p id="prior-source-help" className="text-xs text-muted-foreground">
            One account per line with its weight: a plain positive number such
            as 10 or 2.5, no signs, exponents, or duplicate accounts. ENS names
            are resolved in your browser at a finalized Ethereum mainnet block,
            recorded only in the provenance receipt, and re-checked before you
            simulate and before you sign.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={sourceUri}
              onChange={(e) => {
                setSourceUri(e.target.value)
                clearDerived()
              }}
              placeholder="Source URI (optional)"
              aria-label="Source URI"
            />
            <Input
              value={author}
              onChange={(e) => {
                setAuthor(e.target.value)
                clearDerived()
              }}
              placeholder="Author (optional)"
              aria-label="Author"
            />
            <Input
              value={license}
              onChange={(e) => {
                setLicense(e.target.value)
                clearDerived()
              }}
              placeholder="License (optional)"
              aria-label="License"
            />
            <Input
              value={transform}
              onChange={(e) => {
                setTransform(e.target.value)
                clearDerived()
              }}
              placeholder="How this list was produced (optional)"
              aria-label="Transform description"
            />
          </div>
          <Button
            type="button"
            onClick={importSource}
            disabled={busy || !sourceText.trim()}
          >
            {busy && (
              <LoaderCircle
                className="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            Build the exact list
          </Button>
          {fieldIssues.length > 0 && (
            <ul
              id="prior-errors"
              className="list-disc pl-5 text-sm text-destructive"
              role="alert"
            >
              {fieldIssues.map((issue, index) => (
                <li key={`${issue.field}-${index}`}>
                  {issue.field}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {artifacts && (
        <>
          <section className="space-y-4" aria-labelledby="preview-heading">
            <h2 id="preview-heading" className="text-lg">
              2. Check how the weights are shared
            </h2>
            <div className="grid gap-4 sm:grid-cols-4">
              <Card type="outline" size="md">
                <p className="text-xs text-muted-foreground">Largest share</p>
                <p className="text-xl">
                  {percent(artifacts.concentration.largestWeight)}
                </p>
              </Card>
              <Card type="outline" size="md">
                <p className="text-xs text-muted-foreground">Top-10 share</p>
                <p className="text-xl">
                  {percent(artifacts.concentration.top10Weight)}
                </p>
              </Card>
              <Card type="outline" size="md">
                <p className="text-xs text-muted-foreground">
                  Concentration score (HHI)
                </p>
                <p className="text-xl">
                  {artifacts.concentration.hhiBps.toString()}
                </p>
              </Card>
              <Card type="outline" size="md">
                <p className="text-xs text-muted-foreground">Entries</p>
                <p className="text-xl">
                  {artifacts.priorCount.toLocaleString()}
                </p>
              </Card>
            </div>
            {(artifacts.concentration.largestWeight >
              500_000_000_000_000_000n ||
              artifacts.concentration.hhiBps > 2500n) && (
              <p className="text-sm text-warning" role="status">
                This list is highly concentrated. That is allowed, but it gives
                a small set of accounts an unusually large head start, and a
                head start set here never fades on its own.
              </p>
            )}
            <Card type="outline" size="md" className="space-y-3">
              <p className="text-sm">
                Every account on this list has a score from day one, before any
                vouches. Until the first vouch lands, the proven scoreboard is
                exactly this list, normalized.
              </p>
              <div aria-live="polite" className="text-sm">
                {preview?.phase}
                {preview?.elapsedMs !== undefined &&
                  ` · ${preview.elapsedMs.toFixed(1)} ms · ${preview.iterations} iterations`}
              </div>
              {preview?.outputRoot && (
                <p className="font-mono text-xs break-all">
                  Day-zero root: {preview.outputRoot}
                </p>
              )}
              {workerRef.current && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    workerRef.current?.terminate()
                    workerRef.current = null
                    setPreview({
                      phase: 'Cancelled. You can rebuild the preview.',
                    })
                  }}
                >
                  <Square className="h-3 w-3" aria-hidden="true" /> Cancel
                  preview
                </Button>
              )}
              {!workerRef.current &&
                preview &&
                (preview.phase.startsWith('Cancelled') ||
                  preview.phase.startsWith('Preview failed')) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => startPreview(artifacts)}
                  >
                    Rebuild exact preview
                  </Button>
                )}
            </Card>
            <div className="overflow-x-auto border border-border">
              <table className="w-full text-sm">
                <caption className="p-3 text-left text-xs text-muted-foreground">
                  First 50 normalized entries in canonical address order.
                  Exports contain all {artifacts.priorCount.toLocaleString()}{' '}
                  entries.
                </caption>
                <thead>
                  <tr>
                    <th className="p-2 text-left">Account</th>
                    <th className="p-2 text-right">Normalized share</th>
                  </tr>
                </thead>
                <tbody>
                  {artifacts.normalizedEntries.slice(0, 50).map((entry) => (
                    <tr key={entry.account} className="border-t border-border">
                      <td className="p-2 font-mono text-xs">{entry.account}</td>
                      <td className="p-2 text-right">
                        {percent(entry.weight, 6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rotationDiff && (
              <Card type="outline" size="md" className="space-y-2">
                <h3 className="font-medium">What this update changes</h3>
                <p className="text-sm">
                  {rotationDiff.added.length} added ·{' '}
                  {rotationDiff.removed.length} removed ·{' '}
                  {rotationDiff.changed.length} changed.
                </p>
                <details>
                  <summary className="cursor-pointer text-sm">
                    Review address-level changes
                  </summary>
                  <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
                    {rotationDiff.added.map((entry) => (
                      <li key={`added-${entry.account}`}>
                        Added {entry.account}: {percent(entry.weight, 6)}
                      </li>
                    ))}
                    {rotationDiff.removed.map((entry) => (
                      <li key={`removed-${entry.account}`}>
                        Removed {entry.account}: {percent(entry.weight, 6)}
                      </li>
                    ))}
                    {rotationDiff.changed.map((entry) => (
                      <li key={`changed-${entry.account}`}>
                        Changed {entry.account}: {percent(entry.before, 6)} →{' '}
                        {percent(entry.after, 6)}
                      </li>
                    ))}
                  </ul>
                </details>
              </Card>
            )}
          </section>

          <section className="space-y-4" aria-labelledby="commitment-heading">
            <h2 id="commitment-heading" className="text-lg">
              3. Save and verify what will go onchain
            </h2>
            <Card type="outline" size="md" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                These are the exact commitments your transaction will carry. The
                downloads reproduce the bytes exactly, so anyone can verify the
                network against them later.
              </p>
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Prior root</dt>
                  <dd className="font-mono break-all">{artifacts.priorRoot}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Manifest SHA-256</dt>
                  <dd className="font-mono break-all">
                    {artifacts.manifestSha256}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Provenance digest</dt>
                  <dd className="font-mono break-all">
                    {artifacts.metadataDigest}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Onchain data file (TGWP)
                  </dt>
                  <dd>
                    {(artifacts.manifest.length - 2) / 2} bytes ·{' '}
                    <span className="font-mono">
                      {short(artifacts.manifest)}
                    </span>
                  </dd>
                </div>
              </dl>
              {artifacts.ensResolutions.length > 0 && (
                <div className="space-y-1 text-xs">
                  <p className="font-medium">
                    ENS resolution receipts (import only; the addresses are what
                    goes onchain)
                  </p>
                  {artifacts.ensResolutions.map((record) => (
                    <p key={record.name} className="font-mono break-all">
                      {record.name} → {record.address} at finalized block{' '}
                      {record.blockNumber} ({record.blockHash})
                    </p>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {weightedExportArtifacts(artifacts).map((artifact) => (
                  <Button
                    key={artifact.name}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      download(artifact.name, artifact.body, artifact.type)
                    }
                  >
                    <Download className="h-3 w-3" /> {artifact.label}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    navigator.clipboard.writeText(artifacts.provenanceJson)
                  }
                >
                  <Copy className="h-3 w-3" /> Copy provenance
                </Button>
              </div>
            </Card>
          </section>

          <section className="space-y-4" aria-labelledby="sign-heading">
            <h2 id="sign-heading" className="text-lg">
              4. Preview the transaction, then sign
            </h2>
            {mode !== 'rotate' && (
              <Card
                type="outline"
                size="md"
                className="grid gap-3 sm:grid-cols-2"
              >
                <div>
                  <label
                    htmlFor="weighted-name"
                    className="text-sm font-medium"
                  >
                    Network name
                  </label>
                  <Input
                    id="weighted-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setSimulatedPayload(null)
                    }}
                  />
                  {nameProblem(name) && (
                    <p className="mt-1 text-xs text-destructive">
                      {nameProblem(name)}
                    </p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="weighted-epoch"
                    className="text-sm font-medium"
                  >
                    Scoring round length (blocks)
                  </label>
                  <Input
                    id="weighted-epoch"
                    inputMode="numeric"
                    value={epochLength}
                    onChange={(e) => {
                      setEpochLength(e.target.value.replace(/[^0-9]/g, ''))
                      setSimulatedPayload(null)
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  The factory floor is{' '}
                  {(epochFloor as bigint | undefined)?.toString() ?? 'loading'}{' '}
                  blocks; shorter requests are raised to it.
                </p>
                <div className="space-y-2 sm:col-span-2">
                  <NetworkProfileFields
                    idPrefix="weighted-profile"
                    value={profile}
                    onChange={updateProfile}
                  />
                  {metadataURI && (
                    <p className="break-all text-xs text-emerald-700">
                      Profile saved as {metadataURI}
                    </p>
                  )}
                </div>
              </Card>
            )}

            {mode !== 'rotate' && (
              <Card type="outline" size="md" className="space-y-4">
                <div className="flex flex-row items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Add a shared fund</p>
                    <p className="text-xs text-muted-foreground max-w-xl">
                      A shared fund lets your community put money in one place
                      and split it by trust score. Anyone can top it up, and
                      each member claims their own share. Skip this if your
                      community only wants scores.
                    </p>
                  </div>
                  <Switch
                    size="md"
                    enabled={withFund}
                    readOnly={!GOVERNED_AVAILABLE}
                    onClick={() => {
                      if (!GOVERNED_AVAILABLE) return
                      const next = !withFund
                      setWithFund(next)
                      if (next) {
                        // Community funds may only be owned by an initialized Safe. The governed
                        // wrapper creates that Safe atomically; a direct EOA-owned creation would
                        // revert InvalidDistributorSafe.
                        setWithGovernance(true)
                        setPrepayEth('')
                        setMaxPerRootUsd(DEFAULT_MAX_PER_ROOT_USD)
                      }
                      setSimulatedPayload(null)
                      setGasEstimate(null)
                    }}
                  />
                </div>
                {!GOVERNED_AVAILABLE && (
                  <p className="text-xs text-muted-foreground">
                    A shared fund requires the governed factory to create its
                    Safe owner, and governance is not available on this
                    deployment.
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
                          setSimulatedPayload(null)
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
                          setSimulatedPayload(null)
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
                        onChange={(e) => {
                          setFundTokenAddress(e.target.value)
                          setSimulatedPayload(null)
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
                    Skipping this closes no doors: the network&apos;s authority
                    can attach a fund later with the factory&apos;s
                    attachDistributor call, though this workspace does not offer
                    that button yet.
                  </p>
                )}
              </Card>
            )}

            {mode !== 'rotate' && (
              <Card type="outline" size="md" className="space-y-4">
                <div className="flex flex-row items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">
                      Create with governance
                    </p>
                    <p className="text-xs text-muted-foreground max-w-xl">
                      Hand the new network to a DAO Safe instead of your wallet.
                      A Safe is a shared onchain account; one is created for you
                      in the same transaction and owns the network from the
                      first block. Your wallet becomes the Safe&apos;s only
                      recorded owner, but a permanently sealed guard disables
                      owner-signed transactions: members direct the Safe through
                      delayed trust-weighted voting, and your wallet keeps only
                      a slow, visible recovery role.
                    </p>
                  </div>
                  <Switch
                    size="md"
                    enabled={withGovernance}
                    readOnly={!GOVERNED_AVAILABLE || withFund}
                    onClick={() => {
                      if (!GOVERNED_AVAILABLE || withFund) return
                      setWithGovernance(!withGovernance)
                      setPrepayEth('')
                      setMaxPerRootUsd(DEFAULT_MAX_PER_ROOT_USD)
                      setSimulatedPayload(null)
                      setGasEstimate(null)
                    }}
                  />
                </div>
                {withFund && (
                  <p className="text-xs text-muted-foreground">
                    Governance is required while a shared fund is selected: the
                    fund&apos;s owner must be an initialized Safe.
                  </p>
                )}
                {!GOVERNED_AVAILABLE && (
                  <p className="text-xs text-muted-foreground">
                    Create with governance is not available on this deployment,
                    so a network created here is owned by your wallet.
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
                          {describeBlocks(authority.memberVotingPeriod ?? 0n)}{' '}
                          to vote and{' '}
                          {describeBlocks(authority.memberExecutionDelay ?? 0n)}{' '}
                          before the Safe executes a passed proposal.
                        </p>
                        <p>
                          Recovery: your wallet may publish one exact Safe
                          action but cannot execute it early. Anyone may execute
                          it after {describeSeconds(authority.recoveryDelay)},
                          and the member-governed Safe can cancel it or replace
                          the proposer.
                        </p>
                        <p>
                          Updates to the starting shares take longer under
                          governance: a proposed update must first pass a member
                          vote (the delays above), and the network&apos;s own
                          activation delay of{' '}
                          {describeSeconds(
                            priorActivationDelay as number | undefined
                          )}{' '}
                          runs after that before the new shares apply.
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
                      Score-selected Safe signers are not offered for weighted
                      networks: the only signer verifier today proves the
                      standard trust-graph pipeline.
                    </p>

                    <div className="space-y-3 border-t border-border pt-3">
                      <p className="text-sm font-medium">
                        Pay for score refreshes up front?
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Scores only refresh if somebody does the work, and that
                        costs gas and proving time. Put ETH in during creation
                        to fund the first refreshes, or leave it blank. The ETH
                        lands in the new network&apos;s proving tank, and the
                        DAO Safe controls it afterwards.
                      </p>
                      <div className="flex items-center gap-2">
                        <Input
                          className="w-32"
                          inputMode="decimal"
                          placeholder="0.5"
                          aria-label="Refresh prepayment in ETH"
                          value={prepayEth}
                          onChange={(e) => {
                            setPrepayEth(e.target.value)
                            setSimulatedPayload(null)
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
                              htmlFor="weighted-max-refresh"
                            >
                              Maximum per refresh
                            </label>
                            <div className="flex items-center gap-2">
                              <span className="text-sm opacity-60">$</span>
                              <Input
                                id="weighted-max-refresh"
                                className="w-32"
                                inputMode="decimal"
                                value={maxPerRootUsd}
                                onChange={(e) => {
                                  setMaxPerRootUsd(e.target.value)
                                  setSimulatedPayload(null)
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
                              every {effectiveEpoch.toLocaleString()} blocks,
                              the scoring round length
                            </div>
                            <p className="text-xs text-muted-foreground">
                              This starts equal to the score schedule. The DAO
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
                          this chain has priced the weighted proving band and
                          that your cap covers that fee. Creation is atomic: the
                          ETH and the paid policy either both land or neither
                          does.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            )}
            {!isConnected && <WalletConnectionButton />}
            {!FACTORY_AVAILABLE && mode !== 'rotate' && (
              <p className="text-sm text-warning">
                No weighted factory is configured on this deployment. Import,
                preview, and export remain available; creation is disabled.
              </p>
            )}
            <Card type="outline" size="md" className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {mode === 'rotate' && governedRotation
                  ? 'Exact governance action calldata'
                  : 'Exact transaction calldata'}
              </p>
              <p className="font-mono text-xs break-all">
                {transactionPayload}
              </p>
              <p className="text-sm">
                Gas estimate:{' '}
                {gasEstimate?.toLocaleString() ?? 'simulate to calculate'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={simulate}
                  disabled={
                    busy ||
                    !address ||
                    wrongChain ||
                    (mode === 'rotate'
                      ? !active ||
                        !!pending ||
                        active.availability.status === 'unavailable'
                      : !FACTORY_AVAILABLE ||
                        !!metadataIssue ||
                        !!fundIssue ||
                        !!prepayIssue ||
                        !!governanceIssue ||
                        (withGovernance &&
                          (authority.loading || !initialPolicy)))
                  }
                >
                  {busy ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" />
                  )}{' '}
                  Simulate exact payload
                </Button>
                <Button
                  type="button"
                  onClick={sign}
                  disabled={busy || wrongChain || !payloadMatches}
                >
                  <CheckCircle2 className="h-4 w-4" />{' '}
                  {mode === 'rotate'
                    ? governedRotation
                      ? 'Prepare governance proposal'
                      : 'Propose starting-share change'
                    : withGovernance
                      ? 'Create the weighted network with its Safe'
                      : 'Create the weighted network'}
                </Button>
              </div>
            </Card>
          </section>
        </>
      )}

      {created && (
        <div aria-live="polite" role="status">
          <Card type="outline" size="md" className="space-y-3 border-success">
            <p className="text-sm">Your weighted network is created.</p>
            {created.instanceId ? (
              <>
                <p className="text-sm text-muted-foreground">
                  This is its instance ID, the key that finds it everywhere. It
                  stays visible in the{' '}
                  <Link
                    href="/networks"
                    className="underline underline-offset-4"
                  >
                    network directory
                  </Link>{' '}
                  and under the network&apos;s Settings, so you do not have to
                  save it, but a copy never hurts:
                </p>
                <CopyableText text={created.instanceId} alwaysShowCopyIcon />
                {created.safe && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">
                      Its DAO Safe, the shared account that owns the network and
                      its fund from the first block:
                    </p>
                    <CopyableText text={created.safe} alwaysShowCopyIcon />
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <ButtonLink
                    href={`/networks/${created.instanceId}`}
                    size="sm"
                  >
                    View network
                  </ButtonLink>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openForUpdate(created.instanceId!)}
                  >
                    Review starting shares
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Creation confirmed in transaction{' '}
                <span className="font-mono break-all">{created.txHash}</span>.
                The new network appears in the{' '}
                <Link href="/networks" className="underline underline-offset-4">
                  network directory
                </Link>{' '}
                as soon as the indexer sees it.
              </p>
            )}
          </Card>
        </div>
      )}

      {(problem || success) && (
        <div aria-live="assertive" role={problem ? 'alert' : 'status'}>
          <Card
            type="outline"
            size="md"
            className={problem ? 'border-destructive' : 'border-success'}
          >
            <p className={problem ? 'text-sm text-destructive' : 'text-sm'}>
              {problem ?? success}
            </p>
          </Card>
        </div>
      )}
    </Root>
  )
}
