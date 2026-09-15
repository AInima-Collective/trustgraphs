'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, ListFilter } from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { Hex } from 'viem'
import { useAccount } from 'wagmi'

import { Address, TableAddress } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { CreateAttestationModal } from '@/components/CreateAttestationModal'
import { Dropdown } from '@/components/Dropdown'
import { GraphStat, GraphStatRail } from '@/components/GraphStatRail'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import { Tooltip } from '@/components/Tooltip'
import { useNetworks } from '@/contexts/CatalogContext'
import { NetworkProvider, useNetwork } from '@/contexts/NetworkContext'
import { useIntoAttestationsData } from '@/hooks/useAttestation'
import { useEns } from '@/hooks/useEns'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { AttestationData } from '@/lib/attestation'
import {
  type Erc8004AgentSummary,
  erc8004AgentHref,
  erc8004AgentLabel,
} from '@/lib/erc8004'
import { parseErrorMessage } from '@/lib/error'
import { isTrustedSeed, isValidatedInNetwork } from '@/lib/network'
import { Network } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { cn, formatBigNumber, formatPercentage, isHexEqual } from '@/lib/utils'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

// Uses web2gl, which is not supported on the server
const NetworkGraph = dynamic(
  () => import('@/components/NetworkGraph').then((mod) => mod.NetworkGraph),
  {
    ssr: false,
  }
)

/** Same height as the graph, so the page does not jump when it arrives. */
const GRAPH_HEIGHT = 'h-96 sm:h-[32rem]'

/** A network this account appears in, with its rank there once the indexer has scored it. */
type Membership = {
  network: Network
  rank?: number
}

/** `{ lowercased schema uid -> network }`, built from the runtime catalog by the page. */
type SchemaToNetwork = Record<string, Network>

