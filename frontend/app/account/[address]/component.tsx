'use client'

import { usePonderQuery } from '@ponder/react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowUpRight,
  Check,
  FileText,
  ListFilter,
  MessageSquare,
  MessageSquareOff,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type React from 'react'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { Hex } from 'viem'
import { useAccount } from 'wagmi'

import { Address, TableAddress } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button, ButtonLink } from '@/components/Button'
import { CreateAttestationModal } from '@/components/CreateAttestationModal'
import { Dropdown } from '@/components/Dropdown'
import { InfoTooltip } from '@/components/InfoTooltip'
import { SectionHeading } from '@/components/SectionHeading'
import { StatisticCard } from '@/components/StatisticCard'
import { Column, Table } from '@/components/Table'
import { Tooltip } from '@/components/Tooltip'
import { useNetworks } from '@/contexts/CatalogContext'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { useIntoAttestationsData } from '@/hooks/useAttestation'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { AttestationData } from '@/lib/attestation'
import { parseErrorMessage } from '@/lib/error'
import { isTrustedSeed } from '@/lib/network'
import { Network } from '@/lib/types'
import { cn, formatBigNumber, isHexEqual } from '@/lib/utils'
import { NetworkProfile, ponderQueries, ponderQueryFns } from '@/queries/ponder'

// Uses web2gl, which is not supported on the server
const NetworkGraph = dynamic(
  () => import('@/components/NetworkGraph').then((mod) => mod.NetworkGraph),
  {
    ssr: false,
  }
)

type NetworkRow = NetworkProfile & {
  network: Network
  seed: boolean
}

