'use client'

import { useCallback, useEffect, useState } from 'react'
import { type Hex, isHex } from 'viem'
import { usePublicClient } from 'wagmi'

import { APIS } from '@/lib/config'
import { easAbi } from '@/lib/contract-abis'
import { onchainAttestationImporterAbi } from '@/lib/imported-eas'
import { txToast, type TransactionToast } from '@/lib/tx'
import type { Network } from '@/lib/types'

import { Button } from './Button'
import { Card } from './Card'
import { Input } from './Input'

type Status = {
  progress: Record<
    'attestations' | 'revocations' | 'expirations',
    { total: number; processed: number; pending: number }
  >
  indexedHead: { block: string; timestamp: string } | null
  coverageWatermarkBlock: string | null
  lastImportBlock: string | null
  sweepHealth: 'caught-up' | 'pending' | 'not-observed'
  completeness: string
}

export const ImportedEasStatus = ({ network }: { network: Network }) => {
  const lane = network.importedLane!
  const publicClient = usePublicClient()
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(false)
  const [uid, setUid] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        `${APIS.ponder.replace(/\/$/, '')}/eas-import/instances/${network.instanceId ?? network.id}/status`,
        { cache: 'no-store' }
      )
      if (!response.ok) throw new Error('Import status is not available yet.')
      setStatus((await response.json()) as Status)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not check import status.'
      )
    } finally {
      setLoading(false)
    }
  }, [network.id, network.instanceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const syncUid = async () => {
    if (!publicClient || !isHex(uid, { strict: true }) || uid.length !== 66) {
      setError('Paste a 32-byte attestation UID.')
      return
    }
    setSyncing(true)
    setError(null)
    try {
      const canonicalUid = uid as Hex
      const [attestation, attested, revoked, expired] = await Promise.all([
        publicClient.readContract({
          address: lane.eas,
          abi: easAbi,
          functionName: 'getAttestation',
          args: [canonicalUid],
        }),
        publicClient.readContract({
          address: lane.importer,
          abi: onchainAttestationImporterAbi,
          functionName: 'attestationsProcessed',
          args: [canonicalUid],
        }),
        publicClient.readContract({
          address: lane.importer,
          abi: onchainAttestationImporterAbi,
          functionName: 'revocationsProcessed',
          args: [canonicalUid],
        }),
        publicClient.readContract({
          address: lane.importer,
          abi: onchainAttestationImporterAbi,
          functionName: 'expirationsProcessed',
          args: [canonicalUid],
        }),
      ])
      if (attestation.uid.toLowerCase() !== canonicalUid.toLowerCase()) {
        throw new Error('EAS does not contain that UID.')
      }
      if (attestation.schema.toLowerCase() !== lane.schemaUid.toLowerCase()) {
        throw new Error('That attestation belongs to another schema.')
      }
      const transactions: TransactionToast[] = []
      if (!attested) {
        transactions.push({
          tx: {
            address: lane.importer,
            abi: onchainAttestationImporterAbi,
            functionName: 'importAttestations',
            args: [[canonicalUid]],
          },
          successMessage: 'Attestation imported.',
        })
      }
      if (attestation.revocationTime > 0n && !revoked) {
        transactions.push({
          tx: {
            address: lane.importer,
            abi: onchainAttestationImporterAbi,
            functionName: 'importRevocations',
            args: [[canonicalUid]],
          },
          successMessage: 'Revocation imported.',
        })
      }
      if (
        attestation.expirationTime > 0n &&
        attestation.expirationTime <= BigInt(Math.floor(Date.now() / 1_000)) &&
        !expired
      ) {
        transactions.push({
          tx: {
            address: lane.importer,
            abi: onchainAttestationImporterAbi,
            functionName: 'importExpirations',
            args: [[canonicalUid]],
          },
          successMessage: 'Expiration imported.',
        })
      }
      if (transactions.length === 0) {
        setError('This UID is already fully imported.')
        return
      }
      await txToast(...transactions)
      setUid('')
      await refresh()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not import that UID.'
      )
    } finally {
      setSyncing(false)
    }
  }

  const indexedAt = status?.indexedHead
    ? new Date(Number(status.indexedHead.timestamp) * 1_000).toLocaleString()
    : null
  return (
    <Card type="outline" size="md" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Imported EAS history</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            {status?.completeness ?? lane.completeness}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? 'Checking…' : 'Check for new'}
        </Button>
      </div>
      {status && (
        <div className="space-y-3">
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            {(
              [
                ['attestations', 'attestations'],
                ['revocations', 'revocations'],
                ['expirations', 'expired attestations'],
              ] as const
            ).map(([kind, label]) => (
              <div key={kind}>
                <span className="tabular-nums">
                  {status.progress[kind].processed.toLocaleString()} /{' '}
                  {status.progress[kind].total.toLocaleString()}
                </span>
                <div className="text-xs text-muted-foreground">
                  {label} processed
                </div>
              </div>
            ))}
            <div>
              <span className="capitalize">
                {status.sweepHealth.replace('-', ' ')}
              </span>
              <div className="text-xs text-muted-foreground">sweep health</div>
            </div>
            <div>
              <span className="tabular-nums">
                {status.coverageWatermarkBlock ?? '—'}
              </span>
              <div className="text-xs text-muted-foreground">
                complete through block
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Indexer as of {indexedAt ?? 'an unknown time'} (block{' '}
            {status.indexedHead?.block ?? '—'}). The sweep operator pays routine
            catch-up gas; importing a UID below uses your connected wallet.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row">
        <Input
          className="font-mono"
          placeholder="Missing attestation UID"
          value={uid}
          onChange={(event) => setUid(event.target.value.trim())}
        />
        <Button
          variant="outline"
          disabled={syncing}
          onClick={() => void syncUid()}
        >
          {syncing ? 'Importing…' : 'Import UID'}
        </Button>
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
    </Card>
  )
}
