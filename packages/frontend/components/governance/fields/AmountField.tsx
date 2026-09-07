'use client'

import { useEffect, useRef, useState } from 'react'
import { formatUnits, isAddress, parseUnits, zeroAddress } from 'viem'

import { Button } from '@/components/Button'
import { Input } from '@/components/Input'
import { useGovernanceComposer } from '@/components/governance/GovernanceComposerContext'
import { type TokenDisplay, formatTokenAmount } from '@/lib/actions'
import { cn } from '@/lib/utils'

import { FieldShell, describedBy } from './FieldShell'
import { DIGITS, type FieldComponentProps, stringValue } from './types'

const DECIMAL = /^\d*(?:\.\d*)?$/

const decimalToBaseUnits = (
  text: string,
  decimals: number
): { value: string } | { error: string } => {
  const trimmed = text.trim()
  if (!trimmed) return { value: '' }
  if (!DECIMAL.test(trimmed)) return { error: 'Enter a decimal amount.' }
  const [, fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals) {
    return {
      error: `This token keeps at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.`,
    }
  }
  try {
    return { value: parseUnits(trimmed, decimals).toString() }
  } catch {
    return { error: 'Enter a decimal amount.' }
  }
}

const baseUnitsToDecimal = (value: unknown, decimals: number) => {
  const text = stringValue(value)
  return DIGITS.test(text) ? formatUnits(BigInt(text), decimals) : ''
}

/**
 * A token amount typed as people think of it and stored as the base units the contract takes.
 * The token's decimals come from the sibling token field (or are fixed by the action); until
 * they are known, or when the token cannot be read, the field falls back to base units.
 */
export function AmountField(props: FieldComponentProps) {
  const { id, spec, value, values, error, current, onChange, onBlur } = props
  const data = useGovernanceComposer()
  const isEther = spec.kind === 'ether'
  const tokenField =
    spec.token && 'field' in spec.token ? spec.token.field : undefined
  const tokenAddress = tokenField ? stringValue(values[tokenField]).trim() : ''
  const fixed: TokenDisplay | undefined = isEther
    ? { decimals: 18, symbol: 'ETH' }
    : spec.token && !('field' in spec.token)
      ? spec.token
      : undefined
  const tokenKnown = !!tokenAddress && isAddress(tokenAddress)
  const meta = fixed ?? (tokenKnown ? data?.token(tokenAddress) : undefined)
  const tokenState = fixed
    ? 'ready'
    : tokenKnown
      ? (data?.tokenState(tokenAddress) ?? 'loading')
      : 'idle'
  const balanceKey = isEther
    ? zeroAddress
    : fixed
      ? spec.token && 'symbol' in spec.token && spec.token.symbol === 'ETH'
        ? zeroAddress
        : undefined
      : tokenKnown
        ? tokenAddress
        : undefined
  const balance = balanceKey ? data?.treasuryBalance(balanceKey) : undefined

  // Ether fields store the decimal text itself; amounts store base units and keep a local
  // decimal rendering in sync unless the last change came from this field.
  const [text, setText] = useState(() =>
    isEther
      ? stringValue(value)
      : meta
        ? baseUnitsToDecimal(value, meta.decimals)
        : ''
  )
  const [rawMode, setRawMode] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const lastEmitted = useRef<unknown>(value)
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setLocalError(null)
    setText(
      isEther
        ? stringValue(value)
        : meta
          ? baseUnitsToDecimal(value, meta.decimals)
          : ''
    )
  }, [isEther, meta, value])
  useEffect(() => {
    // Decimals arrived after the value did (prefill, picker): render it now.
    if (!isEther && meta && !text && DIGITS.test(stringValue(value))) {
      setText(baseUnitsToDecimal(value, meta.decimals))
    }
  }, [isEther, meta, text, value])

  const emit = (next: string) => {
    lastEmitted.current = next
    onChange(next)
  }
  const handleText = (next: string) => {
    setText(next)
    if (isEther) {
      emit(next.trim())
      return
    }
    if (!meta) return
    const result = decimalToBaseUnits(next, meta.decimals)
    if ('error' in result) {
      setLocalError(result.error)
      emit('')
    } else {
      setLocalError(null)
      emit(result.value)
    }
  }
  const useMax = () => {
    if (balance === undefined || !meta) return
    handleText(formatUnits(balance, meta.decimals))
  }

  const raw = rawMode || (!isEther && !fixed && tokenState === 'error')
  const waiting = !isEther && !meta && !raw
  const shownError = error ?? localError ?? undefined

  return (
    <FieldShell
      id={id}
      spec={spec}
      error={shownError}
      current={current}
      trailing={
        balance !== undefined && meta && !raw ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={useMax}
          >
            Max
          </Button>
        ) : undefined
      }
      notes={
        <>
          {balance !== undefined && meta && (
            <p className="text-xs text-text-muted">
              Treasury holds {formatTokenAmount(balance.toString(), meta)}.
            </p>
          )}
          {waiting && (
            <p className="text-xs text-text-muted">
              {tokenState === 'loading'
                ? 'Reading the token’s decimals…'
                : 'Choose the token first, or enter base units.'}
            </p>
          )}
          {!isEther && !fixed && tokenState === 'error' && (
            <p className="text-xs text-warn">
              This token’s decimals could not be read, so the amount is taken as
              base units.
            </p>
          )}
          {!isEther && !raw && meta && DIGITS.test(stringValue(value)) && (
            <p className="text-xs text-text-muted">
              Encoded as {stringValue(value)} base units.
            </p>
          )}
          {!isEther && !(!fixed && tokenState === 'error') && (
            <button
              type="button"
              onClick={() => setRawMode((mode) => !mode)}
              className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              {rawMode
                ? `Enter as ${meta?.symbol ?? 'tokens'} instead`
                : 'Enter base units instead'}
            </button>
          )}
        </>
      }
    >
      {raw ? (
        <Input
          id={id}
          value={stringValue(value)}
          onChange={(event) => emit(event.target.value.trim())}
          onBlur={onBlur}
          inputMode="numeric"
          placeholder="Base units"
          className="h-11"
          aria-invalid={!!shownError}
          aria-describedby={describedBy(id, spec, shownError)}
        />
      ) : (
        <div className="relative">
          <Input
            id={id}
            value={text}
            onChange={(event) => handleText(event.target.value)}
            onBlur={onBlur}
            inputMode="decimal"
            placeholder={spec.placeholder ?? '0.0'}
            disabled={waiting}
            className={cn('h-11', meta && 'pr-16')}
            aria-invalid={!!shownError}
            aria-describedby={describedBy(id, spec, shownError)}
          />
          {meta && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-text-muted"
            >
              {meta.symbol}
            </span>
          )}
        </div>
      )}
    </FieldShell>
  )
}
