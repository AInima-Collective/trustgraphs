import { getPonderQueryOptions } from '@ponder/react'
import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import { notFound } from 'next/navigation'

import { NetworkProvider } from '@/contexts/NetworkContext'
import {
  VISIBLE_CONTRIBUTIONS_NETWORKS,
  VISIBLE_HYPERCERTS_NETWORKS,
  VISIBLE_NETWORKS,
} from '@/lib/config'
import { ponderClient } from '@/lib/ponder'
import { makeQueryClient } from '@/lib/query'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { NetworkPage } from './component'
import { ContributionsNetworkPage } from './contributions'
import { HypercertsNetworkPage } from './hypercerts'

export const revalidate = 3_600 // 1 hour

export async function generateStaticParams() {
  return [
    ...VISIBLE_NETWORKS,
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
  // address-keyed prefetching below applies.
  const hypercertsNetwork = VISIBLE_HYPERCERTS_NETWORKS.find(
    (network) => network.id === id
  )
  if (hypercertsNetwork) {
    return <HypercertsNetworkPage network={hypercertsNetwork} />
  }

  // A contributions instance renders the round view — claims/ratings live on-chain against its
  // own resolver, so none of the vouching-network prefetching below applies either.
  const contributionsNetwork = VISIBLE_CONTRIBUTIONS_NETWORKS.find(
    (network) => network.id === id
  )
  if (contributionsNetwork) {
    return <ContributionsNetworkPage network={contributionsNetwork} />
  }

  const network = VISIBLE_NETWORKS.find((network) => network.id === id)
  if (!network) {
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
    // Gnosis Safe
    network.contracts.safe?.proxy &&
      queryClient.prefetchQuery({
        ...getPonderQueryOptions(
          ponderClient,
          ponderQueryFns.getGnosisSafe(network.contracts.safe.proxy)
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
