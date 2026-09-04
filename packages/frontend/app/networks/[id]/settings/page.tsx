import { notFound } from 'next/navigation'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { CatalogUnavailable } from '@/components/CatalogUnavailable'
import { CompositionNetworkHeader } from '@/components/CompositionNetworkHeader'
import { NetworkHeader } from '@/components/NetworkHeader'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { getInstanceDetails, getNetwork } from '@/lib/catalog.server'
import { compositionAsNetwork } from '@/lib/composition/network'
import { getCompositionInstance } from '@/lib/composition.server'
import {
  CONTRIBUTIONS_FACTORY,
  FAST_CONTRIBUTIONS_FACTORY,
  PROVING_VAULT,
} from '@/lib/config'
import { fetchContributionsNetwork } from '@/lib/contributions-catalog'

import { SettingsPage } from './component'
import { NetworkProfileSettings, SnapshotProfileSettings } from './profile'
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
      const compositionNetwork = compositionAsNetwork(composition.instance, {
        ...(PROVING_VAULT ? { provingVault: PROVING_VAULT } : {}),
        ...(FAST_CONTRIBUTIONS_FACTORY || CONTRIBUTIONS_FACTORY
          ? {
              contributionsFactory: (FAST_CONTRIBUTIONS_FACTORY ||
                CONTRIBUTIONS_FACTORY) as `0x${string}`,
            }
          : {}),
      })
      return (
        <div className="space-y-8">
          <BreadcrumbRenderer />
          <CompositionNetworkHeader instance={composition.instance} />
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Manage source policy changes and score-refresh payments for this
            network.
          </p>
          <NetworkProfileSettings
            network={compositionNetwork}
            instance={null}
          />
          <CompositionWorkspace
            settingsInstanceId={composition.instance.id}
            embedded
          />
        </div>
      )
    }
    const contributions = await fetchContributionsNetwork(id)
    if (contributions.round) {
      const round = contributions.round
      const parent = round.parentInstanceId
        ? await getNetwork(round.parentInstanceId)
        : { network: null }
      const parentId = parent.network?.id ?? round.parentInstanceId
      return (
        <div className="space-y-8">
          <BreadcrumbRenderer />
          <NetworkHeader
            network={round}
            description={round.about}
            tabs={[
              {
                href: parent.network
                  ? `/networks/${parent.network.id}/contributions?round=${round.id}`
                  : `/networks/${round.id}`,
                label: 'Round',
                icon: 'overview',
              },
              {
                href: `/networks/${round.id}/settings`,
                label: 'Settings',
                icon: 'settings',
              },
            ]}
          />
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Manage the public profile for this contribution round. Its scoring
            window and payout parameters remain unchanged.
          </p>
          <SnapshotProfileSettings
            target={{
              id: round.id,
              ...(parentId ? { governanceNetworkId: parentId } : {}),
              snapshot: round.contracts.merkleSnapshot,
              governance: round.governance,
              profile: round.profile ?? {
                name: round.name,
                description: round.about,
                criteria: round.criteria ?? '',
                image: round.image ?? '',
                applicationUrl: round.applicationUrl ?? '',
              },
              metadataURI: round.metadataURI,
              metadataURIHash: round.metadataURIHash,
              metadataRevision: round.metadataRevision,
              metadataStatus: round.metadataStatus,
            }}
          />
        </div>
      )
    }
    if (composition.error || contributions.error) {
      return (
        <CatalogUnavailable
          reason={composition.error ?? contributions.error!}
          networkId={id}
        />
      )
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
