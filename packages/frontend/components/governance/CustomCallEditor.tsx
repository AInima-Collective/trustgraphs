'use client'

import { useMemo, useState } from 'react'
import { type Abi, type AbiFunction, isAddress } from 'viem'

import { GovernanceFieldGrid } from '@/components/governance/fields/GovernanceFieldGrid'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { Textarea } from '@/components/Textarea'
import {
  type GovernanceActionContext,
  decodeKnownCall,
  encodeCustomCall,
  functionSignature,
  governanceActionFields,
  knownContractFor,
  parseAbiText,
  parseFunctionArgument,
  shortenHex,
  writableFunctions,
} from '@/lib/actions'
import { cn } from '@/lib/utils'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (values: Record<string, unknown>, key: string) =>
  typeof values[key] === 'string' ? (values[key] as string) : ''

type Builder = { signature?: string; args?: string[] }

const builderOf = (values: Record<string, unknown>): Builder => {
  const raw = record(values.builder)
  return {
    ...(typeof raw.signature === 'string' ? { signature: raw.signature } : {}),
    args: Array.isArray(raw.args)
      ? raw.args.map((entry) => (typeof entry === 'string' ? entry : ''))
      : [],
  }
}

const placeholderFor = (type: string) =>
  type === 'address'
    ? '0x…'
    : type === 'bool'
      ? 'true or false'
      : /^u?int/.test(type)
        ? '0'
        : type.endsWith(']')
          ? '["…", "…"]'
          : type === 'tuple'
            ? '{ "field": "…" }'
            : type.startsWith('bytes')
              ? '0x…'
              : ''

/**
 * A custom call built from an ABI instead of pasted calldata. The network's own contracts
 * bring their ABI; any other target takes a pasted one. Raw calldata stays available, and is
 * what the draft stores either way.
 */