type PushBreadcrumb = ReturnType<typeof usePushBreadcrumb>

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`

export const AccountProfilePage = ({
  address,
  ensName: serverEnsName,
}: {
  address: Hex
  ensName: string | null
}) => {
  const router = useRouter()

  // The runtime trust-graph catalog: this page attributes scores and attestations to
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
  const isYou = !!connectedAddress && isHexEqual(connectedAddress, address)
  // The server resolves the name for the first paint; fill it in here if that lookup failed.
  const { name: clientEnsName } = useEns(address, {
    enableName: !serverEnsName,
  })
  const ensName = serverEnsName || clientEnsName || null
  const displayName = ensName || shortAddress(address)

  const pushBreadcrumb = usePushBreadcrumb({
    route: `/account/${address}`,
    title: ensName || undefined,
  })

  const {
    isLoading: isLoadingNetworkProfiles,
    data: networkProfiles,
    refetch: refreshNetworkProfiles,
  } = useQuery(ponderQueries.accountNetworkProfiles(address))

  const { data: agentRelations } = useQuery(
    ponderQueries.accountAgents(address)
  )

  const {
    isLoading: isLoadingAttestations,
    error: attestationsError,
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

  useEffect(() => {
    attestations?.forEach((attestation) => {
      router.prefetch(`/attestations/${attestation.uid}`)
    })
  }, [router, attestations])

  const relatedAgents = useMemo(() => {
    const byKey = new Map<string, Erc8004AgentSummary>()
    for (const agent of agentRelations?.owns ?? []) byKey.set(agent.key, agent)
    for (const agent of agentRelations?.verifiedWalletFor ?? []) {
      const existing = byKey.get(agent.key)
      byKey.set(
        agent.key,
        existing
          ? {
              ...existing,
              roles: [...new Set([...existing.roles, ...agent.roles])],
            }
          : agent
      )
    }
    return [...byKey.values()]
  }, [agentRelations])

  /**
   * Every network the account appears in: the ones the indexer has scored it in, highest score
   * first, then any other network it has given or received an attestation in.
   *
   * The indexer's list alone is not enough. Until it learned about factory-created networks it
   * returned nothing on mainnet, where every network is one, and this page told members of the
   * showcase network they were in no network at all. An account's own attestations name their
   * networks directly, so a network it takes part in shows up here either way.
   */
  const memberships = useMemo(() => {
    const byId = new Map<string, Membership>()
    const scored = [...(networkProfiles ?? [])]
      .filter((profile) => profile.score !== '0')
      .sort((a, b) => Number(b.score) - Number(a.score))
    for (const profile of scored) {
      const network = networks.find((network) =>
        isHexEqual(
          profile.merkleSnapshotContract,
          network.contracts.merkleSnapshot
        )
      )
      if (network && !byId.has(network.id)) {
        byId.set(network.id, { network, rank: profile.rank })
      }
    }
    for (const attestation of attestations ?? []) {
      const network = schemaToNetwork[attestation.schema.toLowerCase()]
      if (network && !byId.has(network.id)) {
        byId.set(network.id, { network })
      }
    }
    return [...byId.values()]
  }, [networkProfiles, networks, attestations, schemaToNetwork])

  const [selectedId, setSelectedId] = useState<string>()
  const selected =
    memberships.find((membership) => membership.network.id === selectedId) ??
    memberships[0]

  const isLoading = isLoadingNetworkProfiles || isLoadingAttestations

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="flex flex-col items-start gap-4">
        <BreadcrumbRenderer className="mb-2" />
        <div className="flex w-full flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
            <p className="tg-label">{isYou ? 'Your account' : 'Account'}</p>
            <h1 className="max-w-full break-words text-4xl font-bold">
              {displayName}
            </h1>
            <Address
              address={address}
              displayText={address}
              displayMode="full"
              link={false}
              showEns={false}
              noHighlight
              textClassName="text-xs text-text-subtle"
            />
            {relatedAgents.length > 0 && (
              <ul
                aria-label="ERC-8004 agent identities"
                className="flex list-none flex-wrap gap-2 pl-0"
              >
                {relatedAgents.map((agent) => (
                  <li key={agent.key}>
                    <Link
                      href={erc8004AgentHref(agent)}
                      title={`Chain ${agent.chainId} · ERC-8004 #${agent.agentId}`}
                      className="inline-flex items-center gap-1.5 border border-success/40 px-2 py-1 text-[10px] uppercase tracking-wider text-success transition-colors hover:border-success"
                    >
                      ◈ {erc8004AgentLabel(agent)} ·{' '}
                      {agent.roles
                        .map((role) =>
                          role === 'verified_wallet'
                            ? 'Verified wallet'
                            : 'Owner'
                        )
                        .join(' · ')}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex shrink-0 flex-row flex-wrap items-center gap-3 lg:pt-1">
            <CreateAttestationModal
              title={isYou ? 'Vouch for someone' : `Vouch for ${displayName}`}
              className="h-11 px-5"
              defaultRecipient={isYou ? undefined : ensName || address}
            />
          </div>
        </div>
      </header>

      {attestationsError ? (
        <div className="border border-error bg-error-soft p-4 rounded-sm">
          <div className="error-text text-sm text-error">
            ⚠️ {parseErrorMessage(attestationsError)}
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
      ) : isLoading ? (
        <div
          className={cn(
            'flex flex-col items-center justify-center border border-border text-center',
            GRAPH_HEIGHT
          )}
        >
          <div className="text-sm text-text">◉ LOADING PROFILE DATA ◉</div>
          <div className="text-xs mt-2 text-text-muted">
            Fetching account information...
          </div>
        </div>
      ) : selected ? (
        <NetworkProvider key={selected.network.id} network={selected.network}>
          <AccountInNetwork
            address={address}
            displayName={displayName}
            memberships={memberships}
            onSelect={setSelectedId}
            attestations={attestations ?? []}
            schemaToNetwork={schemaToNetwork}
            pushBreadcrumb={pushBreadcrumb}
          />
        </NetworkProvider>
      ) : (
        <AttestationsSection
          address={address}
          attestations={attestations ?? []}
          schemaToNetwork={schemaToNetwork}
          pushBreadcrumb={pushBreadcrumb}
        />
      )}
    </div>
  )
}

