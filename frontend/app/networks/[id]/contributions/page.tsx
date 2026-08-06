import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { getNetwork } from '@/lib/catalog.server'
import { VISIBLE_SEED_NETWORKS } from '@/lib/config'
import { socialCard } from '@/lib/metadata'
import { contributionsRoundsFor } from '@/lib/network-nav'

import { ContributionsNetworkPage } from '../contributions'

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
  if (!network || contributionsRoundsFor(network).length === 0) return {}

  return {
    title: `${network.name} contributions`,
    ...socialCard({
      title: `${network.name} contributions | Trustgraphs`,
      description:
        'See the work, rate it, submit yours, and follow how the community pool will split.',
      path: `/networks/${id}/contributions`,
    }),
  }
}

export default async function ContributionsPageServer({
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

  // Contributions are a capability of the trust network, not a second network
  // destination. V1 configures one active round per trust graph; its program
  // contracts remain separate even though its UX now lives here.
  const round = contributionsRoundsFor(network)[0]
  if (!round) notFound()

  return <ContributionsNetworkPage network={round} hostNetwork={network} />
}
