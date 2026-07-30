import { notFound } from 'next/navigation'
import { ReactNode } from 'react'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getNetwork } from '@/lib/catalog.server'

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

/**
 * Resolves the network once for BOTH governance screens (the proposal list and
 * `[proposalId]`) and puts it in context.
 *
 * A layout rather than a per-page server wrapper because both pages are client components that
 * reach for `useGovernance()` → `useNetwork()`, which throws outside a `NetworkProvider`. One
 * layout covers the whole subtree, including any proposal screen added later.
 */
export default async function GovernanceLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const { network, catalogError } = await getNetwork(id)
  if (!network) {
    // "Not found" and "we could not read the directory" are different answers; 404ing on the
    // second one blames the user's URL for our failed HTTP call.
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  // A network with no Safe gov module has no governance to show. The tab is contract-gated
  // (`lib/network-nav.ts`), so this catches hand-typed URLs rather than anything the UI links to.
  if (!network.contracts.merkleGovModule) {
    notFound()
  }

  return <NetworkProvider network={network}>{children}</NetworkProvider>
}
