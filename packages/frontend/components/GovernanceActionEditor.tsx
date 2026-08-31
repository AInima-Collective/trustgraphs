'use client'

import { useState } from 'react'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import type { GovernanceActionDraft } from '@/lib/actions'

const inputClassName =
  'w-full rounded-md border border-input bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (values: Record<string, unknown>, key: string) =>
  typeof values[key] === 'string' ? (values[key] as string) : ''

const fieldLabel = 'text-xs font-medium text-muted-foreground'

type EditorProps = {
  draft: GovernanceActionDraft
  onChange: (values: unknown) => void
}

function ScoringEditor({
  values,
  onChange,
}: {
  values: Record<string, unknown>
  onChange: (values: unknown) => void
}) {
  const [paramsJson, setParamsJson] = useState(() =>
    JSON.stringify(values.proposed ?? {}, null, 2)
  )
  const [jsonError, setJsonError] = useState<string | null>(null)

  const updateJson = (next: string) => {
    setParamsJson(next)
    try {
      const proposed = JSON.parse(next)
      if (
        !proposed ||
        typeof proposed !== 'object' ||
        Array.isArray(proposed)
      ) {
        throw new Error('Use a JSON object')
      }
      setJsonError(null)
      onChange({ ...values, proposed })
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : 'Invalid JSON')
      // Do not leave the last valid tuple submit-able while the editor visibly contains invalid
      // JSON. A later valid edit restores the exact parsed object.
      onChange({ ...values, proposed: null })
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className={fieldLabel}>Exact proposed parameters (JSON)</label>
        <textarea
          value={paramsJson}
          onChange={(event) => updateJson(event.target.value)}
          className={`${inputClassName} min-h-48 font-mono text-xs`}
          spellCheck={false}
          aria-invalid={!!jsonError}
        />
        {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
      </div>
      <div className="space-y-2">
        <label className={fieldLabel}>Evidence URI (optional)</label>
        <input
          value={text(values, 'evidenceURI')}
          onChange={(event) =>
            onChange({ ...values, evidenceURI: event.target.value })
          }
          className={inputClassName}
          placeholder="ipfs://…"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.syncSigner === true}
          onChange={(event) =>
            onChange({ ...values, syncSigner: event.target.checked })
          }
        />
        Synchronize signer selection to this configuration
      </label>
    </div>
  )
}

export function GovernanceActionEditor({ draft, onChange }: EditorProps) {
  const values = record(draft.values)

  switch (draft.actionKey) {
    case 'send-eth':
      return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel}>Recipient</label>
            <AccountIdentifierInput
              value={text(values, 'recipient')}
              onResolvedAddressChange={(previewAddress) =>
                onChange({ ...values, previewAddress })
              }
              onChange={(event) =>
                onChange({
                  ...values,
                  recipient: event.target.value,
                  previewAddress: null,
                })
              }
              placeholder="0x… or name.eth"
              className={`${inputClassName} font-mono`}
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel}>Amount (ETH)</label>
            <input
              value={text(values, 'amountEth')}
              onChange={(event) =>
                onChange({ ...values, amountEth: event.target.value })
              }
              inputMode="decimal"
              className={inputClassName}
              placeholder="0.0"
              required
            />
          </div>
        </div>
      )
    case 'update-scoring-params':
      return <ScoringEditor values={values} onChange={onChange} />
    case 'update-network-profile':
      return (
        <div className="space-y-4">
          {typeof values.snapshot === 'string' && (
            <div className="space-y-2">
              <label className={fieldLabel}>Target network snapshot</label>
              <input
                value={values.snapshot}
                onChange={(event) =>
                  onChange({ ...values, snapshot: event.target.value })
                }
                className={`${inputClassName} font-mono`}
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <label className={fieldLabel}>Metadata URI</label>
            <input
              value={text(values, 'metadataURI')}
              onChange={(event) =>
                onChange({ ...values, metadataURI: event.target.value })
              }
              className={inputClassName}
              placeholder="ipfs://…"
              required
            />
          </div>
        </div>
      )
    case 'set-signer-sync-paused':
      return (
        <div className="space-y-2">
          <label className={fieldLabel}>Signer synchronization</label>
          <select
            value={values.paused === false ? 'active' : 'paused'}
            onChange={(event) =>
              onChange({ ...values, paused: event.target.value === 'paused' })
            }
            className={inputClassName}
          >
            <option value="paused">Pause new signer proofs</option>
            <option value="active">Resume signer proofs</option>
          </select>
        </div>
      )
    case 'rotate-weighted-prior':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={fieldLabel}>Weighted parameters controller</label>
            <input
              value={text(values, 'controller')}
              onChange={(event) =>
                onChange({ ...values, controller: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel}>Canonical manifest bytes</label>
            <textarea
              value={text(values, 'manifest')}
              onChange={(event) =>
                onChange({ ...values, manifest: event.target.value })
              }
              className={`${inputClassName} min-h-28 font-mono text-xs`}
              spellCheck={false}
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel}>Metadata digest</label>
            <input
              value={text(values, 'metadataDigest')}
              onChange={(event) =>
                onChange({ ...values, metadataDigest: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              required
            />
          </div>
        </div>
      )
    case 'custom': {
      const operation = values.operation === 1 ? 1 : 0
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className={fieldLabel}>Target contract</label>
              <input
                value={text(values, 'target')}
                onChange={(event) =>
                  onChange({ ...values, target: event.target.value })
                }
                className={`${inputClassName} font-mono`}
                required
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel}>Value (ETH)</label>
              <input
                value={text(values, 'valueEth')}
                onChange={(event) =>
                  onChange({ ...values, valueEth: event.target.value })
                }
                inputMode="decimal"
                className={inputClassName}
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel}>Operation</label>
              <select
                value={operation}
                onChange={(event) =>
                  onChange({ ...values, operation: Number(event.target.value) })
                }
                className={inputClassName}
              >
                <option value={0}>Call</option>
                <option value={1}>DelegateCall (advanced)</option>
              </select>
            </div>
          </div>
          {operation === 1 && (
            <p className="text-xs text-warn">
              DelegateCall runs the target&apos;s code as the treasury itself.
              Review it especially carefully.
            </p>
          )}
          <div className="space-y-2">
            <label className={fieldLabel}>What this call does</label>
            <input
              value={text(values, 'description')}
              onChange={(event) =>
                onChange({ ...values, description: event.target.value })
              }
              className={inputClassName}
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel}>Calldata</label>
            <textarea
              value={text(values, 'data')}
              onChange={(event) =>
                onChange({ ...values, data: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              rows={3}
              spellCheck={false}
            />
          </div>
        </div>
      )
    }
  }
}
