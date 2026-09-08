'use client'

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Layers3,
  LoaderCircle,
  Plus,
  Shield,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'

import { Button } from '@/components/Button'
import { CopyableText } from '@/components/CopyableText'
import { GovernanceComposerProvider } from '@/components/governance/GovernanceComposerContext'
import { ProposalSimulationPanel } from '@/components/governance/ProposalSimulationPanel'
import { GovernanceActionEditor } from '@/components/GovernanceActionEditor'
import { GovernanceActionEmoji } from '@/components/GovernanceActionEmoji'
import {
  GovernanceActionLibrary,
  governanceCategoryLabels,
} from '@/components/GovernanceActionLibrary'
import { Markdown } from '@/components/Markdown'
import { ProposalActionList } from '@/components/ProposalActionList'
import { VoteButtons } from '@/components/VoteButtons'
import { useWalletConnectionContext } from '@/components/WalletConnectionProvider'
import { useNetwork } from '@/contexts/NetworkContext'
import { useEnsResolver } from '@/hooks/useEns'
import { type ProposalAction, VoteType } from '@/hooks/useGovernance'
import { useProposalSimulation } from '@/hooks/useProposalSimulation'
import {
  type GovernanceActionDraft,
  GovernanceActionFieldError,
  type GovernanceComposerActionKey,
  defaultGovernanceActionValues,
  encodeGovernanceActionDraft,
  governanceActionContextFor,
  governanceActionFields,
  governanceComposerActionAvailable,
  governanceComposerDefinition,
  governanceComposerRegistry,
  governanceDangerConsequence,
  validateGovernanceActionDraft,
} from '@/lib/actions'
import { getAccountIdentifierErrorMessage } from '@/lib/ens-query'
import type { GovernancePrefill } from '@/lib/governance-prefill'
import { cn, formatBigNumber } from '@/lib/utils'

type DraftEntry = GovernanceActionDraft & { id: number }
type ActionPreview = {
  actions: ProposalAction[]
  error: string | null
  /** The field the error belongs to, when the encoder could attribute it. */
  field?: string
}
export type ProposalDraftContent = Pick<
  GovernancePrefill,
  'title' | 'description' | 'actions'
>

const inputClassName =
  'w-full border border-hairline-strong bg-background px-3 py-3 text-sm text-text placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'

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
  onDraftChange?: (draft: ProposalDraftContent) => void
  draftStatus?: string
}

