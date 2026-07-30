//! Server-side assembly of the `/networks` directory.
//!
//! Import from server components only.
//!
//! THE CONTRACT THIS KEEPS: the list of networks renders whether or not the indexer answers. Names,
//! descriptions and links come from the catalog (or, when that read fails, from the shipped seed).
//! The numbers are a separate, per-row read that is allowed to fail on its own — one unreachable
//! summary greys out one row's figures instead of taking the page down, and a row whose scoreboard
//! could not be read says "Unknown" rather than "0".
//!
//! WHERE EACH NUMBER COMES FROM, because they do not all come from the same place. `scored` and
//! `provenAt` are read off the latest proven root, so they agree with each other. `attestations` is
//! counted LIVE by the indexer (`revocationTime == 0` at query time, among the accounts in that
//! root), so it moves when someone revokes. The page says so rather than implying one timestamp
//! covers the whole row.

import { getCatalog } from './catalog.server'
import {
  APIS,
  VISIBLE_CONTRIBUTIONS_NETWORKS,
  VISIBLE_HYPERCERTS_NETWORKS,
} from './config'
import {
  type Directory,
  type DirectoryProgram,
  type DirectoryRow,
  type ScoreboardSummary,
  oneLine,
  toSections,
} from './directory'
import { activeFixture, fixtureDirectory } from './directory.fixtures'

/** Same window as the pages' `revalidate`. See CATALOG_REVALIDATE_SECONDS in catalog.server.ts. */
const SUMMARY_REVALIDATE_SECONDS = 10

/**
 * A hung indexer must not hang the directory. Next's fetch has no timeout of its own, so an
 * indexer that accepts the connection and then stops talking would hold the render open until the
 * platform's own limit. Three seconds is well past a healthy local read and well short of anyone
 * noticing a slow page.
 */
const SUMMARY_TIMEOUT_MS = 3_000

const UNREADABLE: ScoreboardSummary = {
  scored: null,
  attestations: null,
  provenAt: null,
  unavailable: true,
}

const NEVER_PROVEN: ScoreboardSummary = {
  scored: null,
  attestations: null,
  provenAt: null,
  unavailable: false,
}

const readJson = async <T>(path: string): Promise<T | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  try {
    const response = await fetch(`${APIS.ponder}${path}`, {
      signal: controller.signal,
      next: { revalidate: SUMMARY_REVALIDATE_SECONDS },
    })
    // 404 is a real answer from these routes ("nothing has been proven here"), not a failure.
    if (response.status === 404) return null
    if (!response.ok)
      throw new Error(`GET ${path} responded ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

type MerkleTreeList = {
  trees: Array<{ root: string; numAccounts: number; timestamp: string }>
}
type NetworkPayload = { attestations: unknown[] }

/**
 * The latest proven scoreboard for one snapshot.
 *
 * Two reads, and the second is skipped when the first says nothing has ever been proven — a
 * directory of twelve networks should not fire twelve pointless requests to learn that.
 */
const readSummary = async (
  snapshot: string,
  { withAttestations }: { withAttestations: boolean }
): Promise<ScoreboardSummary> => {
  let summary: ScoreboardSummary
  try {
    const list = await readJson<MerkleTreeList>(`/merkle/${snapshot}/all`)
    const latest = list?.trees?.[0]
    if (!latest) return NEVER_PROVEN

    // Guarded, not trusted. A missing or non-numeric `timestamp` yields NaN, which passes
    // the `provenAt === null` test in `freshnessLabel` and falls through every branch of
    // `humanAgo` to print "NaN months ago"; `Intl.NumberFormat.format(undefined)` prints
    // the string "NaN" in a figure cell. A fourth, silently wrong state is worse than the
    // three this type is careful to keep apart, so unparseable means unreadable.
    const provenAt = Number(latest.timestamp)
    const scored = Number(latest.numAccounts)
    if (!Number.isFinite(provenAt) || !Number.isFinite(scored)) {
      console.error(
        `[directory] ${snapshot} returned an unparseable scoreboard summary`
      )
      return UNREADABLE
    }

    summary = {
      scored,
      attestations: null,
      provenAt,
      unavailable: false,
    }
  } catch (error) {
    console.error(
      `[directory] scoreboard summary unavailable for ${snapshot}:`,
      error instanceof Error ? error.message : String(error)
    )
    return UNREADABLE
  }

  if (!withAttestations) return summary

  // Only the vouching program has vouches to count, and this is the expensive read, so it is gated
  // on there being a root to count them against.
  //
  // Its own try block on purpose. Sharing one with the read above threw away a member count and a
  // date we already had in hand because a second request failed, which turned a row that knew most
  // of its own facts into a row that claimed to know none of them.
  try {
    const network = await readJson<NetworkPayload>(`/network/${snapshot}`)
    return {
      ...summary,
      attestations: network ? network.attestations.length : null,
    }
  } catch (error) {
    console.error(
      `[directory] vouch count unavailable for ${snapshot}:`,
      error instanceof Error ? error.message : String(error)
    )
    return summary
  }
}

/**
 * The whole directory, ready to render.
 *
 * `TG_FIXTURE` short-circuits everything below it: see `directory.fixtures.ts` for why the four
 * states exist and how the screenshot harness drives them.
 */
export const loadDirectory = async (): Promise<Directory> => {
  const fixture = activeFixture()
  if (fixture) return fixtureDirectory(fixture)

  const catalog = await getCatalog()

  const sources: Array<{
    program: DirectoryProgram
    id: string
    name: string
    about: string
    snapshot: string
  }> = [
    ...catalog.networks.map((network) => ({
      program: 'trust-graph' as const,
      id: network.id,
      name: network.name,
      about: network.about,
      snapshot: network.contracts.merkleSnapshot,
    })),
    ...VISIBLE_CONTRIBUTIONS_NETWORKS.map((network) => ({
      program: 'contributions' as const,
      id: network.id,
      name: network.name,
      about: network.about,
      snapshot: network.contracts.merkleSnapshot,
    })),
    ...VISIBLE_HYPERCERTS_NETWORKS.map((network) => ({
      program: 'hypercerts' as const,
      id: network.id,
      name: network.name,
      about: network.about,
      snapshot: network.contracts.merkleSnapshot,
    })),
  ]

  const summaries = await Promise.all(
    sources.map((source) =>
      readSummary(source.snapshot, {
        withAttestations: source.program === 'trust-graph',
      })
    )
  )

  const grouped: Record<DirectoryProgram, DirectoryRow[]> = {
    'trust-graph': [],
    contributions: [],
    hypercerts: [],
  }

  sources.forEach((source, index) => {
    grouped[source.program].push({
      id: source.id,
      name: source.name,
      blurb: oneLine(source.about),
      href: `/networks/${source.id}`,
      summary: summaries[index] ?? UNREADABLE,
    })
  })

  const sections = toSections(grouped)

  return {
    sections,
    catalogError: catalog.error,
    total: sections.reduce((n, section) => n + section.rows.length, 0),
  }
}
