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
//! `provenAt` are read off the latest proven root. The canonical blob contains only positive scores,
//! so `scored` uses the same set as the network roster. `attestations` is counted LIVE by replaying
//! the accumulator's pair state among that same set, so it moves on revocation without reviving an
//! older vouch.

import { getCatalog } from './catalog.server'
import { APIS, VISIBLE_HYPERCERTS_NETWORKS } from './config'
import {
  type Directory,
  type DirectoryProgram,
  type DirectoryRow,
  type ScoreboardSummary,
  oneLine,
  toSections,
} from './directory'
import { activeFixture, fixtureDirectory } from './directory.fixtures'
import {
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
} from './score-program'

/** Same window as the pages' `revalidate`. See CATALOG_REVALIDATE_SECONDS in catalog.server.ts. */
const SUMMARY_REVALIDATE_SECONDS = 10

/**
 * A hung indexer must not hang the directory. Next's fetch has no timeout of its own, so an
 * indexer that accepts the connection and then stops talking would hold the render open until the
 * platform's own limit. Three seconds is well past a healthy local read and well short of anyone
 * noticing a slow page.
 */
const SUMMARY_TIMEOUT_MS = 3_000
const PROGRAM_CATALOG_PAGE_SIZE = 200
const PROGRAM_CATALOG_MAX_ROWS = 10_000

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
  scoreProgram: unknown
}
type HypercertsRootList = {
  roots: Array<{
    root: string
    numNodes: number
    timestamp: string
    merkleSnapshotContract: string
  }>
  scorePrograms: Record<string, unknown>
}
type NostrWorkspaceRootList = {
  roots: Array<{
    root: string
    numNodes: number
    timestamp: string
    scoreProgram: unknown
  }>
}
type ScoreProgramCatalogPage = {
  bindings: Array<{ snapshot: unknown; scoreProgram: unknown }>
  pagination: { limit: unknown; offset: unknown; total: unknown }
}
type NostrWorkspaceBinding = {
  snapshot: string
  scoreProgram: ScoreProgramProvenance
}
type NetworkPayload = { attestations: unknown[] }

const boundedCatalogInteger = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`score-program catalog ${label} is malformed`)
  }
  return value
}

/**
 * Discover Nostr workspaces only from authenticated InstanceRegistry bindings. The indexer returns
 * newest bindings first; all pages are consumed so the directory cannot silently look complete
 * after the first 200 rows.
 */
const readNostrWorkspaceBindings = async (): Promise<{
  bindings: NostrWorkspaceBinding[]
  error: string | null
}> => {
  const bindings: NostrWorkspaceBinding[] = []
  const snapshots = new Set<string>()
  let offset = 0

  try {
    for (;;) {
      const page = await readJson<ScoreProgramCatalogPage>(
        `/score-programs?program=nostr-workspace&limit=${PROGRAM_CATALOG_PAGE_SIZE}&offset=${offset}`
      )
      if (!page || !Array.isArray(page.bindings) || !page.pagination) {
        throw new Error('score-program catalog response is malformed')
      }
      const returnedOffset = boundedCatalogInteger(
        page.pagination.offset,
        'offset'
      )
      const limit = boundedCatalogInteger(page.pagination.limit, 'limit')
      const total = boundedCatalogInteger(page.pagination.total, 'total')
      if (
        returnedOffset !== offset ||
        limit < 1 ||
        limit > PROGRAM_CATALOG_PAGE_SIZE ||
        total > PROGRAM_CATALOG_MAX_ROWS
      ) {
        throw new Error('score-program catalog pagination is inconsistent')
      }

      for (const row of page.bindings) {
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.snapshot !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(row.snapshot)
        ) {
          throw new Error('score-program catalog snapshot is malformed')
        }
        const snapshot = row.snapshot.toLowerCase()
        if (snapshots.has(snapshot)) {
          throw new Error('score-program catalog repeats a snapshot')
        }
        snapshots.add(snapshot)
        bindings.push({
          snapshot,
          scoreProgram: parseScoreProgramProvenance(
            row.scoreProgram,
            'nostr-workspace'
          ),
        })
      }

      if (offset + page.bindings.length >= total) break
      if (page.bindings.length === 0) {
        throw new Error('score-program catalog ended before its declared total')
      }
      offset += page.bindings.length
    }
    return { bindings, error: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[directory] Nostr workspace catalog unavailable:', reason)
    return { bindings: [], error: reason }
  }
}

