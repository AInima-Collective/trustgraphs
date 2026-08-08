'use client'

import type React from 'react'
import { useCallback, useState } from 'react'
import { type Address, formatEther, isAddress, parseEther } from 'viem'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import { Button } from '@/components/Button'
import { VoteButtons } from '@/components/VoteButtons'
import { useEnsResolver } from '@/hooks/useEns'
import { ProposalAction, VoteType } from '@/hooks/useGovernance'
import { parseAccountIdentifier } from '@/lib/ens'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'
import { formatBigNumber } from '@/lib/utils'

import { Card } from './Card'
import { Switch } from './Switch'

/**
 * A draft action is either the common case (send ETH from the treasury,
 * amount in ETH, no calldata) or a custom contract call for people who know
 * what calldata is. The wei conversion happens exactly once, on submit, so
 * the unit a user types is the unit the chain gets.
 */
type DraftAction =
  | {
      kind: 'sendEth'
      recipient: string
      amountEth: string
      previewAddress?: Address | null
    }
  | {
      kind: 'custom'
      target: string
      valueEth: string
      data: string
      operation: number
      description: string
    }

const newSendEth = (): DraftAction => ({
  kind: 'sendEth',
  recipient: '',
  amountEth: '',
})

const newCustom = (): DraftAction => ({
  kind: 'custom',
  target: '',
  valueEth: '0',
  data: '0x',
  operation: 0,
  description: '',
})

const inputClassName =
  'w-full bg-background border border-input rounded-md p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20'

interface CreateProposalFormProps {
  canCreateProposal: boolean
  userVotingPower?: string
  onCreateProposal?: (
    title: string,
    description: string,
    actions: ProposalAction[],
    voteType?: VoteType | null
  ) => Promise<string | null>
  isLoading?: boolean
}

