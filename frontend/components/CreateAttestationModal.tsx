'use client'

import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useSetAtom } from 'jotai'
import { Check, LoaderCircle, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import { Hex, zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { Button, ButtonProps } from '@/components/Button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/Form'
import { Input } from '@/components/Input'
import { Modal } from '@/components/Modal'
import {
  AttestationFormData,
  GenericSchemaComponent,
  schemaComponentRegistry,
} from '@/components/schema-components'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/Select'
import { useNetworks } from '@/contexts/CatalogContext'
import { useNetworkIfAvailable } from '@/contexts/NetworkContext'
import { useAttestation, useIntoAttestationsData } from '@/hooks/useAttestation'
import { useResolveEnsName } from '@/hooks/useEns'
import { AttestationData } from '@/lib/attestation'
import { parseErrorMessage } from '@/lib/error'
import { SchemaManager } from '@/lib/schemas'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { bumpPendingEchoAtom } from '@/state/score-updates'
import {
  formatBigNumber,
  formatPercentage,
  isHexEqual,
  mightBeEnsName,
} from '@/lib/utils'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { Card } from './Card'
import { CopyableText } from './CopyableText'
import { EnsIcon } from './icons/EnsIcon'
import { Markdown } from './Markdown'
import { Column, Table } from './Table'
import { Tooltip } from './Tooltip'

export type CreateAttestationModalProps = {
  trigger?: React.ReactNode
  title?: string
  onSuccess?: () => void
  isOpen?: boolean
  setIsOpen?: (value: boolean) => void
  defaultRecipient?: string
  variant?: ButtonProps['variant']
  className?: string
}

export const CreateAttestationModal = ({
  trigger,
  title = 'Make Attestation',
  onSuccess,
  isOpen: externalIsOpen,
  setIsOpen: externalSetIsOpen,
  defaultRecipient = '',
  variant = 'default',
  className,
}: CreateAttestationModalProps) => {
  const networkContext = useNetworkIfAvailable()
  // Outside a network page the picker lists the RUNTIME catalog, so a network created through the
  // factory can be vouched in without a rebuild.
  const networks = useNetworks()
  const attestableNetworks = networks.filter(
    (network) => network.schemas.length > 0
  )

  const [internalIsOpen, setInternalIsOpen] = useState(false)
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen
  const setIsOpen = (value: boolean) => {
    if (externalIsOpen !== undefined && externalSetIsOpen) {
      externalSetIsOpen(value)
    } else {
      setInternalIsOpen(value)
    }
  }

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

  const selectedSchemaUid = form.watch('schema')
  const selectedSchemaInfo = selectedSchemaUid
    ? // `maybe`, not the throwing variant: the known-schema set is now populated at runtime from
      // the catalog, and a uid arriving a beat before its network does should degrade to "no form
      // yet", not take the whole page down. Every render path below already handles undefined.
      SchemaManager.maybeSchemaForUid(selectedSchemaUid)
    : undefined

  const recipient = form.watch('recipient', '')
  const shouldResolveEnsName = mightBeEnsName(recipient)
  const resolvedEnsName = useResolveEnsName(
    shouldResolveEnsName ? recipient : ''
  )
  const isResolvingEnsName = shouldResolveEnsName && resolvedEnsName.isLoading
  const validResolvedEnsAddress =
    shouldResolveEnsName &&
    !resolvedEnsName.isLoading &&
    !!resolvedEnsName.address
  const invalidResolvedEnsName =
    shouldResolveEnsName &&
    !resolvedEnsName.isLoading &&
    !resolvedEnsName.address
  const resolvedRecipient =
    (validResolvedEnsAddress && resolvedEnsName.address) || recipient

  const { address: connectedAddress = '0x', isConnected } = useAccount()

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
  } = useAttestation()

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

  const bumpPendingEcho = useSetAtom(bumpPendingEchoAtom)
  const currentSnapshot = currentNetwork?.contracts.merkleSnapshot

  // Monitor transaction state
  useEffect(() => {
    if (hash && isCreated) {
      console.log(`✅ Transaction successful: ${hash}`)
      // The indexer will not serve this attestation until it is past Ponder's finality window, so
      // echo it locally: the network header's pending count moves the instant the modal closes,
      // instead of the page sitting unchanged for a minute.
      if (currentSnapshot) {
        bumpPendingEcho(currentSnapshot)
      }
      onSuccess?.()
      setIsOpen(false)
      form.reset()
    }
  }, [hash, isCreated, onSuccess, form, currentSnapshot, bumpPendingEcho])

  // Clear transaction state when modal reopens
  useEffect(() => {
    if (isOpen) {
      // Clear any previous transaction state
      clearTransactionState()
      // Reset form to default values
      form.reset({
        schema: defaultSchemaUid,
        recipient: defaultRecipient,
        data: {
          comment: '',
          confidence: '100',
        },
      })
    }
  }, [isOpen, clearTransactionState])

  const onSubmit = async (data: AttestationFormData) => {
    try {
      await createAttestation({
        ...data,
        recipient:
          (validResolvedEnsAddress && resolvedEnsName.address) ||
          data.recipient,
      })
    } catch (err) {
      console.error('Failed to create attestation:', err)
    }
  }

  const defaultTrigger = (
    <Tooltip
      asChild
      title={
        !isConnected
          ? 'Connect your wallet to make attestations'
          : !currentNetwork?.schemas.length
            ? 'This network schema is not available yet'
            : ''
      }
    >
      <Button
        onClick={() => setIsOpen(true)}
        disabled={!isConnected || !currentNetwork?.schemas.length}
        variant={variant}
        className={className}
      >
        {title}
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
        <div className="text-text">
          <div>{row.formattedTime}</div>
          <div className="text-xs text-text-muted">{row.formattedTimeAgo}</div>
        </div>
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
      {trigger ? (
        <div onClick={() => setIsOpen(true)} className="cursor-pointer">
          {trigger}
        </div>
      ) : (
        defaultTrigger
      )}

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={title}
        className="!max-w-2xl max-h-[90vh]"
      >
        <div className="space-y-6">
          {/* Attestation Form */}
          <Form {...form}>
            <div className="flex flex-col gap-4">
              {noteText && (
                <Card type="accent" size="sm">
                  <Markdown className="text-sm gap-1">{noteText}</Markdown>
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
                        onValueChange={(value) => {
                          field.onChange(value)
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

              <div
                className={clsx(
                  'grid grid-cols-1 gap-4',
                  currentNetwork &&
                    currentNetwork.schemas.length > 1 &&
                    'md:grid-cols-2'
                )}
              >
                <div className="flex flex-col gap-3">
                  <FormField
                    control={form.control}
                    name="recipient"
                    rules={{
                      required: 'Recipient is required',
                      pattern: shouldResolveEnsName
                        ? resolvedEnsName.isLoading || validResolvedEnsAddress
                          ? undefined
                          : {
                              value: /^$/,
                              message: 'Invalid ENS name',
                            }
                        : {
                            value: /^0x[a-fA-F0-9]{40}$/,
                            message: 'Invalid Ethereum address or ENS name',
                          },
                    }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-bold">
                          RECIPIENT
                        </FormLabel>
                        <FormControl>
                          <div className="h-10 w-full relative mt-1">
                            <Input
                              {...field}
                              placeholder="0x..."
                              className={clsx(
                                'text-sm h-full w-full',
                                shouldResolveEnsName && 'pr-9'
                              )}
                            />

                            {shouldResolveEnsName && (
                              <div className="absolute right-3 top-0 bottom-0 z-100 flex items-center">
                                <Tooltip
                                  title={
                                    invalidResolvedEnsName
                                      ? 'ENS name not found'
                                      : validResolvedEnsAddress
                                        ? 'ENS name resolved'
                                        : 'Resolving ENS name...'
                                  }
                                >
                                  {isResolvingEnsName ? (
                                    <LoaderCircle className="h-4 w-4 animate-spin text-text-muted" />
                                  ) : invalidResolvedEnsName ? (
                                    <X className="w-4 h-4 text-destructive" />
                                  ) : validResolvedEnsAddress ? (
                                    <Check className="h-4 w-4 text-success" />
                                  ) : null}
                                </Tooltip>
                              </div>
                            )}
                          </div>
                        </FormControl>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )}
                  />

                  {validResolvedEnsAddress && (
                    <div className="flex items-center gap-1.5 ml-2 md:hidden">
                      <EnsIcon className="w-5 h-5" />
                      <CopyableText
                        truncate
                        truncateEnds={[10, 8]}
                        text={resolvedEnsName.address}
                        className="text-sm text-text-muted"
                      />
                    </div>
                  )}
                </div>

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
                            onValueChange={(value) => field.onChange(value)}
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
              </div>

              {validResolvedEnsAddress && (
                <div className="hidden md:flex items-center gap-2 -mt-2 ml-2">
                  <EnsIcon className="w-4 h-4" />
                  <CopyableText
                    truncate
                    truncateEnds={[7, 5]}
                    text={resolvedEnsName.address}
                    className="text-sm text-text-muted"
                  />
                </div>
              )}

              {attestationsGivenToRecipient.length > 0 && (
                <Card type="outline" size="sm" className="border-warn">
                  <p className="text-sm text-warn">
                    <span className="font-bold">Note:</span> You may want to
                    revoke your other attestation
                    {attestationsGivenToRecipient.length > 1 ? 's' : ''} for
                    this recipient before making a new one.
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

              {selectedSchemaInfo ? (
                (() => {
                  // Check if there's a custom component for this schema
                  const CustomComponent = schemaComponentRegistry.getComponent(
                    selectedSchemaInfo.uid
                  )

                  if (CustomComponent) {
                    // Use custom component
                    return (
                      <CustomComponent
                        form={form}
                        schemaInfo={selectedSchemaInfo}
                        onSubmit={onSubmit}
                        isLoading={isCreating}
                        error={error}
                        isSuccess={isCreated}
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
                        isLoading={isCreating}
                        error={error}
                        isSuccess={isCreated}
                        network={currentNetwork}
                        hash={hash}
                      />
                    )
                  }
                })()
              ) : (
                <p className="text-muted-foreground text-sm">
                  Select a schema to attest to.
                </p>
              )}

              {selectedSchemaInfo && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsOpen(false)}
                  disabled={isCreating || isRevoking}
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
