'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { type Hex, isAddress } from 'viem'

import { AddressListField } from '@/components/governance/fields/TextFields'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { Textarea } from '@/components/Textarea'
import type { GovernanceFieldSpec } from '@/lib/actions'
import type { Params } from '@/lib/pagerank/types'
import {
  type ExactParamsJson,
  MAX_ITERATIONS,
  diffParams,
  formatFixed,
  paramsFromJson,
  paramsToJson,
  parseFixed,
  validateParamsUpdate,
} from '@/lib/scoring-params'
import { cn } from '@/lib/utils'

type FixedKey =
  | 'trustShareFp'
  | 'trustDecayFp'
  | 'dampingFp'
  | 'minWeightFp'
  | 'maxWeightFp'
  | 'totalPool'
  | 'toleranceFp'

const FIXED_FIELDS: { key: FixedKey; label: string; help: string }[] = [
  {
    key: 'trustShareFp',
    label: 'Starting share',
    help: 'Share of all score that starts at the trusted accounts, from 0 to 1.',
  },
  {
    key: 'trustDecayFp',
    label: 'Distance decay',
    help: 'How much score fades with each vouch hop, from 0 to 1.',
  },
  {
    key: 'dampingFp',
    label: 'Damping',
    help: 'Chance of following a vouch instead of restarting, from 0 to 1.',
  },
  {
    key: 'minWeightFp',
    label: 'Minimum vouch weight',
    help: 'Vouches below this weight count as this much.',
  },
  {
    key: 'maxWeightFp',
    label: 'Maximum vouch weight',
    help: 'Vouches above this weight count as this much.',
  },
  {
    key: 'totalPool',
    label: 'Points pool',
    help: 'Total points split across members in proportion to score.',
  },
  {
    key: 'toleranceFp',
    label: 'Convergence tolerance',
    help: 'Stop iterating once scores move less than this between passes.',
  },
]

type Form = Record<FixedKey, string> & {
  maxIterations: string
  trustedSeeds: string[]
}

const SEEDS_SPEC: GovernanceFieldSpec = {
  key: 'trustedSeeds',
  label: 'Trusted accounts',
  kind: 'address-list',
  required: true,
  span: 'full',
  help: 'Score flows outward from these accounts. Between 1 and 64.',
}

const REQUIRED_KEYS: (keyof ExactParamsJson)[] = [
  'dampingFp',
  'toleranceFp',
  'maxIterations',
  'minWeightFp',
  'maxWeightFp',
  'trustShareFp',
  'trustDecayFp',
  'trustedSeeds',
  'totalPool',
  'precisionScale',
  'schemaUid',
  'weightFieldIndex',
  'envelope0DomainSeparators',
  'lane2MaxHeadAge',
  'accumulator',
  'chainId',
]

const isExactParamsJson = (value: unknown): value is ExactParamsJson =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  REQUIRED_KEYS.every((key) => key in (value as object))

const formFromJson = (json: ExactParamsJson): Form => {
  const scale = BigInt(json.precisionScale)
  return {
    trustShareFp: formatFixed(BigInt(json.trustShareFp), scale),
    trustDecayFp: formatFixed(BigInt(json.trustDecayFp), scale),
    dampingFp: formatFixed(BigInt(json.dampingFp), scale),
    minWeightFp: formatFixed(BigInt(json.minWeightFp), scale),
    maxWeightFp: formatFixed(BigInt(json.maxWeightFp), scale),
    totalPool: formatFixed(BigInt(json.totalPool), scale),
    toleranceFp: formatFixed(BigInt(json.toleranceFp), scale),
    maxIterations: String(json.maxIterations),
    trustedSeeds: [...json.trustedSeeds],
  }
}

/** Parse the form over the identity of `base`; errors are keyed by form field. */
const paramsFromForm = (
  form: Form,
  base: ExactParamsJson
): { params?: Params; errors: Record<string, string> } => {
  const errors: Record<string, string> = {}
  const next = paramsFromJson(base)
  for (const { key } of FIXED_FIELDS) {
    try {
      next[key] = parseFixed(form[key], next.precisionScale)
    } catch (error) {
      errors[key] = error instanceof Error ? error.message : 'Invalid value'
    }
  }
  if (!/^\d+$/.test(form.maxIterations.trim())) {
    errors.maxIterations = 'Enter a whole number.'
  } else {
    next.maxIterations = Number(form.maxIterations.trim())
  }
  const seeds = form.trustedSeeds.map((seed) => seed.trim())
  const bad = seeds.findIndex((seed) => !isAddress(seed))
  if (bad >= 0) {
    errors.trustedSeeds = `Entry ${bad + 1} is not a valid address.`
  } else {
    next.trustedSeeds = seeds.map((seed) => seed.toLowerCase() as Hex)
  }
  return Object.keys(errors).length ? { errors } : { params: next, errors }
}

