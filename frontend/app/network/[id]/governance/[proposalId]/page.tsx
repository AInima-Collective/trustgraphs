'use client'

import { useParams, usePathname, useRouter } from 'next/navigation'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { ProposalCard } from '@/components/ProposalCard'
import { VoteType, useGovernance } from '@/hooks/useGovernance'

export default function ProposalPage() {
  const params = useParams()
  const router = useRouter()
  const pathname = usePathname()
  const proposalId = Number(params.proposalId)

  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const {
    isAnyActionLoading,
    isLoadingProposals,
    isLoadingModule,
    error,
    userVotingPower,
    castVote,
    queueProposal,
    executeProposal,
    getProposal,
    getUserVote,
    getProposalStateText,
  } = useGovernance()

  const proposal = getProposal(proposalId)
  const userVote = getUserVote(proposalId)

  // Redirect if proposal not found after loading
  useEffect(() => {
    if (!isLoadingProposals && !isLoadingModule && !proposal) {
      router.push('../')
    }
  }, [isLoadingProposals, isLoadingModule, proposal, router])

  const handleVote = useCallback(
    async (id: number, voteType: VoteType) => {
      setSuccessMessage(null)
      const hash = await castVote(id, voteType)
      if (hash) {
        const voteText =
          voteType === VoteType.Yes
            ? 'FOR'
            : voteType === VoteType.No
              ? 'AGAINST'
              : 'ABSTAIN'
        setSuccessMessage(`Vote cast ${voteText}! Transaction: ${hash}`)
        setTimeout(() => setSuccessMessage(null), 5000)
      }
      return hash
    },
    [castVote]
  )

  const handleQueue = useCallback(
    async (id: number) => {
      setSuccessMessage(null)
      const hash = await queueProposal(id)
      if (hash) {
        setSuccessMessage(`Proposal queued! Transaction: ${hash}`)
        setTimeout(() => setSuccessMessage(null), 5000)
      }
      return hash
    },
    [queueProposal]
  )

  const handleExecute = useCallback(
    async (id: number) => {
      setSuccessMessage(null)
      const hash = await executeProposal(id)
      if (hash) {
        setSuccessMessage(`Proposal executed! Transaction: ${hash}`)
        setTimeout(() => setSuccessMessage(null), 5000)
      }
      return hash
    },
    [executeProposal]
  )

  const isLoading = isLoadingModule || isLoadingProposals

  return (
    <div className="space-y-6">
      <BreadcrumbRenderer
        fallback={{
          title: 'proposals',
          route: pathname.split('/').slice(0, -1).join('/'),
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-4xl font-bold">Proposal #{proposalId}</h1>
      </div>

      {/* Success Message */}
      {successMessage && (
        <div className="border border-green-600 bg-green-50 p-3 rounded-md">
          <div className="text-green-700 text-sm font-medium">
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

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-12">
          <div className="text-muted-foreground text-sm">
            Loading proposal...
          </div>
        </div>
      )}

      {/* Proposal Content */}
      {!isLoading && proposal && (
        <ProposalCard
          proposal={proposal.core}
          actions={proposal.actions}
          userVotingPower={userVotingPower?.value}
          userVote={userVote?.voteType as VoteType | undefined}
          onVote={handleVote}
          onQueue={handleQueue}
          onExecute={handleExecute}
          isLoading={isAnyActionLoading}
          getProposalStateText={getProposalStateText}
        />
      )}

      {/* Not Found */}
      {!isLoading && !proposal && (
        <div className="border border-border bg-muted/30 p-12 rounded-md text-center space-y-3">
          <div className="text-foreground text-sm font-medium">
            Proposal not found
          </div>
          <div className="text-muted-foreground text-xs">
            This proposal may not exist or has been removed
          </div>
          <Button onClick={() => router.push('../')} variant="secondary">
            Back to Proposals
          </Button>
        </div>
      )}
    </div>
  )
}
