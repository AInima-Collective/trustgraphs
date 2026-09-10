import { CHAIN } from '@/lib/config'
import { formatApproxDuration } from '@/lib/duration'

/**
 * Approximate seconds per block for the chains we deploy to. Times shown to
 * users are estimates by nature (hence the "~" everywhere); a wrong entry
 * here degrades to a wrong estimate, never a wrong on-chain action.
 */
const BLOCK_TIME_SECONDS: Record<string, number> = {
  mainnet: 12,
  sepolia: 12,
  local: 12, // Anvil demo cadence mirrors mainnet
}

export const blockTimeSeconds = (): number => BLOCK_TIME_SECONDS[CHAIN] ?? 12

/** Seconds from now until `targetBlock`, negative if it already passed. */
export const secondsUntilBlock = (
  targetBlock: bigint | number,
  currentBlock: bigint | number
): number => (Number(targetBlock) - Number(currentBlock)) * blockTimeSeconds()

export { formatApproxDuration as formatDuration } from '@/lib/duration'

/**
 * The primary display for a block boundary: a time, not a height.
 * Future: "in ~2 days". Past: "~3 hours ago".
 */
export const formatBlockEta = (
  targetBlock: bigint | number,
  currentBlock: bigint | number
): string => {
  const seconds = secondsUntilBlock(targetBlock, currentBlock)
  const duration = formatApproxDuration(seconds)
  if (duration === 'moments') return seconds >= 0 ? 'moments away' : 'just now'
  return seconds >= 0 ? `in ${duration}` : `${duration} ago`
}
