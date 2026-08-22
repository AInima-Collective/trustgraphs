import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { getContributionsNetwork } from '@/lib/contributions-catalog.server'

import { PayoutPage } from './component'

export const revalidate = 10

export default async function PayoutPageServer({
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

  return <PayoutPage network={round} />
}
