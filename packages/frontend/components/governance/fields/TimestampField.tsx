'use client'

import { useEffect, useRef, useState } from 'react'

import { Input } from '@/components/Input'
import { formatRelativeSeconds, formatUtcDateTime } from '@/lib/actions'
import { cn } from '@/lib/utils'

import { FieldShell, describedBy } from './FieldShell'
import { DIGITS, type FieldComponentProps, stringValue } from './types'

/** Unix seconds → the local `YYYY-MM-DDTHH:mm` a datetime-local input shows. */
const toLocalInput = (seconds: number) => {
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

const fromLocalInput = (value: string): string => {
  if (!value) return ''
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : ''
}

const PRESETS: { label: string; seconds: number }[] = [
  { label: 'Now', seconds: 0 },
  { label: 'In 1 week', seconds: 7 * 86400 },
  { label: 'In 1 month', seconds: 30 * 86400 },
  { label: 'In 3 months', seconds: 90 * 86400 },
]

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'local time'
  }
}

/**
 * A moment picked as a date and time in the person's own zone, stored as unix seconds, and
 * echoed back in UTC so proposers and reviewers read the same instant.
 */
export function TimestampField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const text = stringValue(value)
  const seconds = DIGITS.test(text) ? Number(text) : null
  const noExpiry = !!spec.zeroLabel && text === '0'
  const [local, setLocal] = useState(() =>
    seconds && seconds > 0 ? toLocalInput(seconds) : ''
  )
  const lastEmitted = useRef<string>(text)
  useEffect(() => {
    if (text === lastEmitted.current) return
    lastEmitted.current = text
    const next = DIGITS.test(text) ? Number(text) : null
    setLocal(next && next > 0 ? toLocalInput(next) : '')
  }, [text])

  const emit = (next: string) => {
    lastEmitted.current = next
    onChange(next)
  }
  const pick = (input: string) => {
    setLocal(input)
    emit(fromLocalInput(input))
  }
  const preset = (offset: number) => {
    const at = Math.floor(Date.now() / 1000) + offset
    setLocal(toLocalInput(at))
    emit(String(at))
  }

  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        <>
          {seconds !== null && seconds > 0 && (
            <p className="text-xs text-text-muted">
              {formatUtcDateTime(seconds)} · {formatRelativeSeconds(seconds)}
            </p>
          )}
          {!noExpiry && (
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESETS.map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  onClick={() => preset(entry.seconds)}
                  className="border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-hairline-strong hover:text-text"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          {spec.zeroLabel && (
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-4 accent-ink"
                checked={noExpiry}
                onChange={(event) => {
                  if (event.target.checked) {
                    setLocal('')
                    emit('0')
                  } else {
                    emit('')
                  }
                }}
              />
              {spec.zeroLabel}
            </label>
          )}
        </>
      }
    >
      <Input
        id={id}
        type="datetime-local"
        value={local}
        onChange={(event) => pick(event.target.value)}
        onBlur={onBlur}
        disabled={noExpiry}
        className={cn('h-11', noExpiry && 'opacity-50')}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
        aria-label={`${spec.label}, entered in ${timeZone()}`}
      />
    </FieldShell>
  )
}
