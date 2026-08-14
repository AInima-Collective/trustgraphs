/** Creation-time proving policy helpers. Values use the vault's 8-decimal oracle-USD scale. */
export const VAULT_USD_SCALE = 100_000_000n
export const MAX_INITIAL_MAX_PER_ROOT_USD = 10_000n * VAULT_USD_SCALE
export const DEFAULT_MAX_PER_ROOT_USD = '25'

export type InitialProvingPolicy = {
  minPaidIntervalBlocks: bigint
  maxPerRootUsd: bigint
}

/** Parse a plain non-negative USD amount without floating-point rounding. */
export const parseVaultUsd = (value: string): bigint | null => {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,8}))?$/)
  if (!match) return null
  const whole = BigInt(match[1])
  const fraction = (match[2] ?? '').padEnd(8, '0')
  return whole * VAULT_USD_SCALE + BigInt(fraction || '0')
}

export const initialPolicyProblem = (
  prepayEth: string,
  maxPerRootUsd: string
): string | null => {
  if (!prepayEth.trim()) return null
  if (!maxPerRootUsd.trim()) {
    return 'Set the most this tank may spend on one score refresh.'
  }
  const cap = parseVaultUsd(maxPerRootUsd)
  if (cap === null) {
    return 'Enter a USD cap with no more than 8 decimal places.'
  }
  if (cap === 0n) {
    return 'A prepayment needs a nonzero per-refresh cap.'
  }
  if (cap > MAX_INITIAL_MAX_PER_ROOT_USD) {
    return 'The creation-time cap cannot exceed $10,000 per refresh.'
  }
  return null
}

/** Zero/zero is the explicit unpaid policy. A funded creation always carries both terms. */
export const initialPolicyForCreation = (
  prepayWei: bigint,
  minPaidIntervalBlocks: bigint,
  maxPerRootUsd: string
): InitialProvingPolicy => {
  if (prepayWei === 0n) {
    return { minPaidIntervalBlocks: 0n, maxPerRootUsd: 0n }
  }
  const cap = parseVaultUsd(maxPerRootUsd)
  if (cap === null || cap === 0n || cap > MAX_INITIAL_MAX_PER_ROOT_USD) {
    throw new Error('Invalid initial proving policy')
  }
  return { minPaidIntervalBlocks, maxPerRootUsd: cap }
}

/** Conservative count: every refresh is assumed to consume the complete configured cap. */
export const conservativeRefreshEstimate = (
  prepayWei: bigint,
  ethUsd: bigint,
  maxPerRootUsd: bigint
): bigint | null => {
  if (prepayWei === 0n || ethUsd <= 0n || maxPerRootUsd <= 0n) return null
  const prepaidUsd = (prepayWei * ethUsd) / 10n ** 18n
  return prepaidUsd / maxPerRootUsd
}
