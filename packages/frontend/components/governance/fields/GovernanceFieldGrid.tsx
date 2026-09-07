'use client'

import { type ReactNode, useState } from 'react'
import { isAddress } from 'viem'

import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import {
  type GovernanceFieldSpec,
  formatGovernanceFieldValue,
} from '@/lib/actions'

import { AddressField } from './AddressField'
import { AmountField } from './AmountField'
import { BlocksField } from './BlocksField'
import { BooleanField, OperationField } from './ChoiceFields'
import { BpsField, IntegerField, PercentField, UsdField } from './NumberFields'
import {
  AddressListField,
  Bytes32Field,
  BytesField,
  TextField,
  UriField,
} from './TextFields'
import { TimestampField } from './TimestampField'
import type { FieldComponentProps, FieldCurrentValue } from './types'

const hasValue = (value: unknown) =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === 'string'
      ? value.trim().length > 0
      : value !== undefined && value !== null

function FieldFor(props: FieldComponentProps) {
  switch (props.spec.kind) {
    case 'address':
      return <AddressField {...props} />
    case 'amount':
    case 'ether':
      return <AmountField {...props} />
    case 'timestamp':
      return <TimestampField {...props} />
    case 'blocks':
      return <BlocksField {...props} />
    case 'percent':
      return <PercentField {...props} />
    case 'bps':
      return <BpsField {...props} />
    case 'usd':
      return <UsdField {...props} />
    case 'boolean':
      return <BooleanField {...props} />
    case 'operation':
      return <OperationField {...props} />
    case 'bytes32':
      return <Bytes32Field {...props} />
    case 'bytes':
      return <BytesField {...props} />
    case 'uri':
      return <UriField {...props} />
    case 'integer':
      return <IntegerField {...props} />
    case 'address-list':
      return <AddressListField {...props} />
    case 'text':
      return <TextField {...props} />
    case 'params':
      // Structured editors own this kind; the grid never renders it.
      return null
  }
}

/**
 * Renders an action's fields two-up, keeps track of which ones the person has touched so
 * errors appear after interaction (or all at once when review is attempted), and folds
 * derived fields into an "Advanced" disclosure.
 */
export function GovernanceFieldGrid({
  idBase,
  fields,
  values,
  errors,
  showAllErrors,
  onChange,
  children,
}: {
  idBase: string
  fields: readonly GovernanceFieldSpec[]
  values: Record<string, unknown>
  errors: Record<string, string>
  showAllErrors: boolean
  onChange: (values: Record<string, unknown>) => void
  /** Rendered inside the grid after the visible fields (structured editors, notes). */
  children?: ReactNode
}) {
  const data = useGovernanceComposer()
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())

  const currentFor = (
    spec: GovernanceFieldSpec
  ): FieldCurrentValue | undefined => {
    if (!spec.current || !data) return undefined
    const raw = data.current[spec.current]
    if (raw === undefined) return undefined
    const value = values[spec.key]
    if (spec.kind === 'boolean') {
      const flag = raw === 'true'
      return {
        display: flag
          ? (spec.options?.true ?? 'Yes')
          : (spec.options?.false ?? 'No'),
        same: value === flag,
      }
    }
    const typed = typeof value === 'string' ? value.trim() : ''
    if (spec.kind === 'address') {
      const label = data.contractLabel(raw)
      return {
        display: label ? `${raw} (${label})` : raw,
        same: isAddress(typed) && typed.toLowerCase() === raw.toLowerCase(),
      }
    }
    return {
      display: formatGovernanceFieldValue(spec, raw, values, {
        tokens: data.token,
        blockTimeSeconds: data.blockTimeSeconds,
      }),
      same: !!typed && typed === raw,
    }
  }

  const render = (spec: GovernanceFieldSpec) => {
    if (spec.kind === 'params') return null
    const value = values[spec.key]
    const error = errors[spec.key]
    const show =
      !!error &&
      (showAllErrors ||
        touched.has(spec.key) ||
        (hasValue(value) && error !== 'Required.'))
    return (
      <FieldFor
        key={spec.key}
        id={`${idBase}-${spec.key}`}
        spec={spec}
        value={value}
        values={values}
        error={show ? error : undefined}
        current={currentFor(spec)}
        onChange={(next, extra) =>
          onChange({ ...values, [spec.key]: next, ...(extra ?? {}) })
        }
        onBlur={() =>
          setTouched((existing) =>
            existing.has(spec.key) ? existing : new Set([...existing, spec.key])
          )
        }
      />
    )
  }

  const visible = fields.filter((spec) => !spec.advanced)
  const advanced = fields.filter((spec) => spec.advanced)

  return (
    <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
      {visible.map(render)}
      {children}
      {advanced.length > 0 && (
        <details className="@min-[28rem]:col-span-2 border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-text-muted">
            Advanced
          </summary>
          <div className="grid grid-cols-1 gap-4 border-t border-border p-3 @min-[28rem]:grid-cols-2">
            {advanced.map(render)}
          </div>
        </details>
      )}
    </div>
  )
}
