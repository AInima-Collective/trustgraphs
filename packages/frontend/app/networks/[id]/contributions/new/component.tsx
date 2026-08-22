'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { type Address, type Hex, isAddress, parseEventLogs, toHex } from 'viem'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'

import { Button, ButtonLink } from '@/components/Button'
import { CopyableText } from '@/components/CopyableText'
import { Input } from '@/components/Input'
import { Label } from '@/components/Label'
import { NetworkHeader } from '@/components/NetworkHeader'
import { type InstanceRow } from '@/lib/catalog'
import { APIS, CONTRIBUTIONS_FACTORY } from '@/lib/config'
import {
  PARENT_AUTHORITY_ROLE,
  contributionsCreateArgs,
  contributionsFactoryAbi,
} from '@/lib/contributions-factory'
import { parseErrorMessage } from '@/lib/error'
import { txToast } from '@/lib/tx'
import { Network } from '@/lib/types'

const merkleSnapshotHasRoleAbi = [
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

/** Local datetime-local value → unix seconds, or null when empty/invalid. */
const toUnixSeconds = (value: string): bigint | null => {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null
}

const defaultWindow = () => {
  const start = new Date()
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000)
  const toLocal = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16)
  return { start: toLocal(start), end: toLocal(end) }
}

export const NewContributionRoundPage = ({ network }: { network: Network }) => {
  const { address: connectedAddress, isConnected } = useAccount()
  const publicClient = usePublicClient()

  const initialWindow = useMemo(defaultWindow, [])
  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState(initialWindow.start)
  const [endsAt, setEndsAt] = useState(initialWindow.end)
  const [poolShares, setPoolShares] = useState('1000000')
  const [raterRewardPct, setRaterRewardPct] = useState('1')
  const [payoutToken, setPayoutToken] = useState('')
  const [salt] = useState<Hex>(() =>
    toHex(crypto.getRandomValues(new Uint8Array(32)))
  )
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ instanceId: Hex } | null>(null)

  // The gate the factory enforces: only a holder of this network's constitutional role can hang
  // a round on it. Checked here so the page can say so before asking for a signature.
  const { data: isAuthority } = useReadContract({
    address: network.contracts.merkleSnapshot,
    abi: merkleSnapshotHasRoleAbi,
    functionName: 'hasRole',
    args:
      connectedAddress !== undefined
        ? [PARENT_AUTHORITY_ROLE, connectedAddress]
        : undefined,
    query: { enabled: !!connectedAddress },
  })

  // The parent's exact live scoring params: the round re-runs this network's trust algorithm
  // over its vouch graph, so the stage-1 knobs are copied from the source of truth, not typed in.
  const parentQuery = useQuery({
    queryKey: ['instance-exact-params', network.instanceId?.toLowerCase()],
    queryFn: async () => {
      const response = await fetch(
        `${APIS.ponder}/instances/${network.instanceId}`
      )
      if (!response.ok) {
        throw new Error(
          `GET /instances/${network.instanceId} responded ${response.status}`
        )
      }
      const { instance } = (await response.json()) as { instance: InstanceRow }
      return instance
    },
    enabled: !!network.instanceId,
  })
  const parent = parentQuery.data

  const startSeconds = toUnixSeconds(startsAt)
  const endSeconds = toUnixSeconds(endsAt)
  const poolValue = /^\d+$/.test(poolShares.trim())
    ? BigInt(poolShares.trim())
    : null
  const raterPct = Number(raterRewardPct)
  const carveoutBps =
    Number.isFinite(raterPct) && raterPct >= 0 && raterPct <= 100
      ? Math.round(raterPct * 100)
      : null
  const tokenInput = payoutToken.trim()
  const tokenValid = tokenInput === '' || isAddress(tokenInput)

  const problem = !name.trim()
    ? 'Give the round a name.'
    : startSeconds === null || endSeconds === null
      ? 'Pick when the round opens and closes.'
      : startSeconds >= endSeconds
        ? 'The round has to close after it opens.'
        : poolValue === null || poolValue === 0n
          ? 'The pool needs at least one share.'
          : carveoutBps === null
            ? 'The rater reward is a percentage between 0 and 100.'
            : !tokenValid
              ? 'The payout token is not a valid address.'
              : null

  const handleCreate = async () => {
    if (
      !publicClient ||
      !connectedAddress ||
      !network.instanceId ||
      !parent ||
      !CONTRIBUTIONS_FACTORY ||
      network.offchainLane ||
      problem !== null
    ) {
      return
    }
    setError(null)
    setIsCreating(true)
    try {
      const args = contributionsCreateArgs(
        network.instanceId,
        parent.params,
        BigInt(parent.epochLength),
        {
          name,
          roundStart: startSeconds!,
          roundEnd: endSeconds!,
          totalPool: poolValue!,
          evaluatorCarveoutBps: carveoutBps!,
          distributorToken: (tokenInput === ''
            ? `0x${'0'.repeat(40)}`
            : tokenInput) as Address,
          salt,
        }
      )
      const gasEstimate = await publicClient.estimateContractGas({
        address: CONTRIBUTIONS_FACTORY as Address,
        abi: contributionsFactoryAbi,
        functionName: 'createInstance',
        args: [args],
        account: connectedAddress,
      })
      const [receipt] = await txToast({
        tx: {
          address: CONTRIBUTIONS_FACTORY as Address,
          abi: contributionsFactoryAbi,
          functionName: 'createInstance',
          args: [args],
          gas: (gasEstimate * 120n) / 100n,
        },
        successMessage: 'Contribution round created!',
      })
      // Scan the whole receipt by event shape, never by emitting address (the factory pattern
      // survives wrappers where the caller is not the factory).
      const [event] = parseEventLogs({
        abi: contributionsFactoryAbi,
        eventName: 'ContributionsInstanceCreated',
        logs: receipt.logs,
      })
      if (event) setCreated({ instanceId: event.args.instanceId })
    } catch (err) {
      console.error('Round creation error:', err)
      setError(parseErrorMessage(err))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="space-y-10">
      <NetworkHeader network={network} className="w-full" />

      <div className="max-w-2xl space-y-8">
        <div className="space-y-3">
          <h2 className="text-2xl font-bold">Start a contribution round</h2>
          <p className="text-sm leading-relaxed text-text-muted">
            A round lets members submit work, respond when they are named on it,
            and rate each other&apos;s contributions. Ratings are weighted by
            this network&apos;s trust scores, and once the round&apos;s result
            is proven, the pool splits accordingly and recipients claim their
            payouts. One transaction sets up everything: the three attestation
            schemas, the round&apos;s own score contract, and its payout fund.
          </p>
        </div>

        {network.offchainLane ? (
          <div className="space-y-2 text-sm text-warn">
            <p>Contribution rounds are unavailable for this hybrid network.</p>
            <p>
              The contribution guest authenticates the on-chain vouch
              accumulator only; it does not verify the strict retained off-chain
              history that also affects this network&apos;s scores. The factory
              rejects this parent so a round cannot silently use a partial trust
              graph.
            </p>
          </div>
        ) : !CONTRIBUTIONS_FACTORY ? (
          <p className="text-sm text-warn">
            This deployment has no contribution-round factory yet, so rounds
            cannot be started from the app here.
          </p>
        ) : !network.instanceId ? (
          <p className="text-sm text-warn">
            This network is not in the on-chain directory, so a round cannot be
            attached to it. Networks created through the app are always listed.
          </p>
        ) : created ? (
          <div className="space-y-4">
            <p className="text-sm">
              The round is live. Its id (how the app and the indexer refer to
              it):
            </p>
            <CopyableText text={created.instanceId} />
            <div className="flex flex-wrap gap-3">
              <ButtonLink href={`/networks/${network.id}/contributions`}>
                Open the round
              </ButtonLink>
              <ButtonLink
                href={`/networks/${network.id}/settings`}
                variant="outline"
              >
                Back to settings
              </ButtonLink>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {!isConnected ? (
              <p className="text-sm text-warn">
                Connect the wallet that runs this network. Only the network
                authority (the holder of its constitutional role) can start a
                round.
              </p>
            ) : isAuthority === false ? (
              <p className="text-sm text-warn">
                Only this network&apos;s authority can start a round, and the
                connected wallet does not hold its constitutional role. For a
                governed network that means going through a proposal.
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="round-name">Round name</Label>
              <Input
                id="round-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Spring funding round"
                maxLength={64}
              />
              <p className="text-xs text-text-muted">
                Shown wherever the round appears. It is part of the round&apos;s
                id, so two rounds can share a name without clashing.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="round-start">Opens</Label>
                <Input
                  id="round-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="round-end">Closes</Label>
                <Input
                  id="round-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                />
              </div>
              <p className="text-xs text-text-muted sm:col-span-2">
                Only contributions submitted inside this window count toward the
                round.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="round-pool">Pool shares</Label>
              <Input
                id="round-pool"
                inputMode="numeric"
                value={poolShares}
                onChange={(e) => setPoolShares(e.target.value)}
              />
              <p className="text-xs text-text-muted">
                The total number of shares the round splits between
                contributors. Shares are proportional: the money paid out is
                whatever the round&apos;s fund is later funded with, in any
                token.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="round-carveout">Rater reward (%)</Label>
              <Input
                id="round-carveout"
                inputMode="decimal"
                value={raterRewardPct}
                onChange={(e) => setRaterRewardPct(e.target.value)}
              />
              <p className="text-xs text-text-muted">
                A slice of the pool set aside for members whose ratings counted,
                so reviewing work is paid too. 0 turns it off; 1% is the usual
                default.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="round-token">Payout token (optional)</Label>
              <Input
                id="round-token"
                value={payoutToken}
                onChange={(e) => setPayoutToken(e.target.value)}
                placeholder="0x…"
              />
              <p className="text-xs text-text-muted">
                The token you plan to pay out in. This only sets the default the
                app shows; the fund accepts any token when it is funded.
              </p>
            </div>

            <p className="text-xs text-text-muted">
              Scoring settings (how trust is computed) are copied from this
              network&apos;s live configuration, and the round&apos;s three
              attestation schemas are registered automatically.
            </p>

            {problem && name.trim() !== '' && (
              <p className="text-sm text-warn">{problem}</p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              onClick={handleCreate}
              disabled={
                isCreating ||
                problem !== null ||
                !isConnected ||
                isAuthority !== true ||
                !parent
              }
            >
              {isCreating ? 'Starting the round…' : 'Start the round'}
            </Button>
            {network.instanceId && parentQuery.isError && (
              <p className="text-sm text-warn">
                Could not load this network&apos;s live scoring settings from
                the indexer; retry once it is reachable.
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-text-muted">
          Terminology, for clarity: contributors <strong>submit</strong>{' '}
          contributions during the window; once the result is proven, recipients{' '}
          <strong>claim</strong> their payouts from the round&apos;s fund. See
          the{' '}
          <Link
            href={`/networks/${network.id}/contributions`}
            className="underline underline-offset-4"
          >
            contributions page
          </Link>{' '}
          for the member-facing flow.
        </p>
      </div>
    </div>
  )
}
