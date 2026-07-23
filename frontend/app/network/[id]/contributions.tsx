'use client'

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { Address } from '@/components/Address'
import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { Markdown } from '@/components/Markdown'
import { StatisticCard } from '@/components/StatisticCard'
import { contributionsQueries } from '@/lib/contributions-api'
import { ClaimView } from '@/lib/contributions-view'
import { ContributionsNetwork } from '@/lib/types'
import { formatBigNumber } from '@/lib/utils'

import {
  ContributionsNav,
  formatPoolAmount,
  roundStatusLabel,
  useContributionsData,
} from './contributions-shared'

const dateLabel = (unixSeconds: string | bigint) =>
  new Date(Number(unixSeconds) * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

/**
 * One claim, expandable to its contributors and ratings, with plain-language notes on why a
 * rating counted less (or not at all). Score comes from the indexer's audited recompute.
 */
const ClaimCard = ({
  claim,
  network,
  score,
}: {
  claim: ClaimView
  network: ContributionsNetwork
  score: string | undefined
}) => {
  const [expanded, setExpanded] = useState(false)

  // The audit view for this claim: every rating incl. the filtered ones, with reasons.
  const { data: audit } = useQuery({
    ...contributionsQueries.score(network.contracts.merkleSnapshot, claim.uid),
    enabled: expanded,
  })

  // Merge audit info (filter reasons need reputation, so they come from the indexer) into the
  // on-chain ratings; the self-rating rule is known locally either way.
  const auditByRater = new Map(
    (audit?.valuations ?? []).map((v) => [v.rater.toLowerCase(), v])
  )

  return (
    <Card type="outline" size="lg" className="space-y-4">
      <button
        className="w-full flex flex-row items-start justify-between gap-4 text-left cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="space-y-1 min-w-0">
          <div className="font-bold truncate">
            {claim.title || 'Untitled contribution'}
          </div>
          <div className="text-sm text-muted-foreground flex flex-row items-center gap-2 flex-wrap">
            <span>
              Submitted by{' '}
              <Address address={claim.attester} displayMode="truncated" />
            </span>
            <span>·</span>
            <span>{dateLabel(claim.timestamp)}</span>
            {claim.inWindow === false && (
              <span className="text-yellow-700">
                · Outside the round window, so it won&apos;t be funded this
                round
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-row items-center gap-3 shrink-0">
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Community score</div>
            <div className="font-mono">
              {score !== undefined ? formatBigNumber(score, 18) : '—'}
            </div>
          </div>
          {expanded ? (
            <ChevronUp className="w-4 h-4 mt-1" />
          ) : (
            <ChevronDown className="w-4 h-4 mt-1" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-5 border-t border-border pt-4">
          {claim.uri && (
            <a
              href={claim.uri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View the work
            </a>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-bold">Who did the work</h3>
            <div className="space-y-1.5">
              {claim.contributors.map((contributor) => (
                <div
                  key={contributor.account}
                  className="flex flex-row items-center justify-between gap-4 text-sm flex-wrap"
                >
                  <span className="flex flex-row items-center gap-2">
                    <Address
                      address={contributor.account}
                      displayMode="truncated"
                    />
                    <span className="text-muted-foreground">
                      {contributor.sharePct}% of this contribution
                    </span>
                  </span>
                  <span
                    className={
                      contributor.response === 'accept'
                        ? 'text-green-700'
                        : contributor.response === 'reject'
                          ? 'text-red-700'
                          : 'text-muted-foreground'
                    }
                  >
                    {contributor.response === 'accept'
                      ? 'Accepted their share'
                      : contributor.response === 'reject'
                        ? 'Declined: their share is removed'
                        : contributor.isAttester
                          ? 'Submitted this claim, so their share counts in full'
                          : 'No answer yet: their share counts at half weight until they accept'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold">Ratings</h3>
            {claim.valuations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No one has rated this contribution yet.
              </p>
            ) : (
              <div className="space-y-1.5">
                {claim.valuations.map((valuation) => {
                  const auditEntry = auditByRater.get(valuation.rater)
                  const note = valuation.isSelf
                    ? "This rating didn't count: you can't rate your own contribution"
                    : auditEntry?.counted === false
                      ? auditEntry.reason === 'belowMinRep'
                        ? "Didn't count: this rater isn't established enough in the trust graph yet"
                        : "Didn't count"
                      : auditEntry?.collaboratorDiscount
                        ? 'Counted at half weight: this rater worked with the contributors on another claim this round'
                        : null
                  return (
                    <div
                      key={valuation.rater}
                      className="flex flex-row items-center justify-between gap-4 text-sm flex-wrap"
                    >
                      <span className="flex flex-row items-center gap-2">
                        <Address
                          address={valuation.rater}
                          displayMode="truncated"
                        />
                        <span className="font-mono">{valuation.score}/100</span>
                      </span>
                      {note && (
                        <span className="text-muted-foreground">{note}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Every rating is weighted by how established the rater is in the
              trust graph, and each rater&apos;s ratings share one budget: the
              more things they rate highly, the thinner each rating spreads.
            </p>
          </div>
        </div>
      )}
    </Card>
  )
}

/**
 * The round view for a contributions instance: round status, the funding pool, and every
 * claimed contribution with its live community score.
 */
export const ContributionsNetworkPage = ({
  network,
}: {
  network: ContributionsNetwork
}) => {
  const {
    round,
    roundLoading,
    roundAvailable,
    scoreByUid,
    claims,
    state,
    claimsLoading,
    tokenSymbol,
    tokenDecimals,
  } = useContributionsData(network)

  const { name, link, about, criteria } = network

  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="space-y-4">
        <h1 className="text-3xl font-bold">{name}</h1>
        {link && (
          <p className="text-sm text-gray-800">
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
        <Markdown>{about}</Markdown>
        {criteria && <Markdown>{criteria}</Markdown>}
      </div>

      <ContributionsNav network={network} />

      {/* Round status */}
      <div className="flex flex-row gap-4 flex-wrap">
        <StatisticCard
          title="ROUND STATUS"
          tooltip="Whether the round is accepting contributions and ratings, wrapping up, or already paid out."
          value={roundLoading ? '...' : roundStatusLabel(round?.status ?? null)}
        />
        <StatisticCard
          title="ROUND WINDOW"
          tooltip="Contributions submitted inside this window count for this round's funding."
          value={
            round
              ? `${dateLabel(round.window.start)} – ${dateLabel(round.window.end)}`
              : '—'
          }
        />
        <StatisticCard
          title="FUNDING POOL"
          tooltip="The pool that gets split across contributions by their final proven scores."
          value={
            round
              ? formatPoolAmount(round.pool, tokenDecimals, tokenSymbol)
              : '—'
          }
        />
        <StatisticCard
          title="CONTRIBUTIONS"
          tooltip="Claimed contributions currently live on-chain."
          value={claimsLoading ? '...' : String(claims.length)}
        />
        <StatisticCard
          title="RATINGS"
          tooltip="Ratings currently live on-chain (one per person per contribution; new ratings replace old ones)."
          value={claimsLoading ? '...' : String(state.valuations.size)}
        />
      </div>

      {!roundLoading && !roundAvailable && (
        <p className="text-sm text-yellow-700">
          The round summary service isn&apos;t reachable yet, so the window,
          pool, and scores are hidden. Everything below comes straight from the
          chain.
        </p>
      )}

      {/* Actions */}
      <div className="flex flex-row gap-3 flex-wrap">
        <ButtonLink href={`/network/${network.id}/contribute`} variant="brand">
          Claim a contribution
        </ButtonLink>
        <ButtonLink href={`/network/${network.id}/rate`} variant="secondary">
          Rate contributions
        </ButtonLink>
        <ButtonLink href={`/network/${network.id}/respond`} variant="secondary">
          Respond to being named
        </ButtonLink>
        <ButtonLink href={`/network/${network.id}/payout`} variant="secondary">
          Payouts
        </ButtonLink>
      </div>

      {/* Claims */}
      <div className="space-y-4">
        <h2 className="font-bold">CONTRIBUTIONS</h2>
        {claimsLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading contributions...
          </p>
        ) : claims.length === 0 ? (
          <Card type="outline" size="lg" className="text-center">
            <p className="text-muted-foreground">
              No contributions have been claimed yet. Be the first: claim the
              work you or others did.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {claims.map((claim) => (
              <ClaimCard
                key={claim.uid}
                claim={claim}
                network={network}
                score={scoreByUid.get(claim.uid)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