/** The account as seen from the selected network: its graph, its standing, its attestations. */
function AccountInNetwork({
  address,
  displayName,
  memberships,
  onSelect,
  attestations,
  schemaToNetwork,
  pushBreadcrumb,
}: {
  address: Hex
  displayName: string
  memberships: Membership[]
  onSelect: (networkId: string) => void
  attestations: AttestationData[]
  schemaToNetwork: SchemaToNetwork
  pushBreadcrumb: PushBreadcrumb
}) {
  // Standing comes from the same read as the network's own member table, so the two agree.
  const {
    network,
    isLoading,
    accountData,
    attestationsData,
    totalParticipants,
    totalValue,
  } = useNetwork()
  const entry = accountData.find((row) => isHexEqual(row.account, address))
  const weighted = network.program === 'trust-graph-weighted'
  const seed = isTrustedSeed(network, address)
  // A threshold of 0 (every factory network) validates every member, which says nothing.
  const validated =
    !!entry &&
    network.validatedThreshold > 0 &&
    isValidatedInNetwork(network, entry.value)

  // What this network counts: the current attestation between each pair of its members.
  const countedUids = useMemo(
    () =>
      attestationsData
        ? new Set(attestationsData.map(({ uid }) => uid.toLowerCase()))
        : null,
    [attestationsData]
  )

  const pending = isLoading ? '—' : null
  const badges = isLoading
    ? []
    : [
        seed && (weighted ? 'Weighted prior' : 'Seed member'),
        validated && 'Validated',
      ].filter((badge): badge is string => !!badge)
  const headingActions = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {badges.map((badge) => (
        <span
          key={badge}
          className="border border-success/40 px-2 py-1 text-[10px] uppercase tracking-wider text-success"
        >
          {badge}
        </span>
      ))}
      <Link
        href={`/networks/${network.id}`}
        onClick={() => pushBreadcrumb()}
        className="tg-touch-target inline-flex items-center gap-1 text-sm text-text-muted underline underline-offset-4 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        View network
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )

  return (
    <>
      <section
        aria-label={`${displayName} in ${network.name}`}
        className="space-y-4"
      >
        {memberships.length > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-2">
            <nav
              aria-label="Networks"
              className="flex flex-row items-center gap-1 overflow-x-auto"
            >
              {memberships.map((membership) => {
                const active = membership.network.id === network.id
                return (
                  <button
                    key={membership.network.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelect(membership.network.id)}
                    className={cn(
                      'inline-flex min-h-11 shrink-0 items-center gap-2 px-3 py-2 text-sm transition-colors sm:min-h-0 sm:py-1.5',
                      active
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    )}
                  >
                    {membership.network.name}
                    {membership.rank !== undefined && membership.rank > 0 && (
                      <span className="text-xs tabular-nums opacity-70">
                        #{membership.rank}
                      </span>
                    )}
                  </button>
                )
              })}
            </nav>
            {headingActions}
          </div>
        ) : (
          // Not `SectionHeading`: that truncates the name to fit its actions, and on a phone the
          // badge and link left "ETHEREUM EXTITUT…". This wraps them under it instead.
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-2">
            <h2 className="tg-label-strong">{network.name}</h2>
            {headingActions}
          </div>
        )}

        <div className={cn('relative', GRAPH_HEIGHT)}>
          <div className="absolute inset-0">
            <Suspense fallback={null}>
              <NetworkGraph
                title={`${displayName}'s connections`}
                onlyAddress={address}
              />
            </Suspense>
          </div>

          <GraphStatRail label={`${displayName}'s standing in ${network.name}`}>
            <GraphStat
              label="Rank"
              value={
                pending ??
                (entry
                  ? `#${entry.rank} of ${formatBigNumber(totalParticipants, undefined, true)}`
                  : 'Not ranked')
              }
            />
            <GraphStat
              label="Trust score"
              value={pending ?? formatBigNumber(entry?.value ?? '0', 18)}
            />
            <GraphStat
              label="Share of network"
              value={
                pending ??
                (entry && totalValue > 0
                  ? formatPercentage((Number(entry.value) / totalValue) * 100)
                  : '—')
              }
            />
            <GraphStat
              label="Received / given"
              value={pending ?? `${entry?.received ?? 0} / ${entry?.sent ?? 0}`}
            />
          </GraphStatRail>
        </div>
      </section>

      <AttestationsSection
        address={address}
        attestations={attestations}
        network={network}
        countedUids={countedUids}
        schemaToNetwork={schemaToNetwork}
        pushBreadcrumb={pushBreadcrumb}
      />
    </>
  )
}