export const AccountProfilePage = ({
  address,
  ensName,
}: {
  address: Hex
  ensName: string | null
}) => {
  const router = useRouter()

  // The runtime trust-graph catalog (GOAL.md M3): this page attributes scores and attestations to
  // networks, and both lookups have to know about instances created since the last deploy.
  const networks = useNetworks()
  const schemaToNetwork = useMemo(() => {
    const map: SchemaToNetwork = {}
    for (const network of networks) {
      for (const schema of network.schemas) {
        map[schema.uid.toLowerCase()] = network
      }
    }
    return map
  }, [networks])

  const { address: connectedAddress } = useAccount()
  const pushBreadcrumb = usePushBreadcrumb({
    route: `/account/${ensName || address}`,
    title: ensName || undefined,
  })

  const {
    isLoading: isLoadingNetworkProfiles,
    error: errorNetworkProfiles,
    data: networkProfiles,
    refetch: refreshNetworkProfiles,
  } = useQuery(ponderQueries.accountNetworkProfiles(address))

  const {
    isLoading: isLoadingAttestations,
    error: errorAttestations,
    data: attestations,
    refetch: refreshAttestations,
  } = usePonderQuery({
    queryFn: ponderQueryFns.getAttestations({ account: address }),
    select: useIntoAttestationsData(),
  })

  // Refresh network profiles when attestations are refreshed.
  useEffect(() => {
    refreshNetworkProfiles()
  }, [attestations?.length, refreshNetworkProfiles])

  const isLoading = isLoadingNetworkProfiles || isLoadingAttestations
  const error = errorNetworkProfiles || errorAttestations

  useEffect(() => {
    attestations?.forEach((attestation) => {
      router.prefetch(`/attestations/${attestation.uid}`)
    })
  }, [router, attestations])

  const { networkRows, maxScore, averageScore, medianScore } = useMemo(() => {
    const networkRows =
      networkProfiles
        ?.flatMap((networkProfile): NetworkRow | [] => {
          // Find the network that this merkle snapshot contract belongs to.
          const network = networks.find((network) =>
            isHexEqual(
              networkProfile.merkleSnapshotContract,
              network.contracts.merkleSnapshot
            )
          )

          if (!network || networkProfile.score === '0') {
            return []
          }

          return {
            network,
            ...networkProfile,
            seed: isTrustedSeed(network, address),
          }
        })
        .sort((a, b) => Number(b.score) - Number(a.score)) || []

    const maxScore = networkRows.reduce(
      (max, network) => Math.max(max, Number(network.score)),
      0
    )
    const averageScore =
      networkRows.length > 0
        ? networkRows.reduce((sum, network) => sum + Number(network.score), 0) /
          networkRows.length
        : 0
    const medianScore =
      networkRows.length > 1
        ? Number(networkRows[Math.ceil(networkRows.length / 2)].score)
        : Number(networkRows[0]?.score || '0')

    return {
      networkRows,
      maxScore,
      averageScore,
      medianScore,
    }
  }, [networkProfiles, networks, address])

  const networksColumns: Column<NetworkRow>[] = [
    {
      key: 'name',
      header: 'NETWORK',
      tooltip: 'The name of the network.',
      sortable: false,
      accessor: (row) => row.network.name,
    },
    {
      key: 'seed',
      header: 'SEED',
      tooltip:
        'Indicates if this account is part of the initial seed group that bootstrapped this network. Seed member influence is designed to diminish as the network grows.',
      sortable: false,
      render: (row) => (row.seed ? '🌱' : ''),
    },
    {
      key: 'validated',
      header: 'VALIDATED',
      tooltip:
        'Indicates if this member has attained a significant trust score in the network.',
      sortable: false,
      render: (row) => (row.validated ? <Check className="w-4 h-4" /> : ''),
    },
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
      key: 'attestationsReceived',
      header: 'RECEIVED',
      tooltip:
        'The number of attestations this member has received from other participants in this network.',
      sortable: true,
      accessor: (row) => row.attestationsReceived.inNetwork.length,
      render: (row) =>
        formatBigNumber(
          row.attestationsReceived.inNetwork.length,
          undefined,
          true
        ),
    },
    {
      key: 'attestationsGiven',
      header: 'SENT',
      tooltip:
        'The number of attestations this member has given to other participants that are counted for the network, indicating their level of engagement in building network trust.',
      sortable: true,
      accessor: (row) => row.attestationsGiven.inNetwork.length,
      render: (row) =>
        formatBigNumber(
          row.attestationsGiven.inNetwork.length,
          undefined,
          true
        ),
    },
    {
      key: 'score',
      header: 'SCORE',
      tooltip:
        "This member's calculated Trust Score using a PageRank-style algorithm. Higher scores indicate stronger endorsement from trusted peers in the network.",
      sortable: true,
      accessor: (row) => row.score,
      // Score is a pool allocation in wei (scaled by precisionScale = 1e18); divide for display.
      render: (row) => formatBigNumber(row.score, 18),
    },
  ]

  const [filterMode, setFilterMode] = useState<'network' | 'all'>('network')
  const [selectedNetworkId, setSelectedNetworkId] = useState<string>('all')

  const inAnyNetwork = networkRows.length > 0

  // Get the selected network row (if any)
  const selectedNetworkRow =
    selectedNetworkId === 'all'
      ? null
      : networkRows.find((row) => row.network.id === selectedNetworkId)

  // If not a network participant, always show all attestations.
  const onlyNetworkAttestations = !inAnyNetwork
    ? false
    : filterMode === 'network'

  // If in-network and has attestations, show the network graph.
  const showNetworkGraph =
    inAnyNetwork &&
    selectedNetworkId !== 'all' &&
    networkRows.some(
      (row) =>
        row.attestationsReceived.inNetwork.length > 0 ||
        row.attestationsGiven.inNetwork.length > 0
    )

  // Filter network rows based on selected network
  const filteredNetworkRows = selectedNetworkRow
    ? [selectedNetworkRow]
    : networkRows

  const allAttestationsReceived =
    attestations?.filter((attestation) =>
      isHexEqual(attestation.recipient, address)
    ) || []

  const networkAttestationsReceived = filteredNetworkRows.flatMap(
    (row) =>
      attestations?.filter((attestation) =>
        row.attestationsReceived.inNetwork.includes(attestation.uid)
      ) || []
  )

  const attestationsReceived = onlyNetworkAttestations
    ? networkAttestationsReceived
    : allAttestationsReceived

  const outOfNetworkAttestationsReceived =
    allAttestationsReceived.length - networkAttestationsReceived.length

  const allAttestationsGiven =
    attestations?.filter((attestation) =>
      isHexEqual(attestation.attester, address)
    ) || []

  const networkAttestationsGiven = filteredNetworkRows.flatMap(
    (row) =>
      attestations?.filter((attestation) =>
        row.attestationsGiven.inNetwork.includes(attestation.uid)
      ) || []
  )

  const attestationsGiven = onlyNetworkAttestations
    ? networkAttestationsGiven
    : allAttestationsGiven

  const outOfNetworkAttestationsGiven =
    allAttestationsGiven.length - networkAttestationsGiven.length

  return (
    <div className="space-y-6">
      <BreadcrumbRenderer />

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-2 mb-2">
        <Address
          address={address}
          textClassName="text-xl text-primary font-bold"
          displayMode="full"
          showCopyIcon={true}
          noHighlight
          link={false}
        />

        <div className="flex flex-row gap-2">
          {!!selectedNetworkRow?.network.applicationUrl && (
            <Tooltip title={`Apply to join ${selectedNetworkRow.network.name}`}>
              <ButtonLink
                href={selectedNetworkRow.network.applicationUrl}
                target="_blank"
                rel="noopener noreferrer"
                size="icon"
                variant="brand"
              >
                <FileText className="!w-4.5 !h-4.5" />
              </ButtonLink>
            </Tooltip>
          )}

          <CreateAttestationModal
            defaultRecipient={
              connectedAddress?.toLowerCase() === address.toLowerCase()
                ? undefined
                : ensName || address
            }
          />
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-8">
          <div className="text-sm text-text">◉ LOADING PROFILE DATA ◉</div>
          <div className="text-xs mt-2 text-text-muted">
            Fetching account information...
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="border border-error bg-error-soft p-4 rounded-sm">
          <div className="error-text text-sm text-error">
            ⚠️ {parseErrorMessage(error)}
          </div>
          <Button
            onClick={() => {
              refreshNetworkProfiles()
              refreshAttestations()
            }}
            className="mt-3 !px-4 !py-2"
          >
            <span className="text-xs">RETRY</span>
          </Button>
        </div>
      )}

      {/* Account Info */}
      {!isLoading && !error && (
        <>
          {/* Network Status */}
          {networkRows.length > 0 ? (
            <Table
              className="py-6"
              cellClassName="text-sm"
              columns={networksColumns}
              data={networkRows}
              defaultSortColumn="rank"
              defaultSortDirection="asc"
              getRowKey={(row) => row.network.id}
              onRowClick={(row) => {
                pushBreadcrumb()
                router.push(`/network/${row.network.id}`)
              }}
            />
          ) : (
            <div className="my-6 border border-warn bg-warn-soft p-4 rounded-md">
              <div className="text-sm text-warn">
                ⚠️ This account is not currently a participant in any
                TrustNetworks.
              </div>
              <div className="text-xs mt-1 text-warn">
                Participate in attestations to appear in Network rankings.
              </div>
            </div>
          )}

          {/* Statistics */}
          <div
            className={cn(
              'grid grid-cols-1 justify-start items-stretch gap-6 border-y border-border py-12',
              showNetworkGraph && 'lg:grid-cols-2 lg:items-start'
            )}
          >
            <div className="space-y-6">
              <SectionHeading>Statistics</SectionHeading>
              <div className="flex flex-row gap-4 flex-wrap">
                <StatisticCard
                  title="NETWORKS"
                  tooltip="The number of networks this account is participating in."
                  value={formatBigNumber(networkRows.length, undefined, true)}
                />
                <StatisticCard
                  title="HIGHEST SCORE"
                  tooltip="The account's highest Trust Score based on reputation in all their networks."
                  value={formatBigNumber(Math.round(maxScore), 18)}
                />
                {networkRows.length > 1 && (
                  <StatisticCard
                    title="AVERAGE + MEDIAN TRUST SCORE"
                    tooltip="This account's typical Trust Scores in all their networks."
                    value={
                      averageScore === medianScore
                        ? formatBigNumber(Math.round(averageScore), 18)
                        : `${formatBigNumber(
                            Math.round(averageScore),
                            18
                          )} / ${formatBigNumber(Math.round(medianScore), 18)}`
                    }
                  />
                )}
                <StatisticCard
                  title="ATTESTATIONS RECEIVED"
                  tooltip={
                    onlyNetworkAttestations
                      ? 'Total number of attestations this account has received from other network members.'
                      : 'Total number of attestations this account has received from others.'
                  }
                  value={formatBigNumber(
                    attestationsReceived.length,
                    undefined,
                    true
                  )}
                />
                <StatisticCard
                  title="ATTESTATIONS MADE"
                  tooltip={
                    onlyNetworkAttestations
                      ? 'Total number of attestations this account has given to other members that are counted for the network.'
                      : 'Total number of attestations this account has given to others.'
                  }
                  value={formatBigNumber(
                    attestationsGiven.length,
                    undefined,
                    true
                  )}
                />
              </div>
            </div>

            {showNetworkGraph && (
              <div className="h-[66vh] lg:h-full">
                <Suspense fallback={null}>
                  {/* Show network graph for the selected network, or first network if none selected */}
                  <NetworkProvider
                    network={
                      selectedNetworkRow?.network || networkRows[0].network
                    }
                  >
                    <NetworkGraph onlyAddress={address} />
                  </NetworkProvider>
                </Suspense>
              </div>
            )}
          </div>

          {/* Attestations Received Section */}
          <div className="border-b border-border pt-6 pb-12 space-y-6">
            <div className="flex flex-row justify-between items-center gap-4 flex-wrap">
              <h2 className="font-bold">
                {!isLoading && attestationsReceived.length === 0
                  ? 'NO ATTESTATIONS RECEIVED'
                  : 'ATTESTATIONS RECEIVED'}
              </h2>

              <div className="flex flex-row gap-2 flex-wrap">
                {inAnyNetwork && networkRows.length > 1 && (
                  <Dropdown
                    options={[
                      { value: 'all', label: 'All Networks' },
                      ...networkRows.map((row) => ({
                        value: row.network.id,
                        label: row.network.name,
                      })),
                    ]}
                    selected={selectedNetworkId}
                    onSelect={(value) => setSelectedNetworkId(value)}
                  />
                )}

                <Dropdown
                  options={
                    inAnyNetwork
                      ? [
                          { value: 'network', label: 'Network Only' },
                          { value: 'all', label: 'All Attestations' },
                        ]
                      : [{ value: 'all', label: 'All Attestations' }]
                  }
                  selected={filterMode}
                  onSelect={(value) => setFilterMode(value)}
                  icon={<ListFilter className="!w-5 !h-5" />}
                />
              </div>
            </div>

            {isLoading && (
              <div className="text-center py-8">
                <div className="text-sm text-text">LOADING ATTESTATIONS</div>
              </div>
            )}

            {!isLoading && attestationsReceived.length > 0 && (
              <Table
                columns={attestationsReceivedColumns(
                  pushBreadcrumb,
                  schemaToNetwork
                )}
                data={attestationsReceived}
                cellClassName="text-sm"
                defaultSortColumn="time"
                defaultSortDirection="desc"
                onRowClick={(row) => {
                  pushBreadcrumb()
                  router.push(`/attestations/${row.uid}`)
                }}
                getRowKey={(row) => row.uid}
              />
            )}

            {!isLoading &&
              onlyNetworkAttestations &&
              outOfNetworkAttestationsReceived > 0 && (
                <div className="flex flex-row gap-1 items-center">
                  <InfoTooltip
                    title={
                      'Attestations from accounts outside of the Trust Network and duplicates from in-network accounts are currently hidden, as they do not impact this account\'s score. To view these attestations, change the filter from "Network Only" to "All Attestations".'
                    }
                  />
                  <p className="text-xs text-muted-foreground italic">
                    {formatBigNumber(
                      outOfNetworkAttestationsReceived,
                      undefined,
                      true
                    )}{' '}
                    out-of-network attestation
                    {outOfNetworkAttestationsReceived > 1
                      ? 's are'
                      : ' is'}{' '}
                    hidden from view.
                  </p>
                </div>
              )}
          </div>

          {/* Attestations Given Section */}
          <div className="border-b border-border pt-6 pb-12 space-y-6">
            <h2 className="font-bold">
              {!isLoading && attestationsGiven.length === 0
                ? 'NO ATTESTATIONS MADE'
                : 'ATTESTATIONS MADE'}
            </h2>

            {isLoading && (
              <div className="text-center py-8">
                <div className="text-sm text-text">LOADING ATTESTATIONS</div>
              </div>
            )}

            {!isLoading && attestationsGiven.length > 0 && (
              <Table
                columns={attestationsGivenColumns(
                  pushBreadcrumb,
                  schemaToNetwork
                )}
                defaultSortColumn="time"
                cellClassName="text-sm"
                defaultSortDirection="desc"
                data={attestationsGiven}
                onRowClick={(row) => {
                  pushBreadcrumb()
                  router.push(`/attestations/${row.uid}`)
                }}
                getRowKey={(row) => row.uid}
              />
            )}

            {!isLoading &&
              onlyNetworkAttestations &&
              outOfNetworkAttestationsGiven > 0 && (
                <div className="flex flex-row gap-1 items-center">
                  <InfoTooltip
                    title={
                      'Attestations to accounts outside of the Trust Network and duplicates to in-network accounts are currently hidden, as they are not counted in the network. To view these attestations, change the filter from "Network Only" to "All Attestations".'
                    }
                  />
                  <p className="text-xs text-muted-foreground italic">
                    {formatBigNumber(
                      outOfNetworkAttestationsGiven,
                      undefined,
                      true
                    )}{' '}
                    out-of-network attestation
                    {outOfNetworkAttestationsGiven > 1 ? 's are' : ' is'} hidden
                    from view.
                  </p>
                </div>
              )}
          </div>
        </>
      )}
    </div>
  )
}

