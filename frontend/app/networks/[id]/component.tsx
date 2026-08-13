'use client'

import { ArrowUpRight, Check, ListFilter } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { Suspense, useState } from 'react'

import { TableAddress } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CreateAttestationModal } from '@/components/CreateAttestationModal'
import { Dropdown } from '@/components/Dropdown'
import { ExportButton } from '@/components/ExportButton'
import { NetworkHeader } from '@/components/NetworkHeader'
import { NetworkSimulationConfigDropdown } from '@/components/NetworkSimulationConfigDropdown'
import { ScoresAsOf } from '@/components/ScoresAsOf'
import { ScoreUpdateChip } from '@/components/ScoreUpdateChip'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import { useNetwork } from '@/contexts/NetworkContext'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { useScoreDeltas } from '@/hooks/useScoreDeltas'
import { isTrustedSeed, isValidatedInNetwork } from '@/lib/network'
import { NetworkEntry } from '@/lib/types'
import { cn, formatBigNumber } from '@/lib/utils'

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
    scoreboardExportData,
    scoreboardExportMetadata,
    totalValue,
    totalParticipants,
    averageValue,
    medianValue,
    gnosisSafe,
    refresh,
    simulationConfig,
  } = useNetwork()

  const { name, about } = network

  // Small "+0.4" badges on the SCORE column for ten seconds after an update lands, so an
  // attestation's effect is felt without anyone reading a changelog. Off while simulating.
  const scoreDeltas = useScoreDeltas(networkData, !simulationConfig.enabled)

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
      render: (row) => {
        const delta = scoreDeltas?.get(row.account.toLowerCase())
        return (
          <span>
            {formatBigNumber(row.value, 18)}
            {delta !== undefined && delta !== 0n && (
              <span className="ml-1.5 text-xs text-text-muted">
                {delta > 0n ? '+' : '−'}
                {formatBigNumber((delta < 0n ? -delta : delta).toString(), 18)}
              </span>
            )}
          </span>
        )
      },
    },
  ]

  const [filterMode, setFilterMode] = useState<'all' | 'validated'>('all')

  const filteredNetworkData =
    filterMode === 'validated'
      ? networkData.filter((row) => isValidatedInNetwork(network, row.value))
      : networkData

  return (
    <div className="space-y-10 sm:space-y-12">
      {/* The description is network identity, not a competing content column.
          Keep it with the name and tabs; reserve the right edge for the one
          action that changes this graph. */}
      <header className="flex flex-col items-start gap-4">
        <BreadcrumbRenderer className="mb-2" />
        <div className="flex w-full flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
          <NetworkHeader
            network={network}
            description={about}
            className="min-w-0 flex-1"
          />

          <div className="flex shrink-0 flex-row flex-wrap items-center gap-3 lg:pt-1">
            <ScoreUpdateChip snapshot={network.contracts.merkleSnapshot} />
            <CreateAttestationModal
              title="Make attestation"
              className="h-11 px-5"
            />
          </div>
        </div>
      </header>

      {/* The graph is the overview. Stats are docked to its canvas as a quiet
          instrument rail instead of repeated as a row of cards below it. */}
      <section
        aria-label={`${name} trust graph`}
        className="relative h-[max(38rem,calc(100svh-10rem))] max-h-[58rem]"
      >
        <div className="absolute inset-0">
          <Suspense fallback={null}>
            <NetworkGraph title={name} initialZoom={1.1} />
          </Suspense>
        </div>

        <NetworkGraphStats
          isLoading={isLoading}
          totalParticipants={totalParticipants}
          totalValue={totalValue}
          averageValue={averageValue}
          medianValue={medianValue}
          gnosisSafe={gnosisSafe}
        />
      </section>

      <div className="space-y-6 border-t border-border pt-10 sm:pt-12">
        <div className="flex flex-row justify-between items-center gap-x-8 gap-y-4 flex-wrap">
          <div className="flex flex-col gap-1">
            <SectionHeading>Network members</SectionHeading>
            <ScoresAsOf snapshot={network.contracts.merkleSnapshot} />
          </div>

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

              {scoreboardExportMetadata && (
                <ExportButton
                  size="sm"
                  className="text-xs"
                  data={scoreboardExportData}
                  metadata={scoreboardExportMetadata}
                  filename={`trustgraph_${name}_${new Date().toISOString()}`}
                />
              )}

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
                  router.push(`/account/${row.account}`)
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

function NetworkGraphStats({
  isLoading,
  totalParticipants,
  totalValue,
  averageValue,
  medianValue,
  gnosisSafe,
}: {
  isLoading: boolean
  totalParticipants: number
  totalValue: number
  averageValue: number
  medianValue: number
  gnosisSafe?: {
    address: `0x${string}`
    owners: `0x${string}`[]
    threshold: number
  }
}) {
  const loadingValue = isLoading ? '—' : null

  return (
    <aside
      aria-label="Network statistics"
      className="pointer-events-none absolute inset-x-3 top-14 z-10 grid grid-cols-2 border border-hairline-strong bg-surface/95 shadow-[var(--shadow-elevated)] backdrop-blur-md sm:inset-x-auto sm:right-3 sm:w-52 sm:grid-cols-1"
    >
      <GraphStat
        label="Members"
        value={
          loadingValue ?? formatBigNumber(totalParticipants, undefined, true)
        }
      />
      <GraphStat
        label="Network score"
        value={loadingValue ?? formatBigNumber(totalValue, 18)}
      />
      <GraphStat
        label="Average / median"
        wide={!gnosisSafe}
        value={
          loadingValue ??
          `${formatBigNumber(Math.round(averageValue), 18)} / ${formatBigNumber(
            Math.round(medianValue),
            18
          )}`
        }
      />
      {gnosisSafe && (
        <GraphStat
          label="Safe"
          value={`${gnosisSafe.threshold}-of-${gnosisSafe.owners.length}`}
          href={`https://app.safe.global/home?safe=oeth:${gnosisSafe.address}`}
        />
      )}
    </aside>
  )
}

function GraphStat({
  label,
  value,
  href,
  wide = false,
}: {
  label: string
  value: string
  href?: string
  wide?: boolean
}) {
  const content = (
    <>
      <dt className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </dt>
      <dd className="mt-1 flex items-center gap-1.5 text-sm tabular-nums text-text">
        {value}
        {href && <ArrowUpRight aria-hidden="true" className="h-3 w-3" />}
      </dd>
    </>
  )

  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'pointer-events-auto border-b border-r border-hairline px-3 py-2.5 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink even:border-r-0 sm:border-r-0 sm:last:border-b-0',
        wide && 'col-span-2 sm:col-span-1'
      )}
    >
      <dl>{content}</dl>
    </a>
  ) : (
    <dl
      className={cn(
        'border-b border-r border-hairline px-3 py-2.5 even:border-r-0 sm:border-r-0 sm:last:border-b-0',
        wide && 'col-span-2 border-r-0 sm:col-span-1'
      )}
    >
      {content}
    </dl>
  )
}
