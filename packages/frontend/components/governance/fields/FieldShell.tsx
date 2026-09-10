'use client'

import type { ReactNode } from 'react'

import { Label } from '@/components/Label'
import type { GovernancePickerOption } from '@/hooks/useGovernanceComposerData'
import type { GovernanceFieldSpec } from '@/lib/actions'
import { cn } from '@/lib/utils'

import type { FieldCurrentValue } from './types'

/**
 * Label, control, and the lines under it: the live value it replaces, help, a standing warning,
 * and the error. Error and help are wired to the control through `aria-describedby`.
 */
export function FieldShell({
  id,
  spec,
  error,
  current,
  trailing,
  children,
  notes,
  className,
}: {
  id: string
  spec: GovernanceFieldSpec
  error?: string
  current?: FieldCurrentValue
  /** Rendered on the label row's right edge (a Max button, a byte count). */
  trailing?: ReactNode
  children: ReactNode
  /** Extra lines under the control, before help. */
  notes?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'min-w-0 space-y-2',
        spec.span === 'full' && '@min-[28rem]:col-span-2',
        className
      )}
    >
      <div className="flex min-h-5 items-baseline justify-between gap-3">
        <Label htmlFor={id}>
          {spec.label}
          {spec.required === false && (
            <span className="ml-1 normal-case tracking-normal text-text-subtle">
              (optional)
            </span>
          )}
        </Label>
        {trailing}
      </div>
      {children}
      {notes}
      {current && (
        <p className="text-xs text-text-muted">
          Currently:{' '}
          <span className="break-all text-text">{current.display}</span>
          {current.same && (
            <span className="ml-1 text-warn">
              (unchanged, so this action would do nothing)
            </span>
          )}
        </p>
      )}
      {spec.help && (
        <p
          id={`${id}-help`}
          className="text-xs leading-relaxed text-text-muted"
        >
          {spec.help}
        </p>
      )}
      {spec.warning && (
        <p className="text-xs leading-relaxed text-warn">{spec.warning}</p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** `aria-describedby` for a control inside a FieldShell. */
export const describedBy = (
  id: string,
  spec: GovernanceFieldSpec,
  error?: string
) =>
  [error ? `${id}-error` : null, spec.help ? `${id}-help` : null]
    .filter(Boolean)
    .join(' ') || undefined

/**
 * Values a field can take with one click. A short list renders as chips; a long one as a
 * select so the form does not fill with buttons.
 */
export function PickerOptions({
  options,
  label,
  onPick,
  selected,
}: {
  options: readonly GovernancePickerOption[]
  label: string
  onPick: (option: GovernancePickerOption) => void
  selected?: string
}) {
  if (!options.length) return null
  if (options.length > 6) {
    return (
      <select
        aria-label={`Choose ${label.toLowerCase()}`}
        value=""
        onChange={(event) => {
          const option = options.find(
            (entry) => entry.value === event.target.value
          )
          if (option) onPick(option)
        }}
        className="tg-input h-9 w-full border border-input bg-surface px-2 text-xs text-text-muted"
      >
        <option value="">Choose {label.toLowerCase()}…</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {option.description ? ` · ${option.description}` : ''}
          </option>
        ))}
      </select>
    )
  }
  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="group"
      aria-label={`${label} suggestions`}
    >
      {options.map((option) => {
        const active =
          !!selected && option.value.toLowerCase() === selected.toLowerCase()
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onPick(option)}
            title={option.description}
            aria-pressed={active}
            className={cn(
              'max-w-full truncate border px-2 py-1 text-xs transition-colors',
              active
                ? 'border-ink bg-ink text-ink-fg'
                : 'border-border text-text-muted hover:border-hairline-strong hover:text-text'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
