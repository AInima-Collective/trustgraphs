//! The runtime trust-graph catalog (GOAL.md M3; research/INSTANCE_FACTORY.md §3).
//!
//! Trust-graph networks used to be a build-time list: `config/networks.<env>.json` → the
//! `networks.json` symlink → a synchronous `import` in `lib/config.ts`. Adding a network meant
//! editing JSON and redeploying the app. `TrustgraphsFactory` makes networks appear at any moment,
//! so the list has to be read at runtime instead — from the indexer's `/instances` route, which is
//! built from the frozen `InstanceCreated` event.
//!
//! This module is isomorphic (no `fetch` options that only work on one side, no React): the server
//! loader (`lib/catalog.server.ts`) and the client provider (`contexts/CatalogContext.tsx`) both
//! build on it.
//!
//! WHAT STAYS STATIC: only trust-graph instances are factory-minted in v1. The contributions and
//! hypercerts entries in `networks.json` keep their static code paths untouched
//! (`lib/config.ts`).
//!
//! THE SEED FILE IS NOT DEAD. `config/networks.<env>.json` keeps two jobs:
//!   1. curated presentation the chain does not carry — the human-readable URL slug, `about`,
//!      `link`, `callToAction`, the Safe/gov addresses, `validatedThreshold`;
//!   2. an honest fallback when the indexer is unreachable, so a down indexer degrades to "the
//!      networks we shipped with, plus a visible warning" instead of a blank page.
//! A seed entry and a catalog row are the SAME network when they share a `merkleSnapshot`
//! address; the catalog row then wins on everything the chain pins (addresses, params, schema
//! uid) and the seed wins on presentation.

import { type Hex, isAddressEqual } from 'viem'

import { collectCatalogPages } from './catalog-pagination'
import { APIS, VISIBLE_SEED_NETWORKS } from './config'
import type { ExactParamsJson } from './scoring-params'
import { Network, NetworkSchema } from './types'

/** The 17-field params struct as `/instances` serves it: fixed-point, uint256/uint64 as strings. */
export type InstanceParamsJson = ExactParamsJson

/** One row of `GET /instances` (see `indexer/src/api/instances.ts` for the authoritative shape). */
export type InstanceRow = {
  id: Hex
  chainId: string
  factory: Hex
  creator: Hex
  admin: Hex
  name: string
  metadataURI: string
  /** The pinned `{name, description, criteria, image, applicationUrl}` blob, or null. */
  metadata: {
    name?: string
    description?: string
    criteria?: string
    image?: string
    applicationUrl?: string
  } | null
  contracts: {
    merkleSnapshot: Hex
    easIndexerResolver: Hex
    merkleFundDistributor: Hex | null
    trustgraphsParamsController: Hex | null
    merkleGovModule: Hex | null
    safe: { proxy: Hex } | null
  }
  schema: NetworkSchema
  distributorToken: Hex | null
  epochLength: string
  paramsHash: Hex
  params: InstanceParamsJson
  paramsControl: 'typed' | 'legacy'
  paramsVersion: string | null
  paramsState: 'current-unpinned' | 'active' | null
  paramsExecutedAtBlock: string | null
  paramsExecutedTimestamp: string | null
  paramsExecutedTxHash: Hex | null
  paramsFirstCheckpoint: string | null
  trustedSeeds: Hex[]
  createdBlock: string
  createdTimestamp: string
  createdTxHash: Hex
}

export type InstancesResponse = {
  instances: InstanceRow[]
  pagination: { limit: number; offset: number; total: number }
}

/**
 * The catalog as the rest of the app consumes it. `networks` is always usable — when `error` is
 * set it is the static seed only, and the UI is expected to SAY so rather than pretend the
 * directory is complete.
 */
export type Catalog = {
  networks: Network[]
  /** Null on success; a short human-readable reason when the runtime catalog could not be read. */
  error: string | null
  /** True when `networks` came from the indexer (possibly merged with the seed). */
  live: boolean
}

/** Largest page the indexer's `/instances` route accepts. */
const CATALOG_PAGE_SIZE = 200

export const CATALOG_QUERY_KEY = ['catalog', 'instances'] as const

/**
 * Copy shown when an instance published no metadata (or its metadataURI could not be resolved).
 * Deliberately says nothing about the network — inventing a description for someone else's
 * community would be worse than an empty one.
 */
export const NO_DESCRIPTION = ''
export const NO_CRITERIA =
  'This network has not published vouching criteria yet. Vouch only for people you actually know and trust.'

const scaleOf = (params: InstanceParamsJson): bigint => {
  const scale = BigInt(params.precisionScale)
  return scale > 0n ? scale : 10n ** 18n
}

