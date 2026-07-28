'use client'

import { useReadContracts } from 'wagmi'

import { Button } from '@/components/Button'
import { merkleSnapshotAbi } from '@/lib/contract-abis'

/**
 * How old the scores are, and when they can next be refreshed.
 *
 * The refresh button used to be unconditional, so a member could press it and watch the
 * transaction bounce off the contract's epoch gate with a revert they had no way to anticipate.
 * The schedule is public: read it, and either show a working button or say when it will work.
 *
 * Copy rule: a reader should not have to know the word "epoch", "checkpoint" or "root" to
 * understand this. Scores are scores, and they refresh on a schedule.
 */

const humanAgo = (unixSeconds: bigint): string => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSeconds))
  if (seconds < 3_600) return 'just now'
  const days = seconds / 86_400
  if (days < 1) return `${Math.round(seconds / 3_600)} hours ago`
  if (days < 45) return `${Math.round(days)} days ago`
  return `${Math.round(days / 30)} months ago`
}

/** Blocks to something a person can plan around. 12s blocks; the estimate is labelled as one. */
const humanBlocks = (blocks: bigint): string => {
  const seconds = Number(blocks) * 12
  if (seconds < 3_600) return `about ${Math.max(1, Math.round(seconds / 60))} minutes`
  const days = seconds / 86_400
  if (days < 1) return `about ${Math.round(seconds / 3_600)} hours`
  if (days < 14) return `about ${Math.round(days)} days`
  return `about ${Math.round(days / 7)} weeks`
}

export const RootFreshness = ({
  snapshot,
  currentBlock,
  onRefresh,
}: {
  snapshot: `0x${string}`
  currentBlock?: bigint
  /** Called when a refresh is actually possible. Absent renders the line without a button. */
  onRefresh?: () => void
}) => {
  const { data } = useReadContracts({
    contracts: [
      { address: snapshot, abi: merkleSnapshotAbi, functionName: 'epochLength' },
      { address: snapshot, abi: merkleSnapshotAbi, functionName: 'lastTriggerBlock' },
      { address: snapshot, abi: merkleSnapshotAbi, functionName: 'getLatestState' },
    ],
  })

  const epochLength = data?.[0]?.result as bigint | undefined
  const lastTriggerBlock = data?.[1]?.result as bigint | undefined
  const latest = data?.[2]?.result as { timestamp: bigint } | undefined

  const asOf = latest?.timestamp
  // The contract judges the boundary against the block a transaction would run in, so this does
  // too. Off by one here is a bounced transaction.
  const boundary =
    epochLength !== undefined && lastTriggerBlock !== undefined && epochLength > 0n
      ? lastTriggerBlock + epochLength
      : undefined
  const next = currentBlock !== undefined ? currentBlock + 1n : undefined
  const ready = boundary === undefined || (next !== undefined && next >= boundary)
  const blocksLeft = boundary !== undefined && next !== undefined && !ready ? boundary - next : 0n

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="opacity-70">
        {asOf !== undefined ? `Scores as of ${humanAgo(asOf)}.` : 'No scores published yet.'}
      </span>

      {epochLength !== undefined && epochLength > 0n && (
        <span className="opacity-50">Refreshes every {humanBlocks(epochLength)}.</span>
      )}

      {onRefresh &&
        (ready ? (
          <Button size="sm" onClick={onRefresh}>
            Refresh now
          </Button>
        ) : (
          // Deliberately not a disabled button with no explanation: the reason is the useful part.
          <span className="opacity-50">
            Next refresh in {humanBlocks(blocksLeft)}.
          </span>
        ))}
    </div>
  )
}
