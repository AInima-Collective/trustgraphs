import { HydrationBoundary, dehydrate } from '@tanstack/react-query'

import { getCatalog } from '@/lib/catalog.server'
import { makeQueryClient } from '@/lib/query'
import { ponderQueries } from '@/queries/ponder'

import { HomePage } from './component'

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

export default async function HomePageServer() {
  const queryClient = makeQueryClient()

  // The home table lists whatever the runtime catalog holds, so prefetch against that rather than
  // the build-time list.
  const { networks } = await getCatalog()

  // Prefetch network data for all networks in parallel
  await Promise.all(
    networks.map((network) =>
      queryClient.prefetchQuery(
        ponderQueries.network(network.contracts.merkleSnapshot)
      )
    )
  )

  const dehydratedState = dehydrate(queryClient)

  return (
    <HydrationBoundary state={dehydratedState}>
      <HomePage />
    </HydrationBoundary>
  )
}
