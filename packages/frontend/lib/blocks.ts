import { CHAIN } from '@/lib/config'

/**
 * Approximate seconds per block for the chains we deploy to. Times shown to
 * users are estimates by nature (hence the "~" everywhere); a wrong entry
 * here degrades to a wrong estimate, never a wrong on-chain action.
 */
const BLOCK_TIME_SECONDS: Record<string, number> = {
  optimism: 2,
  local: 12, // Anvil demo cadence mirrors mainnet
}

export const blockTimeSeconds = (): number => BLOCK_TIME_SECONDS[CHAIN] ?? 12

/** Seconds from now until `targetBlock`, negative if it already passed. */
export const secondsUntilBlock = (
  targetBlock: bigint | number,
  currentBlock: bigint | number
): number => (Number(targetBlock) - Number(currentBlock)) * blockTimeSeconds()

/**
 * "~2 days", "~3 hours", "~5 minutes", "moments". Coarse on purpose: block
 * math is an estimate and false precision reads as a promise.
 */
export const formatDuration = (seconds: number): string => {
  const s = Math.abs(seconds)
  if (s < 90) return 'moments'
  if (s < 90 * 60) return `~${Math.round(s / 60)} minutes`
  if (s < 36 * 3600) return `~${Math.round(s / 3600)} hours`
  return `~${Math.round(s / 86400)} days`
}

/**
 * The primary display for a block boundary: a time, not a height.
 * Future: "in ~2 days". Past: "~3 hours ago".
 */
export const formatBlockEta = (
  targetBlock: bigint | number,
  currentBlock: bigint | number
): string => {
  const seconds = secondsUntilBlock(targetBlock, currentBlock)
  const duration = formatDuration(seconds)
  if (duration === 'moments') return seconds >= 0 ? 'moments away' : 'just now'
  return seconds >= 0 ? `in ${duration}` : `${duration} ago`
}
