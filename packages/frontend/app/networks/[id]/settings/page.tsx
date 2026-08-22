import { notFound } from 'next/navigation'

import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getInstanceDetails, getNetwork } from '@/lib/catalog.server'
import { VISIBLE_SEED_NETWORKS } from '@/lib/config'

import { SettingsPage } from './component'
import { SETTINGS_TABS, type SettingsTab } from './tabs'

// Must stay aligned with `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

export async function generateStaticParams() {
  return VISIBLE_SEED_NETWORKS.map((network) => ({ id: network.id }))
}

export default async function NetworkSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { id } = await params
  const { tab } = await searchParams
  const requestedTab = Array.isArray(tab) ? tab[0] : tab
  const activeTab = SETTINGS_TABS.some(({ id }) => id === requestedTab)
    ? (requestedTab as SettingsTab)
    : 'overview'
  const { network, catalogError } = await getNetwork(id)

  if (!network) {
    if (catalogError) {
      return <CatalogUnavailable reason={catalogError} networkId={id} />
    }
    notFound()
  }

  const instance = await getInstanceDetails(network)

  return (
    <NetworkProvider network={network}>
      <SettingsPage instance={instance} activeTab={activeTab} />
    </NetworkProvider>
  )
}
