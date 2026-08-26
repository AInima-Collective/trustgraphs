import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { getNetwork } from '@/lib/catalog.server'
import { loadContributionsCatalog } from '@/lib/contributions-catalog'
import { socialCard } from '@/lib/metadata'
import {
  contributionsRoundsFor,
  sortRoundsNewestActiveFirst,
} from '@/lib/network-nav'

import { ContributionsNetworkPage } from '../contributions'

// Permissionless networks and rounds can be created after the production build, and `?round=` is
// request-specific. The catalog fetches keep their own bounded caches, so the route itself must be
// request-time rather than an on-demand static render.
export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { network } = await getNetwork(id)
  if (!network) return {}
  const { rounds } = await loadContributionsCatalog(network.instanceId)
  if (contributionsRoundsFor(network, rounds).length === 0) return {}

  return {
    title: `${network.name} contributions`,
    ...socialCard({
      title: `${network.name} contributions | trustgraphs`,
      description:
        'See the work, rate it, submit yours, and follow how the community pool will split.',
      path: `/networks/${id}/contributions`,
    }),
  }
}

export default async function ContributionsPageServer({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ round?: string }>
}) {
  const { id } = await params
  const { round: requestedRound } = await searchParams
  const { network, catalogError } = await getNetwork(id)

  if (!network) {
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  // Contributions are a capability of the trust network, not a second network destination. The
  // rounds come from the RUNTIME round catalog (rounds are created from this network's settings
  // page at any moment), linked to this network by the factory's parentInstanceId. The newest
  // active round renders by default; ?round= picks a sibling.
  const { rounds: allRounds, error: roundsError } =
    await loadContributionsCatalog(network.instanceId)
  const rounds = sortRoundsNewestActiveFirst(
    contributionsRoundsFor(network, allRounds)
  )
  if (rounds.length === 0) {
    if (roundsError) {
      return <CatalogUnavailable reason={roundsError} networkId={id} />
    }
    notFound()
  }
  const requested = requestedRound
    ? rounds.find(
        (candidate) =>
          candidate.id.toLowerCase() === requestedRound.toLowerCase()
      )
    : undefined
  const round = requested ?? rounds[0]
  if (!round) notFound()

  return (
    <ContributionsNetworkPage
      network={round}
      hostNetwork={network}
      siblingRounds={rounds}
    />
  )
}
