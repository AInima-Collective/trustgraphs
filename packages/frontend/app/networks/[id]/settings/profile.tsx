'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import {
  type Hex,
  encodeFunctionData,
  keccak256,
  stringToBytes,
  zeroAddress,
} from 'viem'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'

import {
  type NetworkMetadata,
  metadataFingerprint,
  nameProblem,
} from '@/app/create/model'
import {
  type NetworkProfile,
  NetworkProfileFields,
  networkProfileProblem,
} from '@/app/create/NetworkProfileFields'
import { pinMetadata } from '@/app/create/pin'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import type { InstanceRow } from '@/lib/catalog'
import { merkleSnapshotAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import { saveGovernancePrefill } from '@/lib/governance-prefill'
import { txToast } from '@/lib/tx'
import type { Network } from '@/lib/types'

const CONSTITUTIONAL_ROLE = keccak256(stringToBytes('CONSTITUTIONAL_ROLE'))
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex

type ReadResult = { status?: string; result?: unknown }
const readResult = (reads: readonly ReadResult[] | undefined, index: number) =>
  reads?.[index]?.status === 'success' ? reads[index].result : undefined

const profileFrom = (
  network: Network,
  instance: InstanceRow | null
): NetworkMetadata => {
  const metadata = instance?.metadata ?? network.profile
  return {
    name: metadata?.name ?? network.name,
    description: metadata?.description ?? network.about,
    criteria: metadata?.criteria ?? network.criteria,
    image: metadata?.image ?? network.image ?? '',
    applicationUrl: metadata?.applicationUrl ?? network.applicationUrl ?? '',
  }
}

const normalizedProfile = (profile: NetworkMetadata): NetworkMetadata => ({
  name: profile.name.trim(),
  description: profile.description.trim(),
  criteria: profile.criteria.trim(),
  image: profile.image.trim(),
  applicationUrl: profile.applicationUrl.trim(),
})

export type SnapshotProfileTarget = {
  id: string
  governanceNetworkId?: string
  snapshot: Hex
  governance?: { module: Hex; safe: Hex } | null
  profile: NetworkMetadata
  metadataURI?: string
  metadataURIHash?: Hex
  metadataRevision?: string
  metadataStatus?: string
}

export const SnapshotProfileSettings = ({
  target,
}: {
  target: SnapshotProfileTarget
}) => {
  const router = useRouter()
  const { address } = useAccount()
  const snapshot = target.snapshot
  const governance = target.governance?.module
  const authoritySafe = target.governance?.safe
  const governed = !!governance && !!authoritySafe
  const initial = useMemo(() => normalizedProfile(target.profile), [target])
  const [profile, setProfile] = useState<NetworkMetadata>(initial)
  const [publishedFingerprint, setPublishedFingerprint] = useState(
    metadataFingerprint(initial)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      {
        address: snapshot,
        abi: merkleSnapshotAbi,
        functionName: 'metadataURI',
      },
      {
        address: snapshot,
        abi: merkleSnapshotAbi,
        functionName: 'metadataURIHash',
      },
      {
        address: snapshot,
        abi: merkleSnapshotAbi,
        functionName: 'metadataRevision',
      },
    ],
    query: { refetchInterval: 30_000 },
  })
  const { data: connectedRole } = useReadContract({
    address: snapshot,
    abi: merkleSnapshotAbi,
    functionName: 'hasRole',
    args: [CONSTITUTIONAL_ROLE, address ?? zeroAddress],
    query: { enabled: !!address, refetchInterval: 30_000 },
  })

  const liveURI =
    (readResult(reads, 0) as string | undefined) ?? target.metadataURI ?? ''
  const liveHash =
    (readResult(reads, 1) as Hex | undefined) ?? target.metadataURIHash
  const liveRevision =
    (readResult(reads, 2) as bigint | undefined)?.toString() ??
    target.metadataRevision ??
    '0'
  const connectedIsConstitutional = connectedRole === true
  const exact = normalizedProfile(profile)
  const fingerprint = metadataFingerprint(exact)
  const validationError =
    nameProblem(exact.name) ||
    networkProfileProblem({
      description: exact.description,
      criteria: exact.criteria,
      image: exact.image,
      applicationUrl: exact.applicationUrl,
    })
  const changed = fingerprint !== publishedFingerprint
  const canSubmit =
    changed &&
    !validationError &&
    !!address &&
    (governed || connectedIsConstitutional)

  const updateProfile = (patch: Partial<NetworkProfile>) =>
    setProfile((current) => ({ ...current, ...patch }))

  const submit = async () => {
    setError(null)
    if (validationError) {
      setError(validationError)
      return
    }
    if (!address) {
      setError('Connect a wallet to publish this profile.')
      return
    }
    if (!governed && !connectedIsConstitutional) {
      setError(
        "Only the address holding this snapshot's constitutional role can update its profile."
      )
      return
    }

    setBusy(true)
    try {
      const { uri } = await pinMetadata(exact)
      if (governed) {
        const data = encodeFunctionData({
          abi: merkleSnapshotAbi,
          functionName: 'setMetadataURI',
          args: [uri],
        })
        const actionFingerprint = keccak256(data)
        const governanceNetworkId = target.governanceNetworkId ?? target.id
        saveGovernancePrefill({
          networkId: governanceNetworkId,
          fingerprint: actionFingerprint,
          parentHash: ZERO_HASH,
          proposedHash: ZERO_HASH,
          title: `Update the ${exact.name} network profile`,
          description: `Publish a new network profile pointer through the governance Safe.\n\nNew metadata URI: ${uri}`,
          actions: [
            {
              target: snapshot,
              value: '0',
              data,
              operation: 0,
              description: 'Set the network metadata URI',
              contractName: 'MerkleSnapshot',
              functionSignature: 'setMetadataURI(string)',
            },
          ],
          createdAt: Date.now(),
        })
        router.push(
          `/networks/${governanceNetworkId}/governance?new=1&actionDraft=${actionFingerprint}`
        )
        return
      }

      await txToast({
        tx: {
          address: snapshot,
          abi: merkleSnapshotAbi,
          functionName: 'setMetadataURI',
          args: [uri],
        },
        successMessage: 'Network profile updated.',
      })
      setProfile(exact)
      setPublishedFingerprint(fingerprint)
      await refetch()
      router.refresh()
    } catch (updateError) {
      setError(parseErrorMessage(updateError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card type="primary" size="lg" className="space-y-6">
        <div>
          <h3 className="text-base font-medium">Published profile</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            These presentation fields are pinned to IPFS. The snapshot stores
            the current pointer, and every constitutional update becomes a new
            on-chain revision.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="network-profile-name">Network name</Label>
          <Input
            id="network-profile-name"
            value={profile.name}
            maxLength={64}
            onChange={(event) =>
              setProfile((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
          />
          {nameProblem(exact.name) && (
            <p className="text-xs text-destructive">
              {nameProblem(exact.name)}
            </p>
          )}
        </div>

        <NetworkProfileFields
          idPrefix="network-profile"
          value={profile}
          onChange={updateProfile}
          note="Publishing pins these public fields to IPFS. Keep private details out; prior pointers remain visible in the revision history."
        />

        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}

        {!address ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect a wallet to prepare this update.
            </p>
            <WalletConnectionButton />
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              type="button"
              onClick={submit}
              disabled={busy || !canSubmit}
            >
              {busy
                ? 'Saving profile...'
                : governed
                  ? 'Create governance proposal'
                  : 'Publish profile update'}
            </Button>
            {!changed && (
              <p className="text-xs text-muted-foreground">
                Change a field to prepare a new revision.
              </p>
            )}
            {!governed && address && !connectedIsConstitutional && (
              <p className="text-xs text-destructive">
                This wallet does not hold the snapshot&apos;s constitutional
                role.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card type="primary" size="lg" className="space-y-4">
        <div>
          <h3 className="text-base font-medium">Profile authority</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {governed
              ? 'The network governance Safe holds the constitutional role. A successful proposal executes this update from that Safe.'
              : 'The connected constitutional holder can publish the update directly.'}
          </p>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Current revision</dt>
          <dd>{liveRevision}</dd>
          <dt className="text-muted-foreground">Authority</dt>
          <dd className="break-all font-mono text-xs">
            {governed ? authoritySafe : 'Direct constitutional holder'}
          </dd>
          <dt className="text-muted-foreground">Metadata URI</dt>
          <dd className="break-all font-mono text-xs">{liveURI || '—'}</dd>
          <dt className="text-muted-foreground">URI hash</dt>
          <dd className="break-all font-mono text-xs">{liveHash || '—'}</dd>
          <dt className="text-muted-foreground">Indexer status</dt>
          <dd>{target.metadataStatus ?? 'Not available'}</dd>
        </dl>
      </Card>
    </div>
  )
}

export const NetworkProfileSettings = ({
  network,
  instance,
}: {
  network: Network
  instance: InstanceRow | null
}) => (
  <SnapshotProfileSettings
    target={{
      id: network.id,
      snapshot: network.contracts.merkleSnapshot,
      governance:
        network.contracts.merkleGovModule && network.contracts.safe?.proxy
          ? {
              module: network.contracts.merkleGovModule,
              safe: network.contracts.safe.proxy,
            }
          : null,
      profile: profileFrom(network, instance),
      metadataURI: instance?.metadataURI ?? network.metadataURI,
      metadataURIHash: instance?.metadataURIHash ?? network.metadataURIHash,
      metadataRevision: instance?.metadataRevision ?? network.metadataRevision,
      metadataStatus: instance?.metadataStatus ?? network.metadataStatus,
    }}
  />
)