function AttestationsSection({
  address,
  attestations,
  network,
  countedUids,
  schemaToNetwork,
  pushBreadcrumb,
}: {
  address: Hex
  attestations: AttestationData[]
  /** The network the page is showing, if the account is in one. */
  network?: Network
  /** The attestation UIDs that network counts, or null while they load. */
  countedUids?: Set<string> | null
  schemaToNetwork: SchemaToNetwork
  pushBreadcrumb: PushBreadcrumb
}) {
  const [filter, setFilter] = useState<'counted' | 'all'>('counted')
  const counting = !!network && filter === 'counted'
  const loading = counting && !countedUids

  const visible =
    counting && countedUids
      ? attestations.filter(({ uid }) => countedUids.has(uid.toLowerCase()))
      : attestations
  const received = visible.filter((attestation) =>
    isHexEqual(attestation.recipient, address)
  )
  const given = visible.filter((attestation) =>
    isHexEqual(attestation.attester, address)
  )
  const hidden = loading ? 0 : attestations.length - visible.length

  return (
    <section aria-label="Attestations" className="space-y-8">
      <div className="flex flex-row flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex flex-col gap-1">
          <SectionHeading>Attestations</SectionHeading>
          <p className="text-xs text-text-muted">
            {counting && network
              ? `The ones ${network.name} counts`
              : 'Every attestation to or from this account'}
          </p>
        </div>

        {network && (
          <Dropdown
            label="Filter attestations"
            options={[
              { value: 'counted', label: 'COUNTED IN NETWORK' },
              { value: 'all', label: 'ALL ATTESTATIONS' },
            ]}
            selected={filter}
            onSelect={(value) => setFilter(value)}
            icon={<ListFilter className="!w-4 !h-4" />}
            triggerSize="sm"
            triggerClassName="text-xs"
            optionClassName="text-xs"
          />
        )}
      </div>

      <AttestationList
        heading="Received"
        rows={received}
        counterparty="attester"
        loading={loading}
        showNetwork={!counting}
        schemaToNetwork={schemaToNetwork}
        pushBreadcrumb={pushBreadcrumb}
      />
      <AttestationList
        heading="Given"
        rows={given}
        counterparty="recipient"
        loading={loading}
        showNetwork={!counting}
        schemaToNetwork={schemaToNetwork}
        pushBreadcrumb={pushBreadcrumb}
      />

      {counting && network && hidden > 0 && (
        <p className="text-xs text-text-muted">
          {formatBigNumber(hidden, undefined, true)} more{' '}
          {hidden === 1 ? 'attestation is' : 'attestations are'} not counted in{' '}
          {network.name}: from another network, replaced by a newer one between
          the same two accounts, or with an account outside it.{' '}
          <button
            type="button"
            onClick={() => setFilter('all')}
            className="tg-touch-target underline underline-offset-4 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Show all
          </button>
        </p>
      )}
    </section>
  )
}

function AttestationList({
  heading,
  rows,
  counterparty,
  loading,
  showNetwork,
  schemaToNetwork,
  pushBreadcrumb,
}: {
  heading: string
  rows: AttestationData[]
  /** The other side of each attestation, the one to list. */
  counterparty: 'attester' | 'recipient'
  loading: boolean
  /** Name each row's network; off when every row is in the one being shown. */
  showNetwork: boolean
  schemaToNetwork: SchemaToNetwork
  pushBreadcrumb: PushBreadcrumb
}) {
  const router = useRouter()
  const columns = attestationColumns({
    counterparty,
    showNetwork,
    schemaToNetwork,
    pushBreadcrumb,
  })

  return (
    <div className="space-y-3">
      <h3 className="tg-label">
        {heading} ·{' '}
        {loading ? '…' : formatBigNumber(rows.length, undefined, true)}
      </h3>

      {loading ? (
        <div className="py-6 text-center text-sm text-text">
          LOADING ATTESTATIONS
        </div>
      ) : rows.length === 0 ? (
        <div className="border border-border bg-surface py-6 text-center text-xs uppercase tracking-wider text-text-muted">
          None yet
        </div>
      ) : (
        <>
          <ul className="list-none divide-y divide-border border-y border-border pl-0 md:hidden">
            {[...rows]
              .sort((a, b) => Number(b.time - a.time))
              .map((row) => {
                const comment = commentOf(row)
                const network = schemaToNetwork[row.schema.toLowerCase()]
                return (
                  <li
                    key={row.uid}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <Address
                        address={row[counterparty]}
                        showCopyIcon={false}
                        showNavIcon
                      />
                      <p className="text-xs text-text-muted">
                        {showNetwork && network && `${network.name} · `}
                        {row.formattedTimeAgo}
                      </p>
                      {comment && (
                        <p className="line-clamp-2 text-xs text-text">
                          {comment}
                        </p>
                      )}
                    </div>
                    <Link
                      href={`/attestations/${row.uid}`}
                      onClick={() => pushBreadcrumb()}
                      aria-label={`View attestation from ${row.formattedTime}`}
                      className="tg-touch-target inline-flex flex-col items-end text-right focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      <span className="text-sm tabular-nums text-text">
                        {formatBigNumber(confidenceOf(row), undefined, true)}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-text-subtle">
                        Confidence
                      </span>
                    </Link>
                  </li>
                )
              })}
          </ul>
          <Table
            className="hidden md:block"
            columns={columns}
            data={rows}
            rowClassName="text-sm"
            defaultSortColumn="time"
            defaultSortDirection="desc"
            onRowClick={(row) => {
              pushBreadcrumb()
              router.push(`/attestations/${row.uid}`)
            }}
            getRowKey={(row) => row.uid}
          />
        </>
      )}
    </div>
  )
}

