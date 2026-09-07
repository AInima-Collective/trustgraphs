'use client'

import { useEffect, useId, useRef } from 'react'
import { type Address, isAddress, toHex } from 'viem'

import { CustomCallEditor } from '@/components/governance/CustomCallEditor'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { ScoringParamsEditor } from '@/components/governance/ScoringParamsEditor'
import { GovernanceFieldGrid } from '@/components/governance/fields/GovernanceFieldGrid'
import {
  type GovernanceActionDraft,
  type GovernanceComposerActionKey,
  governanceActionFields,
} from '@/lib/actions'

const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001' as Address

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (values: Record<string, unknown>, key: string) =>
  typeof values[key] === 'string' ? (values[key] as string) : ''

type EditorProps = {
  draft: GovernanceActionDraft
  onChange: (values: unknown) => void
  /** Field-level problems from the schema check and the encoder, keyed by field. */
  fieldErrors?: Record<string, string>
  /** Show every error now (review was attempted), not only on touched fields. */
  showAllErrors?: boolean
}

/** The predecessor a Safe linked list needs to unlink `target`, or undefined when unknown. */
const safeListPredecessor = (
  list: readonly Address[],
  target: string
): Address | undefined => {
  if (!isAddress(target)) return undefined
  const index = list.findIndex(
    (entry) => entry.toLowerCase() === target.toLowerCase()
  )
  if (index < 0) return undefined
  return index === 0 ? SAFE_SENTINEL : list[index - 1]
}

/** Keep the newest `onChange` reachable from effects without re-running them per render. */
const useLatest = <T,>(value: T) => {
  const ref = useRef(value)
  ref.current = value
  return ref
}

function NoArguments({ note }: { note?: string }) {
  return (
    <div className="space-y-1 text-sm text-text-muted">
      <p>
        This action has no editable arguments. It applies to this network’s
        pending item.
      </p>
      {note && <p className="text-text">{note}</p>}
    </div>
  )
}

/**
 * Safe owner and module lists are singly linked on-chain, so removing an entry needs its
 * predecessor. Derive it from the live list whenever the chosen entry changes; the derived
 * field stays editable under "Advanced" for the rare case the list moved since.
 */
function SafeListEditor({
  draft,
  onChange,
  fieldErrors,
  showAllErrors,
  idBase,
  targetKey,
  previousKey,
  list,
  noun,
}: EditorProps & {
  idBase: string
  targetKey: string
  previousKey: string
  list: readonly Address[]
  noun: string
}) {
  const values = record(draft.values)
  const target = text(values, targetKey).trim()
  const known = isAddress(target)
    ? list.some((entry) => entry.toLowerCase() === target.toLowerCase())
    : true
  return (
    <GovernanceFieldGrid
      idBase={idBase}
      fields={governanceActionFields(draft.actionKey)}
      values={values}
      errors={fieldErrors ?? {}}
      showAllErrors={!!showAllErrors}
      onChange={(next) => {
        const nextTarget = text(next, targetKey).trim()
        if (nextTarget !== target) {
          const previous = safeListPredecessor(list, nextTarget)
          onChange(previous ? { ...next, [previousKey]: previous } : next)
          return
        }
        onChange(next)
      }}
    >
      {list.length > 0 && !known && (
        <p className="text-xs text-warn @min-[28rem]:col-span-2">
          This {noun} is not in the Safe’s current list, so the transaction
          would revert.
        </p>
      )}
    </GovernanceFieldGrid>
  )
}

/**
 * A round copies the parent network's exact live scoring tuple and epoch length, and needs a
 * random salt for a unique address. Neither is something to type: they are attached to the
 * draft as soon as they are known.
 */
function ContributionRoundEditor({
  draft,
  onChange,
  fieldErrors,
  showAllErrors,
  idBase,
}: EditorProps & { idBase: string }) {
  const data = useGovernanceComposer()
  const values = record(draft.values)
  const latest = useLatest({ values, onChange })
  const parent = data?.parentParams
  const hasParent = !!values.parentParams && !!values.parentEpochLength
  const hasSalt = /^0x[0-9a-fA-F]{64}$/.test(text(values, 'salt'))

  useEffect(() => {
    if (hasParent && hasSalt) return
    const next = { ...latest.current.values }
    let changed = false
    if (!hasParent && parent) {
      next.parentParams = parent.params
      next.parentEpochLength = parent.epochLength
      changed = true
    }
    if (!hasSalt) {
      next.salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
      changed = true
    }
    if (changed) latest.current.onChange(next)
  }, [hasParent, hasSalt, latest, parent])

  return (
    <GovernanceFieldGrid
      idBase={idBase}
      fields={governanceActionFields(draft.actionKey)}
      values={values}
      errors={fieldErrors ?? {}}
      showAllErrors={!!showAllErrors}
      onChange={onChange}
    >
      <p className="text-xs leading-relaxed text-text-muted @min-[28rem]:col-span-2">
        {hasParent
          ? 'The parent network’s exact scoring tuple and epoch length are attached to this draft and shown in the encoded transaction.'
          : data?.parentParamsState === 'error'
            ? 'The parent network’s scoring tuple could not be loaded from the indexer. Reload to try again.'
            : 'Loading the parent network’s scoring tuple…'}
      </p>
    </GovernanceFieldGrid>
  )
}

