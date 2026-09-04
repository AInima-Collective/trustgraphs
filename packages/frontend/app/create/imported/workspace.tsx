'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { type Hex, decodeEventLog, isAddress, isHex, zeroAddress } from 'viem'
import {
  useAccount,
  useChainId,
  useReadContract,
  useSimulateContract,
} from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Textarea } from '@/components/Textarea'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useWalletConnectionContext } from '@/components/WalletConnectionProvider'
import { useAuthorityProfile } from '@/hooks/useAuthorityProfile'
import { APIS, IMPORTED_FACTORY_CONFIG } from '@/lib/config'
import {
  governedTrustgraphsFactoryAbi,
  trustgraphsFactoryAbi,
} from '@/lib/contract-abis'
import {
  type EasSchemaPreview,
  decodeLegacySample,
  governedImportedFactoryAbi,
} from '@/lib/imported-eas'
import { txToast } from '@/lib/tx'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'

import {
  EMPTY_WIZARD_DATA,
  buildCreateArgs,
  nameProblem,
  randomSalt,
} from '../model'
import { Field, Note } from '../ui'

const FACTORY = IMPORTED_FACTORY_CONFIG!.factory as Hex
const GOVERNED_FACTORY = IMPORTED_FACTORY_CONFIG!.governedFactory as Hex
const ONE = 10n ** 18n
const UNIFORM_WEIGHT_FIELD = 2 ** 32 - 1

const addressesFrom = (value: string) => [
  ...new Set(
    value
      .split(/[\s,;]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is Hex => isAddress(item) && item !== zeroAddress)
  ),
]

