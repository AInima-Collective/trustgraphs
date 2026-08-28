//! Server-side access to the runtime trust-graph catalog.
//!
//! Import this from server components and route handlers only — client components get the same
//! data from `useNetworks()` (`contexts/CatalogContext.tsx`), which is seeded by whatever the
//! server rendered here.
//!
//! FRESHNESS, deliberately two-tier:
//!   - `getCatalog()` is memoized per request (`React.cache`) and cached for
//!     `CATALOG_REVALIDATE_SECONDS` across requests, so the directory pages stay statically
//!     renderable and one request never hits the indexer twice.
//!   - `getNetwork(id)` falls back to an UNCACHED `GET /instances/:id` when the id is not in that
//!     window. That is the one place staleness would be visible as a lie ("network not found" for
//!     a network created 30 seconds ago), so it pays for a direct read instead.

import { cache } from 'react'

import {
  CATALOG_TIMEOUT_MS,
  type Catalog,
  type InstanceRow,
  loadCatalog,
  mergeInstance,
  resolveNetwork,
} from './catalog'
import { APIS } from './config'
import { Network } from './types'
import { getWeightedNetwork } from './weighted-prior/network.server'

/**
 * How long a rendered directory may lag the chain.
 *
 * The catalog-driven routes set the SAME number as their `export const revalidate`, written out as
 * a literal because Next statically analyses that export and rejects an imported identifier:
 * `app/page.tsx`, `app/networks/page.tsx`, `app/networks/[id]/rewards/page.tsx`,
 * `app/networks/[id]/governance/layout.tsx`. The network detail route is force-dynamic because it
 * must render factory instances created after the build. Change one, change all five: this
 * constant plus those four cached files.
 */
export const CATALOG_REVALIDATE_SECONDS = 10

/**
 * The merged catalog for this request. Never throws: on an indexer failure it returns the static
 * seed with `error` set, and callers are expected to surface that rather than imply the directory
 * is complete.
 */
export const getCatalog = cache(
  async (): Promise<Catalog> =>
    loadCatalog({ next: { revalidate: CATALOG_REVALIDATE_SECONDS } })
)

const isInstanceId = (id: string) => /^0x[0-9a-fA-F]{64}$/.test(id)

/**
 * Resolve one `/networks/[id]` segment against the catalog.
 *
 * `network` is undefined when the id is genuinely unknown. `catalogError` is set when the runtime
 * catalog could not be read at all — a caller that 404s in that case is reporting a network as
 * non-existent on the strength of a failed HTTP request, which is the wrong answer.
 */
export const getNetwork = async (
  id: string
): Promise<{ network?: Network; catalogError: string | null }> => {
  const catalog = await getCatalog()
  const hit = resolveNetwork(catalog.networks, id)
  if (hit) return { network: hit, catalogError: catalog.error }

  // Not in the (up to CATALOG_REVALIDATE_SECONDS old) window. If it looks like an instanceId, ask
  // the indexer directly before concluding it does not exist.
  if (isInstanceId(id)) {
    let directError: string | null = null
    try {
      const response = await fetch(`${APIS.ponder}/instances/${id}`, {
        cache: 'no-store',
      })
      if (response.ok) {
        const { instance } = (await response.json()) as {
          instance: InstanceRow
        }
        if (instance) {
          // Apply the seed overlay (slug, curated copy) for a network that happens to also be in
          // the config file. `hidden` comes along with it: a config entry marked hidden has never
          // had a reachable page, and this bypass path must not quietly give it one.
          const network = mergeInstance(instance)
          if (!network.hidden) {
            return { network, catalogError: catalog.error }
          }
        }
      } else if (response.status !== 404 && response.status !== 400) {
        directError = `GET /instances/:id responded ${response.status}`
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error('[catalog] direct instance lookup failed:', reason)
      directError = reason
    }

    // Weighted instances deliberately live in an isolated indexer table and endpoint. They still
    // resolve to the same address-keyed Network shape once discovered, so every network sub-route
    // (governance, rewards, settings) must share this fallback rather than special-casing only the
    // overview page.
    const weighted = await getWeightedNetwork(id, APIS.ponder)
    if (weighted.network) {
      return {
        network: weighted.network,
        catalogError: catalog.error ?? directError ?? weighted.error,
      }
    }
    if (weighted.error) {
      directError = directError ?? weighted.error
    }

    if (directError) return { catalogError: catalog.error ?? directError }
  }

  return { catalogError: catalog.error }
}

/**
 * The complete factory-birth record behind a merged `Network`.
 *
 * `instanceToNetwork` intentionally narrows the 17-field params tuple to what the existing graph
 * screens consume. The settings page is the one place where that loss is unacceptable, so it
 * asks for the authoritative catalog row separately. Failure is non-fatal: seed-only and pre-factory
 * networks still have useful live contract settings to show.
 */
export const getInstanceDetails = async (
  network: Network
): Promise<InstanceRow | null> => {
  const query = network.instanceId
    ? `${APIS.ponder}/instances/${network.instanceId}`
    : `${APIS.ponder}/instances?limit=1&snapshot=${network.contracts.merkleSnapshot}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const response = await fetch(query, {
      next: { revalidate: CATALOG_REVALIDATE_SECONDS },
      signal: controller.signal,
    })
    if (!response.ok) return null

    const body = (await response.json()) as
      | { instance?: InstanceRow }
      | { instances?: InstanceRow[] }
    if ('instance' in body) return body.instance ?? null
    if ('instances' in body) return body.instances?.[0] ?? null
    return null
  } catch (error) {
    console.error('[catalog] instance detail lookup failed:', error)
    return null
  } finally {
    clearTimeout(timer)
  }
}
