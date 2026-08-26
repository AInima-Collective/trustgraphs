'use client'

import { useQuery } from '@tanstack/react-query'
import { ReactNode, createContext, useContext, useMemo } from 'react'

import { registerNetworks } from '@/components/schema-components/registerNetworks'
import {
  CATALOG_QUERY_KEY,
  type Catalog,
  loadCatalog,
  resolveNetwork,
} from '@/lib/catalog'
import { VISIBLE_SEED_NETWORKS } from '@/lib/config'
import { Network } from '@/lib/types'

/**
 * The runtime trust-graph catalog, client side.
 *
 * The list of trust-graph networks is no longer a build-time import — it is read from the
 * indexer's `/instances` route. The root layout does that read on the server and hands the result
 * down as `initial`, so the first paint already shows every network that exists; this provider
 * then keeps it fresh in the browser (a network created while the tab is open shows up within
 * `REFETCH_MS`) without another full page load.
 *
 * Degradation is explicit, not silent: when the indexer cannot be reached, `networks` is the
 * static seed and `error` says so. Screens that list networks are expected to render the warning
 * rather than imply the directory is complete.
 */

/** How often an open tab re-reads the directory. */
const REFETCH_MS = 30_000

export type CatalogContextType = Catalog & {
  /** True while the first browser-side read is still outstanding. */
  isLoading: boolean
  /** Resolve a `/networks/[id]` segment (slug, instanceId or snapshot address). */
  find: (id: string | undefined) => Network | undefined
}

const CatalogContext = createContext<CatalogContextType | null>(null)

const SEED_CATALOG: Catalog = {
  networks: VISIBLE_SEED_NETWORKS,
  error: null,
  live: false,
}

export const CatalogProvider = ({
  initial,
  children,
}: {
  initial?: Catalog
  children: ReactNode
}) => {
  const seed = initial ?? SEED_CATALOG

  const { data, isLoading } = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: () => loadCatalog(),
    initialData: seed,
    // The server read is at most CATALOG_REVALIDATE_SECONDS old; don't refetch immediately on
    // every mount, but do keep an open tab current.
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
    // `loadCatalog` already degrades to the seed instead of throwing.
    retry: false,
  })

  const catalog = data ?? seed

  // Teach `SchemaManager` + the schema-component registry about every catalog network, so the
  // vouch form and its encoder work for instances that were not in the config file at build time.
  // Both registries are idempotent maps; this is the cheapest place that runs on the server render
  // AND on every client refresh.
  registerNetworks(catalog.networks)

  const value = useMemo<CatalogContextType>(
    () => ({
      ...catalog,
      isLoading,
      find: (id) => resolveNetwork(catalog.networks, id),
    }),
    [catalog, isLoading]
  )

  return (
    <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
  )
}

/** The whole catalog, including its error/live flags. */
export const useCatalog = (): CatalogContextType => {
  const context = useContext(CatalogContext)
  if (!context) {
    // A component rendered outside the provider should not silently show an empty directory.
    throw new Error('useCatalog must be used within a CatalogProvider')
  }
  return context
}

/** The visible trust-graph networks. The runtime replacement for `VISIBLE_NETWORKS`. */
export const useNetworks = (): Network[] => useCatalog().networks

/** Resolve one network by slug, instanceId or snapshot address. */
export const useNetworkFromCatalog = (
  id: string | undefined
): Network | undefined => useCatalog().find(id)
