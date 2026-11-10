'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'

import { TableAddress } from '@/components/Address'
import { Button } from '@/components/Button'
import { ResultBar, StateBadge } from '@/components/ProposalStatus'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { useTrustPoolOverview } from '@/hooks/useTrustPool'
import { formatBlockEta } from '@/lib/blocks'
import {
  governorStateLabel,
  governorStatePriority,
  governorStateTone,
  proposalTitle,
} from '@/lib/trust-pool'
import { formatBigNumber, formatPercentage } from '@/lib/utils'

type Row = ReturnType<typeof useTrustPoolOverview>['rows'][number]

export default function DelegationPage() {
  const router = useRouter()
  const pushBreadcrumb = usePushBreadcrumb()
  const { isConnected } = useAccount()
  const { targetChain } = useApplicationChain()
  const {
    network,
    governor,
    governorName,
    symbol,
    decimals,
    blockNumber,
    rows,
    isLoadingProposals,
    indexError,
    poolPower,
    balance,
    delegatesHere,
    shareFraction,
    isDelegating,
    delegate,
    error,
  } = useTrustPoolOverview()

  const proposalHref = (row: Row) =>
    `/networks/${network.id}/delegation/${row.proposal.proposalId}`
  const explorer = targetChain.blockExplorers?.default.url
  const amount = (value: bigint | undefined) =>
    value === undefined ? '...' : formatBigNumber(value, decimals)

  const columns: Column<Row>[] = [
    {
      key: 'title',
      header: 'TITLE',
      tooltip: 'What the proposal is about.',
      sortable: false,
      render: (row) => (
        <Link
          href={proposalHref(row)}
          onClick={() => pushBreadcrumb({ title: 'proposals' })}
          className="tg-touch-target inline-flex max-w-[300px] items-center font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <span className="truncate">
            {proposalTitle(row.proposal.description, row.proposal.proposalId)}
          </span>
        </Link>
      ),
    },
    {
      key: 'state',
      header: 'STATUS',
      tooltip:
        'Where the proposal is on the governor: voting, passed, executed.',
      sortable: true,
      accessor: (row) =>
        governorStatePriority(row.state) * 1e12 -
        Number(row.proposal.created.block),
      render: (row) => (
        <StateBadge
          tone={governorStateTone(row.state)}
          label={governorStateLabel(row.state)}
        />
      ),
    },
    {
      key: 'network',
      header: 'THIS NETWORK',
      tooltip:
        "How the network's members have cast its delegated votes, as a share of all of them.",
      sortable: false,
      render: (row) =>
        row.poolVotes === undefined ? (
          <span className="text-xs text-muted-foreground">Not open yet</span>
        ) : (
          <ResultBar
            forVotes={BigInt(row.proposal.pool.for)}
            against={BigInt(row.proposal.pool.against)}
            abstain={BigInt(row.proposal.pool.abstain)}
            total={row.poolVotes}
          />
        ),
    },
    {
      key: 'result',
      header: 'OVERALL',
      tooltip: 'Every vote on the governor so far: for, against, abstain.',
      sortable: false,
      render: (row) =>
        row.votes ? (
          <ResultBar
            forVotes={row.votes[1]}
            against={row.votes[0]}
            abstain={row.votes[2]}
          />
        ) : null,
    },
    {
      key: 'timing',
      header: 'TIMING',
      tooltip: 'When voting opens or closes.',
      sortable: true,
      accessor: (row) => Number(row.proposal.voteEnd),
      render: (row) => {
        if (!blockNumber) return null
        const { voteStart, voteEnd } = row.proposal
        const text =
          row.state === 0
            ? `Opens ${formatBlockEta(BigInt(voteStart), blockNumber)}`
            : row.state === 1
              ? `Ends ${formatBlockEta(BigInt(voteEnd), blockNumber)}`
              : `Ended ${formatBlockEta(BigInt(voteEnd), blockNumber)}`
        return (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {text}
          </span>
        )
      },
    },
    {
      key: 'proposer',
      header: 'PROPOSER',
      tooltip: 'The account that created this proposal on the governor.',
      sortable: false,
      render: (row) => <TableAddress address={row.proposal.proposer} />,
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 border-y border-border py-4">
        <div className="space-y-1">
          <div className="tg-label">Delegated here</div>
          <div className="text-2xl tabular-nums">
            {amount(poolPower)}{' '}
            <span className="text-sm text-muted-foreground">{symbol}</span>
          </div>
        </div>
        <div className="space-y-1">
          <div className="tg-label">Your share</div>
          <div className="text-2xl tabular-nums">
            {!isConnected ? (
              <span className="text-base text-muted-foreground">
                Connect a wallet to see it
              </span>
            ) : shareFraction === undefined ? (
              '...'
            ) : (
              <>
                {formatPercentage(shareFraction * 100)}
                {poolPower !== undefined && shareFraction > 0 && (
                  <span className="text-sm text-muted-foreground">
                    {' '}
                    (≈{' '}
                    {formatBigNumber(
                      (Number(poolPower) * shareFraction) / 10 ** decimals
                    )}{' '}
                    {symbol})
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="tg-label">Votes on</div>
          <div className="text-lg sm:text-2xl">
            {governor && explorer ? (
              <a
                href={`${explorer}/address/${governor}`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {governorName ?? '...'}
              </a>
            ) : (
              (governorName ?? '...')
            )}
          </div>
        </div>

        {isConnected && (
          <div className="ml-auto self-end">
            {delegatesHere ? (
              <span className="text-xs text-muted-foreground">
                Your {amount(balance)} {symbol} is delegated here
              </span>
            ) : (
              <Button
                size="sm"
                onClick={() => void delegate()}
                disabled={isDelegating || !balance}
                title={
                  balance === 0n ? `This wallet holds no ${symbol}` : undefined
                }
              >
                {isDelegating ? 'Delegating…' : `Delegate your ${symbol} here`}
              </Button>
            )}
          </div>
        )}
      </div>

      {(error || indexError) && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 rounded-md">
          <div className="text-destructive text-sm font-medium">
            {error ?? 'Could not load proposals from the indexer.'}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <SectionHeading>Proposals</SectionHeading>
        <p className="text-muted-foreground text-xs">
          Members cast the {symbol || 'votes'} delegated to this network on{' '}
          {governorName ?? 'the governor'}, each in proportion to their trust
          score when the proposal&apos;s vote opens.
        </p>

        {isLoadingProposals && (
          <div className="text-center py-12">
            <div className="text-muted-foreground text-sm">
              Loading proposals...
            </div>
          </div>
        )}

        {!isLoadingProposals && rows.length === 0 && (
          <div className="border border-border bg-muted/30 p-12 rounded-md text-center space-y-3">
            <div className="text-foreground text-sm font-medium">
              No proposals yet
            </div>
            <div className="text-muted-foreground text-xs">
              Proposals created on {governorName ?? 'the governor'} appear here.
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <Table
            columns={columns}
            data={rows}
            defaultSortColumn="state"
            defaultSortDirection="asc"
            cellClassName="text-sm"
            getRowKey={(row) => row.proposal.proposalId}
            onRowClick={(row) => {
              pushBreadcrumb({ title: 'proposals' })
              router.push(proposalHref(row))
            }}
            rowClickTitle="View proposal details"
          />
        )}
      </div>
    </div>
  )
}
