import { normalize, toCoinType } from 'viem/ens'

export const ENS_REGISTRY_CHAIN_ID = 1
export const ENS_MAINNET_COIN_TYPE = 60n

/** Return the ENSIP-11 coin type for the application account chain. */
export const getEnsCoinType = (targetChainId: number): bigint => {
  if (targetChainId === ENS_REGISTRY_CHAIN_ID || targetChainId === 31337) {
    return ENS_MAINNET_COIN_TYPE
  }
  return toCoinType(targetChainId)
}

export type AccountIdentifier =
  | { kind: 'empty'; input: string }
  | { kind: 'address'; input: string; address: `0x${string}` }
  | { kind: 'ens'; input: string; name: string }
  | { kind: 'invalid'; input: string }

/**
 * Cheaply decide whether an account input is worth sending through ENS resolution.
 *
 * ENS is not limited to `.eth`: DNS names imported into ENS and their subnames are
 * valid too. This is intentionally only a classifier. `normalizeEnsName` remains the
 * source of truth for whether the candidate is a valid ENSIP-15 name.
 */
export const isPotentialEnsName = (input: string): boolean => {
  const name = input.trim()
  const firstDot = name.indexOf('.')
  return firstDot > 0 && firstDot < name.length - 1
}

/**
 * Trim and ENSIP-15-normalize a possible name, returning `null` for invalid input.
 * Callers should pass only the returned value to a resolver.
 */
export const normalizeEnsName = (input: string): string | null => {
  if (!isPotentialEnsName(input)) return null

  try {
    return normalize(input.trim())
  } catch {
    return null
  }
}

/**
 * Parse a user-entered account without performing any network work.
 */
export const parseAccountIdentifier = (input: string): AccountIdentifier => {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'empty', input }

  // Importing these helpers at module scope would make the tiny ENS parser pull in
  // more of viem in browser chunks. A strict shape check is enough here; callers
  // checksum the value at the resolver boundary.
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return {
      kind: 'address',
      input,
      address: trimmed as `0x${string}`,
    }
  }

  const name = normalizeEnsName(trimmed)
  if (name) return { kind: 'ens', input, name }

  return { kind: 'invalid', input }
}
