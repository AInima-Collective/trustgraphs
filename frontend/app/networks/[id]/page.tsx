import { getPonderQueryOptions } from '@ponder/react'
import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'
import {
  VISIBLE_CONTRIBUTIONS_NETWORKS,
  VISIBLE_HYPERCERTS_NETWORKS,
  VISIBLE_SEED_NETWORKS,
} from '@/lib/config'
import { ponderClient } from '@/lib/ponder'
import { nullable } from '@/lib/ponder-query'
import { makeQueryClient } from '@/lib/query'
import { realAddress } from '@/lib/utils'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { NetworkPage } from './component'
import { ContributionsNetworkPage } from './contributions'
import { HypercertsNetworkPage } from './hypercerts'

// The trust-graph half of this route is catalog-driven, so its cached window is the catalog's
// (seconds), not an hour. `dynamicParams` stays on its default (true): an id that was not known
// when this build ran renders on demand, which is the whole point of a permissionless factory.
// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

export async function generateStaticParams() {
  // Build-time prerender list only. It is deliberately the STATIC seed plus the other programs —
  // the indexer is not a build dependency, and every network it knows about that is missing here
  // is rendered on demand instead.
  return [
    ...VISIBLE_SEED_NETWORKS,
    ...VISIBLE_HYPERCERTS_NETWORKS,
    ...VISIBLE_CONTRIBUTIONS_NETWORKS,
  ].map((network) => ({
    id: network.id,
  }))
}

export default async function NetworkPageServer({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // A hypercerts (nodeId-keyed) instance renders its own read-only page — none of the
  // address-keyed prefetching below applies. Hypercerts instances are not factory-minted in v1,
  // so this list stays static.
  const hypercertsNetwork = VISIBLE_HYPERCERTS_NETWORKS.find(
    (network) => network.id === id
  )
  if (hypercertsNetwork) {
    return <HypercertsNetworkPage network={hypercertsNetwork} />
  }

  // A contributions instance renders the round view — claims/ratings live on-chain against its
  // own resolver, so none of the vouching-network prefetching below applies either. Also not
  // factory-minted in v1; also static.
  const contributionsNetwork = VISIBLE_CONTRIBUTIONS_NETWORKS.find(
    (network) => network.id === id
  )
  if (contributionsNetwork) {
    return <ContributionsNetworkPage network={contributionsNetwork} />
  }

  // Trust-graph: resolved against the RUNTIME catalog, so an instance created seconds ago renders
  // with no rebuild, no config edit and no restart.
  const { network, catalogError } = await getNetwork(id)
  if (!network) {
    // "Not found" and "we could not read the directory" are different answers, and 404ing on the
    // second one tells the user their network does not exist because an HTTP call failed.
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  const queryClient = makeQueryClient()

  await Promise.all([
    // Network
    queryClient.prefetchQuery({
      ...ponderQueries.latestMerkleTree(network.contracts.merkleSnapshot),
      // Refetch right away on page load.
      staleTime: 0,
    }),
    queryClient.prefetchQuery({
      ...ponderQueries.network(network.contracts.merkleSnapshot),
      // Refetch right away on page load.
      staleTime: 0,
    }),
    // Gnosis Safe, when this network actually has one. `realAddress`, not `?.proxy`: a network
    // created without a Safe still carries the field, set to the zero address, which is a truthy
    // string. Prefetching it lands an `undefined` in the dehydrated cache and the client throws
    // "Query data cannot be undefined" on hydration — before any component guard can help, which
    // is why fixing only the client-side hook did not stop it.
    realAddress(network.contracts.safe?.proxy) &&
      queryClient.prefetchQuery({
        ...nullable(
          getPonderQueryOptions(
            ponderClient,
            ponderQueryFns.getGnosisSafe(
              realAddress(network.contracts.safe?.proxy)!
            )
          )
        ),
        // Refetch right away on page load.
        staleTime: 0,
      }),
  ])

  const dehydratedState = dehydrate(queryClient)

  return (
    <HydrationBoundary state={dehydratedState}>
      <NetworkProvider network={network}>
        <NetworkPage />
      </NetworkProvider>
    </HydrationBoundary>
  )
}
