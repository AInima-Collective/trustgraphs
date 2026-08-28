'use client'

import { useSetAtom } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type Address, getAddress } from 'viem'

import { Button } from '@/components/Button'
import { Checkbox } from '@/components/Checkbox'
import { Input } from '@/components/Input'
import { Markdown } from '@/components/Markdown'
import { Modal } from '@/components/Modal'
import { Slider } from '@/components/Slider'
import { Textarea } from '@/components/Textarea'
import { Tooltip } from '@/components/Tooltip'
import { useNetwork } from '@/contexts/NetworkContext'
import { useAttestation } from '@/hooks/useAttestation'
import { useEnsResolver } from '@/hooks/useEns'
import { MAX_RELAY_ATTESTATIONS } from '@/lib/eas-delegation'
import { parseAccountIdentifier } from '@/lib/ens'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'
import { parseErrorMessage } from '@/lib/error'
import { cn } from '@/lib/utils'
import { bumpPendingEchoAtom } from '@/state/score-updates'

const MAX_DIRECT_ATTESTATIONS = 50

type Stage = 'compose' | 'review' | 'success'

type BatchRecipient = {
  address: Address
  /** What the person entered. Retained so ENS can be checked again before signing. */
  identifier: string
  label?: string
  confidence: number
}

const splitAccountIdentifiers = (input: string) =>
  input
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean)

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`

const confidenceSummary = (recipients: BatchRecipient[]) => {
  if (recipients.length === 0) return 'No confidence scores'
  const scores = recipients.map(({ confidence }) => confidence)
  const minimum = Math.min(...scores)
  const maximum = Math.max(...scores)
  return minimum === maximum
    ? `${minimum}% confidence`
    : `${minimum}–${maximum}% confidence range`
}

export function CreateBatchAttestationModal({
  className,
}: {
  className?: string
}) {
  const { network, accountData, attestationsData } = useNetwork()
  const {
    createAttestations,
    clearTransactionState,
    error,
    hash,
    isConnected,
    isCreating,
    isRelayEnabled,
    userAddress,
  } = useAttestation()
  const resolveAccountIdentifier = useEnsResolver()
  const bumpPendingEcho = useSetAtom(bumpPendingEchoAtom)

  const vouchSchema = network.schemas.find(
    (schema) => schema.key === 'vouching'
  )
  const batchLimit = isRelayEnabled
    ? MAX_RELAY_ATTESTATIONS
    : MAX_DIRECT_ATTESTATIONS

  const [isOpen, setIsOpen] = useState(false)
  const [stage, setStage] = useState<Stage>('compose')
  const [recipientInput, setRecipientInput] = useState('')
  const [recipients, setRecipients] = useState<BatchRecipient[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [batchConfidence, setBatchConfidence] = useState(100)
  const [comment, setComment] = useState('')
  const [endorsed, setEndorsed] = useState(false)
  const [isResolving, setIsResolving] = useState(false)
  const [resolutionProgress, setResolutionProgress] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [submittedCount, setSubmittedCount] = useState(0)

  const selectedAddresses = useMemo(
    () => new Set(recipients.map(({ address }) => address.toLowerCase())),
    [recipients]
  )
  const existingRecipientAddresses = useMemo(() => {
    if (!userAddress) return new Set<string>()
    return new Set(
      (attestationsData ?? [])
        .filter(
          (attestation) =>
            attestation.attester.toLowerCase() === userAddress.toLowerCase() &&
            attestation.schema.toLowerCase() ===
              vouchSchema?.uid.toLowerCase() &&
            attestation.status === 'verified'
        )
        .map((attestation) => attestation.recipient.toLowerCase())
    )
  }, [attestationsData, userAddress, vouchSchema?.uid])

  const matchingMembers = useMemo(() => {
    const search = memberSearch.trim().toLowerCase()
    return accountData
      .filter(({ account, ensName }) => {
        if (selectedAddresses.has(account.toLowerCase())) return false
        if (!search) return true
        return (
          account.toLowerCase().includes(search) ||
          ensName?.toLowerCase().includes(search)
        )
      })
      .slice(0, 6)
  }, [accountData, memberSearch, selectedAddresses])

  const reset = () => {
    clearTransactionState()
    setStage('compose')
    setRecipientInput('')
    setRecipients([])
    setMemberSearch('')
    setBatchConfidence(100)
    setComment('')
    setEndorsed(false)
    setIsResolving(false)
    setResolutionProgress('')
    setLocalError(null)
    setImportNote(null)
    setSubmittedCount(0)
  }

  useEffect(() => {
    if (isOpen) reset()
    // Opening is the reset boundary. The callback is intentionally kept local so changing hook
    // identities while the dialog is open cannot wipe an in-progress batch.
  }, [isOpen])

  const close = () => {
    if (!isCreating && !isResolving) setIsOpen(false)
  }

  const appendRecipients = (next: BatchRecipient[]) => {
    setRecipients((current) => {
      const byAddress = new Map(
        current.map((recipient) => [recipient.address.toLowerCase(), recipient])
      )
      for (const recipient of next) {
        if (byAddress.size >= batchLimit) break
        byAddress.set(recipient.address.toLowerCase(), recipient)
      }
      return [...byAddress.values()]
    })
  }

  const addPastedRecipients = async () => {
    const identifiers = splitAccountIdentifiers(recipientInput)
    if (identifiers.length === 0) {
      setLocalError('Paste at least one wallet address or ENS name.')
      return
    }

    const remaining = batchLimit - recipients.length
    if (remaining <= 0) {
      setLocalError(`This batch already contains the maximum of ${batchLimit}.`)
      return
    }

    setIsResolving(true)
    setLocalError(null)
    setImportNote(null)
    const resolved: BatchRecipient[] = []
    const invalid: string[] = []
    let duplicateCount = 0
    let processedCount = 0
    const seen = new Set(selectedAddresses)

    try {
      for (const [index, identifier] of identifiers.entries()) {
        if (resolved.length >= remaining) break
        processedCount += 1
        setResolutionProgress(`Resolving ${index + 1} of ${identifiers.length}`)
        try {
          const parsed = parseAccountIdentifier(identifier)
          if (parsed.kind === 'empty' || parsed.kind === 'invalid') {
            invalid.push(identifier)
            continue
          }
          const result = await resolveAccountIdentifier(identifier)
          const address = getAddress(result.address)
          if (seen.has(address.toLowerCase())) {
            duplicateCount += 1
            continue
          }
          seen.add(address.toLowerCase())
          resolved.push({
            address,
            identifier,
            confidence: batchConfidence,
            ...(parsed.kind === 'ens' ? { label: parsed.name } : {}),
          })
        } catch (resolveError) {
          invalid.push(
            `${identifier} (${getAccountIdentifierErrorMessage(resolveError)})`
          )
        }
      }

      appendRecipients(resolved)
      if (resolved.length > 0) setRecipientInput('')

      const notes = [
        resolved.length > 0
          ? `${resolved.length} account${resolved.length === 1 ? '' : 's'} added.`
          : '',
        duplicateCount > 0
          ? `${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} skipped.`
          : '',
        identifiers.length > processedCount
          ? `${identifiers.length - processedCount} left out to keep this batch within ${batchLimit}.`
          : '',
      ].filter(Boolean)
      setImportNote(notes.join(' '))
      if (invalid.length > 0) {
        setLocalError(`Could not add: ${invalid.join(', ')}`)
      }
    } finally {
      setIsResolving(false)
      setResolutionProgress('')
    }
  }

  const addMember = (address: Address, ensName?: string) => {
    if (recipients.length >= batchLimit) {
      setLocalError(`This batch can contain at most ${batchLimit} accounts.`)
      return
    }
    appendRecipients([
      {
        address: getAddress(address),
        identifier: address,
        confidence: batchConfidence,
        ...(ensName ? { label: ensName } : {}),
      },
    ])
    setLocalError(null)
  }

  const removeRecipient = (address: Address) => {
    setRecipients((current) =>
      current.filter(
        (recipient) => recipient.address.toLowerCase() !== address.toLowerCase()
      )
    )
  }

  const setRecipientConfidence = (address: Address, confidence: number) => {
    const nextConfidence = Math.min(100, Math.max(0, Math.round(confidence)))
    setRecipients((current) =>
      current.map((recipient) =>
        recipient.address.toLowerCase() === address.toLowerCase()
          ? { ...recipient, confidence: nextConfidence }
          : recipient
      )
    )
  }

  const setEveryConfidence = (confidence: number) => {
    setBatchConfidence(confidence)
    setRecipients((current) =>
      current.map((recipient) => ({ ...recipient, confidence }))
    )
  }

  const moveToReview = () => {
    if (recipients.length === 0) {
      setLocalError('Add at least one account to the batch.')
      return
    }
    if (!endorsed) {
      setLocalError('Confirm that every recipient meets the network criteria.')
      return
    }
    setLocalError(null)
    setStage('review')
  }

  const submit = async () => {
    if (!vouchSchema) return
    setLocalError(null)
    setIsResolving(true)

    try {
      // ENS names are checked again at the signing boundary. If a name changed after the draft
      // was composed, the shared ENS resolver rejects the stale preview and makes the user review
      // the new destination instead of silently changing an edge.
      for (const [index, recipient] of recipients.entries()) {
        if (parseAccountIdentifier(recipient.identifier).kind !== 'ens')
          continue
        setResolutionProgress(
          `Rechecking ENS ${index + 1} of ${recipients.length}`
        )
        await resolveAccountIdentifier(recipient.identifier, recipient.address)
      }
    } catch (resolveError) {
      setLocalError(getAccountIdentifierErrorMessage(resolveError))
      setStage('compose')
      setIsResolving(false)
      setResolutionProgress('')
      return
    }

    setIsResolving(false)
    setResolutionProgress('')
    try {
      await createAttestations(
        recipients.map(({ address, confidence }) => ({
          schema: vouchSchema.uid,
          recipient: address,
          data: {
            comment,
            confidence: confidence.toString(),
          },
        }))
      )
      setSubmittedCount(recipients.length)
      for (let i = 0; i < recipients.length; i += 1) {
        bumpPendingEcho(network.contracts.merkleSnapshot)
      }
      setStage('success')
    } catch (submitError) {
      setLocalError(parseErrorMessage(submitError))
    }
  }

  const trigger = (
    <Tooltip
      asChild
      title={
        !isConnected
          ? 'Connect your wallet to vouch for several accounts'
          : !vouchSchema
            ? 'This network does not have a vouching schema'
            : ''
      }
    >
      <Button
        type="button"
        variant="outline"
        className={className}
        disabled={!isConnected || !vouchSchema}
        onClick={() => setIsOpen(true)}
      >
        Vouch for several
      </Button>
    </Tooltip>
  )

  return (
    <>
      {trigger}
      <Modal
        isOpen={isOpen}
        onClose={close}
        title="Vouch for several"
        className="max-w-5xl"
        contentClassName="p-0"
      >
        <div className="border-b border-hairline px-5 py-5 sm:px-7 sm:py-6">
          <p className="tg-label">Batch attestation · {network.name}</p>
          <h3 className="tg-display mt-2 max-w-2xl text-2xl text-text sm:text-3xl">
            Distinct vouches, composed in one deliberate pass.
          </h3>
          <p className="mt-3 max-w-2xl text-sm text-text-muted">
            Each recipient gets a separate confidence score and revocable vouch.
            The batch is submitted together and either succeeds together or not
            at all.
          </p>
        </div>

        <BatchSteps stage={stage} />

        {stage === 'compose' && (
          <div className="grid min-h-[32rem] lg:grid-cols-[minmax(0,1.2fr)_minmax(19rem,0.8fr)]">
            <section className="border-b border-hairline p-5 sm:p-7 lg:border-b-0 lg:border-r">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="tg-marker">01 / Recipients</p>
                  <h4 className="mt-2 text-base text-text">Build the queue</h4>
                </div>
                <span className="text-xs tabular-nums text-text-muted">
                  {recipients.length} / {batchLimit}
                </span>
              </div>

              <div className="mt-5 space-y-3">
                <Textarea
                  value={recipientInput}
                  onChange={(event) => setRecipientInput(event.target.value)}
                  placeholder={'0x…\nvitalik.eth\n0x…'}
                  aria-label="Wallet addresses or ENS names"
                  className="min-h-28 font-mono"
                  disabled={isResolving}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-text-subtle">
                    Separate accounts with a new line, comma, or space.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={isResolving || !recipientInput.trim()}
                    onClick={() => void addPastedRecipients()}
                  >
                    {isResolving ? (
                      <>
                        <LoaderCircle className="animate-spin" />
                        {resolutionProgress || 'Resolving'}
                      </>
                    ) : (
                      'Add to queue'
                    )}
                  </Button>
                </div>
                {importNote && (
                  <p className="text-xs text-success" aria-live="polite">
                    {importNote}
                  </p>
                )}
                {localError && (
                  <p
                    className="border border-error bg-error-soft p-3 text-xs text-error"
                    role="alert"
                  >
                    {localError}
                  </p>
                )}
              </div>

              {accountData.length > 0 && (
                <div className="mt-7 border-t border-hairline pt-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="tg-label">From this network</p>
                    <span className="text-[10px] text-text-subtle">
                      Add known members without copying an address
                    </span>
                  </div>
                  <div className="relative mt-3">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" />
                    <Input
                      value={memberSearch}
                      onChange={(event) => setMemberSearch(event.target.value)}
                      placeholder="Search ENS or address"
                      aria-label="Search network members"
                      className="pl-9"
                    />
                  </div>
                  <div className="mt-2 divide-y divide-hairline border border-hairline">
                    {matchingMembers.length > 0 ? (
                      matchingMembers.map((member) => (
                        <button
                          key={member.account}
                          type="button"
                          className="flex min-h-11 w-full items-center justify-between gap-4 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
                          onClick={() =>
                            addMember(member.account, member.ensName)
                          }
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-xs text-text">
                              {member.ensName || shortAddress(member.account)}
                            </span>
                            {member.ensName && (
                              <span className="mt-0.5 block text-[10px] text-text-subtle">
                                {shortAddress(member.account)}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
                            Add
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-5 text-center text-xs text-text-subtle">
                        No unselected members match.
                      </p>
                    )}
                  </div>
                </div>
              )}

              <RecipientQueue
                recipients={recipients}
                existingRecipientAddresses={existingRecipientAddresses}
                onRemove={removeRecipient}
                onConfidenceChange={setRecipientConfidence}
              />
            </section>

            <section className="bg-surface p-5 sm:p-7">
              <p className="tg-marker">02 / Vouch settings</p>
              <h4 className="mt-2 text-base text-text">Set the baseline</h4>

              <div className="mt-5 border border-hairline bg-surface-2 p-4">
                <p className="tg-label">Network criteria</p>
                <Markdown className="mt-3 text-xs leading-relaxed text-text-muted">
                  {network.criteria}
                </Markdown>
              </div>

              <label className="mt-5 flex cursor-pointer items-start gap-3 border-y border-hairline py-4">
                <Checkbox
                  checked={endorsed}
                  onCheckedChange={(checked) => setEndorsed(checked === true)}
                  className="mt-0.5"
                  aria-label="Confirm every recipient meets the network criteria"
                />
                <span className="text-xs leading-relaxed text-text">
                  I confirm that every account in this batch meets the network
                  criteria.
                </span>
              </label>

              <div className="mt-5">
                <div className="flex items-end justify-between gap-4">
                  <span className="tg-label-strong">Set every score</span>
                  <span className="tg-display text-3xl tabular-nums text-text">
                    {batchConfidence}%
                  </span>
                </div>
                <Slider
                  value={batchConfidence}
                  onValueChange={setEveryConfidence}
                  ariaLabel="Set the confidence score for every vouch"
                  ariaValueText={`${batchConfidence}% confident for every vouch`}
                  className="mt-2"
                />
                <p className="mt-1 text-[10px] leading-relaxed text-text-subtle">
                  This sets the whole queue. Fine-tune individual scores beside
                  each recipient.
                </p>
              </div>

              <div className="mt-5">
                <label className="tg-label-strong" htmlFor="batch-comment">
                  Shared comment{' '}
                  <span className="text-text-subtle">/ optional</span>
                </label>
                <Textarea
                  id="batch-comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Why do these accounts belong in this network?"
                  className="mt-2 min-h-24"
                />
              </div>

              <div className="mt-6 border-l border-ink pl-4 text-xs leading-relaxed text-text-muted">
                {isRelayEnabled ? (
                  <>
                    Gasless relay is on. Your wallet will sign one exact EAS
                    message per recipient; the relay submits them together.
                  </>
                ) : (
                  <>
                    Your wallet will confirm one transaction containing{' '}
                    {recipients.length > 0
                      ? `${recipients.length} vouch${recipients.length === 1 ? '' : 'es'}`
                      : 'every vouch in the queue'}
                    .
                  </>
                )}
                {network.offchainLane && (
                  <span className="mt-2 block text-text-subtle">
                    Batch vouches use this network’s on-chain EAS lane.
                  </span>
                )}
              </div>

              <Button
                type="button"
                size="lg"
                className="mt-6 w-full"
                disabled={recipients.length === 0 || !endorsed}
                onClick={moveToReview}
              >
                Review {recipients.length || ''} vouch
                {recipients.length === 1 ? '' : 'es'}
                <ArrowRight />
              </Button>
            </section>
          </div>
        )}

        {stage === 'review' && (
          <div className="p-5 sm:p-7">
            <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <section>
                <p className="tg-marker">03 / Review</p>
                <h4 className="tg-display mt-2 text-2xl text-text sm:text-3xl">
                  {recipients.length} distinct edge
                  {recipients.length === 1 ? '' : 's'}. Individually weighted.
                </h4>
                <p className="mt-3 max-w-2xl text-sm text-text-muted">
                  Check every destination. A new vouch replaces your current
                  vouch for that recipient; older history remains visible.
                </p>

                <div className="mt-6 divide-y divide-hairline border-y border-hairline">
                  {recipients.map((recipient, index) => (
                    <div
                      key={recipient.address}
                      className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 py-3"
                    >
                      <span className="text-[10px] tabular-nums text-text-subtle">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs text-text">
                          {recipient.label || shortAddress(recipient.address)}
                        </span>
                        {recipient.label && (
                          <>
                            <span className="mt-0.5 block font-mono text-[10px] text-text-subtle sm:hidden">
                              {shortAddress(recipient.address)}
                            </span>
                            <span className="mt-0.5 hidden truncate font-mono text-[10px] text-text-subtle sm:block">
                              {recipient.address}
                            </span>
                          </>
                        )}
                      </span>
                      <span className="text-xs tabular-nums text-text-muted">
                        {recipient.confidence}%
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <aside className="h-fit border border-hairline bg-surface-2 p-5">
                <p className="tg-label">Statement</p>
                <p className="tg-display mt-3 text-2xl text-text">
                  {confidenceSummary(recipients)}
                </p>
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-text-muted">
                  {comment || 'No additional comment.'}
                </p>
                <dl className="mt-6 space-y-3 border-t border-hairline pt-4 text-xs">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-subtle">Recipients</dt>
                    <dd className="tabular-nums text-text">
                      {recipients.length}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-subtle">Schema</dt>
                    <dd className="text-text">Vouching</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-subtle">Submission</dt>
                    <dd className="text-right text-text">
                      {isRelayEnabled ? 'Gasless relay' : 'One transaction'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-subtle">Failure mode</dt>
                    <dd className="text-text">All or nothing</dd>
                  </div>
                </dl>
              </aside>
            </div>

            {(localError || error) && (
              <p
                className="mt-6 border border-error bg-error-soft p-3 text-xs text-error"
                role="alert"
              >
                {localError || error}
              </p>
            )}

            <div className="mt-7 flex flex-col-reverse gap-3 border-t border-hairline pt-5 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStage('compose')}
                disabled={isCreating || isResolving}
              >
                <ArrowLeft />
                Back to edit
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={() => void submit()}
                disabled={isCreating || isResolving}
              >
                {isCreating || isResolving ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    {resolutionProgress ||
                      (isRelayEnabled ? 'Collecting signatures' : 'Submitting')}
                  </>
                ) : isRelayEnabled ? (
                  `Sign ${recipients.length} & relay`
                ) : (
                  `Confirm ${recipients.length} vouches`
                )}
              </Button>
            </div>
          </div>
        )}

        {stage === 'success' && (
          <div className="p-7 sm:p-10">
            <div className="mx-auto max-w-xl text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center border border-success text-success">
                <Check className="h-5 w-5" />
              </span>
              <p className="tg-label mt-6">Batch accepted</p>
              <h4 className="tg-display mt-2 text-3xl text-text sm:text-4xl">
                {submittedCount} new vouch{submittedCount === 1 ? '' : 'es'} are
                on their way into the graph.
              </h4>
              <p className="mt-4 text-sm leading-relaxed text-text-muted">
                The attestations are durable now. Scores will reflect them after
                the next verified update.
              </p>
              {hash && (
                <p className="mt-5 break-all border-y border-hairline py-3 font-mono text-[10px] text-text-subtle">
                  {hash}
                </p>
              )}
              <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
                <Button type="button" variant="outline" onClick={reset}>
                  Start another batch
                </Button>
                <Button type="button" onClick={close}>
                  Return to graph
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

function BatchSteps({ stage }: { stage: Stage }) {
  const current = stage === 'compose' ? 1 : stage === 'review' ? 2 : 3
  const steps = ['Compose', 'Review', 'Complete']

  return (
    <ol className="m-0 grid list-none grid-cols-3 border-b border-hairline p-0">
      {steps.map((label, index) => {
        const number = index + 1
        const active = number === current
        const complete = number < current
        return (
          <li
            key={label}
            className={cn(
              'flex items-center gap-2 border-r border-hairline px-3 py-2.5 text-[10px] uppercase tracking-wider last:border-r-0 sm:px-5',
              active ? 'bg-ink text-ink-fg' : 'text-text-subtle',
              complete && 'text-success'
            )}
            aria-current={active ? 'step' : undefined}
          >
            <span className="tabular-nums">0{number}</span>
            <span>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function RecipientQueue({
  recipients,
  existingRecipientAddresses,
  onRemove,
  onConfidenceChange,
}: {
  recipients: BatchRecipient[]
  existingRecipientAddresses: Set<string>
  onRemove: (address: Address) => void
  onConfidenceChange: (address: Address, confidence: number) => void
}) {
  if (recipients.length === 0) {
    return (
      <div className="mt-7 border border-dashed border-hairline-strong px-4 py-8 text-center">
        <p className="text-xs text-text-muted">The recipient queue is empty.</p>
        <p className="mt-1 text-[10px] text-text-subtle">
          Paste accounts or choose members above.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-7">
      <div className="flex items-end justify-between gap-3">
        <p className="tg-label">Recipient queue</p>
        <p className="text-[10px] text-text-subtle">Confidence / 0–100</p>
      </div>
      <div className="mt-3 divide-y divide-hairline border-y border-hairline">
        {recipients.map((recipient, index) => {
          const updatesExisting = existingRecipientAddresses.has(
            recipient.address.toLowerCase()
          )
          return (
            <div
              key={recipient.address}
              className="grid grid-cols-[2rem_minmax(0,1fr)_4.75rem_2.75rem] items-center gap-2 py-2"
            >
              <span className="text-[10px] tabular-nums text-text-subtle">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs text-text">
                  {recipient.label || shortAddress(recipient.address)}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-subtle">
                  {recipient.label && (
                    <span>{shortAddress(recipient.address)}</span>
                  )}
                  {updatesExisting && (
                    <span className="text-warn">
                      Updates your current vouch
                    </span>
                  )}
                </span>
              </span>
              <label className="flex items-center justify-end gap-1 text-[10px] text-text-muted">
                <span className="sr-only">
                  Confidence for {recipient.label || recipient.address}
                </span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={recipient.confidence}
                  onChange={(event) => {
                    const nextConfidence = event.currentTarget.valueAsNumber
                    if (Number.isFinite(nextConfidence)) {
                      onConfidenceChange(recipient.address, nextConfidence)
                    }
                  }}
                  className="h-8 w-14 px-2 text-right text-xs"
                />
                <span aria-hidden="true">%</span>
              </label>
              <button
                type="button"
                aria-label={`Remove ${recipient.label || recipient.address}`}
                className="flex h-11 w-11 items-center justify-center text-text-subtle transition-colors hover:bg-error-soft hover:text-error focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
                onClick={() => onRemove(recipient.address)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
