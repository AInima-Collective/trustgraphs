'use client'

import { useMemo, useState } from 'react'
import { Hex, zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { Address } from '@/components/Address'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Slider } from '@/components/Slider'
import { useAttestation } from '@/hooks/useAttestation'
import { actorKey } from '@/lib/contributions'
import { ratingPowerPreview } from '@/lib/contributions-view'
import { ContributionsNetwork } from '@/lib/types'

import {
  BackToRound,
  ContributionsNav,
  useContributionsData,
} from '../contributions-shared'

/**
 * Rate contributions 0–100 — with the shared budget made visible. A live bar shows how the
 * rater's voice splits across everything they've rated, recomputed with the same math the final
 * scoring uses, so "rating everything 100" visibly thins each rating out.
 */
export const RatePage = ({ network }: { network: ContributionsNetwork }) => {
  const { address: connectedAddress, isConnected } = useAccount()
  const { claims, state, claimsLoading, valuationSchema } =
    useContributionsData(network)
  const { createAttestation, isCreating } = useAttestation()

  // Draft ratings: claim uid → 0..100. Initialized lazily from the rater's live on-chain
  // ratings; sliders update drafts instantly (the budget bar reacts before anything is sent).
  const [drafts, setDrafts] = useState<Map<string, number>>(new Map())
  const [pendingClaim, setPendingClaim] = useState<string | null>(null)

  // The rater's current on-chain ratings.
  const chainRatings = useMemo(() => {
    const map = new Map<string, number>()
    if (!connectedAddress) return map
    for (const claim of claims) {
      const score = state.valuations.get(
        actorKey(claim.uid, connectedAddress as Hex)
      )
      if (score !== undefined) map.set(claim.uid, score)
    }
    return map
  }, [claims, state, connectedAddress])

  // Draft overrides chain; chain fills the rest.
  const effectiveRatings = useMemo(() => {
    const map = new Map(chainRatings)
    for (const [uid, score] of drafts) map.set(uid, score)
    return map
  }, [chainRatings, drafts])

  const preview = useMemo(
    () =>
      connectedAddress
        ? ratingPowerPreview(connectedAddress as Hex, state, effectiveRatings)
        : [],
    [connectedAddress, state, effectiveRatings]
  )
  const previewByUid = useMemo(
    () => new Map(preview.map((entry) => [entry.claimUid, entry])),
    [preview]
  )
  const countedEntries = preview.filter((entry) => !entry.doesNotCount)

  const titleFor = (uid: string) =>
    claims.find((claim) => claim.uid === uid)?.title || 'Untitled contribution'

  const saveRating = async (claimUid: string) => {
    if (!valuationSchema) return
    const score = effectiveRatings.get(claimUid)
    if (score === undefined) return
    setPendingClaim(claimUid)
    try {
      await createAttestation({
        schema: valuationSchema.uid,
        recipient: zeroAddress,
        data: {
          claimUID: claimUid,
          score: String(score),
        },
      })
    } catch {
      // The attestation hook already surfaced the error via toast.
    } finally {
      setPendingClaim(null)
    }
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="space-y-4">
        <BackToRound network={network} />
        <h1 className="text-3xl font-bold">Rate contributions</h1>
        <p className="text-muted-foreground">
          Score each contribution from 0 to 100. Your ratings share one budget:
          rating more things splits your voice, and rating everything 100 gives
          each thing an equal slice. Your voice also counts for more as you
          become more established in the trust graph.
        </p>
      </div>

      <ContributionsNav network={network} />

      {/* The live budget bar. */}
      {isConnected && countedEntries.length > 0 && (
        <Card type="accent" size="lg" className="space-y-3">
          <h2 className="font-bold text-sm">YOUR RATING POWER RIGHT NOW</h2>
          <div className="flex flex-row w-full h-5 rounded-full overflow-hidden bg-secondary">
            {countedEntries.map((entry, index) => (
              <div
                key={entry.claimUid}
                className="h-full border-r border-background last:border-r-0"
                style={{
                  width: `${entry.shareBps / 100}%`,
                  backgroundColor: `hsl(${(index * 63) % 360} 55% 55%)`,
                }}
                title={`${titleFor(entry.claimUid)}: ${(entry.shareBps / 100).toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="space-y-1">
            {countedEntries.map((entry, index) => (
              <div
                key={entry.claimUid}
                className="flex flex-row items-center gap-2 text-sm"
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{
                    backgroundColor: `hsl(${(index * 63) % 360} 55% 55%)`,
                  }}
                />
                <span className="truncate">{titleFor(entry.claimUid)}</span>
                <span className="text-muted-foreground shrink-0">
                  {(entry.shareBps / 100).toFixed(1)}% of your voice
                  {entry.reducedWeight &&
                    ' (counts at half weight: you share a claim with these contributors)'}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            This splits as you rate: giving one thing 100 and another 50 sends
            twice as much of your voice to the first. Ratings you save replace
            any rating you gave that contribution before.
          </p>
        </Card>
      )}

      {!isConnected ? (
        <Card type="outline" size="lg" className="text-center">
          <p className="text-muted-foreground">
            Connect your wallet to rate contributions.
          </p>
        </Card>
      ) : claimsLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : claims.length === 0 ? (
        <Card type="outline" size="lg" className="text-center">
          <p className="text-muted-foreground">
            Nothing to rate yet — no contributions have been claimed.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {claims.map((claim) => {
            const isMine =
              !!connectedAddress &&
              (claim.attester.toLowerCase() ===
                connectedAddress.toLowerCase() ||
                claim.contributors.some(
                  (contributor) =>
                    contributor.account.toLowerCase() ===
                    connectedAddress.toLowerCase()
                ))
            const rating = effectiveRatings.get(claim.uid)
            const chainRating = chainRatings.get(claim.uid)
            const draft = drafts.get(claim.uid)
            const previewEntry = previewByUid.get(claim.uid as Hex)
            const isPending = pendingClaim === claim.uid

            return (
              <Card
                key={claim.uid}
                type="outline"
                size="lg"
                className="space-y-3"
              >
                <div className="flex flex-row items-start justify-between gap-4 flex-wrap">
                  <div className="space-y-1 min-w-0">
                    <div className="font-bold truncate">
                      {claim.title || 'Untitled contribution'}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Submitted by{' '}
                      <Address
                        address={claim.attester}
                        displayMode="truncated"
                      />
                      {claim.uri && (
                        <>
                          {' '}
                          ·{' '}
                          <a
                            href={claim.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >
                            view the work
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  {rating !== undefined && (
                    <div className="text-right shrink-0">
                      <div className="font-mono text-lg">{rating}/100</div>
                      {previewEntry && !previewEntry.doesNotCount && (
                        <div className="text-xs text-muted-foreground">
                          {(previewEntry.shareBps / 100).toFixed(1)}% of your
                          voice
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {isMine ? (
                  <p className="text-sm text-muted-foreground">
                    You can&apos;t rate your own contribution — a rating here
                    wouldn&apos;t count.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <Slider
                      value={rating ?? 0}
                      min={0}
                      max={100}
                      onValueChange={(value) =>
                        setDrafts((map) => {
                          const next = new Map(map)
                          next.set(claim.uid, value)
                          return next
                        })
                      }
                    />
                    <div className="flex flex-row items-center justify-between gap-4 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        {rating === undefined
                          ? 'Not rated yet — drag to rate'
                          : chainRating !== undefined &&
                              (draft === undefined || draft === chainRating)
                            ? `Your saved rating: ${chainRating}/100`
                            : 'Not saved yet'}
                      </span>
                      {draft !== undefined && draft !== chainRating && (
                        <Button
                          variant="brand"
                          size="sm"
                          onClick={() => saveRating(claim.uid)}
                          disabled={isCreating}
                        >
                          {isPending
                            ? 'Saving...'
                            : `Save rating (${draft}/100)`}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
