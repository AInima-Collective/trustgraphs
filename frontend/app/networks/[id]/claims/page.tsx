import { permanentRedirect } from 'next/navigation'

import { VISIBLE_SEED_NETWORKS } from '@/lib/config'

export const revalidate = 10

export async function generateStaticParams() {
  return VISIBLE_SEED_NETWORKS.map((network) => ({ id: network.id }))
}

export default async function LegacyClaimsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  permanentRedirect(`/networks/${id}/rewards`)
}