export function CreateProposalForm({
  canCreateProposal,
  userVotingPower,
  onCreateProposal,
  isLoading = false,
}: CreateProposalFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [castVoteOnCreate, setCastVoteOnCreate] = useState(false)
  const [voteType, setVoteType] = useState<VoteType>(VoteType.Yes)
  const [drafts, setDrafts] = useState<DraftAction[]>([])
  const resolveAccountIdentifier = useEnsResolver()

  const addDraft = useCallback((draft: DraftAction) => {
    setDrafts((prev) => [...prev, draft])
  }, [])

  const removeDraft = useCallback((index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const updateDraft = useCallback(
    (index: number, patch: Partial<DraftAction>) => {
      setDrafts((prev) =>
        prev.map((draft, i) =>
          i === index ? ({ ...draft, ...patch } as DraftAction) : draft
        )
      )
    },
    []
  )

  /** Validate drafts and convert them to on-chain actions (values in wei). */
  const buildActions = async (): Promise<{
    actions?: ProposalAction[]
    error?: string
  }> => {
    if (!title.trim()) return { error: 'Title is required' }
    if (!description.trim()) return { error: 'Description is required' }

    const actions: ProposalAction[] = []

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i]
      const label = `Action ${i + 1}`

      if (draft.kind === 'sendEth') {
        const parsed = parseAccountIdentifier(draft.recipient)
        if (parsed.kind !== 'address' && parsed.kind !== 'ens') {
          return {
            error: `${label}: enter a valid recipient address or ENS name`,
          }
        }
        if (parsed.kind === 'ens' && !draft.previewAddress) {
          return { error: `${label}: wait for ${parsed.name} to resolve` }
        }
        let wei: bigint
        try {
          wei = parseEther(draft.amountEth)
        } catch {
          return { error: `${label}: enter the ETH amount as a number` }
        }
        if (wei <= 0n) {
          return { error: `${label}: the ETH amount must be more than zero` }
        }
        let resolved
        try {
          resolved = await resolveAccountIdentifier(
            draft.recipient,
            draft.previewAddress
          )
        } catch (error) {
          return {
            error: `${label}: ${getAccountIdentifierErrorMessage(error)}`,
          }
        }
        actions.push({
          target: resolved.address,
          value: wei.toString(),
          data: '0x',
          operation: 0,
          description: `Send ${formatEther(wei)} ETH to ${
            resolved.ensName
              ? `${resolved.ensName} (${resolved.address})`
              : resolved.address
          }`,
        })
      } else {
        if (!isAddress(draft.target)) {
          return { error: `${label}: enter a valid target address` }
        }
        if (!draft.description.trim()) {
          return { error: `${label}: describe what this call does` }
        }
        let wei: bigint
        try {
          wei = parseEther(draft.valueEth || '0')
        } catch {
          return { error: `${label}: enter the ETH value as a number` }
        }
        actions.push({
          target: draft.target,
          value: wei.toString(),
          data: draft.data || '0x',
          operation: draft.operation,
          description: draft.description,
        })
      }
    }

    return { actions }
  }

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()

      if (!onCreateProposal || !canCreateProposal) {
        setError('You need voting power in this network to create a proposal')
        return
      }

      setIsSubmitting(true)
      setError(null)

      let built: Awaited<ReturnType<typeof buildActions>>
      try {
        built = await buildActions()
      } catch (buildError) {
        setError(getAccountIdentifierErrorMessage(buildError))
        setIsSubmitting(false)
        return
      }
      if (built.error || !built.actions) {
        setError(built.error ?? 'Invalid proposal')
        setIsSubmitting(false)
        return
      }

      try {
        const hash = await onCreateProposal(
          title,
          description,
          built.actions,
          castVoteOnCreate ? voteType : null
        )

        if (hash) {
          setTitle('')
          setDescription('')
          setCastVoteOnCreate(false)
          setVoteType(VoteType.Yes)
          setDrafts([])
        } else {
          setError('The transaction was not confirmed')
        }
      } catch (err: unknown) {
        console.error('Error in handleSubmit:', err)
        setError(
          `Failed to create proposal: ${err instanceof Error ? err.message : 'Unknown error'}`
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [
      onCreateProposal,
      canCreateProposal,
      drafts,
      title,
      description,
      castVoteOnCreate,
      voteType,
    ]
  )

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Submit a proposal for the network to vote on. It can simply put a
        question to a vote, or it can move funds when it passes.
      </p>

      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 rounded-md">
          <div className="text-destructive text-sm font-medium">{error}</div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="proposal-title">
            Title
          </label>
          <input
            id="proposal-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="A short name for the proposal"
            className={inputClassName}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="proposal-description">
            Description
          </label>
          <textarea
            id="proposal-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is being decided, and why it matters"
            className={`${inputClassName} min-h-24 p-3`}
            required
          />
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">On-chain actions</p>
            <p className="text-muted-foreground text-xs">
              What happens automatically if the proposal passes. Optional: a
              proposal with no actions is a signal vote.
            </p>
          </div>

          {drafts.map((draft, index) => (
            <Card key={index} type="detail" size="md" className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  {draft.kind === 'sendEth'
                    ? 'Send ETH from the treasury'
                    : 'Custom contract call'}
                </p>
                <Button
                  type="button"
                  onClick={() => removeDraft(index)}
                  variant="destructive"
                  size="xs"
                >
                  Remove
                </Button>
              </div>

              {draft.kind === 'sendEth' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs font-medium">
                      Recipient
                    </div>
                    <AccountIdentifierInput
                      value={draft.recipient}
                      onResolvedAddressChange={(previewAddress) =>
                        updateDraft(index, { previewAddress })
                      }
                      onChange={(e) =>
                        updateDraft(index, {
                          recipient: e.target.value,
                          previewAddress: null,
                        })
                      }
                      placeholder="0x… or name.eth"
                      className={`${inputClassName} font-mono`}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs font-medium">
                      Amount (ETH)
                    </div>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.amountEth}
                      onChange={(e) =>
                        updateDraft(index, { amountEth: e.target.value })
                      }
                      placeholder="0.0"
                      className={inputClassName}
                      required
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <div className="text-muted-foreground text-xs font-medium">
                        Target contract
                      </div>
                      <input
                        type="text"
                        value={draft.target}
                        onChange={(e) =>
                          updateDraft(index, { target: e.target.value })
                        }
                        placeholder="0x..."
                        className={`${inputClassName} font-mono`}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="text-muted-foreground text-xs font-medium">
                        Value (ETH)
                      </div>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft.valueEth}
                        onChange={(e) =>
                          updateDraft(index, { valueEth: e.target.value })
                        }
                        placeholder="0"
                        className={inputClassName}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="text-muted-foreground text-xs font-medium">
                        Operation
                      </div>
                      <select
                        value={draft.operation}
                        onChange={(e) =>
                          updateDraft(index, {
                            operation: Number(e.target.value),
                          })
                        }
                        className={inputClassName}
                      >
                        <option value={0}>Call</option>
                        <option value={1}>DelegateCall (advanced)</option>
                      </select>
                    </div>
                  </div>

                  {draft.operation === 1 && (
                    <p className="text-xs text-warn">
                      DelegateCall runs the target's code as the treasury
                      itself. Only use it if you know exactly why you need it.
                    </p>
                  )}

                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs font-medium">
                      What this call does
                    </div>
                    <input
                      type="text"
                      value={draft.description}
                      onChange={(e) =>
                        updateDraft(index, { description: e.target.value })
                      }
                      placeholder="Plain-language description voters will read"
                      className={inputClassName}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs font-medium">
                      Calldata
                    </div>
                    <textarea
                      value={draft.data}
                      onChange={(e) =>
                        updateDraft(index, { data: e.target.value })
                      }
                      placeholder="0x"
                      className={`${inputClassName} font-mono`}
                      rows={2}
                    />
                  </div>
                </>
              )}
            </Card>
          ))}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => addDraft(newSendEth())}
              variant="brand"
              size="xs"
            >
              + Send ETH
            </Button>
            <Button
              type="button"
              onClick={() => addDraft(newCustom())}
              variant="secondary"
              size="xs"
            >
              + Custom contract call
            </Button>
          </div>
        </div>

        {/* Optional initial vote (saves a transaction) */}
        <div className="border border-border bg-muted/20 p-4 rounded-md space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Cast your own vote now (optional)
            </div>
            <Switch
              enabled={castVoteOnCreate}
              onClick={() => setCastVoteOnCreate(!castVoteOnCreate)}
              size="md"
            />
          </div>

          <div className="text-xs text-muted-foreground">
            Votes with your{' '}
            {userVotingPower
              ? formatBigNumber(BigInt(userVotingPower), 18)
              : '0'}{' '}
            voting power in the same transaction.
          </div>

          <VoteButtons
            isLoading={isSubmitting || isLoading}
            selected={castVoteOnCreate ? voteType : null}
            onSelect={(vt) => {
              setVoteType(vt)
              setCastVoteOnCreate(true)
            }}
          />
        </div>

        <div className="border-t border-border pt-4">
          <Button
            type="submit"
            disabled={isSubmitting || isLoading || !canCreateProposal}
            className="w-full px-4 py-2"
          >
            {isSubmitting ? 'Submitting...' : 'Submit proposal'}
          </Button>
        </div>
      </form>
    </div>
  )
}
