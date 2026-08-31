'use client'

import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/Button'
import { CopyableText } from '@/components/CopyableText'
import { GovernanceActionEditor } from '@/components/GovernanceActionEditor'
import { ProposalActionList } from '@/components/ProposalActionList'
import { VoteButtons } from '@/components/VoteButtons'
import { useNetwork } from '@/contexts/NetworkContext'
import { useEnsResolver } from '@/hooks/useEns'
import { type ProposalAction, VoteType } from '@/hooks/useGovernance'
import {
  type GovernanceActionDraft,
  type GovernanceComposerActionKey,
  defaultGovernanceActionValues,
  encodeGovernanceActionDraft,
  governanceActionContextFor,
  governanceComposerActionAvailable,
  governanceComposerDefinition,
  governanceComposerRegistry,
  isGovernanceComposerActionKey,
} from '@/lib/actions'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'
import type { GovernancePrefill } from '@/lib/governance-prefill'
import { formatBigNumber } from '@/lib/utils'

import { Card } from './Card'
import { Switch } from './Switch'

type DraftEntry = GovernanceActionDraft & { id: number }

const inputClassName =
  'w-full rounded-md border border-input bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20'

const categoryLabels: Record<string, string> = {
  treasury: 'Treasury',
  scoring: 'Scoring',
  network: 'Network',
  safety: 'Safety',
  custom: 'Custom',
}

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
  prefill?: GovernancePrefill | null
}

