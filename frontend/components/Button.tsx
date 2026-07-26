'use client'

import { Slot } from '@radix-ui/react-slot'
import { type VariantProps, cva } from 'class-variance-authority'
import Link from 'next/link'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Buttons are machine labels: uppercase, tracked out, mono, square. That is a
 * deliberate register shift away from sentence-case chrome — a control should
 * not look like prose. Long labels survive it ("VIEW PILOT NETWORK: DEMO
 * CO-OP" reads as intentional); anything that genuinely must stay in sentence
 * case can pass `normal-case` through className.
 *
 * `brand` is kept as an alias of `default` rather than deleted, because the
 * blue it used to paint no longer exists and ~a dozen call-sites still ask for
 * it. Both now render ink.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap border text-xs uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'border-ink bg-ink text-ink-fg hover:opacity-90 active:opacity-80',
        brand:
          'border-ink bg-ink text-ink-fg hover:opacity-90 active:opacity-80',
        destructive:
          'border-error bg-error text-ink-fg hover:opacity-90 active:opacity-80',
        outline:
          'border-hairline-strong bg-transparent text-text hover:bg-surface-2',
        secondary:
          'border-transparent bg-surface-2 text-text hover:bg-surface-3',
        tertiary:
          'border-transparent bg-surface-3 text-text hover:bg-surface-2',
        ghost:
          'border-transparent bg-transparent text-text-muted hover:bg-surface-2 hover:text-text',
        ghostDestructive:
          'border-transparent bg-transparent text-error hover:bg-error-soft',
        link: 'border-transparent normal-case tracking-normal text-text underline-offset-4 hover:underline',
        custom: '',
      },
      size: {
        default: 'h-9 px-4',
        xs: 'h-6 px-2 text-[10px]',
        sm: 'h-8 px-3',
        lg: 'h-11 px-6 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export interface ButtonLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
})

const ButtonLink = React.forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink(
    { className, variant, size, asChild = false, href = '#', ...props },
    ref
  ) {
    const Comp = asChild ? Slot : !href.startsWith('/') ? 'a' : Link
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        href={href}
        {...props}
      />
    )
  }
)

export { Button, ButtonLink, buttonVariants }