/**
 * Fixed-point → display number, via decimal strings so no float rounding creeps in
 * (`Number(BigInt("100000000000000000000")) / 1e18` is not reliably `100`).
 *
 * The inverse used by the browser recompute is `lib/pagerank/simulate.toFp`, which keeps 9
 * decimal places. A param with more precision than that survives rendering and vouching fine but
 * would make the optional "what-if" simulation's `paramsHash` differ from the chain's — the
 * simulation panel is a preview, the chain is the authority.
 */
export const fromFp = (raw: string | bigint, scale: bigint): number => {
  const value = BigInt(raw)
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const digits = scale.toString().length - 1
  const whole = magnitude / scale
  const fraction = (magnitude % scale)
    .toString()
    .padStart(digits, '0')
    .replace(/0+$/, '')
  const decimal = `${whole}${fraction ? `.${fraction}` : ''}`
  return negative ? -Number(decimal) : Number(decimal)
}

/** Turn one `/instances` row into the `Network` shape every existing page already understands. */
export const instanceToNetwork = (row: InstanceRow): Network => {
  const scale = scaleOf(row.params)
  const metadata = row.metadata ?? {}

  return {
    program: 'trust-graph',
    // Catalog-only networks are addressed by their `instanceId`. A network that also has a seed
    // entry keeps the seed's human slug — see `mergeCatalog`.
    id: row.id,
    instanceId: row.id,
    name: metadata.name?.trim() || row.name,
    admin: row.admin,
    epochLength: row.epochLength,
    paramsHash: row.paramsHash,
    createdTimestamp: row.createdTimestamp,
    about: metadata.description?.trim() || NO_DESCRIPTION,
    criteria: metadata.criteria?.trim() || NO_CRITERIA,
    ...(metadata.applicationUrl?.trim()
      ? { applicationUrl: metadata.applicationUrl.trim() }
      : {}),
    contracts: {
      merkleSnapshot: row.contracts.merkleSnapshot,
      easIndexerResolver: row.contracts.easIndexerResolver,
      ...(row.contracts.merkleFundDistributor
        ? { merkleFundDistributor: row.contracts.merkleFundDistributor }
        : {}),
      ...(row.contracts.trustgraphsParamsController
        ? {
            trustgraphsParamsController:
              row.contracts.trustgraphsParamsController,
          }
        : {}),
      ...(row.contracts.merkleGovModule
        ? { merkleGovModule: row.contracts.merkleGovModule }
        : {}),
      ...(row.contracts.safe ? { safe: row.contracts.safe } : {}),
    },
    schemas: [row.schema],
    pagerank: {
      enabled: true,
      // Kept as the raw decimal string: `totalPool` is routinely 1e24, which a JS number cannot
      // hold exactly, and it is hashed into `paramsHash`.
      pointsPool: row.params.totalPool,
      trustMultiplier: fromFp(row.params.trustMultiplierFp, scale),
      trustShare: fromFp(row.params.trustShareFp, scale),
      trustDecay: fromFp(row.params.trustDecayFp, scale),
      minWeight: fromFp(row.params.minWeightFp, scale),
      maxWeight: fromFp(row.params.maxWeightFp, scale),
      trustedSeeds: row.params.trustedSeeds,
      ...(row.params.envelope0DomainSeparators.length
        ? { envelope0DomainSeparators: row.params.envelope0DomainSeparators }
        : {}),
      ...(row.params.lane2MaxHeadAge && row.params.lane2MaxHeadAge !== '0'
        ? { lane2MaxHeadAge: Number(row.params.lane2MaxHeadAge) }
        : {}),
    },
    // Signer-sync remains optional. Governed factory instances always have a Safe and voting
    // module, while automatic signer rotation can still be added separately.
    safeZodiacSignerSync: {
      enabled: false,
      topNSigners: 5,
      minThreshold: 1,
      targetThreshold: 0.5,
    },
    // Presentation-only "has this member cleared the bar" marker. The chain pins no such number,
    // so an instance that published none has no bar: everyone with a score counts.
    validatedThreshold: 0,
  }
}

const sameSnapshot = (a: string | undefined, b: string | undefined) => {
  if (!a || !b) return false
  try {
    return isAddressEqual(a as Hex, b as Hex)
  } catch {
    return a.toLowerCase() === b.toLowerCase()
  }
}

/**
 * Overlay a seed entry's curated presentation onto a catalog row. The chain wins on everything it
 * pins; the config file wins on everything it is the only source of.
 */
