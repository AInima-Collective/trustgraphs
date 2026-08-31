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
