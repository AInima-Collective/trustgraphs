import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'
import { compositionAsNetwork } from '@/lib/composition/network'
import { getCompositionInstance } from '@/lib/composition.server'

import { SubnetworksPage } from './component'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sub-networks',
  description: 'Create and manage organizational child networks.',
}

export default async function SubnetworksPageServer({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { network: catalogNetwork, catalogError } = await getNetwork(id)
  let network = catalogNetwork
  let compositionError: string | null = null
  if (!network) {
    const composition = await getCompositionInstance(id)
    compositionError = composition.error
    if (composition.instance)
      network = compositionAsNetwork(composition.instance)
  }
  if (!network) {
    if (catalogError || compositionError)
      return (
        <CatalogUnavailable
          reason={catalogError ?? compositionError!}
          networkId={id}
        />
      )
    notFound()
  }
  if (!network.instanceId || !network.contracts.merkleGovModule) notFound()

  return (
    <NetworkProvider network={network}>
      <SubnetworksPage />
    </NetworkProvider>
  )
}
