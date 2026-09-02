import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'
import { compositionAsNetwork } from '@/lib/composition/network'
import { getCompositionInstance } from '@/lib/composition.server'
import { isSubnetworkFeatureAvailable } from '@/lib/config'
import { getContributionsCatalog } from '@/lib/contributions-catalog.server'
import { socialCard } from '@/lib/metadata'
import {
  compositionTabs,
  contributionsRoundsFor,
  sortRoundsNewestActiveFirst,
} from '@/lib/network-nav'

import { RewardsPage } from './component'

// Permissionless instances can be created after the production build, and `?fund=` controls the
// request's initial UI. Keep the route request-time while its catalog reads retain their own
// bounded caches.
export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { network } = await getNetwork(id)
  if (!network) return {}

  return {
    title: `${network.name} rewards`,
    ...socialCard({
      title: `${network.name} rewards | trustgraphs`,
      description:
        'See and claim network rewards and contribution funding in one place.',
      path: `/networks/${id}/rewards`,
    }),
  }
}

export default async function RewardsPageServer({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fund?: string }>
}) {
  const { id } = await params
  const { fund } = await searchParams
  const { network, catalogError } = await getNetwork(id)

  if (!network) {
    const composition = await getCompositionInstance(id)
    if (composition.instance) {
      if (!composition.instance.distributor) notFound()
      return (
        <RewardsPage
          network={compositionAsNetwork(composition.instance)}
          tabs={compositionTabs(
            composition.instance,
            isSubnetworkFeatureAvailable()
          )}
          defaultFundOpen={fund === 'true' || fund === '1'}
        />
      )
    }
    if (composition.error) {
      return <CatalogUnavailable reason={composition.error} networkId={id} />
    }
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  // Rounds come from the runtime round catalog; the newest active one fronts the rewards view.
  const { rounds } = await getContributionsCatalog(network.instanceId)
  const contributionRound = sortRoundsNewestActiveFirst(
    contributionsRoundsFor(network, rounds)
  )[0]
  if (!network.contracts.merkleFundDistributor && !contributionRound) {
    notFound()
  }

  return (
    <NetworkProvider network={network}>
      <RewardsPage
        network={network}
        contributionRound={contributionRound}
        defaultFundOpen={fund === 'true' || fund === '1'}
      />
    </NetworkProvider>
  )
}
