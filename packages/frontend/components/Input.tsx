'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full border border-input bg-surface px-3 text-sm tabular-nums text-text',
          'file:mr-3 file:inline-flex file:h-full file:items-center file:border-0 file:bg-transparent file:p-0 file:text-sm file:text-text',
          'placeholder:text-text-subtle',
          // Focus paints the border ink rather than adding a ring outside it:
          // an offset ring on a square 1px field reads as a second box.
          'transition-colors hover:border-hairline-strong focus:border-ink focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-error',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
