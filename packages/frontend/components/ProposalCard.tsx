'use client'

import { Check } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useAccount } from 'wagmi'

import { Button } from '@/components/Button'
import { VoteButtons } from '@/components/VoteButtons'
import {
  ProposalAction,
  ProposalCore,
  ProposalState,
  VoteType,
} from '@/hooks/useGovernance'
import { formatBlockEta } from '@/lib/blocks'
import { formatBigNumber } from '@/lib/utils'

import { Address } from './Address'
import { Card } from './Card'
import { ProposalActionList } from './ProposalActionList'
import { ProposalScoringSimulation } from './ProposalScoringSimulation'

export interface ProposalVoteRow {
  voter: string
  voteType: number
  votingPower: bigint
  castBy?: string
  delegated?: boolean
  delegate?: string | null
  reason?: string | null
  overridden?: boolean
}

interface ProposalCardProps {
  proposal: ProposalCore
  actions: ProposalAction[]
  votes?: ProposalVoteRow[]
  /** Quorum as a fraction of total voting power (0.10 = 10%). */
  quorum?: number
  currentBlockNumber?: bigint
  userVotingPower?: string
  userVote?: VoteType | null
  userVoteDelegated?: boolean
  userVoteDelegate?: string | null
  userVoteReason?: string | null
  userVoteOverridden?: boolean
  onVote?: (proposalId: number, support: VoteType) => Promise<string | null>
  onExecute?: (proposalId: number) => Promise<string | null>
  isLoading?: boolean
  getProposalStateText?: (state: number) => string
}

const voteTypeText = (voteType: VoteType | number | null | undefined) => {
  switch (voteType) {
    case VoteType.Yes:
      return 'For'
    case VoteType.No:
      return 'Against'
    case VoteType.Abstain:
      return 'Abstain'
    default:
      return 'Unknown'
  }
}

