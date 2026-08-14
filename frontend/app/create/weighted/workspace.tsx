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
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  type Address,
  type Hex,
  decodeEventLog,
  getAddress,
  isAddress,
  isHex,
  keccak256,
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

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Textarea } from '@/components/Textarea'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { APIS, WEIGHTED_FACTORY } from '@/lib/config'
import { getEnsCoinType } from '@/lib/ens-query'
import { txToast } from '@/lib/tx'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'
import {
  type WeightedApiEntry,
  type WeightedApiVersion,
  availabilityDiagnosis,
  fetchBinarySeeds,
  fetchWeightedEntries,
  fetchWeightedVersions,
} from '@/lib/weighted-prior/api'
import {
  weightedCreateArgs,
  weightedCreatePayload,
  weightedPriorParamsControllerAbi,
  weightedRotationPayload,
  weightedTrustgraphsFactoryAbi,
} from '@/lib/weighted-prior/contracts'
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

type Mode = 'create' | 'rotate' | 'redeploy'
type Format = 'csv' | 'json'

const WEIGHTED_FACTORY_ADDRESS = (WEIGHTED_FACTORY || '') as Address
const FACTORY_AVAILABLE = isAddress(WEIGHTED_FACTORY_ADDRESS, {
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

export const WeightedPriorWorkspace = () => {
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const targetChainId = getTargetChainId()
  const chainId = useChainId()
  const publicClient = usePublicClient({ chainId: targetChainId })
  const { switchChain, isPending: switchingChain } = useSwitchChain()
  const [mode, setMode] = useState<Mode>('create')
  const [format, setFormat] = useState<Format>('csv')
  const [sourceText, setSourceText] = useState('account,weight\n')
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
  const [metadataURI, setMetadataURI] = useState('')
  const [sourceUri, setSourceUri] = useState('')
  const [author, setAuthor] = useState('')
  const [license, setLicense] = useState('')
  const [transform, setTransform] = useState('')
  const [epochLength, setEpochLength] = useState('0')
  const [salt] = useState<Hex>(randomSalt)

  const [instanceId, setInstanceId] = useState('')
  const [versions, setVersions] = useState<WeightedApiVersion[]>([])
  const [currentEntries, setCurrentEntries] = useState<WeightedApiEntry[]>([])
  const [binaryInstanceId, setBinaryInstanceId] = useState('')
  const [gasEstimate, setGasEstimate] = useState<bigint | null>(null)
  const [simulatedPayload, setSimulatedPayload] = useState<Hex | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const active = versions.find((version) => version.status === 'active')
  const pending = versions.find((version) => version.status === 'pending')
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

  const provenance = useMemo(
    () => ({ sourceUri, author, license, transform }),
    [sourceUri, author, license, transform]
  )

  const createFields = useMemo(
    () => ({
      name,
      metadataURI,
      dampingFp: 850_000_000_000_000_000n,
      toleranceFp: 0n,
      maxIterations: 40,
      minWeight: 0n,
      maxWeight: 100n,
      admin: address ? getAddress(address) : zeroAddress,
      epochLength: BigInt(epochLength || '0'),
      withDistributor: false,
      distributorToken: zeroAddress,
      salt,
    }),
    [address, epochLength, metadataURI, name, salt]
  )

  const transactionPayload = useMemo(() => {
    if (!artifacts) return null
    return mode === 'rotate'
      ? weightedRotationPayload(artifacts)
      : weightedCreatePayload(createFields, artifacts)
  }, [artifacts, createFields, mode])

  const clearDerived = () => {
    workerRef.current?.terminate()
    workerRef.current = null
    setArtifacts(null)
    setPreview(null)
    setGasEstimate(null)
    setSimulatedPayload(null)
    setSuccess(null)
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
    setPreview({ phase: 'Starting exact day-zero preview…' })
    worker.onmessage = (
      message: MessageEvent<WeightedPreviewWorkerResponse>
    ) => {
      if (message.data.id !== id) return
      if (message.data.phase === 'starting') {
        setPreview({ phase: 'Canonical commitments ready…' })
      } else if (message.data.phase === 'iterating') {
        setPreview({ phase: 'Running 40 exact weighted iterations…' })
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

  const loadRotation = async () => {
    if (!isHex(instanceId) || instanceId.length !== 66) {
      setProblem('Enter a 32-byte weighted instance id.')
      return
    }
    setBusy(true)
    setProblem(null)
    setVersions([])
    setCurrentEntries([])
    try {
      const nextVersions = await fetchWeightedVersions(
        APIS.ponder,
        instanceId as Hex
      )
      const nextActive = nextVersions.find(
        (version) => version.status === 'active'
      )
      if (!nextActive)
        throw new Error('The indexer has no active prior version.')
      setVersions(nextVersions)
      setCurrentEntries(
        nextActive.availability.status === 'unavailable'
          ? []
          : await fetchWeightedEntries(
              APIS.ponder,
              instanceId as Hex,
              nextActive.version
            )
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const prefillBinary = async () => {
    if (!isHex(binaryInstanceId) || binaryInstanceId.length !== 66) {
      setProblem('Enter a 32-byte binary instance id.')
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
    if (!artifacts) throw new Error('Import a prior first.')
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
      if (mode === 'rotate') {
        if (!active) throw new Error('Load an active weighted instance first.')
        if (pending) {
          throw new Error(
            'Activate or cancel the existing pending version before proposing another.'
          )
        }
        await publicClient.simulateContract({
          account: address,
          address: active.controller as Address,
          abi: weightedPriorParamsControllerAbi,
          functionName: 'proposePrior',
          args: [exact.manifest, exact.metadataDigest],
        })
        setGasEstimate(
          await publicClient.estimateContractGas({
            account: address,
            address: active.controller as Address,
            abi: weightedPriorParamsControllerAbi,
            functionName: 'proposePrior',
            args: [exact.manifest, exact.metadataDigest],
          })
        )
        setSimulatedPayload(keccak256(weightedRotationPayload(exact)))
      } else {
        if (!FACTORY_AVAILABLE)
          throw new Error('No weighted factory is configured.')
        const args = weightedCreateArgs(createFields, exact)
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
          keccak256(weightedCreatePayload(createFields, exact))
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
      const payloadHash = keccak256(
        mode === 'rotate'
          ? weightedRotationPayload(exact)
          : weightedCreatePayload(createFields, exact)
      )
      if (payloadHash !== simulatedPayload) {
        throw new Error(
          'The exact payload changed. Simulate it again before signing.'
        )
      }
      if (mode === 'rotate') {
        if (!active) throw new Error('Load an active weighted instance first.')
        if (pending) {
          throw new Error(
            'Activate or cancel the existing pending version before proposing another.'
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
            'Weighted prior proposed; the activation delay is now running.',
        })
        setSuccess(
          'Pending rotation proposed. Reload the instance to review its activation time.'
        )
        await loadRotation()
      } else {
        const [receipt] = await txToast({
          tx: {
            address: WEIGHTED_FACTORY_ADDRESS,
            abi: weightedTrustgraphsFactoryAbi,
            functionName: 'createInstance',
            args: [weightedCreateArgs(createFields, exact)],
          },
          successMessage: 'New weighted-prior instance created.',
        })
        let createdId: Hex | null = null
        for (const log of receipt.logs) {
          if (
            log.address.toLowerCase() !== WEIGHTED_FACTORY_ADDRESS.toLowerCase()
          )
            continue
          try {
            const event = decodeEventLog({
              abi: weightedTrustgraphsFactoryAbi,
              data: log.data,
              topics: log.topics,
            })
            if (event.eventName === 'WeightedInstanceCreated') {
              createdId = event.args.instanceId
            }
          } catch {
            // Another factory log.
          }
        }
        setSuccess(
          createdId
            ? `Created new weighted instance ${createdId}.`
            : `Creation confirmed in ${receipt.transactionHash}.`
        )
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
          'Recover and review the exact pending manifest before activation.'
        )
      }
      if (
        BigInt(pending.readyAt ?? '0') > BigInt(Math.floor(Date.now() / 1000))
      ) {
        throw new Error('The timelock has not reached its activation time yet.')
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
        successMessage: `Weighted prior version ${pending.version} activated.`,
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

  return (
    <main className="max-w-5xl space-y-8" aria-labelledby="weighted-title">
      <header className="space-y-3">
        <h1 id="weighted-title" className="text-2xl">
          Weighted-prior workspace
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Import human CSV or JSON, resolve names outside consensus, inspect the
          exact TGWP bytes, then create a new weighted instance or propose a
          timelocked prior rotation.
        </p>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Weighted workflow"
        >
          {modeButton('create', 'Create new weighted instance')}
          {modeButton('rotate', 'Review a rotation')}
          {modeButton('redeploy', 'Redeploy from binary')}
        </div>
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
            Existing binary instance id
          </label>
          <div className="flex gap-2">
            <Input
              id="binary-instance"
              value={binaryInstanceId}
              onChange={(event) => {
                setBinaryInstanceId(event.target.value)
                clearDerived()
              }}
              placeholder="0x…"
            />
            <Button
              type="button"
              variant="outline"
              onClick={prefillBinary}
              disabled={busy}
            >
              Prefill equal weights
            </Button>
          </div>
        </Card>
      )}

      {mode === 'rotate' && (
        <Card type="outline" size="md" className="space-y-4">
          <label htmlFor="weighted-instance" className="text-sm font-medium">
            Weighted instance id
          </label>
          <div className="flex gap-2">
            <Input
              id="weighted-instance"
              value={instanceId}
              onChange={(event) => {
                setInstanceId(event.target.value)
                setVersions([])
                setCurrentEntries([])
                clearDerived()
              }}
              placeholder="0x…"
            />
            <Button
              type="button"
              variant="outline"
              onClick={loadRotation}
              disabled={busy}
            >
              Load history
            </Button>
          </div>
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
                Exact manifest availability: {pending.availability.status} via{' '}
                {pending.availability.provenance}.
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
                Activate after timelock
              </Button>
            </div>
          )}
        </Card>
      )}

      <section className="space-y-4" aria-labelledby="source-heading">
        <h2 id="source-heading" className="text-lg">
          1. Import source and provenance
        </h2>
        <Card type="outline" size="md" className="space-y-4">
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
            Prior source
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
            Weights must be positive decimal strings: no signs, exponents,
            floats, zero, or duplicate accounts. ENS names are replaced by
            finalized-block addresses before any canonical or consensus bytes
            are built.
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
              placeholder="Human description of transform"
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
            Build exact artifacts
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
              2. Review normalization, concentration, and day-zero behavior
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
                <p className="text-xs text-muted-foreground">HHI</p>
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
                This prior is highly concentrated. That is allowed, but it gives
                a small set of accounts unusually strong persistent teleport
                influence.
              </p>
            )}
            <Card type="outline" size="md" className="space-y-3">
              <p className="text-sm">
                Prior-only accounts receive day-zero score leaves even before
                the first vouch. With no edges, the proven distribution is
                byte-exactly this normalized prior.
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
                <h3 className="font-medium">Pending rotation diff</h3>
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
              3. Verify and export exact commitments
            </h2>
            <Card type="outline" size="md" className="space-y-3">
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
                  <dt className="text-muted-foreground">TGWP bytes</dt>
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
                    Import-only ENS resolution receipts
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
              4. Simulate exact payload, then sign
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
                    New instance name
                  </label>
                  <Input
                    id="weighted-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setSimulatedPayload(null)
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor="weighted-metadata"
                    className="text-sm font-medium"
                  >
                    Presentation metadata URI
                  </label>
                  <Input
                    id="weighted-metadata"
                    value={metadataURI}
                    onChange={(e) => {
                      setMetadataURI(e.target.value)
                      setSimulatedPayload(null)
                    }}
                    placeholder="ipfs://… (optional)"
                  />
                </div>
                <div>
                  <label
                    htmlFor="weighted-epoch"
                    className="text-sm font-medium"
                  >
                    Requested epoch blocks
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
                <p className="text-xs text-muted-foreground self-end">
                  Factory floor:{' '}
                  {(epochFloor as bigint | undefined)?.toString() ?? 'loading'}.
                  The factory raises shorter requests.
                </p>
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
                Exact transaction calldata
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
                      : !FACTORY_AVAILABLE || !name.trim())
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
                    ? 'Sign timelocked proposal'
                    : 'Create new weighted instance'}
                </Button>
              </div>
            </Card>
          </section>
        </>
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
    </main>
  )
}
