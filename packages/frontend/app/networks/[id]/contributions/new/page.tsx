import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { getNetwork } from '@/lib/catalog.server'
import { socialCard } from '@/lib/metadata'

import { NewContributionRoundPage } from './component'

export const revalidate = 10

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { network } = await getNetwork(id)
  if (!network) return {}

  const title = `Start a ${network.name} contribution round`
  return {
    title,
    ...socialCard({
      title: `${title} | trustgraphs`,
      description:
        'One transaction sets up a community-scored funding round on this network.',
      path: `/networks/${id}/contributions/new`,
    }),
  }
}

export default async function NewContributionRoundServer({
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

  return <NewContributionRoundPage network={network} />
}
