'use client'

import { Check } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { parseUnits } from 'viem'
import { useAccount } from 'wagmi'

import { Button } from '@/components/Button'
import { VoteButtons } from '@/components/VoteButtons'
import {
  ProposalAction,
  ProposalCore,
  ProposalState,
  VoteType,
} from '@/hooks/useGovernance'
import { formatBigNumber } from '@/lib/utils'

import { Address } from './Address'
import { Card } from './Card'

interface ProposalCardProps {
  proposal: ProposalCore
  actions: ProposalAction[]
  userVotingPower?: string
  userVote?: VoteType | null
  onVote?: (proposalId: number, support: VoteType) => Promise<string | null>
  onQueue?: (proposalId: number) => Promise<string | null>
  onExecute?: (proposalId: number) => Promise<string | null>
  isLoading?: boolean
  getProposalStateText?: (state: number) => string
}

export function ProposalCard({
  proposal,
  actions,
  userVotingPower,
  userVote,
  onVote,
  onQueue,
  onExecute,
  isLoading = false,
  getProposalStateText = (state) => `State ${state}`,
}: ProposalCardProps) {
  const { isConnected } = useAccount()

  const [isVoting, setIsVoting] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const proposalId = Number(proposal.id)
  const state = proposal.state
  const isActive = state === ProposalState.Active
  const isPassed = state === ProposalState.Passed
  const hasVoted = userVote !== undefined && userVote !== null
  const canVote =
    isActive && userVotingPower && Number(userVotingPower) > 0 && !hasVoted

  // Calculate total votes and percentages
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

  // Block-based timing for MerkleGovModule
  const startBlock = Number(proposal.startBlock || 0)
  const endBlock = Number(proposal.endBlock || 0)

  const getTimeLeft = () => {
    if (state === ProposalState.Pending) {
      return `Starts at block ${startBlock}`
    } else if (isActive) {
      return `Ends at block ${endBlock}`
    }
    return null
  }

  const getVoteTypeText = (voteType: VoteType) => {
    switch (voteType) {
      case VoteType.Yes:
        return 'FOR'
      case VoteType.No:
        return 'AGAINST'
      case VoteType.Abstain:
        return 'ABSTAIN'
      default:
        return 'UNKNOWN'
    }
  }

  const getVoteTypeStyles = (voteType: VoteType) => {
    switch (voteType) {
      case VoteType.Yes:
        return 'border-success/50 bg-success-soft text-success'
      case VoteType.No:
        return 'border-error/50 bg-error-soft text-error'
      case VoteType.Abstain:
        return 'border-border bg-muted text-muted-foreground'
      default:
        return 'border-border bg-muted text-muted-foreground'
    }
  }

  const handleVote = useCallback(
    async (support: VoteType) => {
      if (!onVote || !canVote) return

      setIsVoting(true)
      setSuccessMessage(null)

      try {
        const hash = await onVote(proposalId, support)
        if (hash) {
          const voteText = getVoteTypeText(support)
          setSuccessMessage(`Vote cast ${voteText}! Transaction: ${hash}`)
          setTimeout(() => setSuccessMessage(null), 5000)
        }
      } catch (err) {
        console.error('Error voting:', err)
      } finally {
        setIsVoting(false)
      }
    },
    [onVote, canVote, proposalId]
  )

  const _handleQueue = useCallback(async () => {
    if (!onQueue) return

    const hash = await onQueue(proposalId)
    if (hash) {
      setSuccessMessage(`Proposal queued! Transaction: ${hash}`)
      setTimeout(() => setSuccessMessage(null), 5000)
    }
  }, [onQueue, proposalId])

  const handleExecute = useCallback(async () => {
    if (!onExecute) return

    const hash = await onExecute(proposalId)
    if (hash) {
      setSuccessMessage(`Proposal executed! Transaction: ${hash}`)
      setTimeout(() => setSuccessMessage(null), 5000)
    }
  }, [onExecute, proposalId])

  const timeLeft = getTimeLeft()

  const getStatusStyles = () => {
    if (isActive) {
      return 'border-success/50 bg-success-soft text-success'
    }
    if (state === ProposalState.Passed) {
      return 'border-hairline-strong bg-surface-2 text-text'
    }
    if (state === ProposalState.Executed) {
      return 'border-hairline-strong bg-surface-2 text-text'
    }
    return 'border-border bg-muted text-muted-foreground'
  }

  return (
    <Card type="primary" size="lg" className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-foreground">
              {proposal.title}
            </h3>
            {timeLeft && (
              <div className="text-xs text-muted-foreground">{timeLeft}</div>
            )}
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

        <p className="text-sm text-foreground/80">{proposal.description}</p>
      </div>

      {/* Success Message */}
      {successMessage && (
        <div className="border border-success/50 bg-success-soft p-4 rounded-md">
          <div className="text-success text-sm">✓ {successMessage}</div>
        </div>
      )}

      {/* Actions */}
      {actions.length > 0 && (
        <div className="border-t border-border pt-6 space-y-4">
          <h4 className="text-sm font-bold text-foreground">
            PROPOSED ACTIONS
          </h4>
          <div className="space-y-3">
            {actions.map((action, index) => (
              <Card key={index} type="accent" size="md" className="space-y-3">
                <div className="flex justify-between items-start">
                  <div className="text-xs font-medium text-muted-foreground">
                    ACTION #{index + 1}
                  </div>
                  {action.value !== '0' && (
                    <div className="text-xs font-medium text-foreground">
                      {formatBigNumber(parseUnits(action.value, 18), 18)} ETH
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">TARGET</div>
                  <div className="text-sm font-mono break-all text-foreground">
                    {action.target}
                  </div>
                </div>
                {action.description && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      DESCRIPTION
                    </div>
                    <div className="text-sm text-foreground">
                      {action.description}
                    </div>
                  </div>
                )}
                {action.data !== '0x' && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">
                      CALLDATA
                    </div>
                    <div className="text-xs font-mono break-all text-muted-foreground">
                      {action.data.slice(0, 100)}...
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Vote Results */}
      <div className="border-t border-border pt-6 space-y-4">
        <h4 className="text-sm font-bold text-foreground">VOTING RESULTS</h4>
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">FOR</span>
              <span className="text-foreground font-medium">
                {proposal.yesVotes.toString()}
              </span>
            </div>
            <div className="h-2 overflow-hidden bg-surface-2">
              <div
                className="bg-success h-2 transition-all"
                style={{ width: `${forPercentage}%` }}
              />
            </div>
            <div className="text-center text-muted-foreground">
              {forPercentage.toFixed(1)}%
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">AGAINST</span>
              <span className="text-foreground font-medium">
                {proposal.noVotes.toString()}
              </span>
            </div>
            <div className="bg-muted h-2 rounded-full overflow-hidden">
              <div
                className="bg-error h-2 transition-all"
                style={{ width: `${againstPercentage}%` }}
              />
            </div>
            <div className="text-center text-muted-foreground">
              {againstPercentage.toFixed(1)}%
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">ABSTAIN</span>
              <span className="text-foreground font-medium">
                {proposal.abstainVotes.toString()}
              </span>
            </div>
            <div className="bg-muted h-2 rounded-full overflow-hidden">
              <div
                className="bg-text-subtle h-2 transition-all"
                style={{ width: `${abstainPercentage}%` }}
              />
            </div>
            <div className="text-center text-muted-foreground">
              {abstainPercentage.toFixed(1)}%
            </div>
          </div>
        </div>
        <div className="text-xs text-center text-muted-foreground">
          Total: {totalVotes.toString()} votes
        </div>
      </div>

      {/* Already Voted Message */}
      {hasVoted && (
        <div className="border-t border-border pt-6 space-y-3">
          <h4 className="text-sm font-bold text-foreground">YOUR VOTE</h4>
          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md border font-medium ${getVoteTypeStyles(userVote)}`}
            >
              <Check className="w-4 h-4" />
              <span>Voted {getVoteTypeText(userVote)}</span>
            </div>
            {userVotingPower && (
              <span className="text-xs text-muted-foreground">
                with {formatBigNumber(userVotingPower, undefined, true)} voting
                power
              </span>
            )}
          </div>
        </div>
      )}

      {/* Voting Buttons */}
      {canVote && (
        <div className="border-t border-border pt-6 space-y-4">
          <h4 className="text-sm font-bold text-foreground">CAST YOUR VOTE</h4>
          <div className="text-xs text-muted-foreground">
            Your voting power: {userVotingPower!}
          </div>
          <VoteButtons
            disabled={isVoting}
            isLoading={isLoading}
            onSelect={(vt) => handleVote(vt)}
          />
        </div>
      )}

      {/* Admin Actions */}
      {isPassed && (
        <div className="border-t border-border pt-6 space-y-4">
          <h4 className="text-sm font-bold text-foreground">
            PROPOSAL EXECUTION
          </h4>
          <div className="text-xs text-muted-foreground">
            Passed proposals can be executed immediately
          </div>
          <div className="flex gap-3">
            {onExecute && (
              <Button
                onClick={handleExecute}
                disabled={isLoading}
                variant="brand"
                size="sm"
              >
                EXECUTE PROPOSAL
              </Button>
            )}
          </div>
        </div>
      )}

      {/* No Voting Power Message */}
      {isConnected &&
        isActive &&
        !hasVoted &&
        (!userVotingPower || Number(userVotingPower) === 0) && (
          <div className="border-t border-border pt-6 text-center space-y-2">
            <div className="text-sm font-medium text-muted-foreground">
              NO VOTING POWER
            </div>
            <div className="text-xs text-muted-foreground">
              ◆ YOU NEED VOTING POWER TO PARTICIPATE IN GOVERNANCE ◆
            </div>
          </div>
        )}
    </Card>
  )
}