/** Fills the weighted controller from the network so nobody types it. */
function WeightedPriorEditor({
  draft,
  onChange,
  fieldErrors,
  showAllErrors,
  idBase,
}: EditorProps & { idBase: string }) {
  const data = useGovernanceComposer()
  const values = record(draft.values)
  const controller = data?.actionContext.weightedParamsController
  const latest = useLatest({ values, onChange })
  const missing = !text(values, 'controller').trim() && !!controller
  useEffect(() => {
    if (!missing) return
    latest.current.onChange({ ...latest.current.values, controller })
  }, [controller, latest, missing])
  return (
    <GovernanceFieldGrid
      idBase={idBase}
      fields={governanceActionFields(draft.actionKey)}
      values={values}
      errors={fieldErrors ?? {}}
      showAllErrors={!!showAllErrors}
      onChange={onChange}
    >
      <p className="text-xs leading-relaxed text-text-muted @min-[28rem]:col-span-2">
        The manifest and digest come from the weighted starting-shares
        workspace, which opens this composer with them filled in. Paste them
        here only when you already have reviewed bytes.
      </p>
    </GovernanceFieldGrid>
  )
}

const CANCEL_NOTES: Partial<
  Record<
    GovernanceComposerActionKey,
    (data: ReturnType<typeof useGovernanceComposer>) => string | undefined
  >
> = {
  'cancel-weighted-prior': (data) => data?.pending.weightedPrior,
  'cancel-composition-policy': (data) => data?.pending.compositionPolicy,
  'cancel-vault-withdrawal': (data) => data?.pending.vaultWithdrawal,
}

export function GovernanceActionEditor({
  draft,
  onChange,
  fieldErrors = {},
  showAllErrors = false,
}: EditorProps) {
  const reactId = useId()
  const idBase = `action-field-${reactId}`
  const data = useGovernanceComposer()
  const values = record(draft.values)
  const fields = governanceActionFields(draft.actionKey)
  const grid = (
    <GovernanceFieldGrid
      idBase={idBase}
      fields={fields}
      values={values}
      errors={fieldErrors}
      showAllErrors={showAllErrors}
      onChange={onChange}
    />
  )

  switch (draft.actionKey) {
    case 'update-scoring-params':
      return (
        <div className="space-y-5">
          <ScoringParamsEditor
            idBase={idBase}
            values={values}
            error={fieldErrors.proposed}
            showAllErrors={showAllErrors}
            onChange={onChange}
          />
          {grid}
        </div>
      )
    case 'create-contribution-round':
      return (
        <ContributionRoundEditor
          draft={draft}
          onChange={onChange}
          fieldErrors={fieldErrors}
          showAllErrors={showAllErrors}
          idBase={idBase}
        />
      )
    case 'rotate-weighted-prior':
      return (
        <WeightedPriorEditor
          draft={draft}
          onChange={onChange}
          fieldErrors={fieldErrors}
          showAllErrors={showAllErrors}
          idBase={idBase}
        />
      )
    case 'propose-composition-policy':
      return (
        <GovernanceFieldGrid
          idBase={idBase}
          fields={fields}
          values={values}
          errors={fieldErrors}
          showAllErrors={showAllErrors}
          onChange={onChange}
        >
          <p className="text-xs leading-relaxed text-text-muted @min-[28rem]:col-span-2">
            The manifest, adapters and digest come from the composition
            workspace, which opens this composer with them filled in. Paste them
            here only when you already have reviewed bytes.
          </p>
        </GovernanceFieldGrid>
      )
    case 'disable-safe-module':
      return (
        <SafeListEditor
          draft={draft}
          onChange={onChange}
          fieldErrors={fieldErrors}
          showAllErrors={showAllErrors}
          idBase={idBase}
          targetKey="module"
          previousKey="previousModule"
          list={data?.safeModules ?? []}
          noun="module"
        />
      )
    case 'swap-safe-owner':
      return (
        <SafeListEditor
          draft={draft}
          onChange={onChange}
          fieldErrors={fieldErrors}
          showAllErrors={showAllErrors}
          idBase={idBase}
          targetKey="oldOwner"
          previousKey="previousOwner"
          list={data?.safeOwners ?? []}
          noun="owner"
        />
      )
    case 'cancel-weighted-prior':
    case 'cancel-composition-policy':
    case 'cancel-vault-withdrawal':
      return <NoArguments note={CANCEL_NOTES[draft.actionKey]?.(data)} />
    case 'cancel-constitutional-transfer':
      return (
        <NoArguments note="It cancels the snapshot’s currently pending constitutional transfer." />
      )
    case 'custom':
      return (
        <CustomCallEditor
          idBase={idBase}
          values={values}
          fieldErrors={fieldErrors}
          showAllErrors={showAllErrors}
          onChange={onChange}
        />
      )
    default:
      return fields.length ? grid : <NoArguments />
  }
}
