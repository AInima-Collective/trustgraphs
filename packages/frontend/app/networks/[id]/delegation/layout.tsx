import { notFound } from 'next/navigation'
import { ReactNode } from 'react'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkHeader } from '@/components/NetworkHeader'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

/** Resolves the network once for the pool's proposal list and each proposal screen. */
export default async function DelegationLayout({
  children,
  params,
}: {
  children: ReactNode
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

  // Only networks with a recorded TrustPool delegate anywhere. The tab is contract-gated
  // (`lib/network-nav.ts`), so this catches hand-typed URLs rather than anything the UI links to.
  if (!network.contracts.trustPool) {
    notFound()
  }

  return (
    <NetworkProvider network={network}>
      <div className="space-y-6">
        <NetworkHeader network={network} />
        {children}
      </div>
    </NetworkProvider>
  )
}
