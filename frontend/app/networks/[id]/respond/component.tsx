'use client'

import { useState } from 'react'
import { zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { Address } from '@/components/Address'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { useAttestation } from '@/hooks/useAttestation'
import { ContributionsNetwork } from '@/lib/types'

import {
  BackToRound,
  ContributionsNav,
  useContributionsData,
} from '../contributions-shared'

/**
 * Accept or decline being named on a contribution. The funding consequence is stated plainly on
 * every card: accept to receive the share, decline to remove it, do nothing and it counts at
 * half weight.
 */
export const RespondPage = ({ network }: { network: ContributionsNetwork }) => {
  const { address: connectedAddress, isConnected } = useAccount()
  const { claims, claimsLoading, responseSchema } =
    useContributionsData(network)
  const { createAttestation, isCreating } = useAttestation()

  const [pendingClaim, setPendingClaim] = useState<string | null>(null)

  const myClaims = connectedAddress
    ? claims.filter((claim) =>
        claim.contributors.some(
          (contributor) =>
            contributor.account.toLowerCase() === connectedAddress.toLowerCase()
        )
      )
    : []

  const respond = async (claimUid: string, accept: boolean) => {
    if (!responseSchema) return
    setPendingClaim(claimUid)
    try {
      await createAttestation({
        schema: responseSchema.uid,
        recipient: zeroAddress,
        data: {
          claimUID: claimUid,
          response: accept ? '1' : '2',
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
        <h1 className="text-3xl font-bold">Respond to being named</h1>
        <p className="text-muted-foreground">
          These contributions name you. Accept to receive your share of the
          payout; decline and your share is removed. If you do nothing, your
          share counts at half weight until you accept.
        </p>
      </div>

      <ContributionsNav network={network} />

      {!isConnected ? (
        <Card type="outline" size="lg" className="text-center">
          <p className="text-muted-foreground">
            Connect your wallet to see contributions that name you.
          </p>
        </Card>
      ) : claimsLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : myClaims.length === 0 ? (
        <Card type="outline" size="lg" className="text-center">
          <p className="text-muted-foreground">
            No contributions name you yet.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {myClaims.map((claim) => {
            const me = claim.contributors.find(
              (contributor) =>
                contributor.account.toLowerCase() ===
                connectedAddress!.toLowerCase()
            )!
            const isOwnClaim =
              claim.attester.toLowerCase() === connectedAddress!.toLowerCase()
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
                      />{' '}
                      · your share: {me.sharePct}% of this contribution
                    </div>
                  </div>
                  <div className="text-sm">
                    {me.response === 'accept' ? (
                      <span className="text-success">
                        Accepted: you&apos;ll receive your share
                      </span>
                    ) : me.response === 'reject' ? (
                      <span className="text-error">
                        Declined: your share is removed
                      </span>
                    ) : isOwnClaim ? (
                      <span className="text-muted-foreground">
                        You submitted this claim, so your share counts in full
                        unless you decline
                      </span>
                    ) : (
                      <span className="text-warn">
                        No answer yet: your share counts at half weight until
                        you accept
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-row gap-2">
                  {me.response !== 'accept' && !isOwnClaim && (
                    <Button
                      variant="brand"
                      size="sm"
                      onClick={() => respond(claim.uid, true)}
                      disabled={isCreating}
                    >
                      {isPending ? 'Sending...' : 'Accept my share'}
                    </Button>
                  )}
                  {me.response !== 'reject' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => respond(claim.uid, false)}
                      disabled={isCreating}
                    >
                      {isPending ? 'Sending...' : 'Decline: remove my share'}
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
