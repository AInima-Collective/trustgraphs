'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import type React from 'react'
import { Suspense, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'

import { TableAddress } from '@/components/Address'
import { Button } from '@/components/Button'
import { CreateProposalForm } from '@/components/CreateProposalForm'
import { Modal } from '@/components/Modal'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import {
  VoteDelegationPanel,
  VoteDelegationStatus,
} from '@/components/VoteDelegationPanel'
import { useNetwork } from '@/contexts/NetworkContext'
import {
  ProposalAction,
  ProposalCore,
  ProposalState,
  useGovernance,
} from '@/hooks/useGovernance'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { useRouteModal } from '@/hooks/useRouteModal'
import { formatBlockEta } from '@/lib/blocks'
import {
  clearGovernancePrefill,
  loadGovernancePrefill,
} from '@/lib/governance-prefill'
import { formatBigNumber, formatPercentage } from '@/lib/utils'

interface ProposalRow {
  core: ProposalCore
  actions: ProposalAction[]
}

/** Active proposals first (they can still be voted on), then newest first. */
const statePriority = (state: number): number => {
  switch (state) {
    case ProposalState.Active:
      return 0
    case ProposalState.Pending:
      return 1
    case ProposalState.Passed:
      return 2
    default:
      return 3
  }
}

const StateBadge = ({ state, label }: { state: number; label: string }) => {
  const styles =
    state === ProposalState.Active
      ? 'border-success/50 bg-success-soft text-success'
      : state === ProposalState.Passed || state === ProposalState.Executed
        ? 'border-hairline-strong bg-surface-2 text-text'
        : state === ProposalState.Rejected
          ? 'border-error/50 bg-error-soft text-error'
          : 'border-border bg-muted text-muted-foreground'

  return (
    <span
      className={`text-xs px-2 py-1 rounded-md border font-medium whitespace-nowrap ${styles}`}
    >
      {label}
    </span>
  )
}

/** One stacked bar: For (success) / Against (error) / Abstain (neutral). */
const ResultBar = ({ core }: { core: ProposalCore }) => {
  const total =
    Number(core.yesVotes) + Number(core.noVotes) + Number(core.abstainVotes)

  if (total === 0) {
    return <span className="text-xs text-muted-foreground">No votes yet</span>
  }

  const pct = (v: bigint) => (Number(v) / total) * 100

  return (
    <div className="min-w-[120px] space-y-1">
      <div
        className="flex h-2 w-full overflow-hidden bg-surface-2"
        role="img"
        aria-label={`For ${pct(core.yesVotes).toFixed(0)}%, against ${pct(core.noVotes).toFixed(0)}%, abstain ${pct(core.abstainVotes).toFixed(0)}%`}
      >
        <div
          className="bg-success h-2"
          style={{ width: `${pct(core.yesVotes)}%` }}
        />
        <div
          className="bg-error h-2"
          style={{ width: `${pct(core.noVotes)}%` }}
        />
        <div
          className="bg-text-subtle h-2"
          style={{ width: `${pct(core.abstainVotes)}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {pct(core.yesVotes).toFixed(0)}% for
      </div>
    </div>
  )
}

function GovernancePageContent() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { network } = useNetwork()
  const pushBreadcrumb = usePushBreadcrumb()
  const createModal = useRouteModal('new')
  const delegateModal = useRouteModal('delegate')
  const searchParams = useSearchParams()
  const prefillFingerprint =
    searchParams.get('actionDraft') ?? searchParams.get('scoringDraft')
  const [scoringPrefill, setScoringPrefill] =
    useState<ReturnType<typeof loadGovernancePrefill>>(null)
  useEffect(() => {
    setScoringPrefill(loadGovernancePrefill(network.id, prefillFingerprint))
  }, [network.id, prefillFingerprint])

  const {
    isAnyActionLoading,
    isLoadingProposals,
    isLoadingUserVotingPower,
    isLoadingModule,
    isLoadingSafeBalance,
    error,
    userVotingPower,
    totalVotingPower,
    currentBlockNumber,
    canCreateProposal,
    createProposal,
    getAllProposals,
    getProposalStateText,
    safeBalance,
    quorum,
    votingPeriod,
    currentVoteDelegate,
    isLoadingVoteDelegate,
    isSettingVoteDelegate,
    setVoteDelegate,
    merkleGovAddress,
  } = useGovernance()

  const proposals = getAllProposals()

  const votingPowerPercent =
    userVotingPower && totalVotingPower && Number(totalVotingPower) > 0
      ? (Number(userVotingPower.value) / Number(totalVotingPower)) * 100
      : 0

  const columns: Column<ProposalRow>[] = [
    {
      key: 'title',
      header: 'TITLE',
      tooltip: 'What the proposal is about.',
      sortable: false,
      render: (row) => (
        <div className="max-w-[300px] truncate font-medium">
          {row.core.title || `Proposal #${row.core.id.toString()}`}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'STATUS',
      tooltip: 'Where the proposal is in its life: voting, passed, executed.',
      sortable: true,
      accessor: (row) =>
        statePriority(row.core.state) * 1e9 - Number(row.core.id),
      render: (row) => (
        <StateBadge
          state={row.core.state}
          label={getProposalStateText(row.core.state)}
        />
      ),
    },
    {
      key: 'result',
      header: 'RESULT',
      tooltip: 'Share of votes cast so far: for, against, abstain.',
      sortable: false,
      render: (row) => <ResultBar core={row.core} />,
    },
    {
      key: 'timing',
      header: 'VOTING',
      tooltip: 'When voting opens or closes, estimated from block times.',
      sortable: true,
      accessor: (row) => Number(row.core.endBlock),
      render: (row) => {
        const { state, startBlock, endBlock } = row.core
        if (!currentBlockNumber) return null
        const text =
          state === ProposalState.Pending
            ? `Opens ${formatBlockEta(startBlock, currentBlockNumber)}`
            : state === ProposalState.Active
              ? `Ends ${formatBlockEta(endBlock, currentBlockNumber)}`
              : `Ended ${formatBlockEta(endBlock, currentBlockNumber)}`
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
      tooltip: 'The account that created this proposal.',
      sortable: false,
      render: (row) => <TableAddress address={row.core.proposer} />,
    },
  ]

  return (
    <div className="space-y-6">
      {/* Context strip: the numbers that motivate action and the rules that bound it, one slim
          row. No intro sentence above it — "Governance" is already the tab, and every noun here
          is defined by its own label. */}
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 border-y border-border py-4">
        <div className="space-y-1">
          <div className="tg-label">Treasury</div>
          <div className="text-2xl tabular-nums">
            {isLoadingModule || isLoadingSafeBalance
              ? '...'
              : `${formatBigNumber(BigInt(safeBalance || '0'), 18)} ETH`}
          </div>
        </div>
        <div className="space-y-1">
          <div className="tg-label">Your voting power</div>
          <div className="text-2xl tabular-nums">
            {!isConnected ? (
              <span className="text-base text-muted-foreground">
                Connect a wallet to see it
              </span>
            ) : isLoadingUserVotingPower || isLoadingModule ? (
              '...'
            ) : userVotingPower ? (
              <>
                {formatBigNumber(BigInt(userVotingPower.value), 18)}{' '}
                <span className="text-sm text-muted-foreground">
                  ({votingPowerPercent.toFixed(1)}% of total)
                </span>
              </>
            ) : (
              '0'
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="tg-label">Quorum</div>
          <div className="text-2xl tabular-nums">
            {isLoadingModule ? '...' : formatPercentage(quorum * 100)}
          </div>
        </div>
        <div className="space-y-1">
          <div className="tg-label">Voting period</div>
          <div className="text-2xl tabular-nums">
            {isLoadingModule
              ? '...'
              : `${votingPeriod.toLocaleString()} blocks`}
          </div>
        </div>
        {/* An active delegate reinterprets every proposal below ("if I do
            nothing, my agent votes"), so it is stated here rather than left
            inside the modal that configures it. */}
        {merkleGovAddress && isConnected && (
          <VoteDelegationStatus
            currentDelegate={currentVoteDelegate}
            isLoading={isLoadingVoteDelegate}
            onManage={delegateModal.open}
          />
        )}

        <Link
          href={`/networks/${network.id}/settings?tab=advanced`}
          className="ml-auto self-end text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-text"
        >
          Voting rules and contracts
        </Link>
      </div>

      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 rounded-md">
          <div className="text-destructive text-sm font-medium">{error}</div>
        </div>
      )}

      {/* Proposals: the page's actual content, right below the fold line. */}
      <div className="space-y-4">
        <SectionHeading
          actions={
            canCreateProposal ? (
              <Button onClick={createModal.open} size="sm">
                + New proposal
              </Button>
            ) : undefined
          }
        >
          Proposals
        </SectionHeading>

        {isConnected && !canCreateProposal && !isLoadingModule && (
          <p className="text-muted-foreground text-xs">
            You need a trust score in this network to propose. Earn one by
            receiving trust attestations from members.
          </p>
        )}

        {isLoadingProposals && proposals.length === 0 && (
          <div className="text-center py-12">
            <div className="text-muted-foreground text-sm">
              Loading proposals...
            </div>
          </div>
        )}

        {proposals.length === 0 && !isLoadingProposals && (
          <div className="border border-border bg-muted/30 p-12 rounded-md text-center space-y-3">
            <div className="text-foreground text-sm font-medium">
              No proposals yet
            </div>
            <div className="text-muted-foreground text-xs">
              {canCreateProposal
                ? 'Be the first to create a governance proposal'
                : 'Members with a trust score can create the first proposal'}
            </div>
          </div>
        )}

        {proposals.length > 0 && (
          <Table
            columns={columns}
            data={proposals}
            defaultSortColumn="state"
            defaultSortDirection="asc"
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

      <Modal
        isOpen={createModal.isOpen}
        onClose={createModal.close}
        title="New proposal"
      >
        <CreateProposalForm
          canCreateProposal={canCreateProposal}
          userVotingPower={userVotingPower?.value}
          onCreateProposal={async (title, description, actions, voteType) => {
            const result = await createProposal(
              title,
              description,
              actions,
              voteType
            )
            if (result) {
              if (prefillFingerprint) {
                clearGovernancePrefill(network.id, prefillFingerprint)
              }
              createModal.close()
            }
            return result
          }}
          isLoading={isAnyActionLoading}
          prefill={scoringPrefill}
        />
      </Modal>

      {merkleGovAddress && (
        <Modal
          isOpen={delegateModal.isOpen}
          onClose={delegateModal.close}
          title="Agent voting"
        >
          <VoteDelegationPanel
            networkId={network.id}
            module={merkleGovAddress}
            principal={address}
            currentDelegate={currentVoteDelegate}
            isLoading={isLoadingVoteDelegate || isSettingVoteDelegate}
            onSetDelegate={setVoteDelegate}
            onDone={delegateModal.close}
          />
        </Modal>
      )}
    </div>
  )
}

export default function GovernancePage() {
  // useSearchParams (inside useRouteModal) requires a Suspense boundary when
  // the route is statically prerendered.
  return (
    <Suspense fallback={null}>
      <GovernancePageContent />
    </Suspense>
  )
}
