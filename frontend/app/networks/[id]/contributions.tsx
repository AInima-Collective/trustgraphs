'use client'

import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Hex, encodeAbiParameters, keccak256, zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { Address } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { NetworkHeader } from '@/components/NetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import { Slider } from '@/components/Slider'
import { useAttestation } from '@/hooks/useAttestation'
import { actorKey, computeContributions } from '@/lib/contributions'
import {
  ContributionProjection,
  projectContributionPool,
} from '@/lib/contributions/projection'
import {
  ContributionsRound,
  contributionsQueries,
} from '@/lib/contributions-api'
import { NOMINEE_RESPONSE_COPY } from '@/lib/contributions-copy'
import {
  ClaimView,
  RatingPowerEntry,
  ratingPowerPreview,
} from '@/lib/contributions-view'
import {
  contributionsTabs,
  trustGraphTabs,
  trustNetworkFor,
} from '@/lib/network-nav'
import { ContributionsNetwork, Network } from '@/lib/types'

import {
  RoundPhase,
  formatContributionScore,
  formatPoolAmount,
  useContributionsData,
} from './contributions-shared'
import {
  OptimisticContribution,
  SubmitContributionModal,
  matchesOptimisticContribution,
} from './SubmitContributionModal'

type FeedSort = 'unrated' | 'newest' | 'top'
type ResponseChoice = 'accept' | 'reject'