export function CustomCallEditor({
  idBase,
  values,
  fieldErrors,
  showAllErrors,
  onChange,
}: {
  idBase: string
  values: Record<string, unknown>
  fieldErrors: Record<string, string>
  showAllErrors: boolean
  onChange: (values: Record<string, unknown>) => void
}) {
  const data = useGovernanceComposer()
  const context: GovernanceActionContext = data?.actionContext ?? {}
  const target = text(values, 'target').trim()
  const contract = knownContractFor(context, target)
  const calldata = text(values, 'data').trim() || '0x'
  const builder = builderOf(values)
  const [mode, setMode] = useState<'abi' | 'raw'>(() =>
    builder.signature || calldata === '0x' ? 'abi' : 'raw'
  )
  const [argErrors, setArgErrors] = useState<Record<number, string>>({})

  const pasted = text(values, 'customAbi')
  const pastedAbi = useMemo<Abi | Error | null>(() => {
    if (!pasted.trim()) return null
    try {
      return parseAbiText(pasted)
    } catch (failure) {
      return failure instanceof Error ? failure : new Error('Invalid ABI')
    }
  }, [pasted])
  const abi: Abi | null =
    contract?.abi ??
    (pastedAbi && !(pastedAbi instanceof Error) ? pastedAbi : null)
  const functions = useMemo(() => (abi ? writableFunctions(abi) : []), [abi])
  const selected = functions.find(
    (fn) => functionSignature(fn) === builder.signature
  )
  const decoded = useMemo(
    () =>
      contract
        ? decodeKnownCall(context, target, calldata as `0x${string}`)
        : null,
    [calldata, context, contract, target]
  )

  const fields = governanceActionFields('custom')
  const gridFields = fields.filter((field) =>
    mode === 'raw' ? true : field.key !== 'data'
  )

  const rebuild = (nextBuilder: Builder, fn: AbiFunction | undefined) => {
    const errors: Record<number, string> = {}
    let encoded = '0x'
    if (fn && abi) {
      fn.inputs.forEach((input, index) => {
        try {
          parseFunctionArgument(input, nextBuilder.args?.[index] ?? '')
        } catch (failure) {
          errors[index] =
            failure instanceof Error ? failure.message : 'Invalid value'
        }
      })
      if (!Object.keys(errors).length) {
        try {
          encoded = encodeCustomCall(abi, fn, nextBuilder.args ?? [])
        } catch (failure) {
          errors[-1] =
            failure instanceof Error ? failure.message : 'Could not encode'
        }
      }
    }
    setArgErrors(errors)
    const description = text(values, 'description').trim()
    onChange({
      ...values,
      builder: nextBuilder,
      data: encoded,
      description:
        description || !fn
          ? values.description
          : `${contract?.label ?? 'Contract'}: ${fn.name}`,
    })
  }

  const chooseFunction = (signature: string) => {
    const fn = functions.find((entry) => functionSignature(entry) === signature)
    rebuild(
      {
        signature: signature || undefined,
        args: fn ? fn.inputs.map(() => '') : [],
      },
      fn
    )
  }

  const valueEth = text(values, 'valueEth').trim()
  const sendsEth = !!valueEth && valueEth !== '0' && Number(valueEth) > 0

  return (
    <div className="space-y-4">
      <div
        role="radiogroup"
        aria-label="How to enter the call"
        className="inline-grid grid-cols-2 gap-px border border-border bg-border"
      >
        {(
          [
            ['abi', 'Build from ABI'],
            ['raw', 'Raw calldata'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              'min-h-9 px-3 text-xs transition-colors',
              mode === value
                ? 'bg-ink text-ink-fg'
                : 'bg-surface text-text-muted hover:text-text'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <GovernanceFieldGrid
        idBase={idBase}
        fields={gridFields}
        values={values}
        errors={fieldErrors}
        showAllErrors={showAllErrors}
        onChange={onChange}
      >
        {mode === 'abi' && (
          <div className="space-y-4 @min-[28rem]:col-span-2">
            {contract ? (
              <p className="text-xs text-text-muted">
                Using the ABI of the network’s {contract.label.toLowerCase()}.
              </p>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={`${idBase}-customAbi`}>
                  Contract ABI
                  <span className="ml-1 normal-case tracking-normal text-text-subtle">
                    (JSON, or one signature per line)
                  </span>
                </Label>
                <Textarea
                  id={`${idBase}-customAbi`}
                  value={pasted}
                  onChange={(event) =>
                    onChange({ ...values, customAbi: event.target.value })
                  }
                  placeholder={
                    'function transfer(address to, uint256 amount)\nfunction setOwner(address owner)'
                  }
                  className="min-h-24 font-mono text-xs"
                  spellCheck={false}
                  aria-invalid={pastedAbi instanceof Error}
                />
                {pastedAbi instanceof Error && (
                  <p className="text-xs text-error">{pastedAbi.message}</p>
                )}
                {!isAddress(target) && (
                  <p className="text-xs text-text-muted">
                    Choose one of the network’s contracts above to use its ABI
                    automatically.
                  </p>
                )}
              </div>
            )}
            {abi && (
              <div className="space-y-2">
                <Label htmlFor={`${idBase}-function`}>Function</Label>
                <select
                  id={`${idBase}-function`}
                  value={builder.signature ?? ''}
                  onChange={(event) => chooseFunction(event.target.value)}
                  className="tg-input h-11 w-full border border-input bg-surface px-3 font-mono text-sm text-text"
                >
                  <option value="">Choose a function…</option>
                  {functions.map((fn) => {
                    const signature = functionSignature(fn)
                    return (
                      <option key={signature} value={signature}>
                        {signature}
                        {fn.stateMutability === 'payable' ? ' payable' : ''}
                      </option>
                    )
                  })}
                </select>
                {abi && !functions.length && (
                  <p className="text-xs text-text-muted">
                    This ABI has no state-changing functions.
                  </p>
                )}
              </div>
            )}
            {selected && (
              <div className="grid grid-cols-1 gap-4 @min-[28rem]:grid-cols-2">
                {selected.inputs.map((input, index) => {
                  const id = `${idBase}-arg-${index}`
                  const error = argErrors[index]
                  return (
                    <div key={id} className="min-w-0 space-y-2">
                      <Label htmlFor={id}>
                        {input.name || `Argument ${index + 1}`}
                        <span className="ml-1 normal-case tracking-normal text-text-subtle">
                          {input.type}
                        </span>
                      </Label>
                      <Input
                        id={id}
                        value={builder.args?.[index] ?? ''}
                        onChange={(event) => {
                          const args = [...(builder.args ?? [])]
                          args[index] = event.target.value
                          rebuild({ ...builder, args }, selected)
                        }}
                        placeholder={placeholderFor(input.type)}
                        className="h-11 font-mono"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!error}
                      />
                      {error && <p className="text-xs text-error">{error}</p>}
                    </div>
                  )
                })}
                {selected.inputs.length === 0 && (
                  <p className="text-xs text-text-muted">
                    This function takes no arguments.
                  </p>
                )}
                {argErrors[-1] && (
                  <p className="text-xs text-error @min-[28rem]:col-span-2">
                    {argErrors[-1]}
                  </p>
                )}
                {selected.stateMutability !== 'payable' && sendsEth && (
                  <p className="text-xs text-warn @min-[28rem]:col-span-2">
                    This function does not accept ETH, so sending a value would
                    revert.
                  </p>
                )}
              </div>
            )}
            {calldata !== '0x' && (
              <p className="break-all text-xs text-text-muted">
                Encodes as{' '}
                <span className="font-mono">{shortenHex(calldata, 10)}</span> (
                {(calldata.length - 2) / 2} bytes).
              </p>
            )}
          </div>
        )}
        {mode === 'raw' && decoded && (
          <p className="break-words text-xs text-text-muted @min-[28rem]:col-span-2">
            Decodes as{' '}
            <span className="font-mono">
              {decoded.contract.label}.{decoded.functionName}(
              {decoded.args.map((arg) => arg.value).join(', ')})
            </span>
          </p>
        )}
      </GovernanceFieldGrid>
    </div>
  )
}
