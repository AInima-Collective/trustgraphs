'use client'

import { useParams, usePathname } from 'next/navigation'
import type React from 'react'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { ButtonLink } from '@/components/Button'
import { ProposalCard } from '@/components/ProposalCard'
import { VoteType, useGovernance } from '@/hooks/useGovernance'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { ponderQueryFns } from '@/queries/ponder'

export default function ProposalPage() {
  const params = useParams()
  const pathname = usePathname()
  const proposalId = Number(params.proposalId)
  const listRoute = pathname.split('/').slice(0, -1).join('/')

  const {
    isAnyActionLoading,
    isLoadingProposals,
    isLoadingModule,
    error,
    currentBlockNumber,
    userEntriesByRoot,
    castVote,
    executeProposal,
    getProposal,
    getUserVote,
    getProposalStateText,
    merkleGovAddress,
  } = useGovernance()

  const proposal = getProposal(proposalId)
  const userVote = getUserVote(proposalId)
  const proposalVotingPower = proposal
    ? userEntriesByRoot.get(proposal.core.merkleRoot)
    : undefined

  // Everyone who voted on this proposal, newest first (already indexed).
  const { data: votes = [] } = usePonderQuery({
    queryFn: ponderQueryFns.getGovModuleVotes({
      address: merkleGovAddress,
      proposalId: BigInt(proposalId),
    }),
    enabled: !!merkleGovAddress && Number.isFinite(proposalId),
  })

  const isLoading = isLoadingModule || isLoadingProposals

  return (
    <div className="space-y-6">
      <BreadcrumbRenderer
        fallback={{
          title: 'proposals',
          route: listRoute,
        }}
      />

      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 rounded-md">
          <div className="text-destructive text-sm font-medium">{error}</div>
        </div>
      )}

      {isLoading && (
        <div className="text-center py-12">
          <div className="text-muted-foreground text-sm">
            Loading proposal...
          </div>
        </div>
      )}

      {!isLoading && proposal && (
        <ProposalCard
          proposal={proposal.core}
          actions={proposal.actions}
          votes={votes}
          quorum={Number(proposal.core.quorumFraction) / 1e18}
          currentBlockNumber={currentBlockNumber}
          userVotingPower={proposalVotingPower?.value}
          userVote={userVote?.voteType as VoteType | undefined}
          userVoteDelegated={userVote?.delegated}
          userVoteDelegate={userVote?.delegate}
          userVoteReason={userVote?.reason}
          userVoteOverridden={userVote?.overridden}
          onVote={castVote}
          onExecute={executeProposal}
          isLoading={isAnyActionLoading}
          getProposalStateText={getProposalStateText}
        />
      )}

      {!isLoading && !proposal && (
        <div className="border border-border bg-muted/30 p-12 rounded-md text-center space-y-3">
          <div className="text-foreground text-sm font-medium">
            Proposal not found
          </div>
          <div className="text-muted-foreground text-xs">
            This proposal may not exist or has been removed
          </div>
          <ButtonLink href={listRoute} variant="secondary">
            Back to proposals
          </ButtonLink>
        </div>
      )}
    </div>
  )
}
