'use client'

import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Hex,
  isAddress,
  keccak256,
  parseEventLogs,
  stringToBytes,
  zeroAddress,
  zeroHash,
} from 'viem'
import { useAccount } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { Modal } from '@/components/Modal'
import { useAttestation } from '@/hooks/useAttestation'
import { easAbi } from '@/lib/contract-abis'
import { ContributionsRound } from '@/lib/contributions-api'
import { NOMINEE_RESPONSE_COPY } from '@/lib/contributions-copy'
import { ClaimView } from '@/lib/contributions-view'
import { ContributionsNetwork } from '@/lib/types'

type SubmitTab = 'your-work' | 'nominate'
type ContributorRow = { address: string; share: string }

export interface OptimisticContribution {
  claim: ClaimView
}

export const matchesOptimisticContribution = (
  claim: ClaimView,
  optimistic: OptimisticContribution
) => claim.uid.toLowerCase() === optimistic.claim.uid.toLowerCase()

interface SubmitContributionModalProps {
  isOpen: boolean
  onClose: () => void
  network: ContributionsNetwork
  round: ContributionsRound | null
  claimSchemaUid?: Hex
  onSubmitted: (contribution: OptimisticContribution) => void
}

const emptyNominee = (): ContributorRow => ({ address: '', share: '100' })

/**
 * The round's single submission flow. Self-submission stays on the short path, while nomination
 * is an explicit mode whose contributor list can never include the connected wallet.
 */
