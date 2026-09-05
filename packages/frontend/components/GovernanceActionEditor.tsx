'use client'

import { useId, useState } from 'react'

import { AccountIdentifierInput } from '@/components/AccountIdentifierInput'
import type { GovernanceActionDraft } from '@/lib/actions'

const inputClassName =
  'min-h-11 w-full border border-hairline-strong bg-background px-3 py-2.5 text-sm text-text placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (values: Record<string, unknown>, key: string) =>
  typeof values[key] === 'string' ? (values[key] as string) : ''

const fieldLabel = 'block text-xs font-medium text-text'

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
  const fieldId = useId()
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
        <label className={fieldLabel} htmlFor={`${fieldId}-1`}>
          Exact proposed parameters (JSON)
        </label>
        <textarea
          id={`${fieldId}-1`}
          value={paramsJson}
          onChange={(event) => updateJson(event.target.value)}
          className={`${inputClassName} min-h-48 font-mono text-xs`}
          spellCheck={false}
          aria-invalid={!!jsonError}
        />
        {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
      </div>
      <div className="space-y-2">
        <label className={fieldLabel} htmlFor={`${fieldId}-2`}>
          Evidence URI (optional)
        </label>
        <input
          id={`${fieldId}-2`}
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

function BooleanChoice({
  label,
  value,
  trueLabel,
  falseLabel,
  onChange,
}: {
  label: string
  value: boolean
  trueLabel: string
  falseLabel: string
  onChange: (value: boolean) => void
}) {
  const fieldId = useId()
  return (
    <div className="space-y-2">
      <label className={fieldLabel} htmlFor={`${fieldId}-3`}>
        {label}
      </label>
      <select
        id={`${fieldId}-3`}
        value={value ? 'true' : 'false'}
        onChange={(event) => onChange(event.target.value === 'true')}
        className={inputClassName}
      >
        <option value="true">{trueLabel}</option>
        <option value="false">{falseLabel}</option>
      </select>
    </div>
  )
}

export function GovernanceActionEditor({ draft, onChange }: EditorProps) {
  const fieldId = useId()
  const values = record(draft.values)

  switch (draft.actionKey) {
    case 'send-eth':
      return (
        <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-4`}>
              Recipient
            </label>
            <AccountIdentifierInput
              id={`${fieldId}-4`}
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
            <label className={fieldLabel} htmlFor={`${fieldId}-5`}>
              Amount (ETH)
            </label>
            <input
              id={`${fieldId}-5`}
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
    case 'send-erc20':
      return (
        <div className="grid grid-cols-1 gap-4 @min-[36rem]:grid-cols-3">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-6`}>
              Token contract
            </label>
            <input
              id={`${fieldId}-6`}
              value={text(values, 'token')}
              onChange={(event) =>
                onChange({ ...values, token: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-7`}>
              Recipient
            </label>
            <input
              id={`${fieldId}-7`}
              value={text(values, 'recipient')}
              onChange={(event) =>
                onChange({ ...values, recipient: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-8`}>
              Amount (token base units)
            </label>
            <input
              id={`${fieldId}-8`}
              value={text(values, 'amountBaseUnits')}
              onChange={(event) =>
                onChange({ ...values, amountBaseUnits: event.target.value })
              }
              inputMode="numeric"
              className={inputClassName}
              placeholder="1000000"
              required
            />
          </div>
          <p className="text-xs text-muted-foreground @min-[36rem]:col-span-3">
            Enter the exact integer amount used by the token contract. For
            example, one token with 6 decimals is 1000000 base units.
          </p>
        </div>
      )
    case 'fund-rewards':
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-9`}>
                Reward token
              </label>
              <input
                id={`${fieldId}-9`}
                value={text(values, 'token')}
                onChange={(event) =>
                  onChange({ ...values, token: event.target.value })
                }
                className={`${inputClassName} font-mono`}
                required
              />
              <p className="text-xs text-muted-foreground">
                Use the zero address for native ETH.
              </p>
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-10`}>
                Amount (base units)
              </label>
              <input
                id={`${fieldId}-10`}
                value={text(values, 'amountBaseUnits')}
                onChange={(event) =>
                  onChange({ ...values, amountBaseUnits: event.target.value })
                }
                inputMode="numeric"
                className={inputClassName}
                required
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-11`}>
                Expected score root
              </label>
              <input
                id={`${fieldId}-11`}
                value={text(values, 'expectedRoot')}
                onChange={(event) =>
                  onChange({ ...values, expectedRoot: event.target.value })
                }
                className={`${inputClassName} font-mono`}
                placeholder="0x…"
                required
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-12`}>
                Expected total score
              </label>
              <input
                id={`${fieldId}-12`}
                value={text(values, 'expectedTotalMerkleValue')}
                onChange={(event) =>
                  onChange({
                    ...values,
                    expectedTotalMerkleValue: event.target.value,
                  })
                }
                inputMode="numeric"
                className={inputClassName}
                required
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-13`}>
                Claim deadline (Unix seconds; 0 means no expiry)
              </label>
              <input
                id={`${fieldId}-13`}
                value={text(values, 'claimDeadline')}
                onChange={(event) =>
                  onChange({ ...values, claimDeadline: event.target.value })
                }
                inputMode="numeric"
                className={inputClassName}
                required
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-14`}>
                Maximum fee (base units)
              </label>
              <input
                id={`${fieldId}-14`}
                value={text(values, 'maxFeeAmount')}
                onChange={(event) =>
                  onChange({ ...values, maxFeeAmount: event.target.value })
                }
                inputMode="numeric"
                className={inputClassName}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-15`}>
              Expected fee recipient
            </label>
            <input
              id={`${fieldId}-15`}
              value={text(values, 'expectedFeeRecipient')}
              onChange={(event) =>
                onChange({
                  ...values,
                  expectedFeeRecipient: event.target.value,
                })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
              required
            />
          </div>
          <p className="text-xs text-muted-foreground">
            ERC-20 funding produces an approval plus distribution span. Every
            root, denominator, and fee guard is encoded exactly as entered.
          </p>
        </div>
      )
    case 'set-rewards-paused':
      return (
        <BooleanChoice
          label="Rewards state"
          value={values.paused !== false}
          trueLabel="Pause funding and claims"
          falseLabel="Resume funding and claims"
          onChange={(paused) => onChange({ ...values, paused })}
        />
      )
    case 'set-rewards-fee-recipient':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-16`}>
            New fee recipient
          </label>
          <input
            id={`${fieldId}-16`}
            value={text(values, 'recipient')}
            onChange={(event) =>
              onChange({ ...values, recipient: event.target.value })
            }
            className={`${inputClassName} font-mono`}
            placeholder="0x…"
            required
          />
        </div>
      )
    case 'set-rewards-fee-percentage':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-17`}>
            Fee percentage
          </label>
          <input
            id={`${fieldId}-17`}
            value={text(values, 'feePercent')}
            onChange={(event) =>
              onChange({ ...values, feePercent: event.target.value })
            }
            inputMode="decimal"
            className={inputClassName}
            placeholder="2.5"
            required
          />
          <p className="text-xs text-muted-foreground">
            Decreases apply immediately. Increases are scheduled by the
            distributor&apos;s on-chain delay.
          </p>
        </div>
      )
    case 'set-rewards-allowlist-enabled':
      return (
        <BooleanChoice
          label="Funder allowlist"
          value={values.enabled !== false}
          trueLabel="Require allowlisted funders"
          falseLabel="Allow anyone to fund rewards"
          onChange={(enabled) => onChange({ ...values, enabled })}
        />
      )
    case 'set-rewards-distributor-allowance':
      return (
        <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-18`}>
              Funder address
            </label>
            <input
              id={`${fieldId}-18`}
              value={text(values, 'distributor')}
              onChange={(event) =>
                onChange({ ...values, distributor: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
              required
            />
          </div>
          <BooleanChoice
            label="Allowance"
            value={values.allowed !== false}
            trueLabel="Allow this funder"
            falseLabel="Remove this funder"
            onChange={(allowed) => onChange({ ...values, allowed })}
          />
        </div>
      )
    case 'update-scoring-params':
      return <ScoringEditor values={values} onChange={onChange} />
    case 'update-network-profile':
      return (
        <div className="space-y-4">
          {typeof values.snapshot === 'string' && (
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-19`}>
                Target network snapshot
              </label>
              <input
                id={`${fieldId}-19`}
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
            <label className={fieldLabel} htmlFor={`${fieldId}-20`}>
              Metadata URI
            </label>
            <input
              id={`${fieldId}-20`}
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
    case 'set-operational-role':
      return (
        <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-21`}>
              Account
            </label>
            <input
              id={`${fieldId}-21`}
              value={text(values, 'account')}
              onChange={(event) =>
                onChange({ ...values, account: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
              required
            />
          </div>
          <BooleanChoice
            label="Operational role"
            value={values.granted !== false}
            trueLabel="Grant role"
            falseLabel="Revoke role"
            onChange={(granted) => onChange({ ...values, granted })}
          />
        </div>
      )
    case 'propose-constitutional-transfer':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-22`}>
            Proposed successor
          </label>
          <input
            id={`${fieldId}-22`}
            value={text(values, 'successor')}
            onChange={(event) =>
              onChange({ ...values, successor: event.target.value })
            }
            className={`${inputClassName} font-mono`}
            placeholder="0x…"
            required
          />
          <p className="text-xs text-warn">
            The successor must accept on-chain. Acceptance grants it
            constitutional authority and removes this Safe&apos;s authority.
          </p>
        </div>
      )
    case 'cancel-constitutional-transfer':
      return (
        <p className="text-sm text-muted-foreground">
          This action cancels the snapshot&apos;s currently pending
          constitutional transfer. It has no editable arguments.
        </p>
      )
    case 'set-governance-quorum':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-23`}>
            Quorum (%)
          </label>
          <input
            id={`${fieldId}-23`}
            value={text(values, 'quorumPercent')}
            onChange={(event) =>
              onChange({ ...values, quorumPercent: event.target.value })
            }
            inputMode="decimal"
            className={inputClassName}
            placeholder="15"
            required
          />
          <p className="text-xs text-muted-foreground">
            Must be greater than 0 and at most 100. Abstentions do not count
            toward decisive quorum.
          </p>
        </div>
      )
    case 'set-governance-voting-delay':
    case 'set-governance-voting-period':
    case 'set-governance-execution-delay': {
      const labels = {
        'set-governance-voting-delay': 'Voting delay (blocks)',
        'set-governance-voting-period': 'Voting period (blocks)',
        'set-governance-execution-delay': 'Execution delay (blocks)',
      } as const
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-24`}>
            {labels[draft.actionKey]}
          </label>
          <input
            id={`${fieldId}-24`}
            value={text(values, 'blocks')}
            onChange={(event) =>
              onChange({ ...values, blocks: event.target.value })
            }
            inputMode="numeric"
            className={inputClassName}
            placeholder="0"
            required
          />
        </div>
      )
    }
    case 'set-governance-delegatecall-target':
      return (
        <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-25`}>
              Delegatecall target
            </label>
            <input
              id={`${fieldId}-25`}
              value={text(values, 'target')}
              onChange={(event) =>
                onChange({ ...values, target: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
              required
            />
          </div>
          <BooleanChoice
            label="Allowlist state"
            value={values.allowed !== false}
            trueLabel="Allow delegatecalls"
            falseLabel="Revoke delegatecalls"
            onChange={(allowed) => onChange({ ...values, allowed })}
          />
          <p className="text-xs text-warn md:col-span-2">
            Allowed delegatecall code executes in the Safe&apos;s storage
            context and bypasses its transaction guard.
          </p>
        </div>
      )
    case 'cancel-governance-proposal':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-26`}>
            Proposal ID to cancel
          </label>
          <input
            id={`${fieldId}-26`}
            value={text(values, 'proposalId')}
            onChange={(event) =>
              onChange({ ...values, proposalId: event.target.value })
            }
            inputMode="numeric"
            className={inputClassName}
            placeholder="1"
            required
          />
        </div>
      )
    case 'set-signer-sync-paused':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-27`}>
            Signer synchronization
          </label>
          <select
            id={`${fieldId}-27`}
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
            <label className={fieldLabel} htmlFor={`${fieldId}-28`}>
              Weighted parameters controller
            </label>
            <input
              id={`${fieldId}-28`}
              value={text(values, 'controller')}
              onChange={(event) =>
                onChange({ ...values, controller: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-29`}>
              Canonical manifest bytes
            </label>
            <textarea
              id={`${fieldId}-29`}
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
            <label className={fieldLabel} htmlFor={`${fieldId}-30`}>
              Metadata digest
            </label>
            <input
              id={`${fieldId}-30`}
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
    case 'cancel-weighted-prior':
    case 'cancel-composition-policy':
    case 'cancel-vault-withdrawal':
      return (
        <p className="text-sm text-muted-foreground">
          This action has no editable arguments. It applies to the authenticated
          pending item for this network.
        </p>
      )
    case 'propose-composition-policy':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-31`}>
              Canonical policy manifest (hex)
            </label>
            <textarea
              id={`${fieldId}-31`}
              value={text(values, 'manifest')}
              onChange={(event) =>
                onChange({ ...values, manifest: event.target.value })
              }
              className={`${inputClassName} min-h-24 font-mono text-xs`}
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-32`}>
              Source adapters (one per line)
            </label>
            <textarea
              id={`${fieldId}-32`}
              value={
                Array.isArray(values.adapters) ? values.adapters.join('\n') : ''
              }
              onChange={(event) =>
                onChange({
                  ...values,
                  adapters: event.target.value
                    .split(/\r?\n/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
              className={`${inputClassName} min-h-24 font-mono text-xs`}
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-33`}>
              Metadata digest
            </label>
            <input
              id={`${fieldId}-33`}
              value={text(values, 'metadataDigest')}
              onChange={(event) =>
                onChange({ ...values, metadataDigest: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
            />
          </div>
        </div>
      )
    case 'set-snapshot-verifier':
    case 'set-snapshot-accumulator':
    case 'set-snapshot-anchor-registry':
    case 'enable-safe-module':
    case 'set-safe-guard':
    case 'set-recovery-proposer': {
      const labels = {
        'set-snapshot-verifier': 'New proof verifier',
        'set-snapshot-accumulator': 'New attestation accumulator',
        'set-snapshot-anchor-registry': 'New anchor registry',
        'enable-safe-module': 'Module to enable',
        'set-safe-guard': 'New guard (zero address clears it)',
        'set-recovery-proposer': 'New recovery proposer',
      } as const
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-34`}>
            {labels[draft.actionKey]}
          </label>
          <input
            id={`${fieldId}-34`}
            value={text(values, 'address')}
            onChange={(event) =>
              onChange({ ...values, address: event.target.value })
            }
            className={`${inputClassName} font-mono`}
            placeholder="0x…"
          />
        </div>
      )
    }
    case 'disable-safe-module':
      return (
        <div className="grid gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-35`}>
              Previous module in Safe list
            </label>
            <input
              id={`${fieldId}-35`}
              value={text(values, 'previousModule')}
              onChange={(event) =>
                onChange({ ...values, previousModule: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-36`}>
              Module to disable
            </label>
            <input
              id={`${fieldId}-36`}
              value={text(values, 'module')}
              onChange={(event) =>
                onChange({ ...values, module: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
            />
          </div>
        </div>
      )
    case 'swap-safe-owner':
      return (
        <div className="grid gap-4 @min-[36rem]:grid-cols-3">
          {[
            ['previousOwner', 'Previous owner in Safe list'],
            ['oldOwner', 'Owner to replace'],
            ['newOwner', 'New owner'],
          ].map(([key, label]) => (
            <div className="space-y-2" key={key}>
              <label className={fieldLabel} htmlFor={`${fieldId}-${key}`}>
                {label}
              </label>
              <input
                id={`${fieldId}-${key}`}
                value={text(values, key!)}
                onChange={(event) =>
                  onChange({ ...values, [key!]: event.target.value })
                }
                className={`${inputClassName} font-mono`}
                placeholder="0x…"
              />
            </div>
          ))}
        </div>
      )
    case 'cancel-recovery-action':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-37`}>
            Queued recovery action ID
          </label>
          <input
            id={`${fieldId}-37`}
            value={text(values, 'actionId')}
            onChange={(event) =>
              onChange({ ...values, actionId: event.target.value })
            }
            className={`${inputClassName} font-mono`}
            placeholder="0x…"
          />
        </div>
      )
    case 'set-vault-policy':
      return (
        <div className="grid gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-38`}>
              Minimum paid interval (blocks)
            </label>
            <input
              id={`${fieldId}-38`}
              value={text(values, 'minPaidIntervalBlocks')}
              onChange={(event) =>
                onChange({
                  ...values,
                  minPaidIntervalBlocks: event.target.value,
                })
              }
              inputMode="numeric"
              className={inputClassName}
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-39`}>
              Maximum per root (USD × 1e8)
            </label>
            <input
              id={`${fieldId}-39`}
              value={text(values, 'maxPerRootUsd')}
              onChange={(event) =>
                onChange({ ...values, maxPerRootUsd: event.target.value })
              }
              inputMode="numeric"
              className={inputClassName}
            />
          </div>
        </div>
      )
    case 'request-vault-withdrawal':
      return (
        <div className="grid gap-4 @min-[28rem]:grid-cols-2">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-40`}>
              ETH amount (wei)
            </label>
            <input
              id={`${fieldId}-40`}
              value={text(values, 'ethAmount')}
              onChange={(event) =>
                onChange({ ...values, ethAmount: event.target.value })
              }
              inputMode="numeric"
              className={inputClassName}
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-41`}>
              USDC amount (base units)
            </label>
            <input
              id={`${fieldId}-41`}
              value={text(values, 'usdcAmount')}
              onChange={(event) =>
                onChange({ ...values, usdcAmount: event.target.value })
              }
              inputMode="numeric"
              className={inputClassName}
            />
          </div>
        </div>
      )
    case 'execute-vault-withdrawal':
      return (
        <div className="space-y-2">
          <label className={fieldLabel} htmlFor={`${fieldId}-42`}>
            Withdrawal recipient
          </label>
          <input
            id={`${fieldId}-42`}
            value={text(values, 'recipient')}
            onChange={(event) =>
              onChange({ ...values, recipient: event.target.value })
            }
            className={`${inputClassName} font-mono`}
            placeholder="0x…"
          />
        </div>
      )
    case 'create-contribution-round':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-43`}>
              Round name
            </label>
            <input
              id={`${fieldId}-43`}
              value={text(values, 'name')}
              onChange={(event) =>
                onChange({ ...values, name: event.target.value })
              }
              className={inputClassName}
            />
          </div>
          <div className="grid gap-4 @min-[28rem]:grid-cols-2">
            {[
              ['roundStart', 'Opens (Unix seconds)'],
              ['roundEnd', 'Closes (Unix seconds)'],
              ['totalPool', 'Pool shares'],
              ['evaluatorCarveoutBps', 'Rater reward (basis points)'],
            ].map(([key, label]) => (
              <div className="space-y-2" key={key}>
                <label className={fieldLabel} htmlFor={`${fieldId}-${key}`}>
                  {label}
                </label>
                <input
                  id={`${fieldId}-${key}`}
                  value={text(values, key!)}
                  onChange={(event) =>
                    onChange({ ...values, [key!]: event.target.value })
                  }
                  inputMode="numeric"
                  className={inputClassName}
                />
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-44`}>
              Payout token
            </label>
            <input
              id={`${fieldId}-44`}
              value={text(values, 'distributorToken')}
              onChange={(event) =>
                onChange({ ...values, distributorToken: event.target.value })
              }
              className={`${inputClassName} font-mono`}
              placeholder="0x…"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The parent network’s exact scoring tuple and epoch length remain
            attached to this draft and are shown in the encoded transaction.
          </p>
        </div>
      )
    case 'custom': {
      const operation = values.operation === 1 ? 1 : 0
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 @min-[36rem]:grid-cols-3">
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-45`}>
                Target contract
              </label>
              <input
                id={`${fieldId}-45`}
                value={text(values, 'target')}
                onChange={(event) =>
                  onChange({ ...values, target: event.target.value })
                }
                className={`${inputClassName} font-mono`}
                required
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-46`}>
                Value (ETH)
              </label>
              <input
                id={`${fieldId}-46`}
                value={text(values, 'valueEth')}
                onChange={(event) =>
                  onChange({ ...values, valueEth: event.target.value })
                }
                inputMode="decimal"
                className={inputClassName}
              />
            </div>
            <div className="space-y-2">
              <label className={fieldLabel} htmlFor={`${fieldId}-47`}>
                Operation
              </label>
              <select
                id={`${fieldId}-47`}
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
            <label className={fieldLabel} htmlFor={`${fieldId}-48`}>
              What this call does
            </label>
            <input
              id={`${fieldId}-48`}
              value={text(values, 'description')}
              onChange={(event) =>
                onChange({ ...values, description: event.target.value })
              }
              className={inputClassName}
              required
            />
          </div>
          <div className="space-y-2">
            <label className={fieldLabel} htmlFor={`${fieldId}-49`}>
              Calldata
            </label>
            <textarea
              id={`${fieldId}-49`}
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
