//! The directory of the networks on this chain.
//!
//! Three programs share this page and they do not count the same thing, so each gets a heading and
//! one line saying what it scores. That is the whole reason this is not one grid of identical
//! cards: a badge in a mixed list asks the reader to notice a difference, a heading tells them.
//! Sections with nothing in them are dropped upstream, in `toSections`.
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

// "Every" was three things this page is not. The vouching section reads one page of the registry,
// capped at 200 by the indexer with the returned total discarded. The funding-round and repo
// sections are filtered slices of the shipped config file rather than a chain read, so a stranger's
// instance in either program appears only once someone edits that JSON. Issue filed for the cap.
const STANDFIRST = 'Networks on this chain, and what each one counts.'

/**
 * Was "Every number in a row is read off the same scoreboard as its date", which is not true of
 * the vouches column: `indexer/src/api/network.ts` counts attestations whose `revocationTime` is
 * zero AT QUERY TIME, among the accounts in the latest root. Members and the date are as-of-root;
 * the vouch count is live and moves when someone revokes. Saying so costs one sentence.
 */
const COLUMN_NOTE =
  'Members and the date come from the last proven scoreboard. Vouches are counted live.'

// The share card is set explicitly rather than inherited. Without it, the
// root layout's openGraph block wins and every route shares one card titled
// "Trustgraphs" — a link to the directory and a link to the questions page look
// identical when someone pastes them.
export const metadata: Metadata = {
  title: 'Networks',
  ...socialCard({
    title: 'Networks | Trustgraphs',
    description: STANDFIRST,
    path: '/networks',
  }),
}

/** A filter is furniture until the list outgrows one screen. Twelve rows is where it earns its place. */
const SEARCH_THRESHOLD = 12

const VOUCHES = 'Vouches'

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
const GRID_WITH_VOUCHES = 'lg:grid-cols-[1fr_7rem_7rem_9rem]'
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
 * The row's figures as one line, for the narrow reflow: "48 members · 214 vouches · proven 3 days
 * ago". Every number keeps its label, because below `md` there are no column headers to inherit
 * one from. A row with nothing proven yet says only that, since the counts do not exist until a
 * scoreboard does.
 */
const compactLine = (row: DirectoryRow, section: DirectorySection): string => {
  const { scored, attestations, provenAt, unavailable } = row.summary
  const parts: string[] = []

  if (scored !== null)
    parts.push(`${NUMBER.format(scored)} ${section.scoredLabel.toLowerCase()}`)
  if (section.program === 'trust-graph' && attestations !== null)
    parts.push(`${NUMBER.format(attestations)} vouches`)

  if (provenAt !== null) {
    parts.push(`proven ${freshnessLabel(row.summary)}`)
  } else {
    const state = unavailable ? 'Scores unknown' : 'Not proven yet'
    parts.push(parts.length > 0 ? state.toLowerCase() : state)
  }

  return parts.join(' · ')
}

const toView = (section: DirectorySection): DirectorySectionView => {
  // Only the vouching program has vouches to count; the other two would be quoting a column that
  // means nothing to them.
  const withVouches = section.program === 'trust-graph'

  return {
    key: section.program,
    title: section.title,
    standfirst: section.standfirst,
    nameLabel: section.nameLabel,
    columns: withVouches
      ? [section.scoredLabel, VOUCHES]
      : [section.scoredLabel],
    gridClass: withVouches ? GRID_WITH_VOUCHES : GRID_PLAIN,
    rows: section.rows.map((row) => ({
      id: row.id,
      name: row.name,
      blurb: row.blurb,
      href: row.href,
      figures: [
        figure(section.scoredLabel, row.summary.scored, row.summary),
        ...(withVouches
          ? [figure(VOUCHES, row.summary.attestations, row.summary)]
          : []),
      ],
      freshness: freshnessLabel(row.summary),
      compact: compactLine(row, section),
      haystack: `${row.name} ${row.blurb}`.toLowerCase(),
    })),
  }
}

/** Where a directory of other people's networks sends someone who wants their own. */
const CreateCta = () => (
  <section className="space-y-5 border-t border-border pt-8">
    <h2>Bring your own community.</h2>
    <ButtonLink href="/create" size="lg">
      Create a network
    </ButtonLink>
  </section>
)

/** No rows at all. No table chrome, no empty column header, and the same one button. */
const EmptyDirectory = () => (
  // The cap is on the paragraph, not the section: capping the section clamped its `border-t` to
  // half the frame, so the empty state drew a different rule from the identical CTA in every
  // other state.
  <section className="space-y-5 border-t border-border pt-8">
    <h2>No networks yet. Create the first one.</h2>
    <p className="max-w-prose text-text-muted">
      Creating one takes a single transaction, and nobody has to approve it.
    </p>
    <ButtonLink href="/create" size="lg">
      Create a network
    </ButtonLink>
  </section>
)

export default async function NetworksPage() {
  // Never throws: a failed catalog read comes back as `catalogError` with whatever survived, and a
  // scoreboard the indexer could not answer for comes back as nulls rather than zeroes.
  const directory = await loadDirectory()
  const sections = directory.sections.map(toView)
  const isEmpty = directory.total === 0

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="space-y-2">
        <PageTitle>Networks</PageTitle>
        <p className="max-w-prose text-lg text-balance text-text-muted">
          {STANDFIRST}
        </p>
        {!isEmpty && (
          <p className="max-w-prose text-sm text-text-subtle">{COLUMN_NOTE}</p>
        )}
      </header>

      {directory.catalogError && (
        <CatalogDegradedNotice reason={directory.catalogError} />
      )}

      {isEmpty ? (
        <EmptyDirectory />
      ) : (
        <>
          {directory.total >= SEARCH_THRESHOLD ? (
            <DirectorySearch sections={sections} />
          ) : (
            <div className="space-y-16 sm:space-y-20">
              {sections.map((section) => (
                <DirectorySectionBlock key={section.key} section={section} />
              ))}
            </div>
          )}
          <CreateCta />
        </>
      )}
    </div>
  )
}
