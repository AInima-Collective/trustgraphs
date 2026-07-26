'use client'

import type React from 'react'

interface VotingPowerCardProps {
  userVotingPower?: string
  proposalThreshold?: string
  canCreateProposal?: boolean
  formatVotingPower?: (amount: string) => string
  isLoading?: boolean
}

export function VotingPowerCard({
  userVotingPower,
  proposalThreshold,
  canCreateProposal = false,
  formatVotingPower = (amount) => amount,
  isLoading = false,
}: VotingPowerCardProps) {
  const hasVotingPower = userVotingPower && Number(userVotingPower) > 0

  return (
    <div className="border border-border bg-card p-6 rounded-md space-y-4">
      {/* Header */}
      <div>
        <div className="text-lg font-semibold mb-1">Your Voting Power</div>
        <div className="text-muted-foreground text-sm">
          Your ability to vote and create proposals
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-4">
          <div className="text-muted-foreground text-sm">
            Loading voting power...
          </div>
        </div>
      )}

      {/* Voting Power Display */}
      {!isLoading && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div
              className={`text-4xl font-mono ${
                hasVotingPower ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {userVotingPower ? formatVotingPower(userVotingPower) : '0'}
            </div>
            <div
              className={`text-sm font-medium ${
                hasVotingPower ? 'text-success' : 'text-muted-foreground'
              }`}
            >
              {hasVotingPower
                ? '✓ Eligible to vote on proposals'
                : '✗ No voting power'}
            </div>
          </div>

          {/* Progress Bar for Proposal Threshold */}
          {hasVotingPower && proposalThreshold && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Proposal creation threshold
                </span>
                <span
                  className={`font-medium ${
                    canCreateProposal ? 'text-success' : 'text-muted-foreground'
                  }`}
                >
                  {canCreateProposal ? '✓ Met' : '✗ Not met'}
                </span>
              </div>
              <div className="h-2 overflow-hidden bg-surface-2">
                <div
                  className={`h-2 transition-all ${
                    canCreateProposal ? 'bg-success' : 'bg-text-subtle'
                  }`}
                  style={{
                    width: `${Math.min(
                      (Number(userVotingPower) / Number(proposalThreshold)) *
                        100,
                      100
                    )}%`,
                  }}
                />
              </div>
              <div className="text-muted-foreground text-xs">
                {formatVotingPower(proposalThreshold)} required to create
                proposals
              </div>
            </div>
          )}
        </div>
      )}

      {/* No Voting Power Message */}
      {!isLoading && !hasVotingPower && (
        <div className="text-center py-4 border-t border-border">
          <div className="text-muted-foreground text-sm">
            Participate in attestations to earn governance rights
          </div>
        </div>
      )}
    </div>
  )
}
