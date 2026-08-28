'use client'

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
 * FOCUS IS AN OUTLINE, NOT A RING. The old `ring-1 ring-ring` resolved to
 * --accent, which is also what `default` and `destructive` fill with:
 * the indicator was painted in the button's own colour at 1.00:1, so focusing a
 * primary CTA looked like it had grown a pixel. An outline with an offset sits
 * on the page behind the control, where ink clears 15:1 in both themes.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap border text-xs uppercase tracking-wider transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
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
    VariantProps<typeof buttonVariants> {}

export interface ButtonLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Passed through to `next/link` for internal hrefs, and dropped for external
   * ones so React is not handed an unknown attribute on a plain `<a>`.
   *
   * It is here because a nav built out of this component had no way to say no.
   * `<Link>` prefetches by default, and on this app's chunk sizes that meant a
   * static page pulled the whole wallet and attestation stack for routes the
   * reader had not asked for. See `components/Nav.tsx`.
   */
  prefetch?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, ...props },
  ref
) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
})

const ButtonLink = React.forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink(
    { className, variant, size, href = '#', prefetch, ...props },
    ref
  ) {
    const Comp = !href.startsWith('/') ? 'a' : Link
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        href={href}
        // Only `next/link` understands it. On an external href `Comp` is a plain
        // `<a>`, and React would warn about an unknown attribute.
        {...(Comp === Link && prefetch !== undefined ? { prefetch } : {})}
        {...props}
      />
    )
  }
)

export { Button, ButtonLink, buttonVariants }
