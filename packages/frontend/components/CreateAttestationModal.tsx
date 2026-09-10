'use client'

import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useSetAtom } from 'jotai'
import Link from 'next/link'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import { type Address, Hex, zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import { BatchAttestationForm } from '@/components/BatchAttestationForm'
import { Button } from '@/components/Button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/Form'
import { Modal } from '@/components/Modal'
import {
  AttestationFormData,
  GenericSchemaComponent,
  schemaComponentRegistry,
} from '@/components/schema-components'
import { CreateVouchingSchema } from '@/components/schema-components/CreateVouchingSchema'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/Select'
import { useWalletConnectionContext } from '@/components/WalletConnectionProvider'
import { useNetworks } from '@/contexts/CatalogContext'
import { useNetworkIfAvailable } from '@/contexts/NetworkContext'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import { useAttestation, useIntoAttestationsData } from '@/hooks/useAttestation'
import { useEasOffchainVouches } from '@/hooks/useEasOffchainVouches'
import { useEnsResolver } from '@/hooks/useEns'
import { AttestationData } from '@/lib/attestation'
import { parseAccountIdentifier } from '@/lib/ens'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'
import { parseErrorMessage } from '@/lib/error'
import { SchemaManager } from '@/lib/schemas'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { formatBigNumber, formatPercentage, isHexEqual } from '@/lib/utils'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'
import { bumpPendingEchoAtom } from '@/state/score-updates'

import { Card } from './Card'
import { Markdown } from './Markdown'
import { Column, Table } from './Table'
import { Tooltip } from './Tooltip'

export type CreateAttestationModalProps = {
  title?: string
  defaultRecipient?: string
  className?: string
}

const downloadJson = (name: string, content: string) => {
  const url = window.URL.createObjectURL(
    new Blob([content], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.URL.revokeObjectURL(url)
}

export const CreateAttestationModal = ({
  title = 'Vouch for someone',
  defaultRecipient = '',
  className,
}: CreateAttestationModalProps) => {
  const networkContext = useNetworkIfAvailable()
  // Outside a network page the picker lists the RUNTIME catalog, so a network created through the
  // factory can be vouched in without a rebuild.
  const networks = useNetworks()
  const attestableNetworks = networks.filter(
    (network) => network.schemas.length > 0
  )

  const [isOpen, setIsOpen] = useState(false)
  const [openAfterConnect, setOpenAfterConnect] = useState(false)
  const { openConnectWallet } = useWalletConnectionContext()
  const {
    wrongChain,
    targetChain,
    switchToTarget,
    switchingTarget,
    switchError,
  } = useApplicationChain()
  const [recipientMode, setRecipientMode] = useState<'single' | 'multiple'>(
    'single'
  )
  const [isBatchBusy, setIsBatchBusy] = useState(false)

  const defaultSchemaUid =
    networkContext?.network.schemas[0]?.uid ||
    attestableNetworks[0]?.schemas[0]?.uid ||
    zeroAddress
  const form = useForm<AttestationFormData>({
    defaultValues: {
      networkId: networkContext?.network.id || attestableNetworks[0]?.id || '',
      schema: defaultSchemaUid,
      recipient: defaultRecipient,
      data: {},
    },
  })

  const selectedNetworkId = form.watch('networkId')
  // Use current network context if available, otherwise find the network by ID.
  const currentNetwork =
    networkContext?.network ||
    (selectedNetworkId
      ? networks.find((network) => network.id === selectedNetworkId)
      : undefined)
  const strictVouches = useEasOffchainVouches(currentNetwork)
  const [vouchMode, setVouchMode] = useState<'onchain' | 'offchain'>(
    currentNetwork?.offchainLane ? 'offchain' : 'onchain'
  )
  const useStrictLane = strictVouches.enabled && vouchMode === 'offchain'

  const selectedSchemaUid = form.watch('schema')
  const selectedSchemaInfo = selectedSchemaUid
    ? // `maybe`, not the throwing variant: the known-schema set is now populated at runtime from
      // the catalog, and a uid arriving a beat before its network does should degrade to "no form
      // yet", not take the whole page down. Every render path below already handles undefined.
      SchemaManager.maybeSchemaForUid(selectedSchemaUid)
    : undefined
  const isBatch =
    recipientMode === 'multiple' && selectedSchemaInfo?.key === 'vouching'

  const recipient = form.watch('recipient', '')
  const [recipientPreview, setRecipientPreview] = useState<Address | null>(null)
  const [isResolvingRecipient, setIsResolvingRecipient] = useState(false)
  const resolveAccountIdentifier = useEnsResolver()
  const resolvedRecipient = recipientPreview || recipient

  const { address: connectedAddress = '0x', isConnected } = useAccount()
  useEffect(() => {
    if (isConnected && openAfterConnect) {
      setOpenAfterConnect(false)
      setIsOpen(true)
    }
  }, [isConnected, openAfterConnect])

  const { data: networkMerkleTree } = useQuery(
    ponderQueries.latestMerkleTree(
      currentNetwork?.contracts.merkleSnapshot || ''
    )
  )
  const totalValue = Number(networkMerkleTree?.tree?.totalValue || 0)

  const { data: networkProfile } = useQuery(
    ponderQueries.accountNetworkProfile({
      address: connectedAddress,
      snapshot: currentNetwork?.contracts.merkleSnapshot || '',
    })
  )

  const { data: attestationsGiven = [] } = usePonderQuery({
    queryFn: ponderQueryFns.getAttestationsGiven({
      address: connectedAddress,
      schema: selectedSchemaInfo
        ? [selectedSchemaInfo.uid]
        : currentNetwork?.schemas.map((schema) => schema.uid),
    }),
    select: useIntoAttestationsData(),
  })

  const {
    createAttestation,
    revokeAttestation,
    clearTransactionState,
    isCreating,
    isCreated,
    isRevoking,
    error,
    hash,
    isRelayEnabled,
  } = useAttestation(undefined, currentNetwork?.importedLane)

  const noteText =
    totalValue > 0 && networkProfile && networkProfile.score !== '0'
      ? '**Note:**\n' +
        [
          (networkProfile.attestationsGiven.inNetwork.length > 0 ? '- ' : '') +
            `Your **trust score** determines how much influence your attestations carry — currently **${formatPercentage(
              (Number(networkProfile.score) / totalValue) * 100
            )} of total network trust**.`,
          ...(networkProfile.attestationsGiven.inNetwork.length > 0
            ? [
                `- You've made **${formatBigNumber(
                  networkProfile.attestationsGiven.inNetwork.length,
                  undefined,
                  true
                )} attestations** — adding another will reduce each attestation's weight by **${formatPercentage(
                  (1 / networkProfile.attestationsGiven.inNetwork.length -
                    1 /
                      (networkProfile.attestationsGiven.inNetwork.length + 1)) *
                    100
                )}**.`,
              ]
            : []),
        ].join('\n')
      : null

  const [isRevokingUid, setIsRevokingUid] = useState<Hex | null>(null)
  const [revoked, setRevoked] = useState<Record<Hex, boolean>>({})
  const handleRevoke = async (
    e: React.MouseEvent,
    attestation: AttestationData
  ) => {
    e.stopPropagation() // Prevent card click when revoking

    setIsRevokingUid(attestation.uid)
    try {
      await revokeAttestation(attestation.uid, attestation.schema)
      // A revocation changes the next update exactly like a new attestation does.
      if (currentSnapshot) {
        bumpPendingEcho(currentSnapshot)
      }
      setRevoked((r) => ({ ...r, [attestation.uid]: true }))
    } catch (err) {
      console.error('Failed to revoke attestation:', err)
      toast.error(parseErrorMessage(err))
    } finally {
      setIsRevokingUid(null)
    }
  }

  const handleStrictRevoke = async (e: React.MouseEvent, uid: Hex) => {
    e.stopPropagation()
    setIsRevokingUid(uid)
    try {
      await strictVouches.prepareRevoke(uid)
    } catch (err) {
      toast.error(parseErrorMessage(err))
    } finally {
      setIsRevokingUid(null)
    }
  }

  const bumpPendingEcho = useSetAtom(bumpPendingEchoAtom)
  const currentSnapshot = currentNetwork?.contracts.merkleSnapshot
  const isBusy =
    isCreating ||
    isRevoking ||
    isResolvingRecipient ||
    strictVouches.isBusy ||
    isBatchBusy
  const close = () => {
    if (!isBusy) setIsOpen(false)
  }

  // Monitor transaction state
  useEffect(() => {
    if (hash && isCreated && !useStrictLane) {
      console.log(`✅ Transaction successful: ${hash}`)
      // The indexer will not serve this attestation until it is past Ponder's finality window, so
      // echo it locally: the network header's pending count moves the instant the modal closes,
      // instead of the page sitting unchanged for a minute.
      if (currentSnapshot) {
        bumpPendingEcho(currentSnapshot)
      }
      setIsOpen(false)
      form.reset()
    }
  }, [hash, isCreated, form, currentSnapshot, bumpPendingEcho, useStrictLane])

  useEffect(() => {
    if (!strictVouches.audit) return
    if (currentSnapshot) bumpPendingEcho(currentSnapshot)
  }, [strictVouches.audit, currentSnapshot, bumpPendingEcho])

  // Clear transaction state when modal reopens
  useEffect(() => {
    if (isOpen) {
      setRecipientMode('single')
      // Clear any previous transaction state
      clearTransactionState()
      strictVouches.reset()
      setVouchMode(currentNetwork?.offchainLane ? 'offchain' : 'onchain')
      if (currentNetwork?.offchainLane) void strictVouches.refreshTimeline()
      // Reset form to default values
      form.reset({
        networkId: currentNetwork?.id || attestableNetworks[0]?.id || '',
        schema: currentNetwork?.schemas[0]?.uid || defaultSchemaUid,
        recipient: defaultRecipient,
        data: {
          comment: '',
          confidence: '100',
        },
      })
    }
  }, [
    isOpen,
    clearTransactionState,
    currentNetwork?.offchainLane,
    strictVouches.refreshTimeline,
    strictVouches.reset,
  ])

  const onSubmit = async (data: AttestationFormData) => {
    if (!isConnected) {
      openConnectWallet()
      return
    }
    if (wrongChain) {
      await switchToTarget()
      return
    }
    let recipient: Address
    setIsResolvingRecipient(true)
    try {
      form.clearErrors('recipient')
      const resolved = await resolveAccountIdentifier(
        data.recipient,
        recipientPreview
      )
      recipient = resolved.address
    } catch (err) {
      form.setError('recipient', {
        type: 'validate',
        message: getAccountIdentifierErrorMessage(err),
      })
      setIsResolvingRecipient(false)
      return
    }

    try {
      if (useStrictLane) {
        await strictVouches.prepareAttest({
          recipient,
          data: SchemaManager.encode(data.schema, data.data),
        })
      } else {
        await createAttestation({
          ...data,
          recipient,
        })
      }
    } catch (err) {
      console.error('Failed to create attestation:', err)
    } finally {
      setIsResolvingRecipient(false)
    }
  }

  const defaultTrigger = (
    <Tooltip
      asChild
      title={
        !isConnected
          ? 'Connect your wallet to continue with this vouch'
          : !currentNetwork?.schemas.length
            ? 'This network schema is not available yet'
            : ''
      }
    >
      <Button
        onClick={() => {
          if (isConnected) setIsOpen(true)
          else {
            setOpenAfterConnect(true)
            openConnectWallet()
          }
        }}
        disabled={!currentNetwork?.schemas.length}
        className={className}
      >
        {isConnected ? title : 'Connect to vouch'}
      </Button>
    </Tooltip>
  )

  const attestationsGivenToRecipient =
    resolvedRecipient.startsWith('0x') && selectedSchemaInfo
      ? attestationsGiven.filter(
          (attestation) =>
            isHexEqual(attestation.recipient, resolvedRecipient) &&
            isHexEqual(attestation.schema, selectedSchemaInfo.uid) &&
            // At least 10 seconds old, so we don't show the one we just made.
            attestation.time < BigInt(Math.floor(Date.now() / 1000) - 10)
        )
      : []

  const offchainToRecipient =
    resolvedRecipient.startsWith('0x') && selectedSchemaInfo
      ? strictVouches.timeline.filter(
          (entry) =>
            entry.recipient.toLowerCase() === resolvedRecipient.toLowerCase()
        )
      : []

  const mixedEvents = [
    ...attestationsGivenToRecipient.flatMap((attestation, position) => [
      {
        kind: 'attest' as const,
        uid: attestation.uid,
        lane: 0,
        time: attestation.time,
        position: position * 2,
      },
      ...(attestation.revocationTime > 0n
        ? [
            {
              kind: 'revoke' as const,
              uid: attestation.uid,
              lane: 0,
              time: attestation.revocationTime,
              position: position * 2 + 1,
            },
          ]
        : []),
    ]),
    ...offchainToRecipient.map((entry) => ({
      kind: entry.kind,
      uid: entry.uid,
      lane: 1,
      time: entry.time,
      position: entry.sequence,
    })),
  ].sort((left, right) =>
    left.time < right.time
      ? -1
      : left.time > right.time
        ? 1
        : left.lane !== right.lane
          ? left.lane - right.lane
          : left.position - right.position
  )
  let mixedWinner: (typeof mixedEvents)[number] | null = null
  for (const event of mixedEvents) {
    if (event.kind === 'attest') mixedWinner = event
    else if (mixedWinner?.uid.toLowerCase() === event.uid.toLowerCase()) {
      mixedWinner = null
    }
  }

  const signedVouch = strictVouches.attestReview
    ? SchemaManager.decode(
        strictVouches.attestReview.schema,
        strictVouches.attestReview.data
      )
    : null

  const attestationsGivenColumns: Column<AttestationData>[] = [
    {
      key: 'confidence',
      header: 'CONFIDENCE',
      tooltip: 'The strength of the attestation as specified by the attester.',
      sortable: true,
      accessor: (row) => Number(row.decodedData?.confidence || '0'),
      render: (row) =>
        formatBigNumber(row.decodedData?.confidence || '0', undefined, true),
    },
    {
      key: 'time',
      header: 'TIME',
      tooltip: 'The time the attestation was made.',
      sortable: true,
      accessor: (row) => Number(row.time),
      render: (row) => (
        <Link
          href={`/attestations/${row.uid}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="text-text underline decoration-dotted underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <div>{row.formattedTime}</div>
          <div className="text-xs text-text-muted">{row.formattedTimeAgo}</div>
          <span className="sr-only">
            View vouch record (opens in a new tab)
          </span>
        </Link>
      ),
    },
    {
      key: 'revoke',
      header: 'REVOKE',
      tooltip: 'Revoke the attestation.',
      render: (row) => (
        <Button
          variant="destructive"
          onClick={(e) => handleRevoke(e, row)}
          size="xs"
          disabled={isRevoking || isRevokingUid === row.uid || revoked[row.uid]}
        >
          {isRevokingUid === row.uid
            ? 'Revoking...'
            : revoked[row.uid]
              ? 'Revoked'
              : 'Revoke'}
        </Button>
      ),
    },
  ]

  return (
    <>
      {defaultTrigger}

      <Modal
        isOpen={isOpen}
        onClose={close}
        title={title}
        className={clsx('max-h-[90vh]', isBatch ? '!max-w-5xl' : '!max-w-2xl')}
      >
        <div className="space-y-6">
          {wrongChain && (
            <Card type="outline" size="sm" className="space-y-2">
              <p className="text-sm">
                Switch to {targetChain.name} before signing this vouch.
              </p>
              <Button
                type="button"
                disabled={switchingTarget || isBusy}
                onClick={() => void switchToTarget()}
              >
                {switchingTarget
                  ? 'Switching…'
                  : `Switch to ${targetChain.name}`}
              </Button>
              {switchError && (
                <p role="alert" className="text-sm text-destructive">
                  {switchError}
                </p>
              )}
            </Card>
          )}
          {/* Attestation Form */}
          <Form {...form}>
            <div className="flex flex-col gap-4">
              {!isBatch && noteText && (
                <Card type="accent" size="sm">
                  <Markdown className="text-sm gap-1">{noteText}</Markdown>
                </Card>
              )}

              {!isBatch && strictVouches.enabled && (
                <Card type="outline" size="sm" className="space-y-3">
                  <div className="text-sm font-medium">Where to record it</div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="xs"
                      disabled={isBusy}
                      variant={vouchMode === 'offchain' ? 'default' : 'outline'}
                      onClick={() => {
                        strictVouches.reset()
                        setVouchMode('offchain')
                      }}
                    >
                      Gasless off-chain
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={isBusy}
                      variant={vouchMode === 'onchain' ? 'default' : 'outline'}
                      onClick={() => {
                        strictVouches.reset()
                        setVouchMode('onchain')
                      }}
                    >
                      On-chain EAS
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Gasless vouches use two wallet signatures. A relay records
                    your public vouch and pays the transaction fee. Use an
                    externally owned wallet; smart contract wallets can use the
                    on-chain option and pay gas. Both options affect the same
                    network scores.
                  </p>
                </Card>
              )}

              {/* If not in a network context, show network selection */}
              {!networkContext && (
                <FormField
                  control={form.control}
                  name="networkId"
                  rules={{ required: 'Network selection is required' }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-bold">
                        NETWORK
                      </FormLabel>
                      <Select
                        disabled={isBusy}
                        onValueChange={(value) => {
                          field.onChange(value)
                          setRecipientMode('single')
                          strictVouches.reset()
                          // Default schema to first schema in network
                          const network = networks.find(
                            (network) => network.id === value
                          )
                          if (network?.schemas[0]) {
                            form.setValue('schema', network.schemas[0].uid)
                          }
                        }}
                        value={field.value as string}
                      >
                        <FormControl>
                          <SelectTrigger className="text-sm mt-1">
                            <SelectValue placeholder="Select network..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {attestableNetworks.map((network) => (
                            <SelectItem
                              key={network.id as string}
                              value={network.id as string}
                            >
                              {network.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              )}

              {/* Only show schema selection if there are multiple schemas or the selected schema is invalid */}
              {currentNetwork &&
                (currentNetwork.schemas.length > 1 ||
                  !selectedSchemaUid ||
                  selectedSchemaUid === zeroAddress ||
                  !currentNetwork.schemas.some(
                    (schema) => schema.uid === selectedSchemaUid
                  )) && (
                  <FormField
                    control={form.control}
                    name="schema"
                    rules={{ required: 'Schema selection is required' }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-bold">
                          SCHEMA
                        </FormLabel>
                        <Select
                          disabled={isBusy}
                          onValueChange={(value) => {
                            field.onChange(value)
                            setRecipientMode('single')
                            strictVouches.reset()
                          }}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger className="text-sm mt-1">
                              <SelectValue placeholder="Select schema..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {currentNetwork.schemas.map((schema) => (
                              <SelectItem key={schema.uid} value={schema.uid}>
                                {schema.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )}
                  />
                )}

              {selectedSchemaInfo?.key === 'vouching' && (
                <div className="space-y-2">
                  <p className="text-sm font-bold">RECIPIENTS</p>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Number of recipients"
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant={isBatch ? 'outline' : 'default'}
                      aria-pressed={!isBatch}
                      disabled={isBusy}
                      onClick={() => setRecipientMode('single')}
                    >
                      One recipient
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={isBatch ? 'default' : 'outline'}
                      aria-pressed={isBatch}
                      disabled={isBusy}
                      onClick={() => {
                        strictVouches.reset()
                        setRecipientMode('multiple')
                      }}
                    >
                      Several recipients
                    </Button>
                  </div>
                </div>
              )}

              {isBatch && currentNetwork ? (
                isOpen && (
                  <BatchAttestationForm
                    key={`${currentNetwork.id}:${selectedSchemaUid}`}
                    network={currentNetwork}
                    schemaUid={selectedSchemaUid}
                    accountData={networkContext?.accountData}
                    attestationsData={attestationsGiven}
                    defaultRecipient={recipient}
                    onClose={close}
                    onBusyChange={setIsBatchBusy}
                  />
                )
              ) : (
                <>
                  <div className="flex flex-col gap-3">
                    <FormField
                      control={form.control}
                      name="recipient"
                      rules={{
                        required: 'Recipient is required',
                        validate: (value) => {
                          const parsed = parseAccountIdentifier(value)
                          if (parsed.kind === 'address') return true
                          if (parsed.kind === 'ens' && recipientPreview)
                            return true
                          if (parsed.kind === 'ens') {
                            return 'ENS name has not resolved to an address'
                          }
                          return 'Invalid Ethereum address or ENS name'
                        },
                      }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-bold">
                            RECIPIENT
                          </FormLabel>
                          <FormControl>
                            <AccountIdentifierInput
                              {...field}
                              placeholder="0x… or name.eth"
                              className="h-10 text-sm"
                              onResolvedAddressChange={setRecipientPreview}
                            />
                          </FormControl>
                          <FormMessage className="text-xs" />
                        </FormItem>
                      )}
                    />
                  </div>

                  {attestationsGivenToRecipient.length > 0 && (
                    <Card type="outline" size="sm" className="border-warn">
                      <p className="text-sm text-warn">
                        <span className="font-bold">Note:</span> A new vouch
                        becomes the current vouch for this recipient. Older
                        vouches remain visible as history, but scores will not
                        fall back to them if you later revoke the current one.
                      </p>

                      <Table
                        columns={attestationsGivenColumns}
                        data={attestationsGivenToRecipient}
                        cellClassName="text-sm !py-2"
                        defaultSortColumn="time"
                        defaultSortDirection="desc"
                        onRowClick={(row) =>
                          window.open(`/attestations/${row.uid}`, '_blank')
                        }
                        getRowKey={(row) => row.uid}
                      />
                    </Card>
                  )}

                  {strictVouches.enabled &&
                    (attestationsGivenToRecipient.length > 0 ||
                      offchainToRecipient.length > 0) && (
                      <Card type="outline" size="sm" className="space-y-3">
                        <div className="text-sm font-medium">
                          Mixed-lane history and current winner
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Mutations are replayed by effective timestamp; an
                          off-chain mutation follows an on-chain mutation in the
                          same second. A vouch replaces the current vouch for
                          this wallet/recipient pair. Revoking that exact
                          current UID clears the pair without reviving an older
                          vouch.
                        </p>
                        <p className="text-xs">
                          {mixedWinner
                            ? `Current winner: ${mixedWinner.lane === 1 ? 'gasless off-chain' : 'on-chain EAS'} vouch ${mixedWinner.uid}.`
                            : 'Current result: no vouch for this pair; the winning UID was revoked or none exists.'}
                        </p>
                        {offchainToRecipient.length > 0 && (
                          <div className="space-y-2 border-t border-border pt-3">
                            {offchainToRecipient.map((entry) => {
                              const decoded = SchemaManager.decode(
                                selectedSchemaInfo!.uid,
                                entry.data
                              )
                              const isWinner =
                                mixedWinner?.uid.toLowerCase() ===
                                  entry.uid.toLowerCase() &&
                                mixedWinner.lane === 1
                              return (
                                <div
                                  key={`${entry.sequence}-${entry.kind}`}
                                  className="space-y-1 text-xs"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span>
                                      Gasless off-chain · {entry.kind} ·{' '}
                                      {new Date(
                                        Number(entry.time) * 1_000
                                      ).toISOString()}
                                      {isWinner ? ' · current winner' : ''}
                                    </span>
                                    {entry.kind === 'attest' &&
                                      entry.active && (
                                        <Button
                                          type="button"
                                          size="xs"
                                          variant="destructive"
                                          disabled={
                                            strictVouches.isBusy ||
                                            isRevokingUid === entry.uid
                                          }
                                          onClick={(event) =>
                                            handleStrictRevoke(event, entry.uid)
                                          }
                                        >
                                          Revoke off-chain
                                        </Button>
                                      )}
                                  </div>
                                  <div className="font-mono break-all text-muted-foreground">
                                    {entry.uid}
                                  </div>
                                  {entry.kind === 'attest' && (
                                    <div className="text-muted-foreground">
                                      Confidence{' '}
                                      {String(decoded.confidence ?? '')}%
                                      {decoded.comment
                                        ? ` · ${String(decoded.comment)}`
                                        : ''}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </Card>
                    )}

                  {isRelayEnabled && !useStrictLane && (
                    <div className="border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                      Gasless mode: review this draft, then sign the EAS typed
                      message. The configured agent relay pays gas; it cannot
                      alter the recipient, schema, rating, or comment you sign.
                    </div>
                  )}

                  {useStrictLane && strictVouches.attestReview && (
                    <Card type="accent" size="sm" className="space-y-3">
                      <div className="text-sm font-medium">
                        Step 1 of 2: Sign your vouch
                      </div>
                      <p className="text-sm break-words">
                        You are vouching for{' '}
                        <span className="font-mono break-all">
                          {strictVouches.attestReview.recipient}
                        </span>{' '}
                        in {currentNetwork?.name}. Confidence:{' '}
                        {String(signedVouch?.confidence ?? '')}%.
                      </p>
                      {signedVouch?.comment && (
                        <p className="text-sm whitespace-pre-wrap break-words">
                          {String(signedVouch?.comment)}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        This signature confirms the vouch. You can revoke it
                        later. The next signature authorizes recording it; you
                        pay no gas.
                      </p>
                      <details className="space-y-3">
                        <summary className="cursor-pointer text-sm underline underline-offset-4">
                          Review the exact EAS v2 typed message
                        </summary>
                        <p className="text-xs text-muted-foreground">
                          Check these fields against your wallet prompt before
                          signing.
                        </p>
                        <dl className="grid gap-1 text-xs">
                          {[
                            ['version', '2'],
                            [
                              'chainId',
                              strictVouches.attestReview.chainId.toString(),
                            ],
                            ['EAS', strictVouches.attestReview.eas],
                            [
                              'EAS version',
                              strictVouches.attestReview.easVersion,
                            ],
                            ['registry', strictVouches.attestReview.registry],
                            ['owner', strictVouches.attestReview.owner],
                            ['schema', strictVouches.attestReview.schema],
                            ['recipient', strictVouches.attestReview.recipient],
                            [
                              'time',
                              strictVouches.attestReview.time.toString(),
                            ],
                            ['expirationTime', '0'],
                            ['revocable', 'true'],
                            ['refUID', strictVouches.attestReview.refUID],
                            ['data', strictVouches.attestReview.data],
                            ['salt', strictVouches.attestReview.salt],
                          ].map(([label, value]) => (
                            <div
                              key={label}
                              className="grid sm:grid-cols-[8rem_minmax(0,1fr)] gap-1 sm:gap-2"
                            >
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd className="font-mono break-all">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                      <Button
                        type="button"
                        disabled={
                          strictVouches.isBusy || wrongChain || !isConnected
                        }
                        onClick={() =>
                          void strictVouches
                            .signAttestation()
                            .catch(() => undefined)
                        }
                      >
                        Sign vouch
                      </Button>
                    </Card>
                  )}

                  {useStrictLane && strictVouches.headReview && (
                    <Card type="accent" size="sm" className="space-y-3">
                      <div className="text-sm font-medium">
                        Step 2 of 2: Authorize recording
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Authorize the relay to record this{' '}
                        {strictVouches.headReview.operation === 'revoke'
                          ? 'revocation'
                          : 'vouch'}{' '}
                        in {currentNetwork?.name}. The relay pays gas and cannot
                        change the signed content.
                      </p>
                      <details className="space-y-3">
                        <summary className="cursor-pointer text-sm underline underline-offset-4">
                          Review the exact append-head typed message
                        </summary>
                        <p className="text-xs text-muted-foreground">
                          This signature binds the registry, predecessor, full
                          log head, count, and payload commitment below.
                        </p>
                        <dl className="grid gap-1 text-xs">
                          {[
                            ['operation', strictVouches.headReview.operation],
                            ['nodeId', strictVouches.headReview.nodeId],
                            ['envelopeKind', '0'],
                            ['schemaUid', strictVouches.headReview.schemaUid],
                            [
                              'previousHead',
                              strictVouches.headReview.previousHead,
                            ],
                            ['head', strictVouches.headReview.head],
                            [
                              'count',
                              strictVouches.headReview.count.toString(),
                            ],
                            [
                              'dataCommitment',
                              strictVouches.headReview.dataCommitment,
                            ],
                            ['raw CID', strictVouches.headReview.cid],
                          ].map(([label, value]) => (
                            <div
                              key={label}
                              className="grid sm:grid-cols-[8rem_minmax(0,1fr)] gap-1 sm:gap-2"
                            >
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd className="font-mono break-all">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                      <Button
                        type="button"
                        disabled={
                          strictVouches.isBusy || wrongChain || !isConnected
                        }
                        onClick={() =>
                          void strictVouches
                            .signHeadAndSubmit()
                            .catch(() => undefined)
                        }
                      >
                        Sign and record
                      </Button>
                    </Card>
                  )}

                  {useStrictLane && strictVouches.phase !== 'idle' && (
                    <Card type="outline" size="sm" className="space-y-2">
                      <div className="text-sm font-medium">
                        {strictVouches.phase === 'relay-storage'
                          ? 'Recording your signed vouch…'
                          : strictVouches.phase === 'anchored-awaiting-finality'
                            ? 'Recorded; waiting for final confirmation…'
                            : strictVouches.phase === 'anchored-unverified'
                              ? 'Recorded; final verification is still pending'
                              : strictVouches.phase === 'verified'
                                ? 'Finalized and independently verified'
                                : strictVouches.phase.replaceAll('-', ' ')}
                      </div>
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          How confirmation works
                        </summary>
                        <p className="mt-2">
                          Relay acceptance alone is not final. This screen
                          reports success only after the finalized indexer
                          fetches the CID independently and verifies its digest,
                          EAS signatures, head signature, head/count, and
                          canonical log.
                        </p>
                      </details>
                      {strictVouches.error && (
                        <p className="text-xs text-destructive">
                          {strictVouches.error}
                        </p>
                      )}
                      {strictVouches.bundleExport && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              downloadJson(
                                `trustgraphs-eas-offchain-${strictVouches.bundle!.message.nodeId}-${strictVouches.bundle!.message.count}.json`,
                                strictVouches.bundleExport!
                              )
                            }
                          >
                            Export recoverable signed bundle
                          </Button>
                          {strictVouches.phase === 'anchored-unverified' && (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={strictVouches.isBusy}
                              onClick={() =>
                                void strictVouches
                                  .retryFinalizedVerification()
                                  .catch(() => undefined)
                              }
                            >
                              Check finalized verification again
                            </Button>
                          )}
                        </div>
                      )}
                      {strictVouches.audit && (
                        <details className="text-xs break-all">
                          <summary className="cursor-pointer">
                            View verified record
                          </summary>
                          <dl className="grid gap-1 mt-2">
                            <div>Registry: {strictVouches.audit.registry}</div>
                            <div>Node: {strictVouches.audit.nodeId}</div>
                            <div>
                              Count/head: {strictVouches.audit.count} /{' '}
                              {strictVouches.audit.head}
                            </div>
                            <div>CID: {strictVouches.audit.cid}</div>
                            <div>
                              Audit: local canonical/signature verification +
                              finalized independent index verification
                            </div>
                          </dl>
                        </details>
                      )}
                    </Card>
                  )}

                  {selectedSchemaInfo &&
                  !strictVouches.attestReview &&
                  !strictVouches.headReview ? (
                    (() => {
                      // Check if there's a custom component for this schema
                      // The registry's vouching component is lazy so the root catalog provider does
                      // not put the form (and its heavier dependencies) on every route. This modal is
                      // already only loaded on pages that can open the form, however. Rendering the
                      // lazy registry entry here left its default `null` fallback between opening the
                      // modal and loading the chunk — users saw their attestation-count note followed
                      // by only the Cancel button. Keep future custom schemas registry-driven, but
                      // make the core vouch form available on the modal's first render.
                      const CustomComponent =
                        selectedSchemaInfo.key === 'vouching'
                          ? CreateVouchingSchema
                          : schemaComponentRegistry.getComponent(
                              selectedSchemaInfo.uid
                            )

                      if (CustomComponent) {
                        // Use custom component
                        return (
                          <CustomComponent
                            form={form}
                            schemaInfo={selectedSchemaInfo}
                            onSubmit={onSubmit}
                            isLoading={
                              isCreating ||
                              isResolvingRecipient ||
                              strictVouches.isBusy
                            }
                            error={useStrictLane ? strictVouches.error : error}
                            isSuccess={useStrictLane ? false : isCreated}
                            hash={hash}
                            network={currentNetwork}
                          />
                        )
                      } else {
                        // Use generic component
                        return (
                          <GenericSchemaComponent
                            form={form}
                            schemaInfo={selectedSchemaInfo}
                            onSubmit={onSubmit}
                            isLoading={
                              isCreating ||
                              isResolvingRecipient ||
                              strictVouches.isBusy
                            }
                            error={useStrictLane ? strictVouches.error : error}
                            isSuccess={useStrictLane ? false : isCreated}
                            network={currentNetwork}
                            hash={hash}
                          />
                        )
                      }
                    })()
                  ) : !selectedSchemaInfo ? (
                    <p className="text-muted-foreground text-sm">
                      Select a schema to continue.
                    </p>
                  ) : null}
                </>
              )}

              {selectedSchemaInfo && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  disabled={isBusy}
                  className="px-6 py-2 w-full"
                >
                  Cancel
                </Button>
              )}
            </div>
          </Form>
        </div>
      </Modal>
    </>
  )
}
