'use client'

import { cn } from '@/lib/utils'

import { FieldShell } from './FieldShell'
import type { FieldComponentProps } from './types'

function Segmented<T extends string | number | boolean>({
  id,
  label,
  value,
  options,
  onChange,
  onBlur,
  invalid,
}: {
  id: string
  label: string
  value: T | undefined
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  onBlur: () => void
  invalid?: boolean
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={cn(
        'grid gap-px border bg-border',
        options.length > 1 && 'grid-cols-2',
        invalid ? 'border-error' : 'border-border'
      )}
    >
      {options.map((option) => {
        const checked = value === option.value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            onBlur={onBlur}
            className={cn(
              'min-h-11 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
              checked
                ? 'bg-ink text-ink-fg'
                : 'bg-surface text-text-muted hover:bg-surface-2 hover:text-text'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Two named states, shown side by side, with the live state underneath. */
export function BooleanField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  return (
    <FieldShell id={id} spec={spec} error={error} current={current}>
      <Segmented
        id={id}
        label={spec.label}
        value={typeof value === 'boolean' ? value : undefined}
        options={[
          { value: true, label: spec.options?.true ?? 'Yes' },
          { value: false, label: spec.options?.false ?? 'No' },
        ]}
        onChange={onChange}
        onBlur={onBlur}
        invalid={!!error}
      />
    </FieldShell>
  )
}

/** Safe operation: a plain call, or a delegatecall that runs in the Safe's own storage. */
export function OperationField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const operation = value === 1 ? 1 : value === 0 ? 0 : undefined
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        operation === 1 ? (
          <p className="text-xs leading-relaxed text-warn">
            A delegatecall runs the target’s code as the treasury itself and
            must be on the governance module’s delegatecall allowlist.
          </p>
        ) : null
      }
    >
      <Segmented
        id={id}
        label={spec.label}
        value={operation}
        options={[
          { value: 0 as const, label: 'Call' },
          { value: 1 as const, label: 'Delegatecall' },
        ]}
        onChange={onChange}
        onBlur={onBlur}
        invalid={!!error}
      />
    </FieldShell>
  )
}