type WeightedPriorListPage = {
  instances: Array<{
    id: unknown
    name: unknown
    snapshot: unknown
    metadata?: unknown
  }>
  page: { limit: unknown; offset: unknown; total: unknown }
}

/**
 * Weighted networks, from the indexer's own list (`GET /weighted-priors`).
 *
 * This is the persistent surface a created weighted instance gets (GOAL M2): without it the
 * instance id appears once, in a toast, and is unfindable after a reload. Weighted instances have
 * no seed-file fallback (they postdate the shipped seed), so an unreachable indexer degrades to an
 * absent section plus the shared catalog warning; a 404 means the route is not deployed on this
 * indexer yet, which is an empty section, not an error.
 */
const readWeightedInstances = async (): Promise<{
  rows: Array<{
    id: string
    name: string
    about: string
    snapshot: string
  }>
  error: string | null
}> => {
  const rows: Array<{
    id: string
    name: string
    about: string
    snapshot: string
  }> = []
  const seen = new Set<string>()
  let offset = 0

  try {
    for (;;) {
      const page = await readJson<WeightedPriorListPage>(
        `/weighted-priors?limit=${PROGRAM_CATALOG_PAGE_SIZE}&offset=${offset}`
      )
      if (page === null) return { rows: [], error: null }
      if (!Array.isArray(page.instances) || !page.page) {
        throw new Error('weighted network list response is malformed')
      }
      const returnedOffset = boundedCatalogInteger(page.page.offset, 'offset')
      const limit = boundedCatalogInteger(page.page.limit, 'limit')
      const total = boundedCatalogInteger(page.page.total, 'total')
      if (
        returnedOffset !== offset ||
        limit < 1 ||
        limit > PROGRAM_CATALOG_PAGE_SIZE ||
        total > PROGRAM_CATALOG_MAX_ROWS
      ) {
        throw new Error('weighted network list pagination is inconsistent')
      }

      for (const row of page.instances) {
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.id !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(row.id) ||
          typeof row.name !== 'string' ||
          typeof row.snapshot !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(row.snapshot)
        ) {
          throw new Error('weighted network list row is malformed')
        }
        const metadata =
          row.metadata &&
          typeof row.metadata === 'object' &&
          !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null
        const id = row.id.toLowerCase()
        if (seen.has(id)) {
          throw new Error('weighted network list repeats a row')
        }
        seen.add(id)
        rows.push({
          id: row.id,
          name:
            typeof metadata?.name === 'string' && metadata.name.trim()
              ? metadata.name.trim()
              : row.name,
          about:
            typeof metadata?.description === 'string'
              ? metadata.description.trim()
              : '',
          snapshot: row.snapshot,
        })
      }

      if (offset + page.instances.length >= total) break
      if (page.instances.length === 0) {
        throw new Error('weighted network list ended before its declared total')
      }
      offset += page.instances.length
    }
    return { rows, error: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[directory] weighted network catalog unavailable:', reason)
    return { rows: [], error: reason }
  }
}

/**
 * The latest proven scoreboard for one snapshot.
 *
 * Two reads, and the second is skipped when the first says nothing has ever been proven — a
 * directory of twelve networks should not fire twelve pointless requests to learn that.
 */
