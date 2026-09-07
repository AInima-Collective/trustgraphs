'use client'

import { Plus, X } from 'lucide-react'
import { isAddress, isHex } from 'viem'

import { Button } from '@/components/Button'
import { Input } from '@/components/Input'
import { Textarea } from '@/components/Textarea'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { APIS } from '@/lib/config'

import { FieldShell, PickerOptions, describedBy } from './FieldShell'
import { type FieldComponentProps, stringValue } from './types'

/** A 32-byte hash, typed or chosen from a list of the network's own (roots, queued actions). */
export function Bytes32Field(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const data = useGovernanceComposer()
  const text = stringValue(value)
  const options = spec.picker ? data?.pickers[spec.picker] : undefined
  const chosen = options?.find(
    (option) => option.value.toLowerCase() === text.trim().toLowerCase()
  )
  const hexChars = text.trim().startsWith('0x') ? text.trim().length - 2 : 0
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      trailing={
        text.trim() ? (
          <span className="text-xs tabular-nums text-text-muted">
            {hexChars === 64 && isHex(text.trim(), { strict: true })
              ? '32 bytes'
              : `${hexChars}/64 hex characters`}
          </span>
        ) : undefined
      }
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
          {spec.picker && !options?.length && data && (
            <p className="text-xs text-text-muted">
              Nothing to choose from yet; paste the value.
            </p>
          )}
        </>
      }
    >
      <Input
        id={id}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={spec.placeholder ?? '0x…'}
        className="h-11 font-mono"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
    </FieldShell>
  )
}

/** Arbitrary bytes as hex, with the byte count so a pasted manifest can be sanity-checked. */
export function BytesField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const text = stringValue(value)
  const trimmed = text.trim()
  const bytes =
    isHex(trimmed, { strict: true }) && trimmed.length % 2 === 0
      ? (trimmed.length - 2) / 2
      : null
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      trailing={
        bytes !== null && trimmed !== '0x' ? (
          <span className="text-xs tabular-nums text-text-muted">
            {bytes.toLocaleString('en-US')} bytes
          </span>
        ) : undefined
      }
    >
      <Textarea
        id={id}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={spec.placeholder ?? '0x'}
        className="min-h-24 font-mono text-xs"
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
    </FieldShell>
  )
}

const previewHref = (uri: string): string | null => {
  const trimmed = uri.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const ipfs = trimmed.match(/^ipfs:\/\/(.+)$/i)
  if (ipfs && APIS.ipfsGateway) {
    const gateway = APIS.ipfsGateway.endsWith('/')
      ? APIS.ipfsGateway
      : `${APIS.ipfsGateway}/`
    return `${gateway}${ipfs[1]}`
  }
  return null
}

/** A full URI, with a way to open what it points at before proposing it. */
export function UriField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const text = stringValue(value)
  const href = previewHref(text)
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      notes={
        href ? (
          <p className="text-xs text-text-muted">
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-text"
            >
              Open what this points at
            </a>
          </p>
        ) : null
      }
    >
      <Input
        id={id}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={spec.placeholder}
        className="h-11"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
    </FieldShell>
  )
}

export function TextField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  return (
    <FieldShell id={id} spec={spec} error={error} current={current}>
      <Input
        id={id}
        value={stringValue(value)}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={spec.placeholder}
        className="h-11"
        aria-invalid={!!error}
        aria-describedby={describedBy(id, spec, error)}
      />
    </FieldShell>
  )
}

/** One address per row, with add and remove, instead of a newline-separated blob. */
export function AddressListField(props: FieldComponentProps) {
  const { id, spec, value, error, current, onChange, onBlur } = props
  const list = Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry : ''))
    : []
  const update = (next: string[]) => onChange(next)
  return (
    <FieldShell
      id={id}
      spec={spec}
      error={error}
      current={current}
      trailing={
        <span className="text-xs tabular-nums text-text-muted">
          {list.length} {list.length === 1 ? 'address' : 'addresses'}
        </span>
      }
    >
      <div className="space-y-2">
        {list.map((entry, index) => (
          <div key={index} className="flex gap-2">
            <Input
              id={index === 0 ? id : `${id}-${index}`}
              value={entry}
              onChange={(event) =>
                update(
                  list.map((existing, position) =>
                    position === index ? event.target.value : existing
                  )
                )
              }
              onBlur={onBlur}
              placeholder="0x…"
              className="h-11 min-w-0 flex-1 font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${spec.label} ${index + 1}`}
              aria-invalid={!!entry.trim() && !isAddress(entry.trim())}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${spec.label.toLowerCase()} ${index + 1}`}
              onClick={() =>
                update(list.filter((_, position) => position !== index))
              }
            >
              <X />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => update([...list, ''])}
        >
          <Plus />
          Add address
        </Button>
      </div>
    </FieldShell>
  )
}
