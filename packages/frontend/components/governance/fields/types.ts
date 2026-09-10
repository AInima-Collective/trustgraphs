import type { GovernanceFieldSpec } from '@/lib/actions'

/** What a live setting looks like next to the field that would replace it. */
export type FieldCurrentValue = {
  display: string
  /** The draft value equals the live one, so the action would change nothing. */
  same: boolean
}

export type FieldComponentProps = {
  id: string
  spec: GovernanceFieldSpec
  value: unknown
  /** Every value in the draft, for fields that depend on a sibling (token decimals). */
  values: Record<string, unknown>
  /** Already gated by the grid: present only when it should be shown. */
  error?: string
  current?: FieldCurrentValue
  /** `extra` merges sibling keys in the same update (resolved addresses, picker autofill). */
  onChange: (value: unknown, extra?: Record<string, unknown>) => void
  onBlur: () => void
}

export const stringValue = (value: unknown) =>
  typeof value === 'string' ? value : ''

export const DIGITS = /^(0|[1-9]\d*)$/
