import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Figures docked to a graph canvas as a quiet instrument rail, instead of a row
 * of cards repeated below it. Two columns across the top on a phone, one narrow
 * column at the top right from `sm` up, clear of the graph's own controls.
 *
 * The parent must be `relative`. The rail lets pointer events through to the
 * graph underneath, so nothing in it should need a click.
 */
export function GraphStatRail({
  label,
  children,
}: {
  /** Accessible name for the rail. */
  label: string
  children: ReactNode
}) {
  return (
    <aside
      aria-label={label}
      className="pointer-events-none absolute inset-x-3 top-14 z-10 grid grid-cols-2 border border-hairline-strong bg-surface/95 shadow-[var(--shadow-elevated)] backdrop-blur-md sm:inset-x-auto sm:right-3 sm:w-52 sm:grid-cols-1"
    >
      {children}
    </aside>
  )
}

export function GraphStat({
  label,
  value,
  wide = false,
}: {
  label: string
  value: ReactNode
  /** Span both columns on a phone. */
  wide?: boolean
}) {
  return (
    <dl
      className={cn(
        'border-b border-r border-hairline px-3 py-2.5 even:border-r-0 sm:border-r-0 sm:last:border-b-0',
        wide && 'col-span-2 border-r-0 sm:col-span-1'
      )}
    >
      <dt className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </dt>
      <dd className="mt-1 flex items-center gap-1.5 text-sm tabular-nums text-text">
        {value}
      </dd>
    </dl>
  )
}