export const SubmitContributionModal = ({
  isOpen,
  onClose,
  network,
  round,
  claimSchemaUid,
  onSubmitted,
}: SubmitContributionModalProps) => {
  const { address: connectedAddress, isConnected } = useAccount()
  const { createAttestation, isCreating } = useAttestation()

  const [tab, setTab] = useState<SubmitTab>('your-work')
  const [title, setTitle] = useState('')
  const [uri, setUri] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [contributors, setContributors] = useState<ContributorRow[]>([])
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setTab('your-work')
    setTitle('')
    setUri('')
    setFingerprint('')
    setContributors([{ address: connectedAddress ?? '', share: '100' }])
    setFormError(null)
  }, [connectedAddress, isOpen])

  const windowClosed = useMemo(() => {
    if (!round) return false
    const now = BigInt(Math.floor(Date.now() / 1000))
    return now > BigInt(round.window.end) || now < BigInt(round.window.start)
  }, [round])

  const switchTab = (nextTab: SubmitTab) => {
    setTab(nextTab)
    setFormError(null)
    setContributors(
      nextTab === 'your-work'
        ? [{ address: connectedAddress ?? '', share: '100' }]
        : [emptyNominee()]
    )
  }

  const updateRow = (index: number, patch: Partial<ContributorRow>) =>
    setContributors((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row
      )
    )

  const addContributor = () =>
    setContributors((rows) => [...rows, { address: '', share: '100' }])

  const removeContributor = (index: number) =>
    setContributors((rows) => rows.filter((_, rowIndex) => rowIndex !== index))

  const totalShares = contributors.reduce(
    (sum, row) => sum + (parseInt(row.share, 10) || 0),
    0
  )

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    if (!claimSchemaUid) {
      setFormError('This round is missing its contribution schema.')
      return
    }
    if (!title.trim()) {
      setFormError('Give the contribution a title.')
      return
    }
    const cleaned = contributors
      .map((row) => ({
        address: row.address.trim(),
        share: parseInt(row.share, 10),
      }))
      .filter((row) => row.address !== '')
    if (cleaned.length === 0) {
      setFormError('Name at least one contributor.')
      return
    }
    for (const row of cleaned) {
      if (!isAddress(row.address)) {
        setFormError(`"${row.address}" is not a valid wallet address.`)
        return
      }
      if (!Number.isInteger(row.share) || row.share < 0) {
        setFormError('Shares must be whole numbers (0 or more).')
        return
      }
    }
    if (!cleaned.some((row) => row.share > 0)) {
      setFormError('At least one contributor needs a share above zero.')
      return
    }
    if (
      tab === 'nominate' &&
      connectedAddress &&
      cleaned.some(
        (row) => row.address.toLowerCase() === connectedAddress.toLowerCase()
      )
    ) {
      setFormError(
        'Your connected wallet cannot be included when you nominate someone.'
      )
      return
    }

    // The content fingerprint: a 32-byte hash as-is, anything else gets hashed for them,
    // empty = no fingerprint.
    const contentHash =
      fingerprint.trim() === ''
        ? zeroHash
        : /^0x[0-9a-fA-F]{64}$/.test(fingerprint.trim())
          ? (fingerprint.trim() as Hex)
          : keccak256(stringToBytes(fingerprint.trim()))

    try {
      const receipt = await createAttestation({
        schema: claimSchemaUid,
        recipient: zeroAddress,
        data: {
          title: title.trim(),
          contentHash,
          uri: uri.trim(),
          contributors: cleaned.map((row) => row.address as Hex),
          shares: cleaned.map((row) => row.share),
        },
      })
      const attested = parseEventLogs({
        abi: easAbi,
        logs: receipt.logs,
        eventName: 'Attested',
      })[0] as unknown as { args: { uid: Hex } }
      if (!attested) {
        throw new Error(
          'The contribution was submitted, but its record was not found.'
        )
      }

      const timestamp = BigInt(Math.floor(Date.now() / 1000))
      const total = cleaned.reduce((sum, row) => sum + BigInt(row.share), 0n)
      const claim: ClaimView = {
        uid: attested.args.uid,
        attester: connectedAddress as Hex,
        timestamp,
        title: title.trim(),
        uri: uri.trim(),
        contentHash,
        contributors: cleaned.map((row) => ({
          account: row.address.toLowerCase() as Hex,
          share: BigInt(row.share),
          sharePct: Number((BigInt(row.share) * 1000n) / total) / 10,
          response: 'none',
          isAttester:
            row.address.toLowerCase() === connectedAddress?.toLowerCase(),
        })),
        valuations: [],
        inWindow: round
          ? timestamp >= BigInt(round.window.start) &&
            timestamp <= BigInt(round.window.end)
          : null,
      }
      onSubmitted({ claim })
      onClose()
    } catch {
      // The attestation hook already surfaced transaction errors via toast. Keep the form open.
    }
  }

  const shareEditor = contributors.length > 1

  return (
    <Modal
      isOpen={isOpen}
      onClose={isCreating ? undefined : onClose}
      title="Submit contribution"
      className="!max-w-2xl"
      footer={
        <Button
          form="submit-contribution-form"
          type="submit"
          variant="brand"
          size="lg"
          disabled={!isConnected || isCreating}
          className="w-full"
        >
          {!isConnected
            ? 'Connect your wallet to submit'
            : isCreating
              ? 'Submitting...'
              : 'Submit contribution'}
        </Button>
      }
    >
      <form
        id="submit-contribution-form"
        onSubmit={handleSubmit}
        className="space-y-6"
      >
        <div
          role="tablist"
          aria-label="Contribution type"
          className="grid grid-cols-2 border border-hairline"
        >
          <button
            type="button"
            role="tab"
            id="your-work-tab"
            aria-controls="your-work-panel"
            aria-selected={tab === 'your-work'}
            onClick={() => switchTab('your-work')}
            className="min-h-11 border-r border-hairline px-3 text-xs uppercase tracking-wider aria-selected:bg-ink aria-selected:text-ink-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Your work
          </button>
          <button
            type="button"
            role="tab"
            id="nominate-tab"
            aria-controls="nominate-panel"
            aria-selected={tab === 'nominate'}
            onClick={() => switchTab('nominate')}
            className="min-h-11 px-3 text-xs uppercase tracking-wider aria-selected:bg-ink aria-selected:text-ink-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Nominate someone
          </button>
        </div>

        {windowClosed && (
          <Card type="outline" size="md" className="border-warn">
            <p className="text-sm text-warn">
              The round window is closed right now. You can still submit, but
              contributions outside the window won&apos;t be funded this round.
            </p>
          </Card>
        )}

        <div className="space-y-2">
          <Label htmlFor="contribution-title">What was done</Label>
          <Input
            id="contribution-title"
            placeholder="e.g. Organized the June community call"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="contribution-link">Link to the work (optional)</Label>
          <Input
            id="contribution-link"
            placeholder="https://..."
            value={uri}
            onChange={(event) => setUri(event.target.value)}
          />
          <p className="text-xs text-text-muted">
            Anything raters can check: a repo, a document, photos, a recording.
          </p>
        </div>

        {tab === 'your-work' ? (
          <div
            id="your-work-panel"
            role="tabpanel"
            aria-labelledby="your-work-tab"
          >
            <details className="group border border-hairline">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                Add collaborators
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
              </summary>
              <div className="space-y-5 border-t border-hairline p-4">
                <p className="text-sm text-text-muted">
                  Add anyone who shared the work. Shares divide only this
                  contribution&apos;s payout.
                </p>

                {shareEditor && (
                  <div className="space-y-2">
                    {contributors.map((row, index) => (
                      <ContributorInput
                        key={index}
                        row={row}
                        index={index}
                        totalShares={totalShares}
                        isConnectedWallet={index === 0}
                        onChange={updateRow}
                        onRemove={removeContributor}
                      />
                    ))}
                  </div>
                )}

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={addContributor}
                >
                  <Plus />
                  Add collaborator
                </Button>

                <FingerprintField
                  value={fingerprint}
                  onChange={setFingerprint}
                />
              </div>
            </details>
          </div>
        ) : (
          <div
            id="nominate-panel"
            role="tabpanel"
            aria-labelledby="nominate-tab"
            className="space-y-5"
          >
            <Card type="outline" size="md" className="space-y-2">
              <p className="text-sm font-medium">
                Give credit to work done by someone else.
              </p>
              <p className="text-sm text-text-muted">
                Your wallet is excluded from this list. {NOMINEE_RESPONSE_COPY}
              </p>
            </Card>

            <div className="space-y-3">
              <Label>Who did the work</Label>
              <div className="space-y-2">
                {contributors.map((row, index) => (
                  <ContributorInput
                    key={index}
                    row={row}
                    index={index}
                    totalShares={totalShares}
                    onChange={updateRow}
                    onRemove={removeContributor}
                    canRemove={contributors.length > 1}
                  />
                ))}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addContributor}
              >
                <Plus />
                Add nominee
              </Button>
            </div>

            <details className="group border border-hairline">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                Add a content fingerprint
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
              </summary>
              <div className="border-t border-hairline p-4">
                <FingerprintField
                  value={fingerprint}
                  onChange={setFingerprint}
                />
              </div>
            </details>
          </div>
        )}

        {formError && (
          <p className="text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <p className="text-xs text-text-muted">
          Submitting publishes this contribution on-chain for everyone in the
          round to see and rate. You can revoke it later, but the history stays
          public.
        </p>
        <span className="sr-only">Round: {network.name}</span>
      </form>
    </Modal>
  )
}