const readSummary = async (
  snapshot: string,
  { program }: { program: DirectoryProgram }
): Promise<ScoreboardSummary> => {
  let summary: ScoreboardSummary
  try {
    const list =
      program === 'nostr-workspace'
        ? await readJson<NostrWorkspaceRootList>(
            `/nostr-workspace/roots?snapshot=${encodeURIComponent(snapshot)}&limit=1&offset=0`
          )
        : program === 'hypercerts'
          ? await readJson<HypercertsRootList>(
              `/hypercerts/roots?snapshot=${encodeURIComponent(snapshot)}`
            )
          : await readJson<MerkleTreeList>(`/merkle/${snapshot}/all`)
    const latest =
      program === 'nostr-workspace'
        ? (list as NostrWorkspaceRootList | null)?.roots?.[0]
        : program === 'hypercerts'
          ? (list as HypercertsRootList | null)?.roots?.[0]
          : (list as MerkleTreeList | null)?.trees?.[0]
    if (!latest) return NEVER_PROVEN
    const provenance =
      program === 'nostr-workspace'
        ? (latest as NostrWorkspaceRootList['roots'][number]).scoreProgram
        : program === 'hypercerts'
          ? (list as HypercertsRootList).scorePrograms[snapshot.toLowerCase()]
          : (list as MerkleTreeList).scoreProgram
    parseScoreProgramProvenance(provenance, program)

    // Guarded, not trusted. A missing or non-numeric `timestamp` yields NaN, which passes
    // the `provenAt === null` test in `freshnessLabel` and falls through every branch of
    // `humanAgo` to print "NaN months ago"; `Intl.NumberFormat.format(undefined)` prints
    // the string "NaN" in a figure cell. A fourth, silently wrong state is worse than the
    // three this type is careful to keep apart, so unparseable means unreadable.
    const provenAt = Number(latest.timestamp)
    const scored = Number(
      'numAccounts' in latest ? latest.numAccounts : latest.numNodes
    )
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

  if (program !== 'trust-graph') return summary

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

  const [catalog, nostrCatalog, weightedCatalog] = await Promise.all([
    getCatalog(),
    readNostrWorkspaceBindings(),
    readWeightedInstances(),
  ])

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
    ...weightedCatalog.rows.map((row) => ({
      program: 'trust-graph-weighted' as const,
      id: row.id,
      name: row.name,
      about:
        row.about ||
        `Weighted instance ${row.id.slice(0, 10)}…${row.id.slice(-8)}`,
      snapshot: row.snapshot,
    })),
    ...VISIBLE_HYPERCERTS_NETWORKS.map((network) => ({
      program: 'hypercerts' as const,
      id: network.id,
      name: network.name,
      about: network.about,
      snapshot: network.contracts.merkleSnapshot,
    })),
    ...nostrCatalog.bindings.map(({ snapshot, scoreProgram }) => ({
      program: 'nostr-workspace' as const,
      id: `${scoreProgram.instanceId}:${snapshot}`,
      name: `Nostr workspace ${scoreProgram.instanceId.slice(0, 10)}…${scoreProgram.instanceId.slice(-6)}`,
      about:
        'Members and delegated agents scored from anchored Buzz/Nostr workspace history.',
      snapshot,
    })),
  ]

  const summaries = await Promise.all(
    sources.map((source) =>
      readSummary(source.snapshot, {
        program: source.program,
      })
    )
  )

  const grouped: Record<DirectoryProgram, DirectoryRow[]> = {
    'trust-graph': [],
    'trust-graph-weighted': [],
    contributions: [],
    hypercerts: [],
    'nostr-workspace': [],
  }

  sources.forEach((source, index) => {
    grouped[source.program].push({
      id: source.id,
      name: source.name,
      blurb: oneLine(source.about),
      href:
        source.program === 'nostr-workspace'
          ? `/nostr-workspaces/${source.snapshot}`
          : `/networks/${source.id}`,
      summary: summaries[index] ?? UNREADABLE,
    })
  })

  const sections = toSections(grouped)

  return {
    sections,
    catalogError:
      [catalog.error, nostrCatalog.error, weightedCatalog.error]
        .filter(Boolean)
        .join('; ') || null,
    total: sections.reduce((n, section) => n + section.rows.length, 0),
  }
}
