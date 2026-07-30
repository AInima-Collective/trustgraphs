import { notFound } from 'next/navigation'

import { VISIBLE_CONTRIBUTIONS_NETWORKS } from '@/lib/config'

import { RespondPage } from './component'

export const revalidate = 3_600 // 1 hour

export async function generateStaticParams() {
  return VISIBLE_CONTRIBUTIONS_NETWORKS.map((network) => ({
    id: network.id,
  }))
}

export default async function RespondPageServer({
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

  return <RespondPage network={network} />
}