const ContributorInput = ({
  row,
  index,
  totalShares,
  isConnectedWallet = false,
  canRemove = true,
  onChange,
  onRemove,
}: {
  row: ContributorRow
  index: number
  totalShares: number
  isConnectedWallet?: boolean
  canRemove?: boolean
  onChange: (index: number, patch: Partial<ContributorRow>) => void
  onRemove: (index: number) => void
}) => (
  <div className="grid grid-cols-[minmax(0,1fr)_5rem_2.25rem] items-center gap-2">
    <Input
      aria-label={isConnectedWallet ? 'Your wallet' : 'Contributor wallet'}
      className="min-w-0 font-mono"
      placeholder="0x... wallet address"
      value={row.address}
      disabled={isConnectedWallet}
      onChange={(event) => onChange(index, { address: event.target.value })}
    />
    <div className="min-w-0">
      <Input
        aria-label="Share"
        type="number"
        min={0}
        placeholder="Share"
        value={row.share}
        onChange={(event) => onChange(index, { share: event.target.value })}
      />
      <span className="mt-1 block text-right text-[10px] text-text-muted">
        {totalShares > 0 && parseInt(row.share, 10) > 0
          ? `${Math.round((parseInt(row.share, 10) / totalShares) * 100)}%`
          : '0%'}
      </span>
    </div>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Remove contributor"
      onClick={() => onRemove(index)}
      disabled={!canRemove || isConnectedWallet}
    >
      <Trash2 />
    </Button>
  </div>
)

const FingerprintField = ({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) => (
  <div className="space-y-2">
    <Label htmlFor="contribution-fingerprint">
      Content fingerprint (optional)
    </Label>
    <Input
      id="contribution-fingerprint"
      placeholder="Paste a file hash, or any text to fingerprint"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
    <p className="text-xs text-text-muted">
      A permanent fingerprint proves what the link pointed at even if it later
      changes. Text that is not already a hash is stored as a hash.
    </p>
  </div>
)
