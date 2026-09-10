'use client'

import { isAddress } from 'viem'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'

import { FieldShell, PickerOptions, describedBy } from './FieldShell'
import { type FieldComponentProps, stringValue } from './types'

const previews = (values: Record<string, unknown>) => {
  const value = values.resolvedAddresses
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * An account: a checksummed address or an ENS name. Names resolve as you type; the resolved
 * address is kept beside the draft so encoding can detect a name that moved since preview.
 */
export function AddressField(props: FieldComponentProps) {
  const { id, spec, value, values, error, current, onChange, onBlur } = props
  const data = useGovernanceComposer()
  const text = stringValue(value)
  const options = spec.picker ? data?.pickers[spec.picker] : undefined
  const known = isAddress(text) ? data?.contractLabel(text) : undefined

  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        <>
          {known && (
            <p className="text-xs text-text-muted">
              This is the network’s {known}.
            </p>
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
      <AccountIdentifierInput
        id={id}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onResolvedAddressChange={(address) => {
          const existing = previews(values)
          const next = address ?? undefined
          if (existing[spec.key] === next) return
          onChange(text, {
            resolvedAddresses: { ...existing, [spec.key]: next },
          })
        }}
        placeholder={spec.placeholder}
        className="h-11 font-mono"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
    </FieldShell>
  )
}
