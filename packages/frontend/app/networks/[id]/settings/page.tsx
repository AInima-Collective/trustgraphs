import { notFound } from 'next/navigation'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { CompositionNetworkHeader } from '@/components/CompositionNetworkHeader'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getInstanceDetails, getNetwork } from '@/lib/catalog.server'
import { getCompositionInstance } from '@/lib/composition.server'

import { SettingsPage } from './component'
import { SETTINGS_TABS, type SettingsTab } from './tabs'
import { CompositionWorkspace } from '../../../create/composition/workspace'

// Permissionless instances can be created after the production build, and the selected tab comes
// from request-specific search params. Keep this route request-time, while the catalog and instance
// detail fetches retain their own ten-second caches in lib/catalog.server.ts.
export const dynamic = 'force-dynamic'

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
    const composition = await getCompositionInstance(id)
    if (composition.instance) {
      return (
        <div className="space-y-8">
          <BreadcrumbRenderer />
          <CompositionNetworkHeader instance={composition.instance} />
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Manage source policy changes and score-refresh payments for this
            network.
          </p>
          <CompositionWorkspace
            settingsInstanceId={composition.instance.id}
            embedded
          />
        </div>
      )
    }
    if (composition.error) {
      return <CatalogUnavailable reason={composition.error} networkId={id} />
    }
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
