'use client'

import { Check, ListFilter } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { Suspense, useState } from 'react'

import { TableAddress } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { CreateAttestationModal } from '@/components/CreateAttestationModal'
import { Dropdown } from '@/components/Dropdown'
import { ExportButton } from '@/components/ExportButton'
import { Markdown } from '@/components/Markdown'
import { NetworkHeader } from '@/components/NetworkHeader'
import { NetworkSimulationConfigDropdown } from '@/components/NetworkSimulationConfigDropdown'
import { SectionHeading } from '@/components/SectionHeading'
import { StatisticCard } from '@/components/StatisticCard'
import { Column, Table } from '@/components/Table'
import { useNetwork } from '@/contexts/NetworkContext'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { isTrustedSeed, isValidatedInNetwork } from '@/lib/network'
import { trustGraphTabs } from '@/lib/network-nav'
import { NetworkEntry } from '@/lib/types'
import { formatBigNumber } from '@/lib/utils'

// Uses web2gl, which is not supported on the server
const NetworkGraph = dynamic(
  () => import('@/components/NetworkGraph').then((mod) => mod.NetworkGraph),
  {
    ssr: false,
  }
)

export const NetworkPage = () => {
  const router = useRouter()
  const pushBreadcrumb = usePushBreadcrumb()

  const {
    network,
    isLoading,
    error,
    accountData: networkData,
    totalValue,
    totalParticipants,
    averageValue,
    medianValue,
    gnosisSafe,
    refresh,
  } = useNetwork()

  const { name, about, callToAction, applicationUrl, criteria } = network

  // Define table columns
  const columns: Column<NetworkEntry>[] = [
    {
      key: 'rank',
      header: 'RANK',
      tooltip:
        "Member's position in this network ranked by Trust Score. Rank is recalculated as new attestations are made.",
      sortable: true,
      accessor: (row) => row.rank,
      render: (row) => `#${row.rank}`,
    },
    {
      key: 'account',
      header: 'ACCOUNT',
      tooltip: 'The wallet address or ENS name of this network member.',
      sortable: false,
      render: (row) => <TableAddress address={row.account} showNavIcon />,
    },
    {
      key: 'seed',
      header: 'SEED',
      tooltip:
        'Indicates if this member is part of the initial seed group that bootstrapped this network. Seed member influence is designed to diminish as the network grows.',
      sortable: false,
      render: (row) => (isTrustedSeed(network, row.account) ? '🌱' : ''),
    },
    {
      key: 'validated',
      header: 'VALIDATED',
      tooltip:
        'Indicates if this member has attained a significant trust score in the network.',
      sortable: false,
      render: (row) =>
        isValidatedInNetwork(network, row.value) ? (
          <Check className="w-4 h-4" />
        ) : (
          ''
        ),
    },
    {
      key: 'received',
      header: 'RECEIVED',
      tooltip:
        'The number of attestations this member has received from other participants in this network.',
      sortable: true,
      accessor: (row) => row.received || 0,
      render: (row) => formatBigNumber(row.received || 0, undefined, true),
    },
    {
      key: 'sent',
      header: 'SENT',
      tooltip:
        'The number of attestations this member has given to other participants, indicating their level of engagement in building network trust.',
      sortable: true,
      accessor: (row) => row.sent || 0,
      render: (row) => formatBigNumber(row.sent || 0, undefined, true),
    },
    {
      key: 'score',
      header: 'SCORE',
      tooltip:
        "This member's calculated Trust Score using a PageRank-style algorithm. Higher scores indicate stronger endorsement from trusted peers in the network.",
      sortable: true,
      accessor: (row) => Number(BigInt(row.value || '0')),
      // Merkle values are pool allocations in wei (scaled by precisionScale = 1e18); divide for display.
      render: (row) => formatBigNumber(row.value, 18),
    },
  ]

  const [filterMode, setFilterMode] = useState<'all' | 'validated'>('all')

  const filteredNetworkData =
    filterMode === 'validated'
      ? networkData.filter((row) => isValidatedInNetwork(network, row.value))
      : networkData

  return (
    <div className="space-y-12">
      {/* Identity + where you can go from here. Full width, above the two-column body, so the
          tab bar sits directly under the network's name instead of being buried in a column
          beside the graph. */}
      <div className="flex flex-col items-start gap-4">
        <BreadcrumbRenderer className="mb-2" />
        <NetworkHeader network={network} className="w-full" />
      </div>

      <div className="grid grid-cols-1 justify-start items-stretch lg:grid-cols-2 lg:items-start gap-12">
        <div className="flex flex-col items-start gap-4">
          <SectionHeading>About network</SectionHeading>
          <Markdown>{about}</Markdown>

          {callToAction && (
            <ButtonLink
              href={callToAction.href}
              target="_blank"
              variant="brand"
              rel="noopener noreferrer"
              className="mb-2"
            >
              {callToAction.label}
            </ButtonLink>
          )}

          {applicationUrl && (
            <ButtonLink
              href={applicationUrl}
              target="_blank"
              variant="brand"
              rel="noopener noreferrer"
              className="mb-2"
            >
              Apply to join
            </ButtonLink>
          )}

          <SectionHeading className="mt-2">Criteria</SectionHeading>
          <Markdown>{criteria}</Markdown>

          <div className="flex flex-row gap-3 mt-3 flex-wrap">
            <CreateAttestationModal />
          </div>
        </div>

        <div className="h-[66vh] lg:h-4/5">
          <Suspense fallback={null}>
            <NetworkGraph />
          </Suspense>
        </div>
      </div>

      <div className="border-y border-border py-12 space-y-6">
        <SectionHeading>Network statistics</SectionHeading>
        <div className="flex flex-row gap-4 flex-wrap">
          <StatisticCard
            title="TOTAL MEMBERS"
            tooltip="The total number of participants in this trustgraph who have a trust score above this network's threshold."
            value={
              isLoading
                ? '...'
                : formatBigNumber(totalParticipants, undefined, true)
            }
          />
          <StatisticCard
            title="TOTAL NETWORK SCORE"
            tooltip="The sum of all Trust Scores across all network members, indicating overall network capacity and collective credibility."
            value={isLoading ? '...' : formatBigNumber(totalValue, 18)}
          />
          <StatisticCard
            title="AVERAGE + MEDIAN TRUST SCORE"
            tooltip="These metrics show typical member Trust Scores in this network."
            value={`${formatBigNumber(
              Math.round(averageValue),
              18
            )} / ${formatBigNumber(Math.round(medianValue), 18)}`}
          />
          {gnosisSafe && (
            <StatisticCard
              title="GNOSIS SAFE"
              tooltip="The Gnosis Safe multisig for this network."
              value={`${gnosisSafe.threshold}-of-${gnosisSafe.owners.length}`}
              href={`https://app.safe.global/home?safe=oeth:${gnosisSafe.address}`}
            />
          )}
          {/* <StatisticCard
            title="MEMBERS OVER THRESHOLD"
            tooltip="The percentage of network members who have achieved a minimum Trust Score threshold. You can use this threshold to inform governance eligibility decisions."
            value="43%"
          /> */}
        </div>
      </div>

      <div className="space-y-6">
        <div className="flex flex-row justify-between items-center gap-x-8 gap-y-4 flex-wrap">
          <SectionHeading>Network members</SectionHeading>

          {!isLoading && (
            <div className="flex flex-row items-stretch gap-2 flex-wrap">
              <Button
                onClick={refresh}
                variant="secondary"
                size="sm"
                className="text-xs"
                disabled={isLoading}
              >
                REFRESH
              </Button>

              <NetworkSimulationConfigDropdown size="sm" className="text-xs" />

              <ExportButton
                size="sm"
                className="text-xs"
                data={networkData}
                filename={`trustgraph_${name}_${new Date().toISOString()}`}
              />

              <Dropdown
                options={[
                  { value: 'validated', label: 'VALIDATED' },
                  { value: 'all', label: 'ALL MEMBERS' },
                ]}
                selected={filterMode}
                onSelect={(value) => setFilterMode(value)}
                icon={<ListFilter className="!w-4 !h-4" />}
                triggerSize="sm"
                triggerClassName="text-xs"
                optionClassName="text-xs"
              />
            </div>
          )}
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="text-center py-8">
            <div className="text-sm text-text">◉ LOADING NETWORK DATA ◉</div>
            <div className="text-xs mt-2 text-text-muted">
              Fetching latest trustgraph data...
            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="border border-error bg-error-soft p-4 rounded-sm">
            <div className="error-text text-sm text-error">⚠️ {error}</div>
            <Button onClick={refresh} className="mt-3 !px-4 !py-2">
              <span className="text-xs">RETRY</span>
            </Button>
          </div>
        )}

        {/* Members Table */}
        {!isLoading &&
          networkData.length > 0 &&
          (filteredNetworkData.length > 0 ? (
            <Table
              columns={columns}
              data={filteredNetworkData}
              defaultSortDirection="asc"
              rowClassName="text-sm"
              rowCellClassName={(row) =>
                !isValidatedInNetwork(network, row.value) ? 'bg-accent/40' : ''
              }
              defaultSortColumn="rank"
              onRowClick={
                // Will be prefetched in the TableAddress component
                (row) => {
                  pushBreadcrumb()
                  router.push(`/account/${row.ensName || row.account}`)
                }
              }
              getRowKey={(row) => row.account}
            />
          ) : (
            <div className="border border-border bg-surface py-8 text-center">
              <div className="text-sm text-text-muted">NO MEMBERS FOUND</div>
              <div className="text-xs mt-2 text-text-muted">
                TRY ADJUSTING YOUR FILTER SETTINGS
              </div>
            </div>
          ))}

        {/* No Data Message */}
        {!isLoading && (!networkData || networkData.length === 0) && !error && (
          <Card type="primary" size="lg" className="text-center py-8">
            <div className="text-sm text-text-muted">
              NO NETWORK MEMBERS FOUND
            </div>
            <div className="text-xs mt-2 text-text-muted">
              CREATE ATTESTATIONS TO START BUILDING THE NETWORK
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
