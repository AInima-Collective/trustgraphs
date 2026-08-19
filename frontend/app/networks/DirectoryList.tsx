//! The directory, as rows.
//!
//! A directory is a list, so this renders a list: one hairline-ruled line per network, name and one
//! line of what it is for on the left, the figures right-aligned and tabular on the right. No cards,
//! no fills, no badges. The programs are told apart by the heading they sit under, because a
//! badge in a mixed list asks a reader to notice a difference, and a heading tells them.
//!
//! THE REFLOW: below `lg` the same row re-reads as three lines — name, blurb, then one mono line of
//! "48 members · 214 vouches · proven 3 days ago". Nothing is orphaned from its label and nothing
//! needs a sideways scroll, which is why the figures are a sentence there and columns here.
//!
//! WHY THE VIEW MODEL IS BUILT ON THE SERVER (see page.tsx): every string below is already
//! formatted. "3 days ago" is relative to render time, and recomputing it during hydration is how a
//! list like this ends up with a hydration mismatch nobody can reproduce.
//!
//! No 'use client' directive on purpose: the page renders these from the server, and the search
//! island imports the same components so both paths produce identical HTML.

import Link from 'next/link'

import { SectionHeading } from '@/components/SectionHeading'
import { cn } from '@/lib/utils'

/** One right-aligned number. `value` is null when there is no number to state, never when it is 0. */
export type DirectoryFigure = {
  /** Column header, and what a screen reader hears in front of the value. */
  label: string
  value: string | null
  /** What the blank means. Read out in place of the number, never shown. */
  missing: string
}

export type DirectoryRowView = {
  id: string
  name: string
  blurb: string
  href: string
  figures: DirectoryFigure[]
  /** "3 days ago", "Not proven yet", or "Unknown". Never a fabricated date. */
  freshness: string
  /** The figures as one line, for the phone reflow. */
  compact: string
  /** name + blurb, lowercased once here so the filter does no work per keystroke. */
  haystack: string
}

export type DirectorySectionView = {
  key: string
  title: string
  standfirst: string
  /** First column header. Network, Round or Instance: the row is not the same noun in each program. */
  nameLabel: string
  /** The figure columns, in order, excluding the freshness column that every section ends with. */
  columns: string[]
  /** The md-and-up track sizes. Spelled out as a literal in page.tsx so Tailwind can see it. */
  gridClass: string
  rows: DirectoryRowView[]
}

const FRESHNESS_HEADER = 'Scores proven'

/**
 * A right-aligned column label.
 *
 * `tg-label` tracks out 0.12em, and CSS appends that space AFTER the last glyph
 * rather than distributing it between them, so a right-aligned label's box ends
 * a fraction past its ink: measured two to three pixels short of the numbers
 * underneath it. The left-aligned label in the same row lines up exactly, which
 * is the tell. Tracking only breaks the edge you align to when that edge is the
 * right one, so the trailing space is pulled back off.
 */
const LABEL_RIGHT = 'tg-label -mr-[0.12em] text-right'

const NetworkRow = ({
  row,
  gridClass,
}: {
  row: DirectoryRowView
  gridClass: string
}) => (
  <li
    className={cn(
      // The whole row is the target, but the link is only the name: an anchor whose text is the
      // entire row reads its blurb and every figure out loud before it says where it goes.
      'relative grid grid-cols-1 items-baseline gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0 transition-colors',
      'hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2',
      gridClass
    )}
  >
    <div className="min-w-0">
      <Link
        href={row.href}
        // No prefetch, for the reason the nav and the footer already give: a
        // directory is a list of things a reader will open ONE of. Left at the
        // default, every visible row pulled the network page's chunks, and that
        // page carries the EAS SDK and ethers: measured, `/networks` downloaded
        // 5,345 KB of JavaScript to show a list that is server-rendered text.
        // The cost lands on the row that gets clicked instead.
        prefetch={false}
        className={cn(
          'block break-words text-text underline-offset-4 hover:underline',
          'after:absolute after:inset-0 after:content-[""]',
          'focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink'
        )}
      >
        {row.name}
      </Link>
      <p className="line-clamp-2 max-w-prose text-text-muted lg:max-w-none lg:truncate">
        {row.blurb}
      </p>
    </div>

    {row.figures.map((figure) => (
      <div
        key={figure.label}
        className="hidden text-right text-sm tabular-nums text-text lg:block"
      >
        <span className="sr-only">{figure.label}: </span>
        {/* A missing number is never rendered as 0. It used to be left visually blank with the
         * reason exposed to screen readers only, which made the wide table less honest than the
         * phone sentence beside it: a sighted reader saw a labelled column full of holes and no
         * reason given. The reason is visible now, in the muted tone so it reads as an absence
         * rather than as data.
         *
         * `--text-muted`, not `--text-subtle`, for the same reason the compact line below is:
         * this sits inside the row, which paints `--surface-2` on hover AND on focus-visible.
         * Subtle measures 4.32:1 against that wash in dark and misses the floor by 0.18. */}
        {figure.value ?? (
          <span className="text-text-muted">{figure.missing}</span>
        )}
      </div>
    ))}

    <div className="hidden text-right text-sm tabular-nums text-text-muted lg:block">
      <span className="sr-only">{FRESHNESS_HEADER}: </span>
      {row.freshness}
    </div>

    {/* The figures as a sentence. Not `tg-label`: a whole line of counts set in tracked-out caps
     * is harder to read than the numbers deserve, and this is data rather than a label. */}
    {/* --text-muted, not --text-subtle: this line sits under the row's
     * hover/focus wash (--surface-2), where subtle measures 4.32:1 and fails the
     * floor. Below `lg` it is also the ONLY place the row's numbers appear. */}
    <p className="text-sm tabular-nums text-text-muted lg:hidden">
      {row.compact}
    </p>
  </li>
)

export const DirectorySectionBlock = ({
  section,
}: {
  section: DirectorySectionView
}) => (
  <section className="space-y-3">
    <SectionHeading>{section.title}</SectionHeading>
    <p className="max-w-prose text-balance text-text-muted">
      {section.standfirst}
    </p>

    <div>
      {/* Column labels. Hidden below md, where the figures reflow into a sentence that carries its
       * own labels; every cell also names itself for assistive tech, so this row is decoration. */}
      <div
        aria-hidden="true"
        className={cn(
          'hidden gap-x-4 border-b border-border pb-2 lg:grid',
          section.gridClass
        )}
      >
        <span className="tg-label">{section.nameLabel}</span>
        {section.columns.map((column) => (
          <span key={column} className={LABEL_RIGHT}>
            {column}
          </span>
        ))}
        <span className={LABEL_RIGHT}>{FRESHNESS_HEADER}</span>
      </div>

      <ul className="list-none pl-0">
        {section.rows.map((row) => (
          <NetworkRow key={row.id} row={row} gridClass={section.gridClass} />
        ))}
      </ul>
    </div>
  </section>
)
