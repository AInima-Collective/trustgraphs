//! The four states the directory has to be right in, on demand.
//!
//! `/networks` has to hold up with twelve networks, with one, with none, and when the catalog read
//! failed outright. No live stack produces those four on demand, and three of them are exactly the
//! states that get shipped broken because nobody ever saw them.
//!
//! Set `TG_FIXTURE=many|one|none|failed` and the directory renders that state instead of reading
//! the indexer. `frontend/scripts/shots.mjs --states` builds once per state and screenshots each.
//!
//! SERVER ONLY, and deliberately so: this module is imported by `directory.server.ts`, which is
//! only ever imported by a server component, so none of these bytes reach a browser. It is also
//! inert unless the env var is set, so a production build that never sets it carries no fixture
//! behaviour at all.

import {
  type Directory,
  type DirectoryProgram,
  type DirectoryRow,
  type ScoreboardSummary,
  toSections,
} from './directory'

export const FIXTURE_STATES = ['many', 'one', 'none', 'failed'] as const
export type FixtureState = (typeof FIXTURE_STATES)[number]

export const activeFixture = (): FixtureState | null => {
  const raw = process.env.TG_FIXTURE
  return raw && (FIXTURE_STATES as readonly string[]).includes(raw)
    ? (raw as FixtureState)
    : null
}

const DAY = 86_400

const summary = (
  scored: number,
  attestations: number | null,
  daysAgo: number | null
): ScoreboardSummary => ({
  scored,
  attestations,
  provenAt:
    daysAgo === null ? null : Math.floor(Date.now() / 1000) - daysAgo * DAY,
  unavailable: false,
})

/**
 * Twelve vouching networks, a funding round and a repo-reputation instance.
 *
 * Deliberately uneven: two have never been proven, one was proven an hour ago and one four months
 * ago, the score counts span three orders of magnitude, and the names run from four characters to
 * long enough to wrap on a phone. A fixture where every row is the same width proves nothing.
 */
const MANY: Array<[DirectoryProgram, string, string, ScoreboardSummary]> = [
  [
    'trust-graph',
    'Demo Co-op',
    'A fictional member-owned collective that walks the whole workflow end to end.',
    summary(48, 214, 0),
  ],
  [
    'trust-graph',
    'Karachi Makers Assembly',
    'A hardware collective that vouches on the strength of shipped builds.',
    summary(1_284, 9_417, 2),
  ],
  [
    'trust-graph',
    'Hedge',
    'Fourteen researchers who fund each other and nobody else.',
    summary(14, 61, 1),
  ],
  [
    'trust-graph',
    'Riverside Tenants Union',
    'Neighbours vouch for neighbours, and the vouches decide who holds the keys.',
    summary(377, 1_902, 5),
  ],
  [
    'trust-graph',
    'Open Cartography Working Group',
    'Mapmakers scoring the people whose corrections they have merged.',
    summary(92, 448, 11),
  ],
  [
    'trust-graph',
    'The Long Table',
    'A dinner club with a treasury, which turns out to need governance.',
    summary(31, 96, 34),
  ],
  [
    'trust-graph',
    'Sölden Alpine Rescue',
    'Volunteers vouch for the people they would rope in on.',
    summary(58, 240, 128),
  ],
  [
    'trust-graph',
    'Praxis',
    'A reading group that pays its translators.',
    summary(206, 1_121, 3),
  ],
  [
    'trust-graph',
    'Salvage Guild',
    'Repair shops vouching for the technicians they subcontract.',
    summary(844, 4_066, 7),
  ],
  [
    'trust-graph',
    'Nightshift',
    'A worker co-op for overnight logistics.',
    summary(119, 512, 19),
  ],
  [
    'trust-graph',
    'Kelp Line',
    'Coastal farmers scoring each other on harvest reliability.',
    { scored: null, attestations: null, provenAt: null, unavailable: false },
  ],
  [
    'trust-graph',
    'Meridian Assembly for Civic Technology',
    'A long name for a small group that maintains three public services.',
    { scored: null, attestations: null, provenAt: null, unavailable: false },
  ],
  [
    'contributions',
    'Demo Co-op Contributions',
    'Members claim work, respond to attribution, and rate what landed.',
    summary(63, null, 1),
  ],
  [
    'contributions',
    'Winter Grants Round',
    'A twelve-week round splitting a fixed pot by peer rating.',
    summary(211, null, 26),
  ],
  [
    'hypercerts',
    'Certified.one',
    'Repository work proven over AT-Protocol accounts.',
    summary(1_040, null, 4),
  ],
]

const rowsFrom = (
  entries: Array<[DirectoryProgram, string, string, ScoreboardSummary]>
): Record<DirectoryProgram, DirectoryRow[]> => {
  const grouped: Record<DirectoryProgram, DirectoryRow[]> = {
    'trust-graph': [],
    contributions: [],
    hypercerts: [],
  }
  entries.forEach(([program, name, blurb, scoreboard], index) => {
    const id = `fixture-${index}-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}`
    grouped[program].push({
      id,
      name,
      blurb,
      href: `/networks/${id}`,
      summary: scoreboard,
    })
  })
  return grouped
}

export const fixtureDirectory = (state: FixtureState): Directory => {
  if (state === 'none') {
    return { sections: [], catalogError: null, total: 0 }
  }

  if (state === 'failed') {
    // A failed catalog read is not an empty directory, and it is not a complete one either. What
    // survives is the shipped seed — one vouching network and one funding round, here — with every
    // live number unreadable, because the same indexer serves both.
    const seed = MANY.filter(
      ([, name]) => name === 'Demo Co-op' || name === 'Demo Co-op Contributions'
    ).map(
      ([program, name, blurb]) =>
        [
          program,
          name,
          blurb,
          {
            scored: null,
            attestations: null,
            provenAt: null,
            unavailable: true,
          },
        ] as [DirectoryProgram, string, string, ScoreboardSummary]
    )
    const sections = toSections(rowsFrom(seed))
    return {
      sections,
      catalogError: 'GET /instances responded 503',
      total: sections.reduce((n, section) => n + section.rows.length, 0),
    }
  }

  const entries = state === 'one' ? MANY.slice(0, 1) : MANY
  const sections = toSections(rowsFrom(entries))
  return {
    sections,
    catalogError: null,
    total: sections.reduce((n, section) => n + section.rows.length, 0),
  }
}
