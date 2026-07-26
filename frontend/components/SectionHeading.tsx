import { cn } from '@/lib/utils'

/**
 * A heading *inside* a page.
 *
 * These stay in the mono, uppercased by CSS and tracked out, with a hairline
 * under them. That is a deliberate split from the page title, which carries
 * the display serif:
 *
 *   page title      serif, sentence case, large   "RegenHub"
 *   section heading mono, uppercase, small        "NETWORK STATISTICS"
 *
 * The reason is that a serif set in all-caps loses its case contrast, its
 * ascenders, and its descenders — everything that makes it a serif — and ends
 * up looking like a mistake rather than a decision. Sections in this app are
 * almost all named in caps, so they get the register that suits caps.
 *
 * Pass sentence-case children; `text-transform` does the shouting, so the
 * source and the accessibility tree stay readable.
 */
export function SectionHeading({
  children,
  n,
  className,
  actions,
}: {
  children: React.ReactNode
  /** Optional section number, hung to the left as apparatus. */
  n?: string
  className?: string
  /** Optional trailing slot — filters, a link, a count. */
  actions?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex w-full items-baseline justify-between gap-3 border-b border-border pb-2',
        className
      )}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        {n && <span className="tg-marker shrink-0">{n}</span>}
        <h2 className="tg-label-strong truncate">{children}</h2>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}

/**
 * A page title. Serif, sentence case, and the only place on a page that gets
 * the display voice at size.
 */
export function PageTitle({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <h1 className={cn('mb-1', className)}>{children}</h1>
}