/** `{ lowercased schema uid -> network }`, built from the runtime catalog by the page. */
type SchemaToNetwork = Record<string, Network>

const commonAttestationColumns = (
  pushBreadcrumb: ReturnType<typeof usePushBreadcrumb>,
  schemaToNetwork: SchemaToNetwork
): Column<AttestationData>[] => [
  {
    key: 'network',
    header: 'NETWORK',
    tooltip: 'The network this attestation was made on.',
    sortable: false,
    render: (row) => {
      const networkName = schemaToNetwork[row.schema.toLowerCase()]
      if (!networkName) {
        return <span className="text-text-subtle text-sm">—</span>
      }
      return (
        <Link
          className="group/network inline-flex items-center gap-2 transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            pushBreadcrumb()
          }}
          href={`/network/${networkName.id}`}
        >
          <span className="text-sm text-text-muted transition-colors group-hover/network:text-text">
            {networkName.name}
          </span>
          <ArrowUpRight className="h-3 w-3 shrink-0 text-text-muted transition-colors group-hover/network:text-text" />
        </Link>
      )
    },
  },
  {
    key: 'confidence',
    header: 'CONFIDENCE',
    tooltip: 'The strength of the attestation as specified by the attester.',
    sortable: true,
    accessor: (row) => Number(row.decodedData?.confidence || '0'),
    render: (row) => (
      <div className="text-sm text-text">
        {formatBigNumber(row.decodedData?.confidence || '0', undefined, true)}
      </div>
    ),
  },
  {
    key: 'comment',
    header: 'COMMENT',
    tooltip:
      'An optional comment from the attester. Hover or tap on the icon to view.',
    render: (row) =>
      row.decodedData?.comment ? (
        <Tooltip title={row.decodedData.comment}>
          <MessageSquare className="!w-4.5 !h-4.5" />
        </Tooltip>
      ) : (
        <Tooltip title="No comment provided">
          <MessageSquareOff className="!w-4.5 !h-4.5 opacity-40" />
        </Tooltip>
      ),
  },
  {
    key: 'time',
    header: 'TIME',
    tooltip: 'The time the attestation was made.',
    sortable: true,
    accessor: (row) => Number(row.time),
    render: (row) => (
      <div className="text-sm text-text">
        <div>{row.formattedTime}</div>
        <div className="text-xs text-text-muted">{row.formattedTimeAgo}</div>
      </div>
    ),
  },
]

const attestationsReceivedColumns = (
  pushBreadcrumb: ReturnType<typeof usePushBreadcrumb>,
  schemaToNetwork: SchemaToNetwork
): Column<AttestationData>[] => [
  {
    key: 'attester',
    header: 'ATTESTER',
    tooltip: 'The account that made the attestation.',
    sortable: false,
    render: (row) => <TableAddress address={row.attester} showNavIcon />,
  },
  ...commonAttestationColumns(pushBreadcrumb, schemaToNetwork),
]

const attestationsGivenColumns = (
  pushBreadcrumb: ReturnType<typeof usePushBreadcrumb>,
  schemaToNetwork: SchemaToNetwork
): Column<AttestationData>[] => [
  {
    key: 'recipient',
    header: 'RECIPIENT',
    tooltip: 'The account that received the attestation.',
    sortable: false,
    render: (row) => <TableAddress showNavIcon address={row.recipient} />,
  },
  ...commonAttestationColumns(pushBreadcrumb, schemaToNetwork),
]
