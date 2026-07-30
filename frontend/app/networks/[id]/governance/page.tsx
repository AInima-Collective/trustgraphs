'use client'

import { ExternalLink } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useAccount } from 'wagmi'

import { Address, TableAddress } from '@/components/Address'
import { Button } from '@/components/Button'
import { CreateProposalForm } from '@/components/CreateProposalForm'
import { NetworkNav } from '@/components/NetworkNav'
import { SectionHeading } from '@/components/SectionHeading'
import { StatisticCard } from '@/components/StatisticCard'
import { Column, Table } from '@/components/Table'
import { useNetwork } from '@/contexts/NetworkContext'
import {
  ProposalAction,
  ProposalCore,
  ProposalState,
  VoteType,
  useGovernance,
} from '@/hooks/useGovernance'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { trustGraphTabs } from '@/lib/network-nav'
import { formatBigNumber } from '@/lib/utils'

interface ProposalRow {
  core: ProposalCore
  actions: ProposalAction[]
}

export default function GovernancePage() {
  const router = useRouter()
  const { isConnected } = useAccount()
  const { network } = useNetwork()
  const pushBreadcrumb = usePushBreadcrumb()
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const {
    isAnyActionLoading,
    isLoadingProposals,
    isLoadingUserVotingPower,
    isLoadingModule,
    isLoadingSafeBalance,
    error,
    proposalCounter,
    votingDelay,
    votingPeriod,
    quorum,
    userVotingPower,
    totalVotingPower,
    canCreateProposal,
    createProposal,
    getAllProposals,
    getProposalStateText,
    merkleGovAddress,
    safeBalance,
    safeAddress,
  } = useGovernance()

  const proposals = getAllProposals()

  const handleCreateProposal = useCallback(
    async (
      title: string,
      description: string,
      actions: ProposalAction[],
      voteType?: VoteType | null
    ) => {
      setSuccessMessage(null)
      const hash = await createProposal(title, description, actions, voteType)
      if (hash) {
        setSuccessMessage(
          voteType === undefined || voteType === null
            ? `Proposal created successfully! Transaction: ${hash}`
            : `Proposal created & vote cast! Transaction: ${hash}`
        )
        setTimeout(() => setSuccessMessage(null), 5000)
      }
      return hash
    },
    [createProposal]
  )

  const [showCreateForm, setShowCreateForm] = useState(false)

  const isLoading = isLoadingModule || isLoadingSafeBalance

  // Define table columns for proposals
  const columns: Column<ProposalRow>[] = [
    {
      key: 'id',
      header: 'ID',
      tooltip: 'The unique identifier for this proposal.',
      sortable: true,
      accessor: (row) => Number(row.core.id),
      render: (row) => (
        <span className="font-medium">#{row.core.id.toString()}</span>
      ),
    },
    {
      key: 'title',
      header: 'TITLE',
      tooltip: 'The title of the proposal.',
      sortable: false,
      render: (row) => (
        <div className="max-w-[300px] truncate">{row.core.title}</div>
      ),
    },
    {
      key: 'proposer',
      header: 'PROPOSER',
      tooltip: 'The account that created this proposal.',
      sortable: false,
      render: (row) => <TableAddress address={row.core.proposer} />,
    },
    {
      key: 'state',
      header: 'STATUS',
      tooltip: 'The current state of the proposal.',
      sortable: true,
      accessor: (row) => row.core.state,
      render: (row) => {
        const state = row.core.state
        const stateText = getProposalStateText(state)
        const stateStyles =
          state === ProposalState.Active
            ? 'border-success/50 bg-success-soft text-success'
            : state === ProposalState.Passed
              ? 'border-hairline-strong bg-surface-2 text-text'
              : state === ProposalState.Executed
                ? 'border-hairline-strong bg-surface-2 text-text'
                : state === ProposalState.Rejected
                  ? 'border-error/50 bg-error-soft text-error'
                  : 'border-border bg-muted text-muted-foreground'

        return (
          <span
            className={`text-xs px-2 py-1 rounded-md border font-medium ${stateStyles}`}
          >
            {stateText}
          </span>
        )
      },
    },
    {
      key: 'votes',
      header: 'VOTES',
      tooltip: 'The current vote count (Yes / No / Abstain).',
      sortable: true,
      accessor: (row) =>
        Number(row.core.yesVotes) +
        Number(row.core.noVotes) +
        Number(row.core.abstainVotes),
      render: (row) => {
        const total =
          Number(row.core.yesVotes) +
          Number(row.core.noVotes) +
          Number(row.core.abstainVotes)
        return (
          <div className="text-sm">
            <span className="text-success">
              {formatBigNumber(row.core.yesVotes, undefined, true)}
            </span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-error">
              {formatBigNumber(row.core.noVotes, undefined, true)}
            </span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-muted-foreground">
              {formatBigNumber(row.core.abstainVotes, undefined, true)}
            </span>
            <span className="text-muted-foreground text-xs ml-2">
              ({formatBigNumber(total, undefined, true)} total)
            </span>
          </div>
        )
      },
    },
    {
      key: 'actions',
      header: 'ACTIONS',
      tooltip: 'The number of on-chain actions in this proposal.',
      sortable: true,
      accessor: (row) => row.actions.length,
      render: (row) => (
        <span className="text-muted-foreground">
          {row.actions.length} {row.actions.length === 1 ? 'action' : 'actions'}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      {/* Header with Statistics */}
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold">Governance</h1>
          <p className="text-muted-foreground text-sm">
            Decentralized decision making with merkle proof verification
          </p>
        </div>

        <NetworkNav tabs={trustGraphTabs(network)} />

        {/* Key Statistics - Right under header */}
        <div className="flex flex-row gap-4 flex-wrap">
          <StatisticCard
            title="TREASURY BALANCE"
            tooltip="The total ETH balance held in the governance treasury (Safe). This can be distributed through governance proposals."
            value={
              isLoading
                ? '...'
                : safeBalance
                  ? `${(Number(safeBalance) / 1e18).toFixed(2)} ETH`
                  : '0.00 ETH'
            }
          />
          <StatisticCard
            title="TOTAL PROPOSALS"
            tooltip="The total number of governance proposals that have been created."
            value={isLoadingModule ? '...' : String(proposalCounter)}
          />
          <StatisticCard
            title="YOUR VOTING POWER"
            tooltip="Your voting power as a percentage of total voting power. This is based on your Trust Score in the network."
            value={
              !isConnected
                ? '?'
                : isLoadingUserVotingPower || isLoadingModule
                  ? '...'
                  : userVotingPower && totalVotingPower
                    ? formatBigNumber(
                        (Number(userVotingPower.value) /
                          Number(totalVotingPower)) *
                          100
                      ) + '%'
                    : '0%'
            }
          />
        </div>
      </div>

      {/* Success Message */}
      {successMessage && (
        <div className="border border-success bg-success-soft p-3 rounded-md">
          <div className="text-success text-sm font-medium">
            ✓ {successMessage}
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 rounded-md">
          <div className="text-destructive text-sm font-medium">⚠️ {error}</div>
        </div>
      )}

      {/* Parameters & Contracts */}
      <div className="border-y border-border py-6 space-y-4">
        <SectionHeading>Parameters</SectionHeading>
        <div className="flex flex-row gap-4 flex-wrap">
          <StatisticCard
            title="VOTING DELAY"
            tooltip="The number of blocks that must pass after a proposal is created before voting can begin."
            value={
              isLoadingModule ? '...' : `${formatBigNumber(votingDelay)} blocks`
            }
          />
          <StatisticCard
            title="VOTING PERIOD"
            tooltip="The number of blocks during which voting is open."
            value={
              isLoadingModule
                ? '...'
                : `${formatBigNumber(votingPeriod, undefined, true)} blocks`
            }
          />
          <StatisticCard
            title="QUORUM"
            tooltip="The minimum percentage of total voting power that must participate for a proposal to be valid."
            value={
              isLoadingModule ? '...' : `${formatBigNumber(quorum * 100)}%`
            }
          />
        </div>

        <SectionHeading className="mt-6">Contracts</SectionHeading>

        {/* Contract Addresses */}
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="font-bold">Zodiac Module:</span>
            {merkleGovAddress ? (
              <Address
                address={merkleGovAddress}
                displayMode="truncated"
                showCopyIcon
                link={false}
                noHighlight
              />
            ) : (
              <span>Not available</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold">Treasury Safe:</span>
            {isLoadingModule ? (
              <span>...</span>
            ) : safeAddress ? (
              <>
                <Address
                  address={safeAddress}
                  displayMode="truncated"
                  showCopyIcon
                  link={false}
                  noHighlight
                />
                <a
                  href={`https://app.safe.global/home?safe=eth:${safeAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-text underline underline-offset-4 transition-colors hover:text-text-muted"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </>
            ) : (
              <span>Not available</span>
            )}
          </div>
        </div>
      </div>

      {/* Proposals Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <SectionHeading>Proposals</SectionHeading>
          <Button onClick={() => setShowCreateForm(!showCreateForm)} size="sm">
            {showCreateForm ? 'Cancel' : '+ New Proposal'}
          </Button>
        </div>

        {/* Create Proposal Form - Conditional */}
        {showCreateForm && (
          <CreateProposalForm
            canCreateProposal={canCreateProposal}
            userVotingPower={userVotingPower?.value}
            onCreateProposal={async (title, description, actions, voteType) => {
              const result = await handleCreateProposal(
                title,
                description,
                actions,
                voteType
              )
              if (result) {
                setShowCreateForm(false)
              }
              return result
            }}
            isLoading={isAnyActionLoading}
          />
        )}

        {/* Proposals Count */}
        {!isLoadingProposals && (
          <div className="text-muted-foreground text-sm">
            {formatBigNumber(proposals.length)}{' '}
            {proposals.length === 1 ? 'proposal' : 'proposals'}
          </div>
        )}

        {/* Loading State */}
        {isLoadingProposals && proposals.length === 0 && (
          <div className="text-center py-12">
            <div className="text-muted-foreground text-sm">
              Loading proposals...
            </div>
          </div>
        )}

        {/* Empty State */}
        {proposals.length === 0 && !isLoadingProposals && (
          <div className="border border-border bg-muted/30 p-12 rounded-md text-center space-y-3">
            <div className="text-foreground text-sm font-medium">
              No proposals yet
            </div>
            <div className="text-muted-foreground text-xs">
              {canCreateProposal
                ? 'Be the first to create a governance proposal'
                : 'Participate in attestations to earn proposal creation rights'}
            </div>
          </div>
        )}

        {/* Proposals Table */}
        {proposals.length > 0 && (
          <Table
            columns={columns}
            data={proposals}
            defaultSortColumn="id"
            defaultSortDirection="desc"
            cellClassName="text-sm"
            getRowKey={(row) => row.core.id.toString()}
            onRowClick={(row) => {
              pushBreadcrumb()
              router.push(`governance/${row.core.id}`)
            }}
            rowClickTitle="View proposal details"
          />
        )}
      </div>
    </div>
  )
}
