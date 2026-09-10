import type { Address } from 'viem'

import type { SafeAction } from './types'

export const targetMatches = (
  action: SafeAction | undefined,
  expected: Address | undefined
) =>
  !!action &&
  !!expected &&
  action.target.toLowerCase() === expected.toLowerCase()

export const isCall = (action: SafeAction | undefined) =>
  !!action && action.operation === 0

export const isZeroValue = (action: SafeAction | undefined) => {
  if (!action) return false
  try {
    return BigInt(action.value) === 0n
  } catch {
    return false
  }
}

export const requiredAddress = (
  value: Address | undefined,
  label: string
): Address => {
  if (!value) throw new Error(`${label} is not available for this network`)
  return value
}

const UINT256_MAX = (1n << 256n) - 1n

export const unsignedInteger = (
  value: string,
  label: string,
  options: { positive?: boolean; max?: bigint } = {}
) => {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a decimal whole number`)
  }
  const parsed = BigInt(value)
  const maximum = options.max ?? UINT256_MAX
  if (parsed > maximum || (options.positive && parsed === 0n)) {
    throw new Error(
      `${label} must be ${options.positive ? 'positive and ' : ''}within its on-chain range`
    )
  }
  return parsed
}
