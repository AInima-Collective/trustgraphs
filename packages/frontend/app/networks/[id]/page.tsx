import { getPonderQueryOptions } from '@ponder/react'
import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getCatalog, getNetwork } from '@/lib/catalog.server'
import { VISIBLE_HYPERCERTS_NETWORKS } from '@/lib/config'
import { fetchContributionsNetwork } from '@/lib/contributions-catalog'
import { socialCard } from '@/lib/metadata'
import { trustNetworkFor } from '@/lib/network-nav'
import { ponderClient } from '@/lib/ponder'
import { nullable } from '@/lib/ponder-query'
import { makeQueryClient } from '@/lib/query'
import { getScoreProgram } from '@/lib/score-program.server'
import { realAddress } from '@/lib/utils'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { NetworkPage } from './component'
import { ContributionsNetworkPage } from './contributions'
import { HypercertsNetworkPage } from './hypercerts'

// A permissionless factory can mint an id after this production bundle was built. Next 15 treats
// an ISR route with generated params as static, then rejects `getNetwork()`'s required no-store
// fallback for that fresh id as a static-to-dynamic transition. Make the detail route explicitly
// request-time; its catalog fetch still keeps its own ten-second cache, while the direct instance
// fallback can truthfully render a just-created network without a rebuild.
export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { round } = await fetchContributionsNetwork(id)
  if (!round) return {}

  const title = `${round.name} contribution round`
  return {
    title,
    ...socialCard({
      title: `${title} | trustgraphs`,
      description:
        'See the work, rate it, submit yours, and follow how the pool would split.',
      path: `/networks/${id}`,
    }),
  }
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
  // Contribution rounds come from the RUNTIME round catalog (the indexer's
  // /contributions/instances, built from ContributionsFactory's creation event): a round created
  // a minute ago renders here with no config edit and no rebuild.
  const { round: contributionsNetwork } = hypercertsNetwork
    ? { round: null }
    : await fetchContributionsNetwork(id)
  const programNetwork = hypercertsNetwork ?? contributionsNetwork
  if (programNetwork) {
    let scoreProgram
    try {
      scoreProgram = await getScoreProgram(
        programNetwork.contracts.merkleSnapshot
      )
    } catch (error) {
      return (
        <CatalogUnavailable
          reason={error instanceof Error ? error.message : String(error)}
          networkId={id}
        />
      )
    }
    // Dispatch comes from authenticated registry provenance. The catalog row supplies only the
    // page slug, copy, and program-specific contract addresses, and must agree with it.
    if (scoreProgram.programName === 'hypercerts' && hypercertsNetwork) {
      return (
        <HypercertsNetworkPage
          network={{ ...hypercertsNetwork, scoreProgram }}
        />
      )
    }
    if (scoreProgram.programName === 'contributions' && contributionsNetwork) {
      const { networks } = await getCatalog()
      const trustNetwork = trustNetworkFor(contributionsNetwork, networks)
      if (trustNetwork) {
        redirect(`/networks/${trustNetwork.id}/contributions`)
      }
      return (
        <ContributionsNetworkPage
          network={{ ...contributionsNetwork, scoreProgram }}
        />
      )
    }
    return (
      <CatalogUnavailable
        reason={`Configured page type conflicts with authenticated ${scoreProgram.programName} program`}
        networkId={id}
      />
    )
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

  try {
    network.scoreProgram =
      network.scoreProgram ??
      (await getScoreProgram(network.contracts.merkleSnapshot, 'trust-graph'))
  } catch (error) {
    return (
      <CatalogUnavailable
        reason={error instanceof Error ? error.message : String(error)}
        networkId={id}
      />
    )
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