const overlaySeed = (catalog: Network, seed: Network): Network => ({
  ...catalog,
  // The slug people have bookmarked and linked. `instanceId` stays resolvable too.
  id: seed.id,
  name: seed.name,
  ...(seed.hidden !== undefined ? { hidden: seed.hidden } : {}),
  ...(seed.link ? { link: seed.link } : {}),
  ...(seed.callToAction ? { callToAction: seed.callToAction } : {}),
  ...(seed.applicationUrl ? { applicationUrl: seed.applicationUrl } : {}),
  about: seed.about || catalog.about,
  criteria: seed.criteria || catalog.criteria,
  contracts: {
    // Seed-only addresses survive; chain-discovered addresses win. Merge Safe fields separately
    // so a runtime proxy does not erase the seed's optional factory/singleton metadata.
    ...seed.contracts,
    ...catalog.contracts,
    ...(seed.contracts.safe || catalog.contracts.safe
      ? {
          safe: {
            ...seed.contracts.safe,
            ...catalog.contracts.safe,
          } as NonNullable<Network['contracts']['safe']>,
        }
      : {}),
  },
  safeZodiacSignerSync: seed.safeZodiacSignerSync,
  validatedThreshold: seed.validatedThreshold,
})

/**
 * One catalog row as a `Network`, with its seed entry's curated presentation applied when the two
 * describe the same instance (same `merkleSnapshot`).
 */
export const mergeInstance = (
  row: InstanceRow,
  seeds: Network[] = VISIBLE_SEED_NETWORKS
): Network => {
  const network = instanceToNetwork(row)
  const seed = seeds.find((candidate) =>
    sameSnapshot(
      candidate.contracts.merkleSnapshot,
      row.contracts.merkleSnapshot
    )
  )
  return seed ? overlaySeed(network, seed) : network
}

/**
 * Merge the runtime catalog with the static seed. Catalog order (newest first) is preserved and
 * seed-only networks are appended, so a freshly created network shows up at the top of the list
 * and networks the indexer has not caught up on do not vanish.
 */
export const mergeCatalog = (
  rows: InstanceRow[],
  seeds: Network[] = VISIBLE_SEED_NETWORKS
): Network[] => {
  const claimed = new Set<string>()
  const merged = rows.map((row) => {
    const network = mergeInstance(row, seeds)
    const seed = seeds.find((candidate) =>
      sameSnapshot(
        candidate.contracts.merkleSnapshot,
        row.contracts.merkleSnapshot
      )
    )
    if (seed) claimed.add(seed.id)
    return network
  })

  const orphans = seeds.filter((seed) => !claimed.has(seed.id))
  return [...merged, ...orphans].filter((network) => !network.hidden)
}

/**
 * Resolve a `/networks/[id]` path segment. A network created through the factory is addressed by
 * its `instanceId`; the networks that predate the factory keep their config slug; and the
 * snapshot address works for both because it is the one identifier every other surface (indexer
 * routes, explorer links, proofs) already uses.
 */
export const resolveNetwork = (
  networks: Network[],
  id: string | undefined
): Network | undefined => {
  if (!id) return undefined
  const needle = id.toLowerCase()
  return networks.find(
    (network) =>
      network.id.toLowerCase() === needle ||
      network.instanceId?.toLowerCase() === needle ||
      network.contracts.merkleSnapshot.toLowerCase() === needle
  )
}

/**
 * Read the catalog off the indexer. Throws on anything that is not a well-formed 200 — callers
 * decide how to degrade (see `Catalog.error`); silently returning an empty directory would render
 * "this network does not exist" for networks that plainly do.
 */
export const CATALOG_TIMEOUT_MS = 3_000

export const fetchInstances = async (
  init?: RequestInit & { next?: { revalidate?: number } }
): Promise<InstancesResponse> => {
  // The root layout awaits this on EVERY route, and `fetch` has no timeout of its own. An
  // indexer that is down rejects immediately and degrades fine; one that accepts the
  // connection and then stops talking would hold `/`, `/networks` and `/faq` open until the
  // platform's limit. Same budget the per-row summaries already use.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    return await collectCatalogPages<InstanceRow>(async (offset) => {
      const url = `${APIS.ponder}/instances?limit=${CATALOG_PAGE_SIZE}&offset=${offset}`
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (!response.ok) {
        throw new Error(`GET /instances responded ${response.status}`)
      }
      return response.json()
    })
  } finally {
    clearTimeout(timer)
  }
}

/** `fetchInstances` + `mergeCatalog`, as one already-degraded-or-not `Catalog`. */
export const loadCatalog = async (
  init?: RequestInit & { next?: { revalidate?: number } }
): Promise<Catalog> => {
  try {
    const { instances } = await fetchInstances(init)
    return { networks: mergeCatalog(instances), error: null, live: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[catalog] falling back to the static network list:', reason)
    return {
      networks: VISIBLE_SEED_NETWORKS,
      error: reason,
      live: false,
    }
  }
}