const formatBasisPoints = (basisPoints: number) => {
  const whole = Math.floor(basisPoints / 100)
  const fraction = String(basisPoints % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}%` : `${whole}%`
}

const basisPointsWidth = (basisPoints: number) =>
  `${Math.floor(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, '0')}%`

const previewTone = (index: number) =>
  ['bg-ink', 'bg-text-muted', 'bg-text-subtle'][index % 3]

const projectionWidth = (basisPoints: bigint) =>
  `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, '0')}%`

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

const PoolSplitBar = ({
  claims,
  projections,
  tokenDecimals,
  tokenSymbol,
  phase,
  previewUnavailable,
}: {
  claims: ClaimView[]
  projections: ContributionProjection[]
  tokenDecimals: number
  tokenSymbol: string
  phase: RoundPhase
  previewUnavailable: boolean
}) => {
  const titleByUid = new Map(
    claims.map((claim) => [
      claim.uid.toLowerCase(),
      claim.title || 'Untitled contribution',
    ])
  )
  if (projections.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        The pool split is unavailable until proven scores are present.
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <div
        className="flex h-5 w-full overflow-hidden border border-hairline-strong bg-surface-2"
        aria-label="Projected pool split"
      >
        {projections.map((projection, index) => (
          <div
            key={projection.claimUid}
            className={`${previewTone(index)} h-full border-r border-surface transition-[width] duration-200 last:border-r-0 motion-reduce:transition-none`}
            style={{
              width: projectionWidth(projection.shareBps),
              backgroundImage:
                index % 3 === 1
                  ? 'repeating-linear-gradient(135deg, transparent 0, transparent 4px, var(--surface) 4px, var(--surface) 5px)'
                  : index % 3 === 2
                    ? 'repeating-linear-gradient(45deg, transparent 0, transparent 2px, var(--surface) 2px, var(--surface) 3px)'
                    : undefined,
            }}
            title={`${titleByUid.get(projection.claimUid)}: ${formatPoolAmount(projection.payout, tokenDecimals, tokenSymbol)}`}
          />
        ))}
      </div>
      <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
        {projections.map((projection, index) => (
          <div
            key={projection.claimUid}
            className="flex min-w-0 items-start gap-2 text-xs"
          >
            <span
              aria-hidden="true"
              className={`${previewTone(index)} mt-0.5 h-3 w-3 shrink-0 border border-hairline-strong`}
            />
            <span className="min-w-0">
              <span className="block truncate text-text">
                {titleByUid.get(projection.claimUid)}
              </span>
              <span className="text-text-muted">
                ~
                {formatPoolAmount(
                  projection.payout,
                  tokenDecimals,
                  tokenSymbol
                )}
              </span>
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-text-muted">
        {phase === 'claimable'
          ? 'This is the final score split. '
          : 'If the round settled now: this is how the pool would split. '}
        <a
          href="/faq#then-what-does-the-zero-knowledge-proof-hide"
          className="underline underline-offset-4"
        >
          Final scores are proven, not administered.
        </a>
      </p>
      {previewUnavailable && (
        <p className="text-xs text-warn">
          A live re-split needs the round parameters and trust edges. The last
          proven split stays visible.
        </p>
      )}
    </div>
  )
}

/**
 * One claim, expandable to its contributors and ratings, with plain-language notes on why a
 * rating counted less (or not at all). Score comes from the indexer's audited recompute.
 */
const ClaimCard = ({
  claim,
  network,
  score,
  projection,
  projectionIsPreview,
  tokenDecimals,
  tokenSymbol,
  connectedAddress,
  rating,
  chainRating,
  draft,
  previewEntry,
  isSubmitted,
  isPending,
  responseOverride,
  respondingChoice,
  responseBusy,
  onRatingChange,
  onRespond,
}: {
  claim: ClaimView
  network: ContributionsNetwork
  score: string | undefined
  projection?: ContributionProjection
  projectionIsPreview: boolean
  tokenDecimals: number
  tokenSymbol: string
  connectedAddress?: Hex
  rating?: number
  chainRating?: number
  draft?: number
  previewEntry?: RatingPowerEntry
  isSubmitted: boolean
  isPending?: boolean
  responseOverride?: ResponseChoice
  respondingChoice?: ResponseChoice | null
  responseBusy: boolean
  onRatingChange: (value: number) => void
  onRespond: (response: ResponseChoice) => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const isMine =
    !!connectedAddress &&
    (claim.attester.toLowerCase() === connectedAddress.toLowerCase() ||
      claim.contributors.some(
        (contributor) =>
          contributor.account.toLowerCase() === connectedAddress.toLowerCase()
      ))
  const auditId = `contribution-audit-${claim.uid}`
  const myContributor = connectedAddress
    ? claim.contributors.find(
        (contributor) =>
          contributor.account.toLowerCase() === connectedAddress.toLowerCase()
      )
    : undefined
  const myResponse = responseOverride ?? myContributor?.response

  // The audit view for this claim: every rating incl. the filtered ones, with reasons.
  const { data: audit } = useQuery({
    ...contributionsQueries.score(network.contracts.merkleSnapshot, claim.uid),
    enabled: expanded && !isPending,
  })

  // Merge audit info (filter reasons need reputation, so they come from the indexer) into the
  // on-chain ratings; the self-rating rule is known locally either way.
  const auditByRater = new Map(
    (audit?.valuations ?? []).map((v) => [v.rater.toLowerCase(), v])
  )

  return (
    <Card
      id={`contribution-${claim.uid}`}
      type="outline"
      size="lg"
      className="scroll-mt-6 space-y-4 px-4 sm:px-6"
    >
      <button
        className="grid min-h-11 w-full grid-cols-1 items-start gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink min-[420px]:grid-cols-[minmax(0,1fr)_auto]"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={auditId}
      >
        <div className="space-y-1 min-w-0">
          <div className="break-words font-bold">
            {claim.title || 'Untitled contribution'}
            {isPending && (
              <span className="ml-2 inline-block border border-hairline-strong px-1.5 py-0.5 align-middle text-[10px] font-normal uppercase tracking-wider text-text-muted">
                Pending indexing
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground flex flex-row items-center gap-2 flex-wrap">
            <span>
              Submitted by{' '}
              <Address
                address={claim.attester}
                displayMode="truncated"
                link={false}
                showCopyIcon={false}
              />
            </span>
            <span className="hidden min-[420px]:inline">·</span>
            <span>{dateLabel(claim.timestamp)}</span>
            {claim.inWindow === false && (
              <span className="text-warn">
                · Outside the round window, so it won&apos;t be funded this
                round
              </span>
            )}
          </div>
        </div>
        <div className="flex w-full flex-row items-start justify-between gap-3 min-[420px]:w-auto min-[420px]:shrink-0 min-[420px]:justify-start">
          <div className="text-left min-[420px]:max-w-[10rem] min-[420px]:text-right">
            <div className="text-xs text-muted-foreground">
              {projectionIsPreview ? 'Preview score' : 'Community score'}
            </div>
            <div className="font-mono">
              {isPending
                ? 'Pending'
                : score !== undefined
                  ? formatContributionScore(score)
                  : 'Unavailable'}
            </div>
            {projection ? (
              <p className="mt-1 text-xs text-text-muted">
                ~
                {formatPoolAmount(
                  projection.payout,
                  tokenDecimals,
                  tokenSymbol
                )}{' '}
                if the round settled now
              </p>
            ) : (
              <p className="mt-1 text-xs text-text-muted">
                Projected payout unavailable.
              </p>
            )}
          </div>
          {expanded ? (
            <ChevronUp className="w-4 h-4 mt-1" />
          ) : (
            <ChevronDown className="w-4 h-4 mt-1" />
          )}
        </div>
      </button>

      {connectedAddress &&
        (isMine ? (
          <p className="border-t border-hairline pt-3 text-xs text-text-subtle">
            You can&apos;t rate your own contribution because that rating would
            not count.
          </p>
        ) : (
          <div className="space-y-2 border-t border-hairline pt-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="tg-label">Your rating</p>
                <p className="text-xs text-text-muted">
                  {draft !== undefined && draft !== chainRating
                    ? isSubmitted
                      ? 'Saved. Waiting for the chain record.'
                      : 'Not saved yet'
                    : chainRating !== undefined
                      ? `Saved at ${chainRating} out of 100`
                      : 'Not rated yet. Drag or use the arrow keys.'}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-lg tabular-nums">
                  {rating ?? 0}/100
                </p>
                {previewEntry && !previewEntry.doesNotCount && (
                  <p className="text-xs text-text-muted">
                    {formatBasisPoints(previewEntry.shareBps)} of your voice
                  </p>
                )}
              </div>
            </div>
            <Slider
              value={rating ?? 0}
              min={0}
              max={100}
              ariaLabel={`Your rating for ${claim.title || 'Untitled contribution'}`}
              ariaValueText={`${rating ?? 0} out of 100`}
              onValueChange={onRatingChange}
            />
            {previewEntry?.reducedWeight && (
              <p className="text-xs text-text-muted">
                This rating counts at half weight because you worked with these
                contributors elsewhere in the round.
              </p>
            )}
          </div>
        ))}

      {myContributor && !myContributor.isAttester && (
        <div className="space-y-3 border-t border-hairline pt-3">
          <div className="space-y-1">
            <p className="tg-label">Your contributor share</p>
            <p className="text-sm text-text-muted">
              {myContributor.sharePct}% of this contribution
            </p>
            {myResponse === 'accept' ? (
              <p className="text-sm text-success">
                Accepted: you will receive this share.
              </p>
            ) : myResponse === 'reject' ? (
              <p className="text-sm text-error">
                Declined: this share is removed.
              </p>
            ) : (
              <p className="text-sm text-text-muted">{NOMINEE_RESPONSE_COPY}</p>
            )}
          </div>
          {myResponse === 'none' && (
            <div className="flex flex-col gap-2 min-[360px]:flex-row">
              <Button
                type="button"
                variant="brand"
                size="lg"
                onClick={() => onRespond('accept')}
                disabled={responseBusy}
                className="w-full min-[360px]:w-auto"
              >
                {respondingChoice === 'accept' ? 'Accepting' : 'Accept share'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => onRespond('reject')}
                disabled={responseBusy}
                className="w-full min-[360px]:w-auto"
              >
                {respondingChoice === 'reject' ? 'Declining' : 'Decline share'}
              </Button>
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div id={auditId} className="space-y-5 border-t border-border pt-4">
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
              {claim.contributors.map((contributor) => {
                const isConnectedContributor =
                  !!connectedAddress &&
                  contributor.account.toLowerCase() ===
                    connectedAddress.toLowerCase()
                const response = isConnectedContributor
                  ? (responseOverride ?? contributor.response)
                  : contributor.response
                return (
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
                        response === 'accept'
                          ? 'text-success'
                          : response === 'reject'
                            ? 'text-error'
                            : 'text-muted-foreground'
                      }
                    >
                      {response === 'accept'
                        ? 'Accepted their share'
                        : response === 'reject'
                          ? 'Declined: their share is removed'
                          : contributor.isAttester
                            ? 'Submitted this contribution, so their share counts in full'
                            : NOMINEE_RESPONSE_COPY}
                    </span>
                  </div>
                )
              })}
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
                        ? 'Counted at half weight: this rater worked with the contributors on another contribution this round'
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
  hostNetwork,
}: {
  network: ContributionsNetwork
  hostNetwork?: Network
}) => {
  const { address: connectedAddress, isConnected } = useAccount()
  const { createAttestation, createAttestations, isCreating } = useAttestation()
  const {
    round,
    roundAvailable,
    roundLoading,
    scoreByUid,
    scoresAvailable,
    claims,
    state,
    records,
    trustEdges,
    claimsLoading,
    tokenSymbol,
    tokenDecimals,
    phase,
    claimSchema,
    responseSchema,
    valuationSchema,
  } = useContributionsData(network)

  const trustNetwork = hostNetwork ?? trustNetworkFor(network)
  const [now, setNow] = useState<number | null>(null)
  const [feedSort, setFeedSort] = useState<FeedSort>('unrated')
  const [drafts, setDrafts] = useState<Map<string, number>>(new Map())
  const [submittedDrafts, setSubmittedDrafts] = useState<Set<string>>(new Set())
  const [submitOpen, setSubmitOpen] = useState(false)
  const [optimisticContribution, setOptimisticContribution] =
    useState<OptimisticContribution | null>(null)
  const [pendingResponse, setPendingResponse] = useState<{
    claimUid: string
    response: ResponseChoice
  } | null>(null)
  const [responseOverrides, setResponseOverrides] = useState<
    Map<string, ResponseChoice>
  >(new Map())

  const optimisticIsIndexed =
    optimisticContribution !== null &&
    claims.some((claim) =>
      matchesOptimisticContribution(claim, optimisticContribution)
    )
  const pendingContribution = optimisticIsIndexed
    ? null
    : optimisticContribution

  const connectedContributorFor = (claim: ClaimView) =>
    connectedAddress
      ? claim.contributors.find(
          (contributor) =>
            contributor.account.toLowerCase() === connectedAddress.toLowerCase()
        )
      : undefined
  const responseFor = (claim: ClaimView) =>
    responseOverrides.get(claim.uid) ?? connectedContributorFor(claim)?.response
  const unansweredClaims = connectedAddress
    ? claims.filter((claim) => {
        const contributor = connectedContributorFor(claim)
        return (
          contributor !== undefined &&
          !contributor.isAttester &&
          responseFor(claim) === 'none'
        )
      })
    : []

  const chainRatings = useMemo(() => {
    const ratings = new Map<string, number>()
    if (!connectedAddress) return ratings
    for (const claim of claims) {
      const rating = state.valuations.get(
        actorKey(claim.uid, connectedAddress as Hex)
      )
      if (rating !== undefined) ratings.set(claim.uid, rating)
    }
    return ratings
  }, [claims, connectedAddress, state.valuations])

  const effectiveRatings = useMemo(() => {
    const ratings = new Map(chainRatings)
    for (const [uid, rating] of drafts) ratings.set(uid, rating)
    return ratings
  }, [chainRatings, drafts])

  const deferredDrafts = useDeferredValue(drafts)
  const optimisticScoreByUid = useMemo(() => {
    if (
      deferredDrafts.size === 0 ||
      !connectedAddress ||
      !round?.params ||
      !round.root ||
      trustEdges.length === 0 ||
      records.length === 0
    )
      return null
    try {
      let latestTimestamp = 0n
      for (const record of records) {
        if (record.blockTimestamp > latestTimestamp)
          latestTimestamp = record.blockTimestamp
      }
      const draftRecords = Array.from(deferredDrafts.entries()).map(
        ([claimUid, score], index) => ({
          kind: 4,
          attester: connectedAddress as Hex,
          recipient: zeroAddress,
          uid: keccak256(
            encodeAbiParameters(
              [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint8' }],
              [claimUid as Hex, connectedAddress as Hex, score]
            )
          ),
          blockTimestamp: latestTimestamp + BigInt(index + 1),
          data: encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'uint8' }],
            [claimUid as Hex, score]
          ),
        })
      )
      return computeContributions({
        trustEdges,
        records: [...records, ...draftRecords],
        params: { ...round.params, totalPool: BigInt(round.pool) },
      }).claimScores
    } catch {
      return null
    }
  }, [connectedAddress, deferredDrafts, records, round, trustEdges])

  const projectionIsPreview =
    deferredDrafts.size > 0 && optimisticScoreByUid !== null
  const projectionScores = optimisticScoreByUid ?? scoreByUid
  const projections = useMemo(
    () =>
      round?.root && (projectionIsPreview || scoresAvailable)
        ? projectContributionPool(projectionScores, round.pool)
        : [],
    [projectionIsPreview, projectionScores, round, scoresAvailable]
  )
  const projectionByUid = useMemo(
    () =>
      new Map(
        projections.map((projection) => [projection.claimUid, projection])
      ),
    [projections]
  )
  const previewUnavailable =
    deferredDrafts.size > 0 && optimisticScoreByUid === null

  const ratingPreview = useMemo(
    () =>
      connectedAddress
        ? ratingPowerPreview(connectedAddress as Hex, state, effectiveRatings)
        : [],
    [connectedAddress, effectiveRatings, state]
  )
  const previewByUid = useMemo(
    () => new Map(ratingPreview.map((entry) => [entry.claimUid, entry])),
    [ratingPreview]
  )
  const countedPreview = ratingPreview.filter((entry) => !entry.doesNotCount)

  const isMyClaim = (claim: ClaimView) =>
    !!connectedAddress &&
    (claim.attester.toLowerCase() === connectedAddress.toLowerCase() ||
      claim.contributors.some(
        (contributor) =>
          contributor.account.toLowerCase() === connectedAddress.toLowerCase()
      ))

  const sortedClaims = useMemo(() => {
    const sorted = [...claims]
    const scoreFor = (claim: ClaimView) => {
      const score = scoreByUid.get(claim.uid)
      return score === undefined ? -1n : BigInt(score)
    }
    const scoreOrder = (a: ClaimView, b: ClaimView) => {
      const aScore = scoreFor(a)
      const bScore = scoreFor(b)
      return aScore === bScore ? 0 : aScore < bScore ? 1 : -1
    }
    const newestOrder = (a: ClaimView, b: ClaimView) =>
      a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1

    const activeSort = isConnected ? feedSort : 'top'
    sorted.sort((a, b) => {
      if (activeSort === 'newest') return newestOrder(a, b)
      if (activeSort === 'top') return scoreOrder(a, b) || newestOrder(a, b)

      const bucket = (claim: ClaimView) =>
        isMyClaim(claim) ? 2 : chainRatings.has(claim.uid) ? 1 : 0
      const bucketDifference = bucket(a) - bucket(b)
      return bucketDifference || scoreOrder(a, b) || newestOrder(a, b)
    })
    return pendingContribution ? [pendingContribution.claim, ...sorted] : sorted
  }, [
    chainRatings,
    claims,
    connectedAddress,
    feedSort,
    isConnected,
    pendingContribution,
    scoreByUid,
  ])

  const dirtyUids = Array.from(drafts.entries())
    .filter(([uid, rating]) => chainRatings.get(uid) !== rating)
    .map(([uid]) => uid)
  const unsavedDirtyUids = dirtyUids.filter((uid) => !submittedDrafts.has(uid))
  const titleFor = (uid: string) =>
    claims.find((claim) => claim.uid === uid)?.title || 'Untitled contribution'

  const updateDraft = (claimUid: string, rating: number) => {
    setDrafts((current) => new Map(current).set(claimUid, rating))
    setSubmittedDrafts((current) => {
      if (!current.has(claimUid)) return current
      const next = new Set(current)
      next.delete(claimUid)
      return next
    })
  }

  const saveRatings = async () => {
    if (!valuationSchema || unsavedDirtyUids.length === 0) return
    const savingUids = [...unsavedDirtyUids]
    try {
      await createAttestations(
        savingUids.map((claimUid) => ({
          schema: valuationSchema.uid,
          recipient: zeroAddress,
          data: {
            claimUID: claimUid,
            score: String(effectiveRatings.get(claimUid)),
          },
        }))
      )
      setSubmittedDrafts((current) => {
        const next = new Set(current)
        for (const uid of savingUids) next.add(uid)
        return next
      })
    } catch {
      // The batch is atomic. A revert leaves every draft intact and none marked submitted.
    }
  }

  const respondToContribution = async (
    claimUid: string,
    response: ResponseChoice
  ) => {
    if (!responseSchema) return
    setPendingResponse({ claimUid, response })
    try {
      await createAttestation({
        schema: responseSchema.uid,
        recipient: zeroAddress,
        data: {
          claimUID: claimUid,
          response: response === 'accept' ? '1' : '2',
        },
      })
      setResponseOverrides((current) =>
        new Map(current).set(claimUid, response)
      )
    } catch {
      // The transaction hook reports the error. Leave the unanswered state intact.
    } finally {
      setPendingResponse(null)
    }
  }

  // Keep the server and first client render identical, then switch the absolute fallback to the
  // useful relative window line after hydration.
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000))
  }, [])

  // Once the live chain record agrees, it becomes the source of truth and the local draft can go.
  useEffect(() => {
    setDrafts((current) => {
      let changed = false
      const next = new Map(current)
      for (const [uid, rating] of current) {
        if (chainRatings.get(uid) === rating) {
          next.delete(uid)
          changed = true
        }
      }
      return changed ? next : current
    })
    setSubmittedDrafts((current) => {
      const next = new Set(current)
      for (const uid of current) {
        if (!drafts.has(uid) || chainRatings.get(uid) === drafts.get(uid)) {
          next.delete(uid)
        }
      }
      return next.size === current.size ? current : next
    })
  }, [chainRatings, drafts])

  // The optimistic card is keyed by the real EAS uid, so it remains pending until that exact
  // on-chain record reaches the feed and can safely take over.
  useEffect(() => {
    if (optimisticIsIndexed) setOptimisticContribution(null)
  }, [optimisticIsIndexed])

  // Drop optimistic response state once the reconciled chain record says the same thing.
  useEffect(() => {
    setResponseOverrides((current) => {
      const next = new Map(current)
      for (const [claimUid, response] of current) {
        const claim = claims.find((candidate) => candidate.uid === claimUid)
        const contributor = claim ? connectedContributorFor(claim) : undefined
        if (contributor?.response === response) next.delete(claimUid)
      }
      return next.size === current.size ? current : next
    })
  }, [claims, connectedAddress])

  return (
    <div className="space-y-10">
      <header className="space-y-6">
        <BreadcrumbRenderer
          fallback={{
            title: 'Network',
            route: trustNetwork ? `/networks/${trustNetwork.id}` : '/networks',
          }}
        />
        <NetworkHeader
          network={trustNetwork ?? network}
          tabs={
            trustNetwork
              ? trustGraphTabs(trustNetwork)
              : contributionsTabs(network)
          }
          className="w-full"
        />

        <div className="max-w-3xl space-y-2">
          <h2 className="text-2xl font-semibold">Contributions</h2>
          <p className="text-sm leading-relaxed text-text-muted">
            {network.about}
          </p>
          {trustNetwork ? (
            <p className="text-sm text-text-muted">
              Rater influence is weighted by this network&apos;s{' '}
              <a
                href={`/networks/${trustNetwork.id}`}
                className="text-text underline underline-offset-4"
              >
                trust graph
              </a>
              .
            </p>
          ) : (
            <p className="text-sm text-text-muted">
              Rater influence is weighted by this round&apos;s trust network.
            </p>
          )}
        </div>

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
                  {sortedClaims.length} contribution
                  {sortedClaims.length === 1 ? '' : 's'}
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
              <Button
                type="button"
                variant="brand"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => setSubmitOpen(true)}
              >
                Submit contribution
              </Button>
            )}
            {phase === 'claimable' && (
              <ButtonLink
                href={
                  trustNetwork
                    ? `/networks/${trustNetwork.id}/claims`
                    : `/networks/${network.id}/claim`
                }
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

          {round && claims.length > 0 && (
            <div className="space-y-2 border-t border-hairline pt-5 sm:col-span-2">
              <p className="tg-label">Pool split by community score</p>
              <PoolSplitBar
                claims={claims}
                projections={projections}
                tokenDecimals={tokenDecimals}
                tokenSymbol={tokenSymbol}
                phase={phase}
                previewUnavailable={previewUnavailable}
              />
            </div>
          )}
        </div>

        {!roundLoading && !roundAvailable && (
          <p className="text-sm text-warn">
            The round service is not reachable, so the window, pool, and scores
            are hidden. Contributions and ratings below still come straight from
            the chain.
          </p>
        )}
      </header>

      {unansweredClaims.length > 0 && (
        <Card
          type="accent"
          size="md"
          role="status"
          aria-live="polite"
          className="border-hairline-strong"
        >
          <a
            href={`#contribution-${unansweredClaims[0].uid}`}
            className="block min-h-11 py-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {unansweredClaims.length} contribution
            {unansweredClaims.length === 1 ? '' : 's'} name you. Accept to
            receive your share.
          </a>
        </Card>
      )}

      <SubmitContributionModal
        isOpen={submitOpen}
        onClose={() => setSubmitOpen(false)}
        network={network}
        round={round}
        claimSchemaUid={claimSchema?.uid}
        onSubmitted={setOptimisticContribution}
      />

      {/* Claims */}
      <div className="space-y-4">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <SectionHeading>Contributions</SectionHeading>
          {isConnected && sortedClaims.length > 1 && (
            <label>
              <span className="sr-only">Sort contributions</span>
              <select
                className="h-11 border border-hairline-strong bg-surface px-3 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                value={feedSort}
                onChange={(event) =>
                  setFeedSort(event.target.value as FeedSort)
                }
              >
                <option value="unrated">Unrated first</option>
                <option value="newest">Newest</option>
                <option value="top">Top scored</option>
              </select>
            </label>
          )}
        </div>
        {claimsLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading contributions...
          </p>
        ) : sortedClaims.length === 0 ? (
          <Card type="outline" size="lg" className="text-center">
            <p className="text-muted-foreground">
              No contributions have been submitted yet. Be the first to share
              work you or others did.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {sortedClaims.map((claim) => (
              <ClaimCard
                key={claim.uid}
                claim={claim}
                network={network}
                score={projectionScores
                  .get(claim.uid.toLowerCase())
                  ?.toString()}
                projection={projectionByUid.get(claim.uid.toLowerCase())}
                projectionIsPreview={projectionIsPreview}
                tokenDecimals={tokenDecimals}
                tokenSymbol={tokenSymbol}
                connectedAddress={connectedAddress}
                rating={effectiveRatings.get(claim.uid)}
                chainRating={chainRatings.get(claim.uid)}
                draft={drafts.get(claim.uid)}
                previewEntry={previewByUid.get(claim.uid)}
                isSubmitted={submittedDrafts.has(claim.uid)}
                isPending={pendingContribution?.claim.uid === claim.uid}
                responseOverride={responseOverrides.get(claim.uid)}
                respondingChoice={
                  pendingResponse?.claimUid === claim.uid
                    ? pendingResponse.response
                    : null
                }
                responseBusy={isCreating}
                onRatingChange={(rating) => updateDraft(claim.uid, rating)}
                onRespond={(response) =>
                  respondToContribution(claim.uid, response)
                }
              />
            ))}
          </div>
        )}
      </div>

      {connectedAddress && drafts.size > 0 && (
        <aside
          aria-label="Your rating power"
          className="sticky bottom-3 z-30 space-y-2 border border-hairline-strong bg-surface p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="tg-label-strong">Your rating power</p>
              <p className="truncate text-xs text-text-muted">
                {countedPreview.length > 0
                  ? countedPreview
                      .map(
                        (entry) =>
                          `${titleFor(entry.claimUid)} ${formatBasisPoints(entry.shareBps)}`
                      )
                      .join(', ')
                  : 'A zero rating assigns none of your voice.'}
              </p>
            </div>
            {unsavedDirtyUids.length > 0 && (
              <Button
                size="lg"
                variant="brand"
                onClick={saveRatings}
                disabled={isCreating}
                className="shrink-0"
              >
                {isCreating
                  ? `Saving ${unsavedDirtyUids.length} rating${unsavedDirtyUids.length === 1 ? '' : 's'}`
                  : `Save ${unsavedDirtyUids.length} rating${unsavedDirtyUids.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
          <div
            className="flex h-2 overflow-hidden border border-hairline bg-surface-2"
            aria-hidden="true"
          >
            {countedPreview.map((entry, index) => (
              <div
                key={entry.claimUid}
                className={previewTone(index)}
                style={{ width: basisPointsWidth(entry.shareBps) }}
                title={`${titleFor(entry.claimUid)}: ${formatBasisPoints(entry.shareBps)} of your voice`}
              />
            ))}
          </div>
          <ul className="sr-only">
            {countedPreview.map((entry) => (
              <li key={entry.claimUid}>
                {titleFor(entry.claimUid)}: {formatBasisPoints(entry.shareBps)}
                of your voice
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  )
}
