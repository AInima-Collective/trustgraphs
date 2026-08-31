import { isAddress, isHex } from 'viem'

import type { SafeAction } from './types'

const MAX_UINT256 = (1n << 256n) - 1n
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/

export type SafeActionNormalization =
  | { ok: true; actions: SafeAction[] }
  | { ok: false; reason: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const normalizedUint256 = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !DECIMAL_UINT.test(value)) return undefined
  try {
    return BigInt(value) <= MAX_UINT256 ? value : undefined
  } catch {
    return undefined
  }
}

/** Validate the JSON representation of the exact tuple accepted by MerkleGovModule and Safe. */
export const normalizeSafeAction = (value: unknown): SafeAction | undefined => {
  const candidate = record(value)
  if (!candidate) return undefined

  const { target, data, operation, description } = candidate
  const normalizedValue = normalizedUint256(candidate.value)
  const normalizedDescription =
    typeof description === 'string' ? description : undefined
  if (
    typeof target !== 'string' ||
    !isAddress(target) ||
    typeof data !== 'string' ||
    !isHex(data, { strict: true }) ||
    data.length % 2 !== 0 ||
    normalizedValue === undefined ||
    (operation !== 0 && operation !== 1) ||
    (description !== undefined && typeof description !== 'string')
  ) {
    return undefined
  }

  return {
    target,
    value: normalizedValue,
    data,
    operation,
    ...(normalizedDescription === undefined
      ? {}
      : { description: normalizedDescription }),
  }
}

/** Reject the entire ordered action span if any tuple is malformed; never renumber or omit calls. */
export const normalizeSafeActions = (
  value: unknown
): SafeActionNormalization => {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'Proposal actions are not an array.' }
  }

  const actions: SafeAction[] = []
  for (let index = 0; index < value.length; index++) {
    const action = normalizeSafeAction(value[index])
    if (!action) {
      return {
        ok: false,
        reason: `Proposal action ${index + 1} is not a valid Safe transaction tuple.`,
      }
    }
    actions.push(action)
  }
  return { ok: true, actions }
}
