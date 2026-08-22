import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { getCatalog } from '@/lib/catalog.server'
import { getContributionsNetwork } from '@/lib/contributions-catalog.server'
import { socialCard } from '@/lib/metadata'
import { trustNetworkFor } from '@/lib/network-nav'

import { PayoutPage } from '../payout/component'

export const revalidate = 10

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { round } = await getContributionsNetwork(id)
  if (!round) return {}

  const title = `Claim your ${round.name} share`
  return {
    title,
    ...socialCard({
      title: `${title} | trustgraphs`,
      description: 'See your settled share and claim the money you earned.',
      path: `/networks/${id}/claim`,
    }),
  }
}

export default async function ClaimPageServer({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // Rounds are resolved from the runtime round catalog (they are factory-minted at any moment);
  // the static config list is gone.
  const { round, error } = await getContributionsNetwork(id)
  if (!round) {
    if (error) {
      return <CatalogUnavailable reason={error} networkId={id} />
    }
    notFound()
  }

  const { networks } = await getCatalog()
  const trustNetwork = trustNetworkFor(round, networks)
  if (trustNetwork) {
    redirect(`/networks/${trustNetwork.id}/rewards`)
  }

  return <PayoutPage network={round} />
}