const commentOf = (row: AttestationData) =>
  typeof row.decodedData?.comment === 'string'
    ? row.decodedData.comment.trim()
    : ''

const confidenceOf = (row: AttestationData) =>
  Number(row.decodedData?.confidence || '0')

const attestationColumns = ({
  counterparty,
  showNetwork,
  schemaToNetwork,
  pushBreadcrumb,
}: {
  counterparty: 'attester' | 'recipient'
  showNetwork: boolean
  schemaToNetwork: SchemaToNetwork
  pushBreadcrumb: PushBreadcrumb
}): Column<AttestationData>[] => [
  counterparty === 'attester'
    ? {
        key: 'attester',
        header: 'ATTESTER',
        tooltip: 'The account that made the attestation.',
        sortable: false,
        render: (row) => <TableAddress address={row.attester} showNavIcon />,
      }
    : {
        key: 'recipient',
        header: 'RECIPIENT',
        tooltip: 'The account that received the attestation.',
        sortable: false,
        render: (row) => <TableAddress address={row.recipient} showNavIcon />,
      },
  ...(showNetwork
    ? [
        {
          key: 'network',
          header: 'NETWORK',
          tooltip: 'The network this attestation was made in.',
          sortable: false,
          render: (row: AttestationData) => {
            const network = schemaToNetwork[row.schema.toLowerCase()]
            if (!network) {
              return <span className="text-text-subtle text-sm">—</span>
            }
            return (
              <Link
                className="group/network inline-flex items-center gap-2 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  pushBreadcrumb()
                }}
                href={`/networks/${network.id}`}
              >
                <span className="text-sm text-text-muted transition-colors group-hover/network:text-text">
                  {network.name}
                </span>
                <ArrowUpRight className="h-3 w-3 shrink-0 text-text-muted transition-colors group-hover/network:text-text" />
              </Link>
            )
          },
        },
      ]
    : []),
  {
    key: 'confidence',
    header: 'CONFIDENCE',
    tooltip: 'The strength of the attestation as specified by the attester.',
    sortable: true,
    accessor: confidenceOf,
    render: (row) => formatBigNumber(confidenceOf(row), undefined, true),
  },
  {
    key: 'comment',
    header: 'COMMENT',
    tooltip: 'An optional comment from the attester.',
    sortable: false,
    render: (row) => {
      const comment = commentOf(row)
      return comment ? (
        <Tooltip title={comment}>
          <span className="block max-w-[32ch] truncate text-left text-text-muted">
            {comment}
          </span>
        </Tooltip>
      ) : (
        <span className="text-text-subtle">—</span>
      )
    },
  },
  {
    key: 'time',
    header: 'TIME',
    tooltip: 'The time the attestation was made.',
    sortable: true,
    accessor: (row) => Number(row.time),
    render: (row) => (
      <Link
        href={`/attestations/${row.uid}`}
        onClick={() => pushBreadcrumb()}
        className="tg-touch-target inline-flex flex-col justify-center text-sm text-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        aria-label={`View attestation from ${row.formattedTime}`}
      >
        <span>{row.formattedTime}</span>
        <span className="text-xs text-text-muted">{row.formattedTimeAgo}</span>
      </Link>
    ),
  },
]
