'use client'

import { LoaderCircle } from 'lucide-react'
import { ComponentPropsWithoutRef } from 'react'

import { cn } from '@/lib/utils'

export type SwitchProps = Pick<
  ComponentPropsWithoutRef<'button'>,
  'onClick' | 'aria-label' | 'aria-labelledby' | 'id'
> & {
  enabled: boolean
  className?: string
  size?: 'sm' | 'md' | 'lg'
  readOnly?: boolean
  loading?: boolean
  /** Use only when a surrounding control already owns the interaction. */
  decorative?: boolean
}

export const Switch = ({
  enabled,
  onClick,
  className,
  size = 'lg',
  readOnly,
  loading,
  decorative = false,
  ...props
}: SwitchProps) => {
  const track = (
    <span
      aria-hidden="true"
      className={cn('relative flex shrink-0 items-center border', {
        'border-ink bg-ink': enabled,
        'border-hairline-strong bg-transparent': !enabled,
        'h-4 w-7': size === 'sm',
        'h-[27px] w-[47px]': size === 'md',
        'h-[38px] w-[67px]': size === 'lg',
      })}
    >
      <span
        className={cn(
          'absolute flex items-center justify-center transition-[left]',
          enabled ? 'bg-ink-fg' : 'bg-text-subtle',
          {
            'h-2.5 w-2.5': size === 'sm',
            'left-[15px]': size === 'sm' && enabled,
            'left-0.5': size === 'sm' && !enabled,
            'h-[18px] w-[18px]': size === 'md',
            'left-6': size === 'md' && enabled,
            'left-1': size === 'md' && !enabled,
            'h-7 w-7': size === 'lg',
            'left-[33px]': size === 'lg' && enabled,
            'left-[4.5px]': size === 'lg' && !enabled,
          }
        )}
      >
        {loading && <LoaderCircle className="h-full w-full animate-spin" />}
      </span>
    </span>
  )

  if (decorative) {
    return (
      <span className={cn('inline-flex shrink-0', className)}>{track}</span>
    )
  }

  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-busy={loading || undefined}
      disabled={readOnly || loading}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
    >
      {track}
    </button>
  )
}
