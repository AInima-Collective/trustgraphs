const MAX_RETRY_DELAY_BLOCKS = 300n

/** Exponential retry spacing, capped so a repaired provider is rediscovered within one hour. */
export const scoreBlobRetryDelayBlocks = (attempts: number): bigint => {
  const exponent = Math.max(0, Math.min(attempts, 20))
  const delay = 1n << BigInt(exponent)
  return delay > MAX_RETRY_DELAY_BLOCKS ? MAX_RETRY_DELAY_BLOCKS : delay
}

export const nextScoreBlobRetryBlock = (
  currentBlock: bigint,
  attempts: number
): bigint => currentBlock + scoreBlobRetryDelayBlocks(attempts)

export const boundedIngestionError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
