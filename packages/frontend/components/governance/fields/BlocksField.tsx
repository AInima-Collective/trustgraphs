'use client'

import { useEffect, useRef, useState } from 'react'

import { Input } from '@/components/Input'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { blocksForSeconds, formatBlockCount } from '@/lib/actions'
import { formatApproxDuration } from '@/lib/duration'

import { FieldShell, describedBy } from './FieldShell'
import { DIGITS, type FieldComponentProps, stringValue } from './types'

type Unit = 'blocks' | 'minutes' | 'hours' | 'days'

const UNIT_SECONDS: Record<Exclude<Unit, 'blocks'>, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
}

/** The largest whole unit that expresses the block count exactly, so a reload shows "2 days". */
const unitFor = (
  blocks: string,
  blockTime: number
): { text: string; unit: Unit } => {
  if (!DIGITS.test(blocks) || blocks === '0')
    return { text: blocks, unit: 'blocks' }
  const count = Number(blocks)
  if (!Number.isSafeInteger(count)) return { text: blocks, unit: 'blocks' }
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    const perUnit = UNIT_SECONDS[unit] / blockTime
    if (Number.isInteger(perUnit) && perUnit > 0 && count % perUnit === 0) {
      return { text: String(count / perUnit), unit }
    }
  }
  return { text: blocks, unit: 'blocks' }
}

/**
 * A block count entered as a duration. The chain's block time turns "2 days" into blocks; the
 * stored value is always the block count, and the estimate is shown as one.
 */
export function BlocksField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const data = useGovernanceComposer()
  const blockTime = data?.blockTimeSeconds ?? 12
  const stored = stringValue(value)
  const [entry, setEntry] = useState(() => unitFor(stored, blockTime))
  const lastEmitted = useRef(stored)
  useEffect(() => {
    if (stored === lastEmitted.current) return
    lastEmitted.current = stored
    setEntry(unitFor(stored, blockTime))
  }, [blockTime, stored])

  const emit = (text: string, unit: Unit) => {
    setEntry({ text, unit })
    const trimmed = text.trim()
    let next = ''
    if (unit === 'blocks') {
      next = trimmed
    } else if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      next = blocksForSeconds(
        Number(trimmed) * UNIT_SECONDS[unit],
        blockTime
      ).toString()
    }
    lastEmitted.current = next
    onChange(next)
  }

  const estimate = DIGITS.test(stored)
    ? entry.unit === 'blocks'
      ? Number(stored) > 0
        ? `About ${formatApproxDuration(Number(stored) * blockTime).replace(/^~/, '')} at ~${blockTime}s per block.`
        : ''
      : `Encoded as ${formatBlockCount(stored)} at ~${blockTime}s per block.`
    : ''

  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        estimate ? <p className="text-xs text-text-muted">{estimate}</p> : null
      }
    >
      <div className="flex gap-2">
        <Input
          id={id}
          value={entry.text}
          onChange={(event) => emit(event.target.value, entry.unit)}
          onBlur={onBlur}
          inputMode={entry.unit === 'blocks' ? 'numeric' : 'decimal'}
          placeholder="0"
          className="h-11 min-w-0 flex-1"
          aria-invalid={!!error}
          aria-describedby={describedBy(id, spec, error)}
        />
        <select
          aria-label={`${spec.label} unit`}
          value={entry.unit}
          onChange={(event) => {
            const unit = event.target.value as Unit
            // Re-express the same block count in the new unit when it divides evenly;
            // otherwise keep the typed number and re-encode it in the new unit.
            const exact = unitFor(stored, blockTime)
            if (exact.unit === unit) emit(exact.text, unit)
            else emit(entry.text, unit)
          }}
          className="tg-input h-11 shrink-0 border border-input bg-surface px-2 text-sm text-text"
        >
          <option value="blocks">blocks</option>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
    </FieldShell>
  )
}
