import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'
import { VISIBLE_SEED_NETWORKS } from '@/lib/config'
import { socialCard } from '@/lib/metadata'
import { contributionsRoundsFor } from '@/lib/network-nav'

import { RewardsPage } from '../claims/component'

export const revalidate = 10

export async function generateStaticParams() {
  return VISIBLE_SEED_NETWORKS.map((network) => ({ id: network.id }))
}

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
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  const contributionRound = contributionsRoundsFor(network)[0]
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
