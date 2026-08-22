import { permanentRedirect } from 'next/navigation'

import { VISIBLE_SEED_NETWORKS } from '@/lib/config'

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

export async function generateStaticParams() {
  // Build-time prerender list only; catalog networks render on demand (`dynamicParams` default).
  return VISIBLE_SEED_NETWORKS.map((network) => ({
    id: network.id,
  }))
}

export default async function DistributePageServer({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  permanentRedirect(`/networks/${id}/rewards?fund=true`)
}
