'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { formatEther, parseEther } from 'viem'
import { useAccount, useWriteContract } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { SectionHeading } from '@/components/SectionHeading'
import { ponderQueries } from '@/queries/ponder'

/**
 * The proving tank.
 *
 * Scores only stay fresh if somebody keeps proving them, and proving costs money. This panel says
 * how much is left, how fast it is going, and what happens when it runs out, in the words a member
 * would use. No `epochLength`, no `maxPerRoot`, no spec references: a normal reader should get it
 * on the first pass.
 *
 * The honesty rules it follows:
 *
 *   - An unfunded instance is not shown as an empty tank. "Nobody has funded this" and "the money
 *     ran out" are different situations with different fixes, and conflating them would hide the
 *     second one.
 *   - A runway is shown only when there is evidence for one. A made-up "about 3 weeks left" is
 *     worse than saying nothing.
 *   - Roots that landed and paid nothing are surfaced, because that is what running dry looks
 *     like from the outside, and it is the moment somebody needs to act.
 */

const VAULT_ABI = [
  {
    type: 'function',
    name: 'depositETH',
    stateMutability: 'payable',
    inputs: [{ name: 'instanceId', type: 'bytes32' }],
    outputs: [],
  },
] as const

/** "about 3 weeks", "about 5 days", "less than a day". Never a false precision. */
const humanDuration = (seconds: number): string => {
  const days = seconds / 86_400
  if (days < 1) return 'less than a day'
  if (days < 14) return `about ${Math.round(days)} days`
  if (days < 60) return `about ${Math.round(days / 7)} weeks`
  return `about ${Math.round(days / 30)} months`
}

const humanAgo = (unixSeconds: number): string => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds)
  if (seconds < 3_600) return 'in the last hour'
  const days = seconds / 86_400
  if (days < 1) return `${Math.round(seconds / 3_600)} hours ago`
  if (days < 45) return `${Math.round(days)} days ago`
  return `${Math.round(days / 30)} months ago`
}

export const ProvingTank = ({
  instanceId,
  vaultAddress,
}: {
  instanceId: `0x${string}`
  /** The chain's `ProvingVault`. Absent on a deployment without one; the panel then explains. */
  vaultAddress?: `0x${string}`
}) => {
  const { isConnected } = useAccount()
  const { writeContract, isPending } = useWriteContract()
  const [amount, setAmount] = useState('')

  const { data, isLoading } = useQuery(ponderQueries.provingTank(instanceId))

  if (isLoading) {
    return (
      <Card type="detail" size="md">
        <SectionHeading>Keeping scores fresh</SectionHeading>
        <p className="text-sm opacity-60">Loading…</p>
      </Card>
    )
  }

  const topUp = () => {
    if (!vaultAddress || !amount) return
    writeContract({
      abi: VAULT_ABI,
      address: vaultAddress,
      functionName: 'depositETH',
      args: [instanceId],
      value: parseEther(amount),
    })
  }

  const topUpBox = vaultAddress ? (
    <div className="mt-4 flex items-end gap-2">
      <label className="flex flex-col gap-1 text-xs opacity-70">
        Add funds (ETH)
        <input
          className="w-32 rounded border border-current/20 bg-transparent px-2 py-1 text-sm"
          inputMode="decimal"
          placeholder="0.5"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <Button onClick={topUp} disabled={!isConnected || !amount || isPending}>
        {isPending ? 'Confirming…' : 'Add funds'}
      </Button>
    </div>
  ) : null

  // Not funded. Say what that means and what the options are, rather than showing a zero.
  if (!data || !data.funded) {
    return (
      <Card type="detail" size="md">
        <SectionHeading>Keeping scores fresh</SectionHeading>
        <p className="text-sm">
          Nobody is being paid to refresh this network&apos;s scores. That is fine if the community
          runs its own prover or if we are covering it: scores still update, they just depend on
          somebody choosing to do the work.
        </p>
        <p className="mt-2 text-sm opacity-70">
          Add funds and anyone who refreshes the scores gets paid for it, so it keeps happening
          whether or not a particular person is watching.
        </p>
        {topUpBox}
      </Card>
    )
  }

  const eth = BigInt(data.ethBalance)
  const usdc = BigInt(data.usdcBalance)
  const empty = eth === 0n && usdc === 0n
  const runway = data.burn.secondsRemaining

  return (
    <Card type="detail" size="md">
      <SectionHeading>Keeping scores fresh</SectionHeading>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-2xl">{formatEther(eth)} ETH</span>
        {usdc > 0n && (
          <span className="text-lg opacity-70">
            + {(Number(usdc) / 1e6).toFixed(2)} USDC
          </span>
        )}
      </div>

      <p className="mt-2 text-sm">
        {empty ? (
          <span className="font-medium">
            The funds have run out, so nobody is being paid to refresh these scores.
          </span>
        ) : runway !== null ? (
          <>At the current rate that is {humanDuration(runway)} of refreshes.</>
        ) : (
          <>
            No refreshes have been paid for yet, so there is nothing to estimate from. The first
            one will show a rate.
          </>
        )}
      </p>

      {data.lastPaidAt !== null && (
        <p className="mt-1 text-sm opacity-70">
          Last paid refresh: {humanAgo(data.lastPaidAt)}.
        </p>
      )}

      {/* The tank-ran-dry signal. This is the moment somebody has to act, so it is not buried. */}
      {data.unpaidRootsSinceLastPayment > 0 && (
        <p className="mt-2 text-sm">
          {data.unpaidRootsSinceLastPayment === 1
            ? 'One refresh since then went unpaid.'
            : `${data.unpaidRootsSinceLastPayment} refreshes since then went unpaid.`}{' '}
          They still happened, but whoever did the work was not paid for it, which is not something
          to rely on.
        </p>
      )}

      {BigInt(data.withdrawalReadyAt) > 0n && (
        <p className="mt-2 text-sm opacity-70">
          A withdrawal has been requested. The funds keep paying for refreshes until it goes
          through, so nothing stops in the meantime.
        </p>
      )}

      {topUpBox}
    </Card>
  )
}
