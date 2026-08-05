import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { VISIBLE_CONTRIBUTIONS_NETWORKS } from '@/lib/config'
import { socialCard } from '@/lib/metadata'

import { PayoutPage } from '../payout/component'

export const revalidate = 3_600 // 1 hour

export async function generateStaticParams() {
  return VISIBLE_CONTRIBUTIONS_NETWORKS.map((network) => ({
    id: network.id,
  }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const network = VISIBLE_CONTRIBUTIONS_NETWORKS.find(
    (candidate) => candidate.id === id
  )
  if (!network) return {}

  const title = `Claim your ${network.name} share`
  return {
    title,
    ...socialCard({
      title: `${title} | Trustgraphs`,
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

  const network = VISIBLE_CONTRIBUTIONS_NETWORKS.find(
    (network) => network.id === id
  )
  if (!network) {
    notFound()
  }

  return <PayoutPage network={network} />
}
