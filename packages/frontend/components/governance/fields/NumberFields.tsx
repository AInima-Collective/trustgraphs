'use client'

import { useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'

import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { Input } from '@/components/Input'
import { Slider } from '@/components/Slider'
import { BPS_DECIMALS, USD_DECIMALS, formatUsd8 } from '@/lib/actions'
import { cn } from '@/lib/utils'

import { FieldShell, PickerOptions, describedBy } from './FieldShell'
import { DIGITS, type FieldComponentProps, stringValue } from './types'

/** A decimal percentage stored as typed; the encoder scales it to the contract's fraction. */
export function PercentField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const text = stringValue(value)
  const numeric = Number(text)
  const sliderValue =
    text && Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        <div className="px-1 pt-1">
          <Slider
            value={sliderValue}
            onValueChange={(next) => onChange(String(Math.round(next)))}
            min={0}
            max={100}
            ariaLabel={`${spec.label} slider`}
          />
        </div>
      }
    >
      <SuffixInput
        id={id}
        value={text}
        suffix="%"
        placeholder={spec.placeholder ?? '0'}
        onChange={onChange}
        onBlur={onBlur}
        error={error}
        spec={spec}
      />
    </FieldShell>
  )
}

/** Local decimal text synchronized with a scaled integer in the draft. */
const useScaledText = (
  value: unknown,
  decimals: number,
  onChange: (value: unknown) => void
) => {
  const stored = stringValue(value)
  const render = (raw: string) =>
    DIGITS.test(raw) ? formatUnits(BigInt(raw), decimals) : ''
  const [text, setText] = useState(() => render(stored))
  const [localError, setLocalError] = useState<string | null>(null)
  const lastEmitted = useRef(stored)
  useEffect(() => {
    if (stored === lastEmitted.current) return
    lastEmitted.current = stored
    setLocalError(null)
    setText(render(stored))
  }, [stored])
  const update = (next: string) => {
    setText(next)
    const trimmed = next.trim()
    let encoded = ''
    if (trimmed) {
      const match = trimmed.match(/^(\d+)(?:\.(\d*))?$/)
      if (!match) {
        setLocalError('Enter a decimal number.')
      } else if ((match[2] ?? '').length > decimals) {
        setLocalError(
          `Use at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.`
        )
      } else {
        setLocalError(null)
        encoded = parseUnits(trimmed, decimals).toString()
      }
    } else {
      setLocalError(null)
    }
    lastEmitted.current = encoded
    onChange(encoded)
  }
  return { text, update, localError }
}

/** A percentage stored as basis points (10000 = 100%). */
export function BpsField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const { text, update, localError } = useScaledText(
    value,
    BPS_DECIMALS,
    onChange
  )
  const shownError = error ?? localError ?? undefined
  const numeric = Number(text)
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={shownError}
      current={current}
      notes={
        <div className="px-1 pt-1">
          <Slider
            value={
              text && Number.isFinite(numeric)
                ? Math.min(100, Math.max(0, numeric))
                : 0
            }
            onValueChange={(next) => update(String(Math.round(next)))}
            min={0}
            max={100}
            ariaLabel={`${spec.label} slider`}
          />
        </div>
      }
    >
      <SuffixInput
        id={id}
        value={text}
        suffix="%"
        placeholder="0"
        onChange={update}
        onBlur={onBlur}
        error={shownError}
        spec={spec}
      />
    </FieldShell>
  )
}

/** A dollar amount stored as USD × 1e8. */
export function UsdField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const { text, update, localError } = useScaledText(
    value,
    USD_DECIMALS,
    onChange
  )
  const shownError = error ?? localError ?? undefined
  const stored = stringValue(value)
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={shownError}
      current={current}
      notes={
        DIGITS.test(stored) && stored ? (
          <p className="text-xs text-text-muted">
            Encoded as {formatUsd8(stored)} in the vault’s 8-decimal USD.
          </p>
        ) : null
      }
    >
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-text-muted"
        >
          $
        </span>
        <Input
          id={id}
          value={text}
          onChange={(event) => update(event.target.value)}
          onBlur={onBlur}
          inputMode="decimal"
          placeholder="0.00"
          className="h-11 pl-7"
          aria-invalid={!!shownError}
          aria-describedby={describedBy(id, spec, shownError)}
        />
      </div>
    </FieldShell>
  )
}

/** A whole number used as-is, optionally chosen from a list (proposal ids). */
export function IntegerField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const data = useGovernanceComposer()
  const text = stringValue(value)
  const options = spec.picker ? data?.pickers[spec.picker] : undefined
  const chosen = options?.find((option) => option.value === text)
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        <>
          {chosen?.description && (
            <p className="text-xs text-text-muted">{chosen.description}</p>
          )}
          {options && (
            <PickerOptions
              options={options}
              label={spec.label}
              selected={text}
              onPick={(option) => onChange(option.value, option.fill)}
            />
          )}
        </>
      }
    >
      <Input
        id={id}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        inputMode="numeric"
        placeholder={spec.placeholder}
        className="h-11"
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
    </FieldShell>
  )
}

function SuffixInput({
  id,
  value,
  suffix,
  placeholder,
  onChange,
  onBlur,
  error,
  spec,
}: {
  id: string
  value: string
  suffix: string
  placeholder?: string
  onChange: (value: string) => void
  onBlur: () => void
  error?: string
  spec: FieldComponentProps['spec']
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        inputMode="decimal"
        placeholder={placeholder}
        className={cn('h-11 pr-9')}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-text-muted"
      >
        {suffix}
      </span>
    </div>
  )
}
