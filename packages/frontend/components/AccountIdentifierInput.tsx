'use client'

import { Check, LoaderCircle, X } from 'lucide-react'
import React, { useEffect, useRef } from 'react'
import type { Address } from 'viem'

import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { useResolveEnsName } from '@/hooks/useEns'
import { isPotentialEnsName, parseAccountIdentifier } from '@/lib/ens'
import { cn } from '@/lib/utils'
import { getTargetChainConfig } from '@/lib/wagmi'

export interface AccountIdentifierInputProps
  extends Omit<React.ComponentProps<'input'>, 'value'> {
  value: string
  onResolvedAddressChange?: (address: Address | null) => void
  wrapperClassName?: string
  resolutionClassName?: string
}

/** A shared address/ENS input with an explicit destination preview. */
export const AccountIdentifierInput = React.forwardRef<
  HTMLInputElement,
  AccountIdentifierInputProps
>(
  (
    {
      value,
      onResolvedAddressChange,
      className,
      wrapperClassName,
      resolutionClassName,
      ...props
    },
    ref
  ) => {
    const parsed = parseAccountIdentifier(value)
    const ens = useResolveEnsName(parsed.kind === 'ens' ? parsed.name : '')
    const callbackRef = useRef(onResolvedAddressChange)
    callbackRef.current = onResolvedAddressChange

    const resolvedAddress =
      parsed.kind === 'address'
        ? parsed.address
        : ens.status === 'resolved'
          ? (ens.address as Address)
          : null

    useEffect(() => {
      callbackRef.current?.(resolvedAddress)
    }, [resolvedAddress])

    const invalidEnsCandidate =
      parsed.kind === 'invalid' && isPotentialEnsName(value)
    const showEnsStatus = parsed.kind === 'ens' || invalidEnsCandidate

    return (
      <div className={cn('w-full space-y-1.5', wrapperClassName)}>
        <div className="relative">
          <Input
            {...props}
            ref={ref}
            value={value}
            className={cn(showEnsStatus && 'pr-9', className)}
          />
          {showEnsStatus && (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              {ens.status === 'loading' ? (
                <LoaderCircle className="h-4 w-4 animate-spin text-text-muted" />
              ) : ens.status === 'resolved' ? (
                <Check className="h-4 w-4 text-success" />
              ) : ens.status === 'not-found' || ens.status === 'error' ? (
                <X className="h-4 w-4 text-destructive" />
              ) : invalidEnsCandidate ? (
                <X className="h-4 w-4 text-destructive" />
              ) : null}
            </span>
          )}
        </div>

        {showEnsStatus && (
          <div
            className={cn(
              'min-h-5 text-xs text-text-muted',
              resolutionClassName
            )}
            aria-live="polite"
          >
            {ens.status === 'loading' && 'Resolving ENS name…'}
            {ens.status === 'resolved' && (
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{getTargetChainConfig().name} address:</span>
                <CopyableText
                  text={ens.address}
                  truncateOnMobile={false}
                  alwaysShowCopyIcon
                />
              </span>
            )}
            {ens.status === 'not-found' &&
              `No ${getTargetChainConfig().name} address is set for this name.`}
            {ens.status === 'error' &&
              'ENS is temporarily unavailable. Please try again.'}
            {invalidEnsCandidate && 'This is not a valid ENS name.'}
          </div>
        )}
      </div>
    )
  }
)
AccountIdentifierInput.displayName = 'AccountIdentifierInput'