export function CreateProposalForm({
  canCreateProposal,
  userVotingPower,
  onCreateProposal,
  isLoading = false,
  prefill,
  onDraftChange,
  draftStatus,
}: CreateProposalFormProps) {
  const { network } = useNetwork()
  const { isConnected } = useAccount()
  const { openConnectWallet } = useWalletConnectionContext()
  const resolveAccountIdentifier = useEnsResolver()
  const nextDraftId = useRef(prefill?.actions.length ?? 0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(prefill?.title ?? '')
  const [description, setDescription] = useState(prefill?.description ?? '')
  const [castVoteOnCreate, setCastVoteOnCreate] = useState(false)
  const [voteType, setVoteType] = useState<VoteType>(VoteType.Yes)
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false)
  const [drafts, setDrafts] = useState<DraftEntry[]>(() =>
    (prefill?.actions ?? []).map((draft, index) => ({
      ...draft,
      id: index + 1,
    }))
  )
  const [expandedId, setExpandedId] = useState<number | null>(
    prefill?.actions.length ? 1 : null
  )
  const [step, setStep] = useState<'compose' | 'review'>('compose')
  const [attemptedReview, setAttemptedReview] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [preview, setPreview] = useState<{
    drafts: DraftEntry[]
    encoder: typeof encodeDraft
    results: ActionPreview[]
  } | null>(null)
  const [removed, setRemoved] = useState<{
    draft: DraftEntry
    index: number
  } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef<number | null>(null)
  const busy = isSubmitting || isLoading

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

  useEffect(() => {
    onDraftChange?.({
      title,
      description,
      actions: drafts.map(({ actionKey, values }) => ({ actionKey, values })),
    })
  }, [description, drafts, onDraftChange, title])

  const encodeDraft = useCallback(
    async (draft: DraftEntry): Promise<ActionPreview> => {
      try {
        return {
          actions: await encodeGovernanceActionDraft(
            draft,
            actionContext,
            resolveAccountIdentifier
          ),
          error: null,
        }
      } catch (failure) {
        return {
          actions: [],
          error:
            failure instanceof Error
              ? failure.message
              : getAccountIdentifierErrorMessage(failure),
          ...(failure instanceof GovernanceActionFieldError
            ? { field: failure.field }
            : {}),
        }
      }
    },
    [actionContext, resolveAccountIdentifier]
  )

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void Promise.all(drafts.map(encodeDraft)).then((results) => {
        if (!cancelled) setPreview({ drafts, encoder: encodeDraft, results })
      })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [drafts, encodeDraft])

  useEffect(() => {
    if (pendingFocus.current === null) return
    document.getElementById(`action-heading-${pendingFocus.current}`)?.focus()
    pendingFocus.current = null
  }, [drafts])

  const previewCurrent =
    preview?.drafts === drafts && preview?.encoder === encodeDraft
  const previewPending = drafts.length > 0 && !previewCurrent
  const results = previewCurrent ? preview.results : []
  const invalidIndex = results.findIndex((result) => result.error)
  const previewActions = results.flatMap((result) => result.actions)
  const actionsReady = !previewPending && invalidIndex === -1
  const detailsReady = !!title.trim() && !!description.trim()
  const readyCount = results.filter((result) => !result.error).length
  const highImpactCount = drafts.filter(
    (draft) => governanceComposerDefinition(draft.actionKey)?.danger
  ).length
  const simulation = useProposalSimulation(
    previewActions,
    step === 'review' && actionsReady && previewActions.length > 0
  )
  const proposalJson = actionsReady
    ? JSON.stringify(
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
      )
    : null

  const focusDraft = (id: number) => {
    setExpandedId(id)
    pendingFocus.current = id
  }

  const addDraft = (actionKey: GovernanceComposerActionKey) => {
    const id = ++nextDraftId.current
    setDrafts((current) => [
      ...current,
      { id, actionKey, values: defaultGovernanceActionValues(actionKey) },
    ])
    focusDraft(id)
    setAnnouncement(
      `${governanceComposerDefinition(actionKey)?.label} added as action ${drafts.length + 1}.`
    )
  }

  const duplicateDraft = (index: number) => {
    const id = ++nextDraftId.current
    const copy = {
      ...drafts[index]!,
      id,
      values: structuredClone(drafts[index]!.values),
    }
    setDrafts((current) => [
      ...current.slice(0, index + 1),
      copy,
      ...current.slice(index + 1),
    ])
    focusDraft(id)
    setAnnouncement(`Action ${index + 1} duplicated.`)
  }

  const removeDraft = (index: number) => {
    const draft = drafts[index]!
    setRemoved({ draft, index })
    setDrafts((current) => current.filter((item) => item.id !== draft.id))
    if (expandedId === draft.id) {
      const neighbor = drafts[index + 1] ?? drafts[index - 1]
      setExpandedId(neighbor?.id ?? null)
      pendingFocus.current = neighbor?.id ?? null
      if (!neighbor) document.getElementById('action-search')?.focus()
    }
    setAnnouncement(`Action ${index + 1} removed. Undo is available.`)
  }

  const moveDraft = (index: number, direction: -1 | 1) => {
    setDrafts((current) => {
      const destination = index + direction
      if (destination < 0 || destination >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(destination, 0, moved!)
      return next
    })
    setAnnouncement(
      `Action ${index + 1} moved to position ${index + direction + 1}.`
    )
  }

  /**
   * Problems shown beside their fields: the synchronous schema check first, then whatever the
   * encoder attributed to a field. Anything else stays an action-level message.
   */
  const fieldErrorsFor = (
    draft: DraftEntry,
    result: ActionPreview | undefined
  ): Record<string, string> => {
    const errors = validateGovernanceActionDraft(draft.actionKey, draft.values)
    if (result?.error && result.field && !errors[result.field]) {
      errors[result.field] = result.error
    }
    return errors
  }
  const actionErrorFor = (
    draft: DraftEntry,
    result: ActionPreview | undefined
  ): string | null => {
    if (!result?.error) return null
    const attributed =
      !!result.field &&
      governanceActionFields(draft.actionKey).some(
        (field) => field.key === result.field
      )
    return attributed ? null : result.error
  }

  const updateDraft = (index: number, values: unknown) =>
    setDrafts((current) =>
      current.map((draft, itemIndex) =>
        itemIndex === index ? { ...draft, values } : draft
      )
    )

  const changeStep = (next: 'compose' | 'review') => {
    setStep(next)
    setError(null)
    requestAnimationFrame(() => headingRef.current?.focus())
  }

  const reviewProposal = () => {
    setAttemptedReview(true)
    if (!detailsReady) {
      document
        .getElementById(
          !title.trim() ? 'proposal-title' : 'proposal-description'
        )
        ?.focus()
      return
    }
    if (!actionsReady) {
      if (invalidIndex >= 0) {
        setExpandedId(drafts[invalidIndex]!.id)
        document
          .getElementById(`action-heading-${drafts[invalidIndex]!.id}`)
          ?.focus()
      }
      return
    }
    changeStep('review')
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (step === 'compose') {
      reviewProposal()
      return
    }
    if (busy) return
    if (!onCreateProposal || !canCreateProposal) {
      setError(
        'Connect a wallet with voting power in this network to submit your proposal.'
      )
      return
    }
    if (!detailsReady || !actionsReady) {
      changeStep('compose')
      setAttemptedReview(true)
      return
    }
    if (highImpactCount > 0 && !dangerAcknowledged) {
      setError('Acknowledge the high-impact actions before submitting.')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      const encoded = await Promise.all(drafts.map(encodeDraft))
      const failureIndex = encoded.findIndex((result) => result.error)
      if (failureIndex >= 0)
        throw new Error(
          `Action ${failureIndex + 1}: ${encoded[failureIndex]!.error}`
        )
      const hash = await onCreateProposal(
        title,
        description,
        encoded.flatMap((result) => result.actions),
        castVoteOnCreate ? voteType : null
      )
      if (!hash)
        setError(
          'The transaction was not confirmed. Your draft is still here; you can try again.'
        )
    } catch (submitError) {
      setError(
        `Failed to create proposal: ${submitError instanceof Error ? submitError.message : 'Unknown error'}`
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <GovernanceComposerProvider drafts={drafts}>
      <form onSubmit={handleSubmit} noValidate className="space-y-8">
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
          <nav
            aria-label="Proposal steps"
            className="flex items-center gap-3 sm:gap-6"
          >
            <button
              type="button"
              aria-current={step === 'compose' ? 'step' : undefined}
              onClick={() => changeStep('compose')}
              disabled={isSubmitting}
              className={cn(
                'flex min-h-9 items-center gap-2 text-sm disabled:opacity-50',
                step !== 'compose' && 'text-text-muted'
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center border text-xs',
                  step === 'compose'
                    ? 'border-ink bg-ink text-ink-fg'
                    : 'border-border'
                )}
              >
                {step === 'review' ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  '1'
                )}
              </span>
              Compose
            </button>
            <span className="h-px w-6 bg-border sm:w-12" aria-hidden="true" />
            <button
              type="button"
              aria-current={step === 'review' ? 'step' : undefined}
              onClick={reviewProposal}
              disabled={isSubmitting || previewPending}
              className={cn(
                'flex min-h-9 items-center gap-2 text-sm disabled:opacity-50',
                step !== 'review' && 'text-text-muted'
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center border text-xs',
                  step === 'review'
                    ? 'border-ink bg-ink text-ink-fg'
                    : 'border-border'
                )}
              >
                2
              </span>
              Review & submit
            </button>
          </nav>
          {draftStatus && (
            <span role="status" className="text-xs text-text-muted">
              {draftStatus}
            </span>
          )}
        </div>

        <fieldset disabled={isSubmitting} className="min-w-0 space-y-8">
          <legend className="sr-only">Proposal builder</legend>
          <div hidden={step !== 'compose'} className="space-y-10">
            <section
              aria-labelledby="proposal-details-heading"
              className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-8"
            >
              <div className="space-y-2">
                <p className="tg-label">01 / The decision</p>
                <h3
                  id="proposal-details-heading"
                  ref={step === 'compose' ? headingRef : undefined}
                  tabIndex={-1}
                  className="text-2xl outline-none"
                >
                  Make your case.
                </h3>
                <p className="max-w-sm text-sm leading-relaxed text-text-muted">
                  A clear proposal helps members understand what will change and
                  why it matters.
                </p>
              </div>
              <div className="min-w-0 space-y-5">
                <div className="space-y-2">
                  <label
                    htmlFor="proposal-title"
                    className="text-sm font-medium"
                  >
                    Proposal title
                  </label>
                  <input
                    id="proposal-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="e.g. Fund the next community research round"
                    className={inputClassName}
                    required
                    aria-invalid={attemptedReview && !title.trim()}
                    aria-describedby={
                      attemptedReview && !title.trim()
                        ? 'proposal-title-error'
                        : undefined
                    }
                  />
                  {attemptedReview && !title.trim() && (
                    <p id="proposal-title-error" className="text-xs text-error">
                      Give your proposal a title.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="proposal-description"
                      className="text-sm font-medium"
                    >
                      Description
                    </label>
                    <span className="text-xs text-text-muted">
                      Markdown supported
                    </span>
                  </div>
                  <textarea
                    id="proposal-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={
                      'What do you propose?\n\nExplain the context, the intended outcome, and any tradeoffs.'
                    }
                    className={`${inputClassName} min-h-36 resize-y leading-relaxed`}
                    required
                    aria-invalid={attemptedReview && !description.trim()}
                    aria-describedby={
                      attemptedReview && !description.trim()
                        ? 'proposal-description-error'
                        : undefined
                    }
                  />
                  {attemptedReview && !description.trim() && (
                    <p
                      id="proposal-description-error"
                      className="text-xs text-error"
                    >
                      Add context so members can make an informed decision.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section
              aria-labelledby="proposal-actions-heading"
              className="space-y-5 border-t border-border pt-8"
            >
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="space-y-2">
                  <p className="tg-label">02 / The execution</p>
                  <h3 id="proposal-actions-heading" className="text-2xl">
                    Build the actions.
                  </h3>
                  <p className="text-sm text-text-muted">
                    Choose what this proposal will do. Actions run in order when
                    a passed proposal is executed.
                  </p>
                </div>
                <span className="text-xs text-text-muted">
                  Optional for a signal vote
                </span>
              </div>
              <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-8">
                <GovernanceActionLibrary
                  definitions={availableDefinitions}
                  onAdd={addDraft}
                />
                <div className="min-w-0 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                    <h4 className="text-sm font-medium">
                      Your actions{' '}
                      <span className="ml-2 border border-border px-1.5 py-0.5 text-xs tabular-nums">
                        {drafts.length.toString().padStart(2, '0')}
                      </span>
                    </h4>
                    <span className="text-xs text-text-muted">
                      {drafts.length
                        ? `${readyCount} of ${drafts.length} ready`
                        : 'No actions yet'}
                    </span>
                  </div>
                  {removed && (
                    <div
                      role="status"
                      className="flex items-center justify-between gap-3 border border-border bg-surface-2 px-3 py-2 text-xs"
                    >
                      <span>
                        {
                          governanceComposerDefinition(removed.draft.actionKey)
                            ?.label
                        }{' '}
                        removed.
                      </span>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        onClick={() => {
                          setDrafts((current) => [
                            ...current.slice(0, removed.index),
                            removed.draft,
                            ...current.slice(removed.index),
                          ])
                          focusDraft(removed.draft.id)
                          setRemoved(null)
                          setAnnouncement('Action restored.')
                        }}
                      >
                        Undo
                      </Button>
                    </div>
                  )}
                  {!drafts.length && (
                    <div className="flex min-h-80 flex-col items-center justify-center gap-4 border border-dashed border-hairline-strong bg-surface/50 px-5 py-10 text-center">
                      <div className="flex size-12 items-center justify-center border border-border bg-background">
                        <Layers3
                          className="size-5 text-text-muted"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="space-y-2">
                        <h4 className="text-base">
                          Turn a decision into action.
                        </h4>
                        <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-muted">
                          Transfer funds, update your network, or change
                          governance rules. Start with an action from the
                          library.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => addDraft('send-eth')}
                      >
                        <Plus />
                        Add a treasury transfer
                      </Button>
                      <p className="max-w-sm border-t border-border pt-4 text-xs leading-relaxed text-text-muted">
                        Just gathering support? Leave actions empty to create a
                        signal vote with no contract calls.
                      </p>
                    </div>
                  )}
                  {drafts.map((draft, index) => {
                    const definition = governanceComposerDefinition(
                      draft.actionKey
                    )
                    const expanded = expandedId === draft.id
                    const result = results[index]
                    return (
                      <article
                        key={draft.id}
                        aria-labelledby={`action-heading-${draft.id}`}
                        className={cn(
                          'min-w-0 border bg-surface',
                          expanded ? 'border-hairline-strong' : 'border-border'
                        )}
                      >
                        <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-2 p-3 sm:flex sm:flex-wrap sm:p-4">
                          <span className="mt-1 flex size-8 shrink-0 items-center justify-center border border-border text-xs text-text-muted">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <button
                            id={`action-heading-${draft.id}`}
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={`action-editor-${draft.id}`}
                            onClick={() =>
                              setExpandedId(expanded ? null : draft.id)
                            }
                            className="min-w-0 flex-1 space-y-1 px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                          >
                            <span className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-muted">
                              {
                                governanceCategoryLabels[
                                  definition?.category ?? 'custom'
                                ]
                              }
                            </span>
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <GovernanceActionEmoji
                                actionKey={draft.actionKey}
                              />
                              {definition?.label ?? draft.actionKey}
                              <ChevronDown
                                className={cn(
                                  'size-3.5 shrink-0 text-text-muted transition-transform',
                                  expanded && 'rotate-180'
                                )}
                                aria-hidden="true"
                              />
                            </span>
                            <span
                              className={cn(
                                'flex items-center gap-1.5 text-xs',
                                result?.error
                                  ? 'text-warn'
                                  : result
                                    ? 'text-success'
                                    : 'text-text-muted'
                              )}
                            >
                              {previewPending ? (
                                <>
                                  <LoaderCircle
                                    className="size-3 animate-spin"
                                    aria-hidden="true"
                                  />
                                  Checking fields…
                                </>
                              ) : result?.error ? (
                                'Needs attention'
                              ) : (
                                <>
                                  <Check
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                  Ready
                                </>
                              )}
                            </span>
                            {!expanded && result && !result.error && (
                              <span className="line-clamp-2 break-all text-xs leading-relaxed text-text-muted">
                                {result.actions
                                  .map((action) => action.description)
                                  .filter(Boolean)
                                  .join(' · ') || definition?.summary}
                              </span>
                            )}
                          </button>
                          <div
                            className="col-start-2 flex shrink-0 items-center gap-0.5"
                            role="group"
                            aria-label={`Action ${index + 1} controls`}
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveDraft(index, -1)}
                              disabled={index === 0}
                              aria-label={`Move action ${index + 1} up`}
                              title="Move up"
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveDraft(index, 1)}
                              disabled={index === drafts.length - 1}
                              aria-label={`Move action ${index + 1} down`}
                              title="Move down"
                            >
                              <ArrowDown />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => duplicateDraft(index)}
                              aria-label={`Duplicate action ${index + 1}`}
                              title="Duplicate"
                            >
                              <Copy />
                            </Button>
                            <Button
                              type="button"
                              variant="ghostDestructive"
                              size="icon"
                              onClick={() => removeDraft(index)}
                              aria-label={`Remove action ${index + 1}`}
                              title="Remove"
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                        <div
                          id={`action-editor-${draft.id}`}
                          hidden={!expanded}
                          className="@container space-y-4 border-t border-border p-4 sm:p-5"
                        >
                          <p className="text-xs leading-relaxed text-text-muted">
                            {definition?.summary}
                          </p>
                          {definition?.danger && (
                            <div className="flex gap-2 border border-warn/40 bg-warn-soft p-3 text-xs">
                              <Shield
                                className="mt-0.5 size-4 shrink-0 text-warn"
                                aria-hidden="true"
                              />
                              <div>
                                <p className="font-medium">
                                  High-impact governance action
                                </p>
                                <p className="mt-1 leading-relaxed text-text-muted">
                                  This changes an authority or an execution
                                  safety boundary. Check every address and
                                  consequence before submitting.
                                </p>
                              </div>
                            </div>
                          )}
                          <GovernanceActionEditor
                            draft={draft}
                            onChange={(values) => updateDraft(index, values)}
                            fieldErrors={fieldErrorsFor(draft, result)}
                            showAllErrors={attemptedReview}
                          />
                          {actionErrorFor(draft, result) && (
                            <p
                              className="border-l-2 border-warn bg-warn-soft px-3 py-2 text-xs leading-relaxed"
                              role="status"
                            >
                              {actionErrorFor(draft, result)}
                            </p>
                          )}
                        </div>
                      </article>
                    )
                  })}
                  {drafts.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-3 border border-dashed border-border p-4">
                      <p className="text-xs text-text-muted">
                        Need another step? Add an action from the library.
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          document.getElementById('action-search')?.focus()
                        }
                      >
                        <Plus />
                        Browse actions
                      </Button>
                    </div>
                  )}
                  {drafts.length > 0 && (
                    <details className="border border-border bg-surface">
                      <summary className="cursor-pointer px-4 py-3 text-xs text-text-muted">
                        Live encoded preview{' '}
                        <span className="ml-2">
                          {actionsReady
                            ? `${previewActions.length} contract calls`
                            : 'Complete your actions to preview'}
                        </span>
                      </summary>
                      <div className="space-y-4 border-t border-border p-4">
                        {actionsReady ? (
                          <>
                            <ProposalActionList actions={previewActions} />
                            {proposalJson && (
                              <CopyableText
                                text={proposalJson}
                                displayText="Copy DAO proposal JSON"
                                truncate={false}
                                truncateOnMobile={false}
                                alwaysShowCopyIcon
                              />
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-text-muted">
                            {previewPending
                              ? 'Checking action fields…'
                              : `Action ${invalidIndex + 1}: ${results[invalidIndex]?.error}`}
                          </p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </section>
          </div>

          {step === 'review' && (
            <section
              aria-labelledby="proposal-review-heading"
              className="grid items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
            >
              <div className="min-w-0 space-y-6">
                <div className="space-y-2">
                  <p className="tg-label">Ready for your network</p>
                  <h3
                    id="proposal-review-heading"
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-2xl outline-none"
                  >
                    Review your proposal.
                  </h3>
                  <p className="text-sm text-text-muted">
                    Check the decision and every action before submitting it to
                    a vote.
                  </p>
                </div>
                <div className="space-y-5 border border-border bg-surface p-5 sm:p-6">
                  <div className="flex items-center justify-between">
                    <span className="tg-label">The proposal</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => changeStep('compose')}
                    >
                      Edit details
                    </Button>
                  </div>
                  <h3 className="break-words text-2xl">{title}</h3>
                  <Markdown className="min-w-0 gap-3 break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
                    {description}
                  </Markdown>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-sm font-medium">
                      Execution plan · {drafts.length}{' '}
                      {drafts.length === 1 ? 'action' : 'actions'}
                    </h4>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => changeStep('compose')}
                    >
                      Edit actions
                    </Button>
                  </div>
                  {drafts.length ? (
                    <>
                      <p className="text-xs leading-relaxed text-text-muted">
                        These are the exact contract calls in execution order. A
                        passed proposal must be executed for the changes to take
                        effect.
                      </p>
                      {actionsReady ? (
                        <>
                          <ProposalActionList actions={previewActions} />
                          <ProposalSimulationPanel
                            simulation={simulation}
                            actions={previewActions}
                          />
                        </>
                      ) : (
                        <p
                          role="status"
                          className="border border-warn/40 bg-warn-soft p-4 text-xs"
                        >
                          {previewPending
                            ? 'Refreshing the action preview…'
                            : `Action ${invalidIndex + 1}: ${results[invalidIndex]?.error}`}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="flex items-start gap-3 border border-border bg-surface p-5">
                      <FileText
                        className="size-5 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm">Signal vote</p>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted">
                          Members vote on the idea. This proposal has no
                          contract calls and will not move funds or change
                          settings.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                {proposalJson && (
                  <div className="border-t border-border pt-4">
                    <CopyableText
                      text={proposalJson}
                      displayText="Copy DAO proposal JSON"
                      truncate={false}
                      truncateOnMobile={false}
                      alwaysShowCopyIcon
                      className="min-h-11 border border-border px-3 py-2 text-xs"
                    />
                  </div>
                )}
              </div>
              <aside className="min-w-0 space-y-5 lg:sticky lg:top-6">
                <div className="space-y-4 border border-border bg-surface p-5">
                  <p className="tg-label">At a glance</p>
                  <dl className="space-y-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Proposal type</dt>
                      <dd>{drafts.length ? 'Executable' : 'Signal vote'}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Actions</dt>
                      <dd>{drafts.length}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-muted">Contract calls</dt>
                      <dd>{previewActions.length}</dd>
                    </div>
                  </dl>
                  {highImpactCount > 0 && (
                    <div className="space-y-3 border-t border-border pt-4">
                      <p className="flex items-start gap-2 text-xs leading-relaxed text-warn">
                        <Shield
                          className="size-4 shrink-0"
                          aria-hidden="true"
                        />
                        {highImpactCount} high-impact{' '}
                        {highImpactCount === 1
                          ? 'action changes'
                          : 'actions change'}{' '}
                        authority or execution safeguards.
                      </p>
                      <ul className="space-y-2 text-xs leading-relaxed">
                        {drafts
                          .filter(
                            (draft) =>
                              governanceComposerDefinition(draft.actionKey)
                                ?.danger
                          )
                          .map((draft) => {
                            const definition = governanceComposerDefinition(
                              draft.actionKey
                            )!
                            return (
                              <li key={draft.id}>
                                <span className="font-medium">
                                  {definition.label}.
                                </span>{' '}
                                <span className="text-text-muted">
                                  {governanceDangerConsequence(
                                    draft.actionKey,
                                    definition.summary
                                  )}
                                </span>
                              </li>
                            )
                          })}
                      </ul>
                      <label className="flex cursor-pointer items-start gap-3 text-sm">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 shrink-0 accent-ink"
                          checked={dangerAcknowledged}
                          onChange={(event) =>
                            setDangerAcknowledged(event.target.checked)
                          }
                          aria-describedby="danger-acknowledgement-help"
                        />
                        <span>
                          I understand what these actions change
                          <span
                            id="danger-acknowledgement-help"
                            className="mt-1 block text-xs leading-relaxed text-text-muted"
                          >
                            Required before submitting a proposal with
                            high-impact actions.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>
                <div className="space-y-4 border border-border bg-surface p-5 [&_[role=radiogroup]]:flex-col">
                  <label className="flex cursor-pointer items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      aria-label="Include my vote"
                      className="mt-0.5 size-4 shrink-0 accent-ink"
                      checked={castVoteOnCreate}
                      onChange={(event) =>
                        setCastVoteOnCreate(event.target.checked)
                      }
                    />
                    <span>
                      Include my vote
                      <span className="mt-1 block text-xs leading-relaxed text-text-muted">
                        Cast your vote in the same transaction.
                      </span>
                    </span>
                  </label>
                  {castVoteOnCreate && (
                    <>
                      <p className="text-xs text-text-muted">
                        Your voting power:{' '}
                        {userVotingPower
                          ? formatBigNumber(BigInt(userVotingPower), 18)
                          : '0'}
                      </p>
                      <VoteButtons
                        isLoading={isSubmitting}
                        selected={voteType}
                        onSelect={setVoteType}
                      />
                    </>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-text-muted">
                  Submitting publishes this proposal for the network to vote on.
                  Your wallet will ask you to confirm the transaction.
                </p>
              </aside>
            </section>
          )}
        </fieldset>

        {error && (
          <div
            role="alert"
            className="border border-error/40 bg-error-soft p-4 text-sm text-error"
          >
            {error}
          </div>
        )}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline-strong bg-background py-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm">
              {step === 'review'
                ? 'Your proposal is ready to submit.'
                : drafts.length
                  ? `${drafts.length} ${drafts.length === 1 ? 'action' : 'actions'} in your proposal`
                  : 'A decision starts here.'}
            </p>
            <p className="text-xs text-text-muted">
              {step === 'review'
                ? canCreateProposal
                  ? highImpactCount > 0 && !dangerAcknowledged
                    ? 'Acknowledge the high-impact actions to submit.'
                    : 'Confirm the transaction in your wallet.'
                  : isConnected
                    ? 'You need voting power in this network to submit.'
                    : 'Connect a wallet with voting power to submit.'
                : attemptedReview && !actionsReady
                  ? 'Complete the action fields marked above to continue.'
                  : 'Review everything before it goes to a vote.'}
            </p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            {step === 'review' && (
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => changeStep('compose')}
              >
                <ArrowLeft />
                Back
              </Button>
            )}
            {step === 'review' && !isConnected ? (
              <Button
                type="button"
                className="min-h-11 flex-1 sm:flex-none"
                onClick={openConnectWallet}
              >
                Connect wallet
              </Button>
            ) : (
              <Button
                type="submit"
                className="min-h-11 flex-1 sm:flex-none"
                disabled={
                  step === 'review'
                    ? busy ||
                      !canCreateProposal ||
                      !actionsReady ||
                      (highImpactCount > 0 && !dangerAcknowledged)
                    : previewPending
                }
              >
                {isSubmitting ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Submitting…
                  </>
                ) : step === 'review' ? (
                  'Submit proposal'
                ) : (
                  <>
                    Review proposal
                    <ArrowRight />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </form>
    </GovernanceComposerProvider>
  )
}
