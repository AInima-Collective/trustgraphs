import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { getNetwork } from '@/lib/catalog.server'
import { VISIBLE_SEED_NETWORKS } from '@/lib/config'
import { socialCard } from '@/lib/metadata'
import { contributionsRoundsFor } from '@/lib/network-nav'

import { ClaimsPage } from './component'

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
    title: `${network.name} claims`,
    ...socialCard({
      title: `${network.name} claims | Trustgraphs`,
      description:
        'See and claim trust-weighted distributions and contribution rewards in one place.',
      path: `/networks/${id}/claims`,
    }),
  }
}

export default async function ClaimsPageServer({
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

  const contributionRound = contributionsRoundsFor(network)[0]
  if (!network.contracts.merkleFundDistributor && !contributionRound) {
    notFound()
  }

  return <ClaimsPage network={network} contributionRound={contributionRound} />
}