export function CreateProposalForm({
  canCreateProposal,
  userVotingPower,
  onCreateProposal,
  isLoading = false,
  prefill,
}: CreateProposalFormProps) {
  const { network } = useNetwork()
  const resolveAccountIdentifier = useEnsResolver()
  const nextDraftId = useRef(0)
  const entries = useCallback(
    (actions: readonly GovernanceActionDraft[]): DraftEntry[] =>
      actions.map((action) => ({ ...action, id: ++nextDraftId.current })),
    []
  )

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(prefill?.title ?? '')
  const [description, setDescription] = useState(prefill?.description ?? '')
  const [castVoteOnCreate, setCastVoteOnCreate] = useState(false)
  const [voteType, setVoteType] = useState<VoteType>(VoteType.Yes)
  const [drafts, setDrafts] = useState<DraftEntry[]>(() =>
    entries(prefill?.actions ?? [])
  )
  const [pickerKey, setPickerKey] =
    useState<GovernanceComposerActionKey>('send-eth')
  const [previewActions, setPreviewActions] = useState<ProposalAction[]>([])
  const [previewError, setPreviewError] = useState<string | null>(null)

  const actionContext = useMemo(
    () => governanceActionContextFor(network),
    [network]
  )
  const availableDefinitions = useMemo(
    () =>
      governanceComposerRegistry.filter((definition) =>
        governanceComposerActionAvailable(definition.key, actionContext)
      ),
    [actionContext]
  )
  const definitionsByCategory = useMemo(() => {
    const grouped = new Map<string, typeof availableDefinitions>()
    for (const definition of availableDefinitions) {
      grouped.set(definition.category, [
        ...(grouped.get(definition.category) ?? []),
        definition,
      ])
    }
    return [...grouped.entries()]
  }, [availableDefinitions])

  useEffect(() => {
    if (!prefill) return
    setTitle(prefill.title)
    setDescription(prefill.description)
    setDrafts(entries(prefill.actions))
  }, [entries, prefill])

  const encodeDrafts = useCallback(async () => {
    const actions: ProposalAction[] = []
    for (let index = 0; index < drafts.length; index++) {
      try {
        actions.push(
          ...(await encodeGovernanceActionDraft(
            drafts[index]!,
            actionContext,
            resolveAccountIdentifier
          ))
        )
      } catch (draftError) {
        const message =
          draftError instanceof Error
            ? draftError.message
            : getAccountIdentifierErrorMessage(draftError)
        throw new Error(`Action ${index + 1}: ${message}`)
      }
    }
    return actions
  }, [actionContext, drafts, resolveAccountIdentifier])

  useEffect(() => {
    let cancelled = false
    if (drafts.length === 0) {
      setPreviewActions([])
      setPreviewError(null)
      return
    }
    void encodeDrafts()
      .then((actions) => {
        if (cancelled) return
        setPreviewActions(actions)
        setPreviewError(null)
      })
      .catch((previewFailure) => {
        if (cancelled) return
        setPreviewActions([])
        setPreviewError(
          previewFailure instanceof Error
            ? previewFailure.message
            : 'Complete the action fields to preview the encoded calls.'
        )
      })
    return () => {
      cancelled = true
    }
  }, [drafts.length, encodeDrafts])

  const proposalJson = useMemo(
    () =>
      previewError
        ? null
        : JSON.stringify(
            {
              title,
              description,
              targets: previewActions.map((action) => action.target),
              values: previewActions.map((action) => action.value),
              calldatas: previewActions.map((action) => action.data),
              operations: previewActions.map((action) => action.operation),
              actionDescriptions: previewActions.map(
                (action) => action.description ?? ''
              ),
            },
            null,
            2
          ),
    [description, previewActions, previewError, title]
  )

  const addDraft = () =>
    setDrafts((current) => [
      ...current,
      {
        id: ++nextDraftId.current,
        actionKey: pickerKey,
        values: defaultGovernanceActionValues(pickerKey),
      },
    ])

  const removeDraft = (index: number) =>
    setDrafts((current) =>
      current.filter((_, itemIndex) => itemIndex !== index)
    )

  const moveDraft = (index: number, direction: -1 | 1) =>
    setDrafts((current) => {
      const destination = index + direction
      if (destination < 0 || destination >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(destination, 0, moved!)
      return next
    })

  const updateDraft = (index: number, values: unknown) =>
    setDrafts((current) =>
      current.map((draft, itemIndex) =>
        itemIndex === index ? { ...draft, values } : draft
      )
    )

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!onCreateProposal || !canCreateProposal) {
        setError('You need voting power in this network to create a proposal')
        return
      }
      if (!title.trim()) {
        setError('Title is required')
        return
      }
      if (!description.trim()) {
        setError('Description is required')
        return
      }

      setIsSubmitting(true)
      setError(null)
      try {
        const actions = await encodeDrafts()
        const hash = await onCreateProposal(
          title,
          description,
          actions,
          castVoteOnCreate ? voteType : null
        )
        if (!hash) {
          setError('The transaction was not confirmed')
          return
        }
        setTitle('')
        setDescription('')
        setCastVoteOnCreate(false)
        setVoteType(VoteType.Yes)
        setDrafts([])
      } catch (submitError) {
        setError(
          `Failed to create proposal: ${submitError instanceof Error ? submitError.message : 'Unknown error'}`
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [
      canCreateProposal,
      castVoteOnCreate,
      description,
      encodeDrafts,
      onCreateProposal,
      title,
      voteType,
    ]
  )

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Submit a proposal for the network to vote on. Add typed on-chain
        actions, or leave the proposal empty for a signal vote.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <div className="text-sm font-medium text-destructive">{error}</div>
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
            onChange={(event) => setTitle(event.target.value)}
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
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is being decided, and why it matters"
            className={`${inputClassName} min-h-24 p-3`}
            required
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">On-chain actions</p>
            <p className="text-xs text-muted-foreground">
              Actions execute in this order if the proposal passes. Every edit
              is re-encoded into the preview below.
            </p>
          </div>

          {prefill && (
            <div className="border border-success/40 bg-success-soft p-4 text-sm">
              <p className="font-medium">Editable action draft loaded</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Review or change the typed values here. The exact Safe calls and
                portable proposal JSON update automatically.
              </p>
            </div>
          )}

          {drafts.map((draft, index) => {
            const definition = governanceComposerDefinition(draft.actionKey)
            return (
              <Card
                key={draft.id}
                type="detail"
                size="md"
                className="space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {categoryLabels[definition?.category ?? 'custom']} ·
                      Action {index + 1}
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {definition?.label ?? draft.actionKey}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {definition?.summary}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => moveDraft(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move action ${index + 1} up`}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => moveDraft(index, 1)}
                      disabled={index === drafts.length - 1}
                      aria-label={`Move action ${index + 1} down`}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      onClick={() => removeDraft(index)}
                      variant="destructive"
                      size="xs"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <GovernanceActionEditor
                  draft={draft}
                  onChange={(values) => updateDraft(index, values)}
                />
              </Card>
            )
          })}

          <div className="flex flex-col gap-2 border border-border bg-muted/20 p-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <label className="text-xs font-medium" htmlFor="action-picker">
                Add an action
              </label>
              <select
                id="action-picker"
                value={pickerKey}
                onChange={(event) => {
                  if (isGovernanceComposerActionKey(event.target.value)) {
                    setPickerKey(event.target.value)
                  }
                }}
                className={inputClassName}
              >
                {definitionsByCategory.map(([category, definitions]) => (
                  <optgroup
                    key={category}
                    label={categoryLabels[category] ?? category}
                  >
                    {definitions.map((definition) => (
                      <option key={definition.key} value={definition.key}>
                        {definition.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <Button type="button" onClick={addDraft} size="sm">
              + Add action
            </Button>
          </div>

          {drafts.length > 0 && (
            <div className="space-y-3 border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">Live encoded preview</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This is the exact ordered transaction span voters will review.
                </p>
              </div>
              {previewError ? (
                <p className="border border-border bg-surface-2 p-3 text-xs text-muted-foreground">
                  {previewError}
                </p>
              ) : (
                <ProposalActionList actions={previewActions} />
              )}
              {proposalJson && (
                <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Portable JSON includes the exact target, value, operation,
                    calldata, and description arrays.
                  </p>
                  <CopyableText
                    text={proposalJson}
                    displayText="Copy DAO proposal JSON"
                    truncate={false}
                    truncateOnMobile={false}
                    alwaysShowCopyIcon
                    className="min-h-11 shrink-0 border border-border px-3 py-2"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
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
            onSelect={(nextVote) => {
              setVoteType(nextVote)
              setCastVoteOnCreate(true)
            }}
          />
        </div>

        <div className="border-t border-border pt-4">
          {prefill && !canCreateProposal && (
            <p className="mb-3 border border-border bg-surface-2 p-3 text-xs text-muted-foreground">
              The draft remains editable and its calldata is copyable above.
              Submission needs a connected wallet with current voting power in
              this DAO.
            </p>
          )}
          <Button
            type="submit"
            disabled={isSubmitting || isLoading || !canCreateProposal}
            className="w-full px-4 py-2"
          >
            {isSubmitting
              ? 'Submitting...'
              : canCreateProposal
                ? 'Submit DAO proposal'
                : 'Eligible member wallet required'}
          </Button>
        </div>
      </form>
    </div>
  )
}