export const ImportedNetworkWorkspace = () => {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchToTarget, switchingTarget } = useWalletConnectionContext()
  const [name, setName] = useState('')
  const [schemaUid, setSchemaUid] = useState('')
  const [seedText, setSeedText] = useState('')
  const [preview, setPreview] = useState<EasSchemaPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [selectedWeight, setSelectedWeight] = useState<string>('uniform')
  const [failure, setFailure] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [salt] = useState<Hex>(() => randomSalt())

  const { data: epochFloorRead } = useReadContract({
    address: FACTORY,
    abi: trustgraphsFactoryAbi,
    functionName: 'EPOCH_FLOOR',
  })
  const epochFloor = (epochFloorRead as bigint | undefined) ?? 1n
  const seeds = useMemo(() => addressesFrom(seedText), [seedText])
  const importedUid =
    isHex(schemaUid, { strict: true }) && schemaUid.length === 66
      ? (schemaUid as Hex)
      : null
  const chosenField =
    selectedWeight === 'uniform' ? null : Number(selectedWeight)

  const args = useMemo(() => {
    const base = buildCreateArgs({
      data: {
        ...EMPTY_WIZARD_DATA,
        name,
        seeds,
      },
      metadataURI: '',
      admin: zeroAddress,
      epochFloor,
      salt,
    })
    return {
      ...base,
      params: {
        ...base.params,
        // Uniform mode deliberately selects an out-of-range ABI head and lets the checked decoder
        // fall back to one fixed-point unit. Numeric mode preserves the legacy integer's relative
        // values while bounding it to the guest's proven envelope.
        minWeightFp: chosenField === null ? ONE : 1n,
        maxWeightFp: chosenField === null ? ONE : 1_000_000n * ONE,
        weightFieldIndex:
          chosenField === null ? UNIFORM_WEIGHT_FIELD : chosenField,
      },
    }
  }, [chosenField, epochFloor, name, salt, seeds])
  const createArgs = importedUid
    ? [
        args,
        importedUid,
        { minPaidIntervalBlocks: 0n, maxPerRootUsd: 0n },
        { enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0 },
      ]
    : undefined

  const { valid: authorityProfileValid } = useAuthorityProfile(GOVERNED_FACTORY)
  const ready =
    !nameProblem(name) &&
    !!importedUid &&
    preview?.schema.uid.toLowerCase() === importedUid.toLowerCase() &&
    seeds.length > 0 &&
    authorityProfileValid
  const { isSuccess: preflightPassed, isLoading: preflighting } =
    useSimulateContract({
      address: GOVERNED_FACTORY,
      abi: governedImportedFactoryAbi,
      functionName: 'createGovernedImportedInstance',
      args: createArgs,
      query: { enabled: ready },
    } as any)

  const loadPreview = async () => {
    setFailure(null)
    setPreview(null)
    if (!importedUid) {
      setFailure('Paste a 32-byte EAS schema UID.')
      return
    }
    setPreviewing(true)
    try {
      const response = await fetch(
        `${APIS.ponder.replace(/\/$/, '')}/eas-import/schemas/${importedUid}/preview`
      )
      if (!response.ok)
        throw new Error('That schema is not in the indexed EAS history yet.')
      setPreview((await response.json()) as EasSchemaPreview)
      setSelectedWeight('uniform')
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Could not preview this schema.'
      )
    } finally {
      setPreviewing(false)
    }
  }

  const create = async () => {
    if (!createArgs || !preflightPassed) return
    setCreating(true)
    setFailure(null)
    try {
      const [receipt] = await txToast({
        tx: {
          address: GOVERNED_FACTORY,
          abi: governedImportedFactoryAbi,
          functionName: 'createGovernedImportedInstance',
          args: createArgs,
        } as any,
        successMessage: 'Your imported network is live!',
      })
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== FACTORY.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: trustgraphsFactoryAbi,
            data: log.data,
            topics: log.topics,
          })
          if (decoded.eventName === 'InstanceCreated') {
            window.location.assign(`/networks/${decoded.args.instanceId}`)
            return
          }
        } catch {
          // Not the frozen catalog event.
        }
      }
      setFailure(
        'The transaction succeeded, but the new network event was not found in its receipt.'
      )
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Creation failed.')
    } finally {
      setCreating(false)
    }
  }

  const wrongChain = isConnected && chainId !== getTargetChainId()
  return (
    <div className="max-w-3xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl">Start from existing attestations</h1>
        <p className="text-sm text-muted-foreground">
          Preview one existing EAS schema before creating a governed network
          over its full history.
        </p>
        <Link href="/create" className="text-xs underline underline-offset-4">
          Choose a different kind of network
        </Link>
      </div>

      {!isConnected && <WalletConnectionButton />}
      {wrongChain && (
        <Button
          disabled={switchingTarget}
          onClick={() => void switchToTarget()}
        >
          Switch to {getTargetChainConfig().name}
        </Button>
      )}

      <Card type="outline" size="md" className="space-y-5">
        <Field
          label="EAS schema UID"
          htmlFor="legacy-schema"
          hint="The schema is immutable; this network will never read another schema."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="legacy-schema"
              className="font-mono"
              value={schemaUid}
              onChange={(event) => setSchemaUid(event.target.value.trim())}
            />
            <Button
              variant="outline"
              disabled={previewing}
              onClick={() => void loadPreview()}
            >
              {previewing ? 'Checking…' : 'Preview'}
            </Button>
          </div>
        </Field>

        {preview && (
          <div className="space-y-4 border-t border-border pt-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <div className="text-2xl tabular-nums">
                  {preview.counts.attestations.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">
                  attestations
                </div>
              </div>
              <div>
                <div className="text-2xl tabular-nums">
                  {preview.counts.uniqueAttesters.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">
                  unique attesters
                </div>
              </div>
              <div>
                <div className="text-2xl tabular-nums">
                  {preview.counts.uniqueRecipients.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">
                  unique recipients
                </div>
              </div>
            </div>
            <div className="text-xs font-mono break-all">
              {preview.schema.schema}
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">Sample graph edges</div>
              {preview.samples.slice(0, 3).map((sample) => (
                <div
                  key={sample.uid}
                  className="border border-border p-3 text-xs"
                >
                  <div className="font-mono break-all">
                    {sample.attester} → {sample.recipient}
                  </div>
                  <div className="mt-1 text-muted-foreground break-all">
                    {JSON.stringify(
                      decodeLegacySample(
                        preview.schema.schema,
                        sample.data
                      ) ?? { raw: sample.data }
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {preview && (
        <Card type="outline" size="md" className="space-y-5">
          <Field label="Network name" htmlFor="imported-name">
            <Input
              id="imported-name"
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="Starting accounts"
            htmlFor="imported-seeds"
            hint={`${seeds.length} valid address${seeds.length === 1 ? '' : 'es'} found. Paste up to 64, separated by spaces or new lines.`}
          >
            <Textarea
              id="imported-seeds"
              rows={4}
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Permanent edge weight meaning
            </legend>
            <label className="flex gap-2 text-sm">
              <input
                type="radio"
                checked={selectedWeight === 'uniform'}
                onChange={() => setSelectedWeight('uniform')}
              />{' '}
              An attestation is an endorsement; every edge has equal weight.
            </label>
            {preview.schema.numericWeightCandidates.map((field) => (
              <label key={field.index} className="flex gap-2 text-sm">
                <input
                  type="radio"
                  checked={selectedWeight === String(field.index)}
                  onChange={() => setSelectedWeight(String(field.index))}
                />{' '}
                Use{' '}
                <span className="font-mono">
                  {field.name || `field ${field.index}`}
                </span>{' '}
                ({field.type}) as the raw relative weight.
              </label>
            ))}
            <Note>
              This choice is part of the instance&apos;s authenticated
              parameters and cannot be reinterpreted later.
            </Note>
          </fieldset>
          <Note>
            Imported networks are checkpoint-complete when the permissionless
            sweep is live. A visible watermark and paste-a-UID backstop make any
            lag explicit. The configured sweep operator pays routine catch-up
            gas; any wallet can permissionlessly import a missing UID.
          </Note>
          {failure && <p className="text-sm text-error">{failure}</p>}
          <Button
            disabled={
              !isConnected ||
              wrongChain ||
              !ready ||
              !preflightPassed ||
              creating
            }
            onClick={() => void create()}
          >
            {creating
              ? 'Creating…'
              : preflighting
                ? 'Checking…'
                : 'Create imported network'}
          </Button>
        </Card>
      )}
      {!preview && failure && <p className="text-sm text-error">{failure}</p>}
    </div>
  )
}
