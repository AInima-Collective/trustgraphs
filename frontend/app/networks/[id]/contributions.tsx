'use client'

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Address } from '@/components/Address'
import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { Markdown } from '@/components/Markdown'
import { SectionHeading } from '@/components/SectionHeading'
import {
  ContributionsRound,
  contributionsQueries,
} from '@/lib/contributions-api'
import { ClaimView } from '@/lib/contributions-view'
import { trustNetworkFor } from '@/lib/network-nav'
import { ContributionsNetwork } from '@/lib/types'
import { formatBigNumber } from '@/lib/utils'

import {
  RoundPhase,
  formatPoolAmount,
  useContributionsData,
} from './contributions-shared'

const dateLabel = (unixSeconds: string | bigint) =>
  new Date(Number(unixSeconds) * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

const timeDistance = (seconds: number) => {
  if (seconds < 60) return 'less than a minute'
  if (seconds < 3_600) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  if (seconds < 86_400) {
    const hours = Math.ceil(seconds / 3_600)
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const days = Math.ceil(seconds / 86_400)
  return `${days} day${days === 1 ? '' : 's'}`
}

const roundWindowLabel = (
  round: ContributionsRound | null,
  phase: RoundPhase,
  now: number | null
) => {
  if (!round || phase === 'unknown') return 'Round timing unavailable'
  if (phase === 'upcoming') {
    return now === null
      ? `Submissions open ${dateLabel(round.window.start)}`
      : `Submissions open in ${timeDistance(
          Math.max(Number(round.window.start) - now, 0)
        )}`
  }
  if (phase === 'open') {
    return now === null
      ? `Closes ${dateLabel(round.window.end)}`
      : `Closes in ${timeDistance(Math.max(Number(round.window.end) - now, 0))}`
  }
  return `Closed ${dateLabel(round.window.end)}`
}

const phaseLabel: Record<RoundPhase, string> = {
  upcoming: 'Upcoming',
  open: 'Open',
  settling: 'Scores being proven',
  claimable: 'Ready to claim',
  unknown: 'Status unavailable',
}

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
              <span className="text-warn">
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
              {score !== undefined ? formatBigNumber(score, 18) : 'Unavailable'}
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
                        ? 'text-success'
                        : contributor.response === 'reject'
                          ? 'text-error'
                          : 'text-muted-foreground'
                    }
                  >
                    {contributor.response === 'accept'
                      ? 'Accepted their share'
                      : contributor.response === 'reject'
                        ? 'Declined: their share is removed'
                        : contributor.isAttester
                          ? 'Submitted this contribution, so their share counts in full'
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
    roundAvailable,
    roundLoading,
    scoreByUid,
    claims,
    state,
    claimsLoading,
    tokenSymbol,
    tokenDecimals,
    phase,
  } = useContributionsData(network)

  const { name, link, about, criteria } = network
  const trustNetwork = trustNetworkFor(network)
  const [now, setNow] = useState<number | null>(null)

  // Keep the server and first client render identical, then switch the absolute fallback to the
  // useful relative window line after hydration.
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000))
  }, [])

  return (
    <div className="space-y-10">
      <header className="space-y-6">
        <div className="space-y-3 max-w-3xl">
          <h1 className="text-3xl font-bold">{name}</h1>
          {trustNetwork ? (
            <p className="text-sm text-text-muted">
              Rater influence is weighted by the{' '}
              <a
                href={`/networks/${trustNetwork.id}`}
                className="text-text underline underline-offset-4"
              >
                {trustNetwork.name} trust network
              </a>
              .
            </p>
          ) : (
            <p className="text-sm text-text-muted">
              Rater influence is weighted by this round&apos;s trust network.
            </p>
          )}
          <Markdown>{about}</Markdown>
          {criteria && <Markdown>{criteria}</Markdown>}
        </div>

        {link && (
          <p className="text-sm text-text">
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

        <div className="grid gap-6 border-y border-hairline py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0 space-y-2">
            <p className="tg-label">Funding pool</p>
            {round ? (
              <p className="tg-display text-4xl tabular-nums break-words">
                {formatPoolAmount(round.pool, tokenDecimals, tokenSymbol)}
              </p>
            ) : (
              <p className="text-sm text-warn">
                {roundLoading
                  ? 'Pool shown when round data arrives.'
                  : 'Pool unavailable while the round service is offline.'}
              </p>
            )}
            <p className="text-sm text-text-muted">
              {claimsLoading ? (
                'On-chain contribution totals are loading.'
              ) : (
                <>
                  {claims.length} contribution{claims.length === 1 ? '' : 's'}
                  <span aria-hidden="true"> · </span>
                  {state.valuations.size} rating
                  {state.valuations.size === 1 ? '' : 's'}
                </>
              )}
            </p>
          </div>

          <div className="space-y-3 sm:text-right">
            <div>
              <p className="tg-label">{phaseLabel[phase]}</p>
              <p className="text-sm text-text-muted">
                {roundWindowLabel(round, phase, now)}
              </p>
            </div>
            {phase === 'open' && (
              <ButtonLink
                href={`/networks/${network.id}/contribute`}
                variant="brand"
                size="lg"
                className="w-full sm:w-auto"
              >
                Submit contribution
              </ButtonLink>
            )}
            {phase === 'claimable' && (
              <ButtonLink
                href={`/networks/${network.id}/payout`}
                variant="brand"
                size="lg"
                className="w-full sm:w-auto"
              >
                Claim your share
              </ButtonLink>
            )}
            {phase === 'settling' && (
              <p className="text-sm text-text-muted" aria-live="polite">
                Scores are being proven. Claiming opens after a distribution is
                funded against the current score table.
              </p>
            )}
            {phase === 'upcoming' && (
              <p className="text-sm text-text-muted">
                Submissions open with the round window.
              </p>
            )}
            {phase === 'unknown' && (
              <p className="text-sm text-warn">
                {roundLoading
                  ? 'Submission status will appear with the round data.'
                  : 'Submission status is unavailable until the round service returns.'}
              </p>
            )}
          </div>
        </div>

        {!roundLoading && !roundAvailable && (
          <p className="text-sm text-warn">
            The round service is not reachable, so the window, pool, and scores
            are hidden. Contributions and ratings below still come straight from
            the chain.
          </p>
        )}
      </header>

      {/* Claims */}
      <div className="space-y-4">
        <SectionHeading>Contributions</SectionHeading>
        {claimsLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading contributions...
          </p>
        ) : claims.length === 0 ? (
          <Card type="outline" size="lg" className="text-center">
            <p className="text-muted-foreground">
              No contributions have been submitted yet. Be the first to share
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
