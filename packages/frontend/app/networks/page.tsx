//! The directory of the networks on this chain.
//!
//! Every score network appears in one table. Program-specific implementation details belong on
//! the network itself, not in parallel directories or separate list sections.
//!
//! WHAT IS SERVER-RENDERED AND WHY: every row, in all four states, plus every string in it. The
//! only client code is the filter island, which appears once the list is long enough to need it.
//! Freshness is a relative string ("3 days ago") computed here, at render time, and passed down as
//! text — computing it again during hydration is how a list like this grows a mismatch that nobody
//! can reproduce.

import type { Metadata } from 'next'

import { ButtonLink } from '@/components/Button'
import { CatalogDegradedNotice } from '@/components/CatalogUnavailable'
import { PageTitle } from '@/components/SectionHeading'
import {
  type DirectoryRow,
  type DirectorySection,
  type ScoreboardSummary,
  freshnessLabel,
} from '@/lib/directory'
import { loadDirectory } from '@/lib/directory.server'
import { socialCard } from '@/lib/metadata'

import {
  DirectorySectionBlock,
  type DirectorySectionView,
} from './DirectoryList'
import { DirectorySearch } from './DirectorySearch'

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts, or a network created thirty seconds ago
// stops appearing here.
export const revalidate = 10

// "Every" is still more than this page can promise: the repo section is a filtered slice of the
// shipped config file rather than a chain read, so a stranger's instance appears only once someone
// edits that JSON. The factory-backed vouching section does read every catalog page.
const DIRECTORY_DESCRIPTION = 'Browse Trustgraph networks on this chain.'

// The share card is set explicitly rather than inherited. Without it, the
// root layout's openGraph block wins and every route shares one card titled
// "Trustgraphs" — a link to the directory and a link to the questions page look
// identical when someone pastes them.
export const metadata: Metadata = {
  title: 'Networks',
  ...socialCard({
    title: 'Networks | trustgraphs',
    description: DIRECTORY_DESCRIPTION,
    path: '/networks',
  }),
}

/** A filter is furniture until the list outgrows one screen. Twelve rows is where it earns its place. */
const SEARCH_THRESHOLD = 12

/**
 * Track sizes for the lg-and-up table.
 *
 * The switch waits for `lg` rather than `md`. At 768 the fixed tracks left the name column
 * NARROWER than the same column gets on a 390px phone, and truncated the blurb to one line to do
 * it: the reflow has to buy the reader something, not just rearrange the loss. Written out as literals because Tailwind reads the source
 * text: a class name assembled from variables at runtime is a class name that never gets generated.
 * The first track is `1fr` with `min-w-0` on its cell, so a network name longer than the column
 * wraps instead of pushing the figures off the page.
 */
const GRID_PLAIN = 'lg:grid-cols-[1fr_9rem_9rem]'

// An explicit locale, not the runtime's: the grouping separator has to be the same character in the
// server HTML and in the browser that hydrates it.
const NUMBER = new Intl.NumberFormat('en-US')

/**
 * What a blank figure means, for the reader who cannot see the row's last column.
 *
 * "Not proven yet" only when there is no scoreboard at all. A row that has one and is still missing
 * a count means the read for that column did not come back, which is "Unknown", not "none".
 */
const missingFigure = (summary: ScoreboardSummary): string =>
  !summary.unavailable && summary.provenAt === null
    ? 'Not proven yet'
    : 'Unknown'

const figure = (
  label: string,
  value: number | null,
  summary: ScoreboardSummary
) => ({
  label,
  value: value === null ? null : NUMBER.format(value),
  missing: missingFigure(summary),
})

/**
 * The row's figures as one line, for the narrow reflow: "48 accounts · proven 3 days
 * ago". Every number keeps its label, because below `md` there are no column headers to inherit
 * one from. A row with nothing proven yet says only that, since the counts do not exist until a
 * scoreboard does.
 */
const compactLine = (row: DirectoryRow, section: DirectorySection): string => {
  const { scored, provenAt, unavailable } = row.summary
  const parts: string[] = []

  if (scored !== null)
    parts.push(`${NUMBER.format(scored)} ${section.scoredLabel.toLowerCase()}`)
  if (provenAt !== null) {
    parts.push(`proven ${freshnessLabel(row.summary)}`)
  } else {
    const state = unavailable ? 'Scores unknown' : 'Not proven yet'
    parts.push(parts.length > 0 ? state.toLowerCase() : state)
  }

  return parts.join(' · ')
}

const toView = (sections: DirectorySection[]): DirectorySectionView => {
  return {
    key: 'networks',
    nameLabel: 'Network',
    columns: ['Scored accounts'],
    gridClass: GRID_PLAIN,
    rows: sections.flatMap((section) =>
      section.rows.map((row) => ({
        id: row.id,
        name: row.name,
        blurb: row.blurb,
        href: row.href,
        figures: [figure('Scored accounts', row.summary.scored, row.summary)],
        freshness: freshnessLabel(row.summary),
        compact: compactLine(row, section),
        haystack: `${row.name} ${row.blurb}`.toLowerCase(),
      }))
    ),
  }
}

/** No rows at all. No table chrome and no empty column header. */
const EmptyDirectory = () => (
  // The cap is on the paragraph, not the section: capping the section clamped its `border-t` to
  // half the frame, so the empty state's rule stopped short of the directory frame.
  <section className="flex flex-col items-start gap-6 border-t border-border pt-5 sm:gap-8">
    <h2>No networks yet.</h2>
    <p className="max-w-prose text-text-muted">
      Creating one takes a single transaction, and nobody has to approve it.
    </p>
  </section>
)

export default async function NetworksPage() {
  // Never throws: a failed catalog read comes back as `catalogError` with whatever survived, and a
  // scoreboard the indexer could not answer for comes back as nulls rather than zeroes.
  const directory = await loadDirectory()
  const table = toView(directory.sections)
  const isEmpty = directory.total === 0

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageTitle>Networks</PageTitle>
        <ButtonLink href="/create" prefetch={false} size="lg">
          Create a network
        </ButtonLink>
      </header>

      {directory.catalogError && (
        <CatalogDegradedNotice reason={directory.catalogError} />
      )}

      {isEmpty ? (
        <EmptyDirectory />
      ) : directory.total >= SEARCH_THRESHOLD ? (
        <DirectorySearch sections={[table]} />
      ) : (
        <DirectorySectionBlock section={table} />
      )}
    </div>
  )
}