const voteTypeStyles = (voteType: VoteType | number | null | undefined) => {
  switch (voteType) {
    case VoteType.Yes:
      return 'border-success/50 bg-success-soft text-success'
    case VoteType.No:
      return 'border-error/50 bg-error-soft text-error'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

export function ProposalCard({
  proposal,
  actions,
  votes = [],
  quorum = 0,
  currentBlockNumber,
  userVotingPower,
  userVote,
  userVoteDelegated = false,
  userVoteDelegate,
  userVoteReason,
  userVoteOverridden = false,
  onVote,
  onExecute,
  isLoading = false,
  getProposalStateText = (state) => `State ${state}`,
}: ProposalCardProps) {
  const { isConnected } = useAccount()

  const [isVoting, setIsVoting] = useState(false)

  const proposalId = Number(proposal.id)
  const state = proposal.state
  const isActive = state === ProposalState.Active
  const isPassed = state === ProposalState.Passed
  const hasVoted = userVote !== undefined && userVote !== null
  const canVote =
    isActive &&
    userVotingPower &&
    Number(userVotingPower) > 0 &&
    (!hasVoted || userVoteDelegated)

  const totalVotes =
    Number(proposal.yesVotes) +
    Number(proposal.noVotes) +
    Number(proposal.abstainVotes)
  const forPercentage =
    totalVotes > 0 ? (Number(proposal.yesVotes) / totalVotes) * 100 : 0
  const againstPercentage =
    totalVotes > 0 ? (Number(proposal.noVotes) / totalVotes) * 100 : 0
  const abstainPercentage =
    totalVotes > 0 ? (Number(proposal.abstainVotes) / totalVotes) * 100 : 0

  // Quorum: participation measured against the network's total voting power
  // at the proposal's snapshot, not against votes cast.
  const quorumNeeded = quorum * Number(proposal.totalVotingPower)
  const decisiveVotes = Number(proposal.yesVotes) + Number(proposal.noVotes)
  const quorumProgress =
    quorumNeeded > 0 ? Math.min((decisiveVotes / quorumNeeded) * 100, 100) : 0
  const quorumReached = quorumNeeded > 0 && decisiveVotes >= quorumNeeded
  const majorityFor = Number(proposal.yesVotes) > Number(proposal.noVotes)

  const timing =
    currentBlockNumber === undefined || currentBlockNumber === 0n
      ? null
      : state === ProposalState.Pending
        ? `Voting opens ${formatBlockEta(proposal.startBlock, currentBlockNumber)}`
        : isActive
          ? `Voting ends ${formatBlockEta(proposal.endBlock, currentBlockNumber)}`
          : isPassed
            ? `Execution expires ${formatBlockEta(proposal.executionDeadlineBlock, currentBlockNumber)}`
            : state === ProposalState.Expired
              ? `Execution expired ${formatBlockEta(proposal.executionDeadlineBlock, currentBlockNumber)}`
              : `Voting ended ${formatBlockEta(proposal.endBlock, currentBlockNumber)}`

  const handleVote = useCallback(
    async (support: VoteType) => {
      if (!onVote || !canVote) return
      setIsVoting(true)
      try {
        await onVote(proposalId, support)
      } catch (err) {
        console.error('Error voting:', err)
      } finally {
        setIsVoting(false)
      }
    },
    [onVote, canVote, proposalId]
  )

  const handleExecute = useCallback(async () => {
    if (!onExecute) return
    await onExecute(proposalId)
  }, [onExecute, proposalId])

  const getStatusStyles = () => {
    if (isActive) {
      return 'border-success/50 bg-success-soft text-success'
    }
    if (state === ProposalState.Passed || state === ProposalState.Executed) {
      return 'border-hairline-strong bg-surface-2 text-text'
    }
    if (state === ProposalState.Rejected) {
      return 'border-error/50 bg-error-soft text-error'
    }
    return 'border-border bg-muted text-muted-foreground'
  }

  return (
    <Card type="primary" size="lg" className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold text-foreground">
              {proposal.title || `Proposal #${proposalId}`}
            </h2>
            <div className="text-xs text-muted-foreground">
              Proposal #{proposalId}
              {timing && <> · {timing}</>}
            </div>
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Proposer:</span>{' '}
              <Address textClassName="text-xs" address={proposal.proposer} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div
              className={`text-xs px-2.5 py-1 rounded-md border font-medium ${getStatusStyles()}`}
            >
              {getProposalStateText(state)}
            </div>
          </div>
        </div>

        <p className="text-sm text-foreground/80 whitespace-pre-wrap">
          {proposal.description}
        </p>
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="border-t border-border pt-6 space-y-4">
          <h3 className="text-sm font-bold text-foreground">
            What passes if this passes
          </h3>
          <ProposalActionList
            actions={actions}
            proposalDescription={proposal.description}
          />
          <ProposalScoringSimulation
            actions={actions}
            description={proposal.description}
            merkleRoot={proposal.merkleRoot}
            proposalBlock={proposal.blockNumber}
          />
        </div>
      )}

      {/* Results */}
      <div className="border-t border-border pt-6 space-y-4">
        <h3 className="text-sm font-bold text-foreground">Results</h3>

        <div className="grid grid-cols-3 gap-4 text-xs">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">For</span>
              <span className="text-foreground font-medium tabular-nums">
                {formatBigNumber(proposal.yesVotes, 18)}
              </span>
            </div>
            <div className="h-2 overflow-hidden bg-surface-2">
              <div
                className="bg-success h-2 transition-all"
                style={{ width: `${forPercentage}%` }}
              />
            </div>
            <div className="text-center text-muted-foreground tabular-nums">
              {forPercentage.toFixed(1)}%
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Against</span>
              <span className="text-foreground font-medium tabular-nums">
                {formatBigNumber(proposal.noVotes, 18)}
              </span>
            </div>
            <div className="h-2 overflow-hidden bg-surface-2">
              <div
                className="bg-error h-2 transition-all"
                style={{ width: `${againstPercentage}%` }}
              />
            </div>
            <div className="text-center text-muted-foreground tabular-nums">
              {againstPercentage.toFixed(1)}%
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Abstain</span>
              <span className="text-foreground font-medium tabular-nums">
                {formatBigNumber(proposal.abstainVotes, 18)}
              </span>
            </div>
            <div className="h-2 overflow-hidden bg-surface-2">
              <div
                className="bg-text-subtle h-2 transition-all"
                style={{ width: `${abstainPercentage}%` }}
              />
            </div>
            <div className="text-center text-muted-foreground tabular-nums">
              {abstainPercentage.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Quorum: the number that decides whether the result counts. */}
        {quorumNeeded > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">
                Quorum: {formatBigNumber(decisiveVotes / 1e18)} of{' '}
                {formatBigNumber(quorumNeeded / 1e18)} voting power needed
              </span>
              <span
                className={
                  quorumReached
                    ? 'text-success font-medium'
                    : 'text-muted-foreground'
                }
              >
                {quorumReached ? 'Reached' : 'Not reached yet'}
              </span>
            </div>
            <div className="h-2 overflow-hidden bg-surface-2">
              <div
                className={`h-2 transition-all ${quorumReached ? 'bg-success' : 'bg-text-subtle'}`}
                style={{ width: `${quorumProgress}%` }}
              />
            </div>
            {isActive && (
              <div className="text-xs text-muted-foreground">
                {quorumReached
                  ? majorityFor
                    ? 'Passing: quorum reached and For is ahead.'
                    : 'Not passing: quorum reached but Against is ahead.'
                  : 'Needs more participation to reach quorum.'}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Voters */}
      {votes.length > 0 && (
        <div className="border-t border-border pt-6 space-y-3">
          <h3 className="text-sm font-bold text-foreground">
            Votes ({votes.length})
          </h3>
          <div className="space-y-2">
            {votes.map((vote) => (
              <div
                key={vote.voter}
                className="flex items-start justify-between gap-3 text-xs"
              >
                <div className="space-y-1">
                  <Address textClassName="text-xs" address={vote.voter} />
                  {vote.delegate && (
                    <div className="text-muted-foreground">
                      {vote.overridden ? 'Originally cast' : 'Cast'} by agent{' '}
                      <Address
                        textClassName="text-xs"
                        address={vote.delegate}
                      />
                      {vote.overridden ? ' · overruled by principal' : ''}
                    </div>
                  )}
                  {vote.reason && (
                    <div className="max-w-lg text-muted-foreground">
                      “{vote.reason}”
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground tabular-nums">
                    {formatBigNumber(vote.votingPower, 18)}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-md border font-medium ${voteTypeStyles(vote.voteType)}`}
                  >
                    {voteTypeText(vote.voteType)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Your vote */}
      {hasVoted && (
        <div className="border-t border-border pt-6 space-y-3">
          <h3 className="text-sm font-bold text-foreground">Your vote</h3>
          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md border font-medium ${voteTypeStyles(userVote)}`}
            >
              <Check className="w-4 h-4" />
              <span>
                {userVoteDelegated ? 'Agent intends' : 'Voted'}{' '}
                {voteTypeText(userVote)}
              </span>
            </div>
            {userVotingPower && (
              <span className="text-xs text-muted-foreground">
                with {formatBigNumber(BigInt(userVotingPower), 18)} voting power
              </span>
            )}
          </div>
          {userVoteDelegated && userVoteDelegate && (
            <div className="text-xs text-muted-foreground space-y-1">
              <div>
                This vote is provisional. Agent{' '}
                <Address textClassName="text-xs" address={userVoteDelegate} />{' '}
                cast it; your own vote below replaces it and becomes final.
              </div>
              {userVoteReason && <div>Agent rationale: “{userVoteReason}”</div>}
            </div>
          )}
          {userVoteOverridden && (
            <div className="text-xs text-muted-foreground">
              You overruled the agent. This vote is final.
            </div>
          )}
        </div>
      )}

      {/* Cast a vote */}
      {canVote && (
        <div className="border-t border-border pt-6 space-y-4">
          <h3 className="text-sm font-bold text-foreground">
            {userVoteDelegated ? 'Overrule your agent' : 'Cast your vote'}
          </h3>
          <div className="text-xs text-muted-foreground">
            {userVoteDelegated
              ? 'Your choice replaces the provisional agent vote. '
              : ''}
            Your voting power: {formatBigNumber(BigInt(userVotingPower!), 18)}
          </div>
          <VoteButtons
            disabled={isVoting}
            isLoading={isLoading}
            onSelect={(vt) => handleVote(vt)}
          />
        </div>
      )}

      {/* Execution */}
      {isPassed && onExecute && (
        <div className="border-t border-border pt-6 space-y-4">
          <h3 className="text-sm font-bold text-foreground">Execution</h3>
          <div className="text-xs text-muted-foreground">
            This proposal passed. Anyone can execute it, which runs its actions
            from the treasury.
          </div>
          <Button
            onClick={handleExecute}
            disabled={isLoading}
            variant="brand"
            size="sm"
          >
            Execute proposal
          </Button>
        </div>
      )}

      {/* No voting power */}
      {isConnected &&
        isActive &&
        !hasVoted &&
        (!userVotingPower || Number(userVotingPower) === 0) && (
          <div className="border-t border-border pt-6 space-y-1">
            <div className="text-sm font-medium text-foreground">
              You can't vote on this proposal
            </div>
            <div className="text-xs text-muted-foreground">
              Voting power comes from your trust score when the proposal was
              created. Earn trust attestations to take part in future votes.
            </div>
          </div>
        )}
    </Card>
  )
}
