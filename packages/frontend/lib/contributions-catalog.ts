//! The runtime contributions-round catalog (network-creation GOAL M7).
//!
//! Contribution rounds used to be a build-time list: a `program: "contributions"` entry in
//! `config/networks.<env>.json`, filled in by the deploy pipeline. `ContributionsFactory` makes
//! rounds appear at any moment — the parent network's authority creates one from the app — so the
//! list is read at runtime from the indexer's `/contributions/instances` route, which is built
//! from the factory's `ContributionsInstanceCreated` event.
//!
//! This module is isomorphic (the `lib/catalog.ts` pattern): server loaders and client hooks both
//! build on it. The parent link is `parentInstanceId` — the trust network whose registry instance
//! id the factory recorded at creation — never address equality.

import { type Hex } from 'viem'

import { APIS } from './config'
import { ContributionsNetwork, NetworkSchema } from './types'

/** One row of `GET /contributions/instances` (packages/indexer/src/api/contributions.ts). */
export type ContributionsInstanceRow = {
  id: Hex
  chainId: string
  factory: Hex
  parentInstanceId: Hex
  creator: Hex
  admin: Hex
  name: string
  metadataURI: string
  metadata: {
    name?: string
    description?: string
    criteria?: string
    image?: string
    applicationUrl?: string
  } | null
  contracts: {
    merkleSnapshot: Hex
    contributionResolver: Hex
    trustAccumulatorMirror: Hex
    trustAccumulator: Hex
    merkleFundDistributor: Hex
    distributorToken: Hex | null
  }
  schemaUids: {
    claim: Hex
    response: Hex
    valuation: Hex
  }
  epochLength: string
  paramsHash: Hex
  roundStart: string
  roundEnd: string
  totalPool: string
  createdTimestamp: string
}

/**
 * The three contribution schema strings, EXACTLY as frozen in
 * research/operations/contributions/interfaces.md §1 (and as the factory registers them). The strings are
 * uniform across every round; only the UIDs differ (they bind each round's own resolver).
 */
export const CONTRIBUTION_SCHEMA_STRINGS = {
  claim:
    'string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares',
  response: 'bytes32 claimUID,uint8 response',
  valuation: 'bytes32 claimUID,uint8 score',
} as const

const schemaFields = (schema: string) =>
  schema.split(',').map((field) => {
    const [type, name] = field.split(' ')
    return { name: name!, type: type! }
  })

const schemaEntry = (
  key: 'claim' | 'response' | 'valuation',
  name: string,
  description: string,
  uid: Hex,
  resolver: Hex
): NetworkSchema => ({
  uid,
  key: `contribution-${key}`,
  name,
  description,
  resolver,
  revocable: true,
  schema: CONTRIBUTION_SCHEMA_STRINGS[key],
  fields: schemaFields(CONTRIBUTION_SCHEMA_STRINGS[key]),
})

/** A catalog row, shaped like the static config entries the round pages already consume. */
export const toContributionsNetwork = (
  row: ContributionsInstanceRow
): ContributionsNetwork => ({
  program: 'contributions',
  id: row.id,
  instanceId: row.id,
  parentInstanceId: row.parentInstanceId,
  admin: row.admin,
  createdTimestamp: row.createdTimestamp,
  roundStart: row.roundStart,
  roundEnd: row.roundEnd,
  totalPool: row.totalPool,
  name: row.metadata?.name || row.name,
  about:
    row.metadata?.description ||
    'A contribution round: members submit their work, respond to being named on it, and rate ' +
      "each other's contributions. Ratings are weighted by the parent network's trust scores, " +
      'and the pool splits accordingly.',
  criteria: row.metadata?.criteria,
  applicationUrl: row.metadata?.applicationUrl,
  contracts: {
    merkleSnapshot: row.contracts.merkleSnapshot,
    contributionResolver: row.contracts.contributionResolver,
    trustAccumulatorMirror: row.contracts.trustAccumulatorMirror,
    trustAccumulator: row.contracts.trustAccumulator,
    merkleFundDistributor: row.contracts.merkleFundDistributor,
    poolToken: row.contracts.distributorToken ?? undefined,
  },
  schemas: [
    schemaEntry(
      'claim',
      'Contribution',
      'A claimed contribution',
      row.schemaUids.claim,
      row.contracts.contributionResolver
    ),
    schemaEntry(
      'response',
      'Response',
      'Accept or reject being named on a contribution',
      row.schemaUids.response,
      row.contracts.contributionResolver
    ),
    schemaEntry(
      'valuation',
      'Valuation',
      'Score a contribution from 0 to 100',
      row.schemaUids.valuation,
      row.contracts.contributionResolver
    ),
  ],
})

/** Same request budget as the trust-graph catalog: a stalled indexer degrades, never hangs. */
export const CONTRIBUTIONS_CATALOG_TIMEOUT_MS = 3_000

/**
 * Read the round catalog off the indexer, newest first, optionally scoped to one parent
 * (`parentInstanceId`). Throws on anything that is not a well-formed 200 — callers decide how to
 * degrade; an empty catalog and an unreachable indexer are different answers.
 */
export const fetchContributionsInstances = async (
  parentInstanceId?: Hex,
  init?: RequestInit & { next?: { revalidate?: number } }
): Promise<ContributionsInstanceRow[]> => {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    CONTRIBUTIONS_CATALOG_TIMEOUT_MS
  )
  try {
    const url = `${APIS.ponder}/contributions/instances${
      parentInstanceId ? `?parent=${parentInstanceId}` : ''
    }`
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`GET /contributions/instances responded ${response.status}`)
    }
    const { instances } = (await response.json()) as {
      instances: ContributionsInstanceRow[]
    }
    return instances
  } finally {
    clearTimeout(timer)
  }
}

/** `fetchContributionsInstances`, mapped and degraded: an unreachable indexer means no rounds. */
export const loadContributionsCatalog = async (
  parentInstanceId?: Hex,
  init?: RequestInit & { next?: { revalidate?: number } }
): Promise<{ rounds: ContributionsNetwork[]; error: string | null }> => {
  try {
    const rows = await fetchContributionsInstances(parentInstanceId, init)
    return { rounds: rows.map(toContributionsNetwork), error: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[contributions-catalog] unavailable:', reason)
    return { rounds: [], error: reason }
  }
}

/** One round by instance id (or snapshot address), or null when unknown/unreachable. */
export const fetchContributionsNetwork = async (
  id: string,
  init?: RequestInit & { next?: { revalidate?: number } }
): Promise<{ round: ContributionsNetwork | null; error: string | null }> => {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    CONTRIBUTIONS_CATALOG_TIMEOUT_MS
  )
  try {
    const response = await fetch(
      `${APIS.ponder}/contributions/instances/${id}`,
      { ...init, signal: controller.signal }
    )
    if (response.status === 404) return { round: null, error: null }
    if (!response.ok) {
      throw new Error(`GET /contributions/instances/${id} responded ${response.status}`)
    }
    const row = (await response.json()) as ContributionsInstanceRow
    return { round: toContributionsNetwork(row), error: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[contributions-catalog] unavailable:', reason)
    return { round: null, error: reason }
  } finally {
    clearTimeout(timer)
  }
}
