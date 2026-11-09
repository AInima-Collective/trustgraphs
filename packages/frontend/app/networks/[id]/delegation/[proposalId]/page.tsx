'use client'

import { useParams, usePathname } from 'next/navigation'
import { useState } from 'react'
import { useAccount } from 'wagmi'

import { Address } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { Markdown } from '@/components/Markdown'
import { StateBadge, StateTone } from '@/components/ProposalStatus'
import { Textarea } from '@/components/Textarea'
import { VoteButtons } from '@/components/VoteButtons'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import { useTrustPoolProposal } from '@/hooks/useTrustPool'
import { formatBlockEta } from '@/lib/blocks'
import {
  SUPPORT_LABELS,
  governorStateLabel,
  governorStateTone,
  proposalBody,
  proposalTitle,
  shortProposalId,
} from '@/lib/trust-pool'
import { formatBigNumber, formatPercentage } from '@/lib/utils'

const SUPPORT_TONES: StateTone[] = ['negative', 'active', 'muted']

/** For / Against / Abstain as three labelled bars, each a share of `denominator`. */
const Tallies = ({
  forVotes,
  against,
  abstain,
  denominator,
  format,
}: {
  forVotes: bigint
  against: bigint
  abstain: bigint
  denominator: bigint
  format: (value: bigint) => string
}) => {
  const pct = (value: bigint) =>
    denominator > 0n ? (Number(value) / Number(denominator)) * 100 : 0
  const columns = [
    { label: 'For', value: forVotes, bar: 'bg-success' },
    { label: 'Against', value: against, bar: 'bg-error' },
    { label: 'Abstain', value: abstain, bar: 'bg-text-subtle' },
  ]
  return (
    <div className="grid grid-cols-3 gap-4 text-xs">
      {columns.map(({ label, value, bar }) => (
        <div key={label} className="space-y-2">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="text-foreground font-medium tabular-nums">
              {format(value)}
            </span>
          </div>
          <div className="h-2 overflow-hidden bg-surface-2">
            <div
              className={`${bar} h-2 transition-all`}
              style={{ width: `${pct(value)}%` }}
            />
          </div>
          <div className="text-center text-muted-foreground tabular-nums">
            {pct(value).toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  )
}

export default function DelegationProposalPage() {
  const params = useParams()
  const pathname = usePathname()
  const listRoute = pathname.split('/').slice(0, -1).join('/')
  const raw = String(params.proposalId)
  const proposalId = /^\d{1,78}$/.test(raw) ? BigInt(raw) : undefined

  const { isConnected } = useAccount()
  const { targetChain } = useApplicationChain()
  const [reason, setReason] = useState('')
  const {
    governor,
    governorName,
    symbol,
    decimals,
    blockNumber,
    proposal,
    memberVotes,
    isLoading,
    notFound,
    loadError,
    started,
    state,
    votes,
    quorum,
    poolVotes,
    entry,
    isLoadingEntry,
    weight,
    myVote,
    hasVoted,
    isVoting,
    vote,
    error,
  } = useTrustPoolProposal(proposalId)

  const amount = (value: bigint) => formatBigNumber(value, decimals)
  const explorer = targetChain.blockExplorers?.default.url

  if (proposalId === undefined || notFound) {
    return (
      <div className="space-y-6">
        <BreadcrumbRenderer
          fallback={{ title: 'delegation', route: listRoute }}
        />
        <div className="border border-border bg-muted/30 p-12 rounded-md text-center space-y-3">
          <div className="text-foreground text-sm font-medium">
            Proposal not found
          </div>
          <div className="text-muted-foreground text-xs">
            This network&apos;s governor has no proposal with this id.
          </div>
          <ButtonLink href={listRoute} variant="secondary">
            Back to proposals
          </ButtonLink>
        </div>
      </div>
    )
  }

  const pool = proposal?.pool
  const poolCast = pool
    ? BigInt(pool.for) + BigInt(pool.against) + BigInt(pool.abstain)
    : 0n
  // Gitcoin counts For and Abstain toward quorum (`COUNTING_MODE` quorum=for,abstain).
  const decisive = votes ? votes[1] + votes[2] : 0n
  const quorumReached = quorum !== undefined && decisive >= quorum
  const timing =
    proposal && blockNumber !== undefined
      ? state === 0
        ? `Opens ${formatBlockEta(BigInt(proposal.voteStart), blockNumber)}`
        : state === 1
          ? `Ends ${formatBlockEta(BigInt(proposal.voteEnd), blockNumber)}`
          : `Ended ${formatBlockEta(BigInt(proposal.voteEnd), blockNumber)}`
      : undefined

  return (
    <div className="space-y-6">
      <BreadcrumbRenderer
        fallback={{ title: 'delegation', route: listRoute }}
      />

      {(error || loadError) && (
        <div className="border border-destructive/50 bg-destructive/10 p-3 rounded-md">
          <div className="text-destructive text-sm font-medium">
            {error ?? 'Could not load this proposal from the indexer.'}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="text-center py-12">
          <div className="text-muted-foreground text-sm">
            Loading proposal...
          </div>
        </div>
      )}

      {proposal && (
        <Card type="primary" size="lg" className="space-y-6">
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold text-foreground">
                  {proposalTitle(proposal.description, proposal.proposalId)}
                </h2>
                <div className="text-xs text-muted-foreground">
                  Proposal {shortProposalId(proposal.proposalId)} on{' '}
                  {governor && explorer ? (
                    <a
                      href={`${explorer}/address/${governor}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4 hover:text-text"
                    >
                      {governorName ?? 'the governor'}
                    </a>
                  ) : (
                    (governorName ?? 'the governor')
                  )}
                  {timing && <> · {timing}</>}
                </div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium">Proposer:</span>{' '}
                  <Address
                    textClassName="text-xs"
                    address={proposal.proposer}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StateBadge
                  tone={governorStateTone(state)}
                  label={governorStateLabel(state)}
                />
              </div>
            </div>

            {/* Governor descriptions are long-form markdown: keep their headings at body scale. */}
            <Markdown className="gap-3 text-sm leading-relaxed text-foreground/80 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
              {proposalBody(proposal.description)}
            </Markdown>
          </div>

          {/* This network's share of the vote. */}
          <div className="border-t border-border pt-6 space-y-4">
            <h3 className="text-sm font-bold text-foreground">
              This network&apos;s vote
            </h3>
            <div className="text-xs text-muted-foreground">
              {poolVotes === undefined
                ? '...'
                : `${amount(poolVotes)} ${symbol} ${
                    started
                      ? 'delegated to this network when voting opened'
                      : 'delegated to this network so far. The amount is fixed when voting opens'
                  }`}
            </div>
            {started && pool && poolVotes !== undefined && (
              <>
                <Tallies
                  forVotes={BigInt(pool.for)}
                  against={BigInt(pool.against)}
                  abstain={BigInt(pool.abstain)}
                  denominator={poolVotes}
                  format={amount}
                />
                <div className="text-xs text-muted-foreground">
                  {pool.voters} member{pool.voters === 1 ? '' : 's'} voted
                  {poolVotes > 0n &&
                    ` · ${formatPercentage((Number(poolCast) / Number(poolVotes)) * 100)} of the network's votes cast`}
                </div>
              </>
            )}
          </div>

          {/* Everyone's votes on the governor. */}
          <div className="border-t border-border pt-6 space-y-4">
            <h3 className="text-sm font-bold text-foreground">
              Overall results
            </h3>
            {votes && (
              <Tallies
                forVotes={votes[1]}
                against={votes[0]}
                abstain={votes[2]}
                denominator={votes[0] + votes[1] + votes[2]}
                format={amount}
              />
            )}
            {quorum !== undefined && quorum > 0n && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">
                    Quorum: {amount(decisive)} of {amount(quorum)} {symbol}{' '}
                    needed (for and abstain count)
                  </span>
                  <span
                    className={
                      quorumReached
                        ? 'text-success font-medium'
                        : 'text-muted-foreground'
                    }
                  >
                    {quorumReached
                      ? 'Reached'
                      : state === 0 || state === 1
                        ? 'Not reached yet'
                        : 'Not reached'}
                  </span>
                </div>
                <div className="h-2 overflow-hidden bg-surface-2">
                  <div
                    className={`h-2 transition-all ${quorumReached ? 'bg-success' : 'bg-text-subtle'}`}
                    style={{
                      width: `${Math.min(100, (Number(decisive) / Number(quorum)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {memberVotes.length > 0 && (
            <div className="border-t border-border pt-6 space-y-3">
              <h3 className="text-sm font-bold text-foreground">
                Members&apos; votes ({memberVotes.length})
              </h3>
              <div className="space-y-2">
                {memberVotes.map((memberVote) => (
                  <div
                    key={memberVote.voter}
                    className="flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <Address
                        textClassName="text-xs"
                        address={memberVote.voter}
                      />
                      {memberVote.reason && (
                        <div className="max-w-lg text-muted-foreground">
                          “{memberVote.reason}”
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground tabular-nums">
                        {amount(BigInt(memberVote.weight))}
                      </span>
                      <StateBadge
                        tone={SUPPORT_TONES[memberVote.support] ?? 'muted'}
                        label={SUPPORT_LABELS[memberVote.support] ?? 'Unknown'}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasVoted && (
            <div className="border-t border-border pt-6 space-y-3">
              <h3 className="text-sm font-bold text-foreground">Your vote</h3>
              <div className="text-sm">
                {myVote ? (
                  <>
                    You voted{' '}
                    <StateBadge
                      tone={SUPPORT_TONES[myVote.support] ?? 'muted'}
                      label={SUPPORT_LABELS[myVote.support] ?? 'Unknown'}
                    />{' '}
                    with {amount(BigInt(myVote.weight))} {symbol}.
                  </>
                ) : (
                  'You voted. It will show here once the indexer catches up.'
                )}
              </div>
            </div>
          )}

          {!hasVoted && (state === 0 || state === 1) && (
            <div className="border-t border-border pt-6 space-y-4">
              <h3 className="text-sm font-bold text-foreground">
                Cast your vote
              </h3>
              {state === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Voting opens {timing?.replace(/^Opens /, '')}. Your share is
                  set by your trust score in this network at that block.
                </p>
              ) : !isConnected ? (
                <p className="text-xs text-muted-foreground">
                  Connect a wallet to vote with your share of this network.
                </p>
              ) : isLoadingEntry ? (
                <p className="text-xs text-muted-foreground">
                  Checking your trust score...
                </p>
              ) : !entry || weight === undefined || weight === 0n ? (
                <p className="text-xs text-muted-foreground">
                  You had no trust score in this network when this vote opened,
                  so you have no share of its votes.
                </p>
              ) : (
                <>
                  <div className="text-xs text-muted-foreground">
                    Your share: {amount(weight)} {symbol}
                    {poolVotes !== undefined &&
                      poolVotes > 0n &&
                      ` (${formatPercentage((Number(weight) / Number(poolVotes)) * 100)} of this network's votes)`}
                  </div>
                  <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason (optional, public)"
                    rows={2}
                    maxLength={1000}
                  />
                  <VoteButtons
                    disabled={isVoting}
                    isLoading={isVoting}
                    onSelect={(support) => void vote(support, reason)}
                  />
                </>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
