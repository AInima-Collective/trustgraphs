'use client'

import { useQuery } from '@tanstack/react-query'

import { ButtonLink } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { SectionHeading } from '@/components/SectionHeading'
import { StatisticCard } from '@/components/StatisticCard'
import { Column, Table } from '@/components/Table'
import { useDidHandle } from '@/hooks/useDidHandle'
import { HypercertsNetwork } from '@/lib/types'
import { formatBigNumber } from '@/lib/utils'
import { HypercertsScore, ponderQueries } from '@/queries/ponder'

type ScoreRow = HypercertsScore & { rank: number }

/** Truncate a 32-byte nodeId for display (artifact / unlabeled nodes). */
const shortNodeId = (nodeId: string) =>
  `${nodeId.slice(0, 10)}…${nodeId.slice(-6)}`

/** DID → handle (PLC directory), falling back to the DID, falling back to the nodeId. */
const NodeLabel = ({ row }: { row: ScoreRow }) => {
  const { data: handle } = useDidHandle(row.did)

  if (!row.did) {
    return (
      <span className="font-mono text-text-muted" title={row.nodeId}>
        {shortNodeId(row.nodeId)}
      </span>
    )
  }
  return (
    <span title={row.did}>
      {handle ?? row.did}
      {handle && (
        <span className="text-text-muted text-xs ml-2">{row.did}</span>
      )}
    </span>
  )
}

/**
 * The read-only detail page for a hypercerts (nodeId-keyed, lane-2) instance: proven scores over
 * anchored atproto repos, rendered from the indexer's `/hypercerts/:snapshot/scores` API. There is
 * deliberately no attest flow — records live on the AT Protocol network; this page shows the
 * on-chain-proven result.
 */
export const HypercertsNetworkPage = ({
  network,
}: {
  network: HypercertsNetwork
}) => {
  const { name, link, about, callToAction, applicationUrl, criteria } = network

  const {
    data: scoreList,
    isLoading,
    error,
  } = useQuery(ponderQueries.hypercertsScores(network.contracts.merkleSnapshot))

  const rows: ScoreRow[] =
    scoreList?.scores.map((score, index) => ({ ...score, rank: index + 1 })) ??
    []

  const columns: Column<ScoreRow>[] = [
    {
      key: 'rank',
      header: 'RANK',
      tooltip: 'Position by proven impact score at the latest on-chain root.',
      sortable: true,
      accessor: (row) => row.rank,
      render: (row) => `#${row.rank}`,
    },
    {
      key: 'node',
      header: 'NODE',
      tooltip:
        'The scored node: an AT Protocol account (handle/DID) or an artifact (a specific record, shown by its nodeId).',
      sortable: false,
      render: (row) => <NodeLabel row={row} />,
    },
    {
      key: 'binding',
      header: 'EVM BINDING',
      tooltip:
        'The EVM address this account linked via a verified app.certified.link.evm record, if any. Bound nodes can consume their score on-chain.',
      sortable: false,
      render: (row) =>
        row.boundAddress ? (
          <span className="font-mono" title={row.boundAddress}>
            {row.boundAddress.slice(0, 8)}…{row.boundAddress.slice(-4)}
          </span>
        ) : (
          ''
        ),
    },
    {
      key: 'score',
      header: 'SCORE',
      tooltip:
        'The trust-weighted impact score proven by the zero-knowledge proof behind the latest on-chain root.',
      sortable: true,
      accessor: (row) => Number(BigInt(row.value || '0')),
      render: (row) => formatBigNumber(row.value, 18),
    },
  ]

  return (
    <div className="space-y-12">
      {/* Header */}
      <div className="space-y-6">
        <div className="flex flex-row justify-between items-start gap-x-8 gap-y-4 flex-wrap">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">{name.toUpperCase()}</h1>
            {link && (
              <p className="text-sm text-text">
                {link.prefix}{' '}
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {link.label}
                </a>
              </p>
            )}
          </div>
          {callToAction && (
            <ButtonLink href={callToAction.href} target="_blank">
              {callToAction.label}
            </ButtonLink>
          )}
          {applicationUrl && (
            <ButtonLink href={applicationUrl} target="_blank">
              Apply to join
            </ButtonLink>
          )}
        </div>
        <Markdown>{about}</Markdown>
        {criteria && <Markdown>{criteria}</Markdown>}
      </div>

      {/* Statistics */}
      <div className="border-y border-border py-12 space-y-6">
        <SectionHeading>Instance statistics</SectionHeading>
        <div className="flex flex-row gap-4 flex-wrap">
          <StatisticCard
            title="NODES SCORED"
            tooltip="The number of nodes (accounts + artifacts) with a nonzero proven score at the latest root."
            value={isLoading ? '...' : String(scoreList?.numNodes ?? 0)}
          />
          <StatisticCard
            title="TOTAL SCORE"
            tooltip="The full distributed pool across all scored nodes at the latest root."
            value={
              isLoading
                ? '...'
                : formatBigNumber(scoreList?.totalValue ?? 0, 18)
            }
          />
          <StatisticCard
            title="ANCHORED REPOS"
            tooltip="The number of repo-head anchors frozen into the checkpoint this root was proven against."
            value={isLoading ? '...' : String(scoreList?.anchorCount ?? 0)}
          />
          <StatisticCard
            title="LATEST ROOT"
            tooltip="The on-chain outputRoot committed by the latest verified zero-knowledge proof."
            value={
              isLoading || !scoreList
                ? '...'
                : `${scoreList.root.slice(0, 10)}…`
            }
          />
        </div>
      </div>

      {/* Scores */}
      <div className="space-y-6">
        <SectionHeading>Proven scores</SectionHeading>
        {error ? (
          <p className="text-sm text-error">
            Failed to load scores: {String(error)}
          </p>
        ) : !isLoading && rows.length === 0 ? (
          <p className="text-sm text-text">
            No proven root indexed yet for this instance. Scores appear after
            the first successful <code>submitProof</code> is ingested.
          </p>
        ) : (
          <Table
            data={rows}
            columns={columns}
            getRowKey={(row) => row.nodeId}
          />
        )}
      </div>
    </div>
  )
}
