import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'
import { VISIBLE_SEED_NETWORKS } from '@/lib/config'
import { makeQueryClient } from '@/lib/query'

import { DistributePage } from './component'

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

export async function generateStaticParams() {
  // Build-time prerender list only; catalog networks render on demand (`dynamicParams` default).
  return VISIBLE_SEED_NETWORKS.map((network) => ({
    id: network.id,
  }))
}

export default async function DistributePageServer({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const { network, catalogError } = await getNetwork(id)
  if (!network) {
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  // A network with no fund distributor has nothing to distribute. The tab is contract-gated
  // (`lib/network-nav.ts`), so this catches hand-typed URLs rather than anything the UI links to.
  if (!network.contracts.merkleFundDistributor) {
    notFound()
  }

  const queryClient = makeQueryClient()

  // Merkle tree data is loaded client-side after querying the latest snapshot root
  const dehydratedState = dehydrate(queryClient)

  return (
    <HydrationBoundary state={dehydratedState}>
      <NetworkProvider network={network}>
        <DistributePage />
      </NetworkProvider>
    </HydrationBoundary>
  )
}
