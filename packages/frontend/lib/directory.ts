//! What the `/networks` directory is a list OF.
//!
//! Several programs share one page and they do not score the same thing. A trust-graph instance
//! scores people who vouch for each other; a weighted instance does the same but its starting
//! accounts hold creation-time shares; a contributions round scores work claimed in a funding
//! round; a hypercerts instance scores published work. Rendering them all as identical cards
//! (which is what shipped) asks a reader to notice a difference that nothing on the page tells
//! them about.
//!
//! So the directory is SECTIONS, one per program, each with a sentence saying what it scores. A
//! section with nothing in it is omitted rather than rendered empty.
//!
//! This module is types and pure shaping only. The reads live in `directory.server.ts`.

/** The programs that put instances on this page. Order is the order they render in. */
export const PROGRAM_ORDER = [
  'trust-graph',
  'trust-graph-weighted',
  'trust-compose',
  'contributions',
  'hypercerts',
  'nostr-workspace',
] as const

export type DirectoryProgram = (typeof PROGRAM_ORDER)[number]

/**
 * The last published scoreboard for one instance.
 *
 * Every field is nullable on purpose. "We could not read this" and "this has never been proven"
 * and "this is empty" are three different answers, and a directory that renders all three as `0`
 * is lying twice.
 */
export type ScoreboardSummary = {
  /** Entries (or claims, or repos) carrying a score greater than zero at the latest root. */
  scored: number | null
  /** Vouches counted into that root. Only meaningful for the vouching program. */
  attestations: number | null
  /** Unix seconds of the latest proven root, or null when nothing has ever been proven. */
  provenAt: number | null
  /** True when the read itself failed, as opposed to succeeding and finding nothing. */
  unavailable: boolean
}

export type DirectoryRow = {
  id: string
  name: string
  /** One line. The full description lives on the instance's own page. */
  blurb: string
  href: string
  summary: ScoreboardSummary
}

export type DirectorySection = {
  program: DirectoryProgram
  /** Section heading. Sentence case; SectionHeading uppercases it in CSS. */
  title: string
  /** One line saying what this program scores, so no row has to carry that weight. */
  standfirst: string
  /** Header for the first column, which is not the same noun in each program. */
  nameLabel: string
  /** Column header for `summary.scored`, which counts a different noun per program. */
  scoredLabel: string
  rows: DirectoryRow[]
}

export type Directory = {
  sections: DirectorySection[]
  /** Set when the runtime catalog could not be read: the list is the shipped seed, not the truth. */
  catalogError: string | null
  /** Total rows across every section, so the page can pick its empty / search treatment. */
  total: number
}

export const SECTION_META: Record<
  DirectoryProgram,
  { title: string; standfirst: string; nameLabel: string; scoredLabel: string }
> = {
  'trust-graph': {
    title: 'Vouching networks',
    standfirst: 'Members vouch for each other, and the vouches become a score.',
    nameLabel: 'Network',
    // The canonical blob contains only value > 0 entries, so `numAccounts` uses
    // the same set as both the network roster and the live vouch count.
    scoredLabel: 'Scored accounts',
  },
  // The persistent surface for weighted instances: before this section a created
  // weighted network's id appeared once, in a toast, and was unfindable after a reload.
  'trust-graph-weighted': {
    title: 'Weighted networks',
    standfirst:
      'Starting accounts hold shares of fixed sizes chosen at creation; vouches still decide the final scores.',
    nameLabel: 'Network',
    scoredLabel: 'Scored accounts',
  },
  'trust-compose': {
    title: 'Composed networks',
    standfirst: 'Scores blended from two or more proved source networks.',
    nameLabel: 'Network',
    scoredLabel: 'Scored accounts',
  },
  contributions: {
    title: 'Funding rounds',
    standfirst:
      'Members claim work and rate each other, and the pot follows the ratings.',
    nameLabel: 'Round',
    scoredLabel: 'Contributions',
  },
  hypercerts: {
    // NOT "repo reputation". The hypercerts graph runs over AT-Protocol records:
    // evaluations, endorsements, attributions, badges. "Repo" there is a PDS data
    // repository, not source code, and nobody is scored on repositories they
    // worked on. The old wording described a different product.
    title: 'Published work',
    standfirst:
      'Accounts are scored on the impact claims and evaluations they have published.',
    nameLabel: 'Instance',
    scoredLabel: 'Accounts',
  },
  'nostr-workspace': {
    title: 'Nostr workspaces',
    standfirst:
      'Members and delegated agents are scored from an anchored Buzz workspace history.',
    nameLabel: 'Workspace',
    scoredLabel: 'Members and agents',
  },
}

/**
 * The one line under a row's name: the first sentence of the network's own
 * description.
 *
 * A SENTENCE, not a character count. Clamping at 120 characters ended rows on
 * "Members…" and "respond…" — a subject with its verb amputated, which reads as
 * a rendering bug rather than as a summary. The first sentence of a description
 * is the sentence the author wrote to be read first.
 *
 * The character clamp survives as the fallback for a description whose first
 * sentence is itself a paragraph, and for one with no sentence break at all.
 */
export const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat

  // A full stop, question mark or exclamation followed by a space and a capital.
  // Requiring the capital keeps "e.g." and "Co-op." from ending the sentence.
  const boundary = flat.search(/[.!?]\s+[A-Z0-9“"']/)
  if (boundary > 0 && boundary + 1 <= max) return flat.slice(0, boundary + 1)

  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`
}

/**
 * "3 days ago", in the register the rest of the app uses.
 *
 * A reader should not need the words epoch, checkpoint or root to understand when the scores are
 * from. Anything under an hour rounds to "just now" rather than pretending to a precision the
 * ten-second cache in front of it does not have.
 */
export const humanAgo = (unixSeconds: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.floor(now / 1000) - unixSeconds)
  if (seconds < 3_600) return 'just now'
  const hours = seconds / 3_600
  if (hours < 24) {
    const rounded = Math.round(hours)
    return `${rounded} hour${rounded === 1 ? '' : 's'} ago`
  }
  const days = seconds / 86_400
  if (days < 45) {
    const rounded = Math.round(days)
    return `${rounded} day${rounded === 1 ? '' : 's'} ago`
  }
  const months = Math.round(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

/** The freshness cell, as one sentence fragment. Never invents a number it does not have. */
export const freshnessLabel = (summary: ScoreboardSummary): string => {
  if (summary.unavailable) return 'Unknown'
  if (summary.provenAt === null) return 'Not proven yet'
  return humanAgo(summary.provenAt)
}

/** Group rows into sections, dropping any section that ends up empty. */
export const toSections = (
  rowsByProgram: Record<DirectoryProgram, DirectoryRow[]>
): DirectorySection[] =>
  PROGRAM_ORDER.filter((program) => rowsByProgram[program].length > 0).map(
    (program) => ({
      program,
      ...SECTION_META[program],
      rows: rowsByProgram[program],
    })
  )