/**
 * The scoring tuple as a form: the seven fixed-point knobs, the iteration cap and the trusted
 * accounts, over the network's live parameters. Identity fields stay read-only. A JSON view
 * remains for people who bring reviewed parameters from elsewhere.
 */
export function ScoringParamsEditor({
  idBase,
  values,
  error,
  showAllErrors,
  onChange,
}: {
  idBase: string
  values: Record<string, unknown>
  /** The schema or encoder problem for `proposed`, if any. */
  error?: string
  showAllErrors: boolean
  onChange: (values: Record<string, unknown>) => void
}) {
  const data = useGovernanceComposer()
  const baseline = data?.parentParams?.params
  const proposed = isExactParamsJson(values.proposed) ? values.proposed : null
  const base = proposed ?? baseline ?? null
  const latest = useRef({ values, onChange })
  latest.current = { values, onChange }

  const [form, setForm] = useState<Form | null>(() =>
    base ? formFromJson(base) : null
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const lastEmitted = useRef<unknown>(values.proposed)
  const initialized = useRef(false)

  // Seed the draft from the live parameters once, so the form edits from what is on-chain.
  useEffect(() => {
    if (initialized.current || proposed || !baseline) return
    initialized.current = true
    lastEmitted.current = baseline
    latest.current.onChange({ ...latest.current.values, proposed: baseline })
    setForm(formFromJson(baseline))
  }, [baseline, proposed])

  // A draft that changed elsewhere (prefill, reload) re-renders the form.
  useEffect(() => {
    if (values.proposed === lastEmitted.current) return
    lastEmitted.current = values.proposed
    if (proposed) {
      setForm(formFromJson(proposed))
      setErrors({})
    }
  }, [proposed, values.proposed])

  const emit = (next: Form) => {
    setForm(next)
    if (!base) return
    const parsed = paramsFromForm(next, base)
    const envelope =
      parsed.params && baseline
        ? validateParamsUpdate(parsed.params, paramsFromJson(baseline))
        : undefined
    const blocking = { ...parsed.errors }
    if (envelope) {
      for (const [key, message] of Object.entries(envelope.errors)) {
        if (key !== 'noop') blocking[key] = message
      }
    }
    setErrors(blocking)
    const value =
      parsed.params && !Object.keys(blocking).length
        ? paramsToJson(parsed.params)
        : null
    lastEmitted.current = value
    latest.current.onChange({ ...latest.current.values, proposed: value })
  }

  const applyJson = (text: string) => {
    setJsonText(text)
    try {
      const parsed = JSON.parse(text)
      if (!isExactParamsJson(parsed)) {
        throw new Error('Every scoring parameter field must be present.')
      }
      setJsonError(null)
      emit(formFromJson(parsed))
      lastEmitted.current = parsed
      latest.current.onChange({ ...latest.current.values, proposed: parsed })
    } catch (failure) {
      setJsonError(failure instanceof Error ? failure.message : 'Invalid JSON')
      lastEmitted.current = null
      latest.current.onChange({ ...latest.current.values, proposed: null })
    }
  }

  const diff = useMemo(() => {
    if (!baseline || !proposed) return []
    try {
      return diffParams(paramsFromJson(baseline), paramsFromJson(proposed))
    } catch {
      return []
    }
  }, [baseline, proposed])

  if (!form || !base) {
    return (
      <p className="text-sm text-text-muted">
        {data?.parentParamsState === 'error'
          ? 'The network’s current scoring parameters could not be loaded from the indexer.'
          : 'Loading the network’s current scoring parameters…'}
      </p>
    )
  }

  const scaleDigits = base.precisionScale.length - 1
  const fieldId = (key: string) => `${idBase}-${key}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wider text-text-muted">
          Scoring parameters
        </p>
        <button
          type="button"
          onClick={() => {
            if (!jsonMode) setJsonText(JSON.stringify(base, null, 2))
            setJsonMode((mode) => !mode)
          }}
          className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
        >
          {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
        </button>
      </div>

      {showAllErrors && error && !Object.keys(errors).length && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}

      {jsonMode ? (
        <div className="space-y-2">
          <Textarea
            id={fieldId('json')}
            value={jsonText}
            onChange={(event) => applyJson(event.target.value)}
            className="min-h-64 font-mono text-xs"
            spellCheck={false}
            aria-invalid={!!jsonError}
            aria-label="Scoring parameters as JSON"
          />
          {jsonError && (
            <p role="alert" className="text-xs text-error">
              {jsonError}
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
          {FIXED_FIELDS.map(({ key, label, help }) => (
            <div key={key} className="min-w-0 space-y-2">
              <Label htmlFor={fieldId(key)}>{label}</Label>
              <Input
                id={fieldId(key)}
                value={form[key]}
                onChange={(event) =>
                  emit({ ...form, [key]: event.target.value })
                }
                inputMode="decimal"
                className="h-11"
                aria-invalid={!!errors[key]}
                aria-describedby={`${fieldId(key)}-help`}
              />
              <p
                id={`${fieldId(key)}-help`}
                className={cn(
                  'text-xs leading-relaxed',
                  errors[key] ? 'text-error' : 'text-text-muted'
                )}
              >
                {errors[key] ?? `${help} Up to ${scaleDigits} decimal places.`}
              </p>
            </div>
          ))}
          <div className="min-w-0 space-y-2">
            <Label htmlFor={fieldId('maxIterations')}>Maximum iterations</Label>
            <Input
              id={fieldId('maxIterations')}
              value={form.maxIterations}
              onChange={(event) =>
                emit({ ...form, maxIterations: event.target.value })
              }
              inputMode="numeric"
              className="h-11"
              aria-invalid={!!errors.maxIterations}
            />
            <p
              className={cn(
                'text-xs leading-relaxed',
                errors.maxIterations ? 'text-error' : 'text-text-muted'
              )}
            >
              {errors.maxIterations ??
                `Passes before scoring stops regardless of tolerance, at most ${MAX_ITERATIONS}.`}
            </p>
          </div>
          {errors.weights && (
            <p className="text-xs text-error @min-[28rem]:col-span-2">
              {errors.weights}
            </p>
          )}
          <AddressListField
            id={fieldId('trustedSeeds')}
            spec={SEEDS_SPEC}
            value={form.trustedSeeds}
            values={{}}
            error={errors.trustedSeeds}
            onChange={(next) =>
              emit({
                ...form,
                trustedSeeds: Array.isArray(next)
                  ? next.map((entry) => String(entry))
                  : [],
              })
            }
            onBlur={() => undefined}
          />
          {(errors.identity ||
            errors.precisionScale ||
            errors.weightFieldIndex) && (
            <p className="text-xs text-error @min-[28rem]:col-span-2">
              {errors.identity ??
                errors.precisionScale ??
                errors.weightFieldIndex}
            </p>
          )}
        </div>
      )}

      <div className="border-l-2 border-hairline-strong bg-surface-2 px-3 py-2 text-xs">
        <p className="font-medium text-text">
          {diff.length
            ? `${diff.length} ${diff.length === 1 ? 'change' : 'changes'} from the current parameters`
            : baseline
              ? 'No changes from the current parameters yet.'
              : 'Current parameters are unavailable, so changes cannot be compared.'}
        </p>
        {diff.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-text-muted">
            {diff.map((entry) => (
              <li key={entry.field} className="break-words">
                {entry.label}: {entry.before} → {entry.after}
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className="border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs text-text-muted">
          Identity fields (not editable)
        </summary>
        <dl className="grid gap-x-4 gap-y-1 border-t border-border p-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
          {(
            [
              ['Schema', base.schemaUid],
              ['Accumulator', base.accumulator],
              ['Chain', base.chainId],
              ['Precision scale', base.precisionScale],
              ['Weight field index', String(base.weightFieldIndex)],
              [
                'Envelope domains',
                String(base.envelope0DomainSeparators.length),
              ],
              ['Lane-2 max head age', base.lane2MaxHeadAge],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-text-muted">{label}</dt>
              <dd className="break-all font-mono text-text">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  )
}
