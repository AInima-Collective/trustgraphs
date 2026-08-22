import { getEnsAddress } from '@wagmi/core'
import type { Config } from '@wagmi/core'
import { type Address, getAddress, isAddressEqual, zeroAddress } from 'viem'

import {
  ENS_REGISTRY_CHAIN_ID,
  getEnsCoinType,
  normalizeEnsName,
  parseAccountIdentifier,
} from './ens'

export { ENS_REGISTRY_CHAIN_ID, getEnsCoinType }

export class InvalidAccountIdentifierError extends Error {
  constructor(public readonly input: string) {
    super(`“${input.trim()}” is not a valid address or ENS name.`)
    this.name = 'InvalidAccountIdentifierError'
  }
}

export class EnsNameNotFoundError extends Error {
  constructor(public readonly ensName: string) {
    super(`${ensName} does not have an address for this network.`)
    this.name = 'EnsNameNotFoundError'
  }
}

export class EnsResolutionChangedError extends Error {
  constructor(
    public readonly ensName: string,
    public readonly previousAddress: Address,
    public readonly currentAddress: Address
  ) {
    super(
      `${ensName} now resolves to ${currentAddress}. Review the new address and try again.`
    )
    this.name = 'EnsResolutionChangedError'
  }
}

export interface ResolvedAccountIdentifier {
  input: string
  address: Address
  ensName: string | null
}

export type EnsAddressLookup = (
  name: string,
  coinType: bigint
) => Promise<Address | null>

/**
 * Resolve directly through wagmi's core action. Unlike UI queries, this is not
 * backed by TanStack Query and therefore provides a fresh check for a write path.
 */
export const resolveEnsNameNow = async (
  config: Config,
  input: string,
  targetChainId: number,
  lookup?: EnsAddressLookup
): Promise<ResolvedAccountIdentifier> => {
  const name = normalizeEnsName(input)
  if (!name) throw new InvalidAccountIdentifierError(input)

  const coinType = getEnsCoinType(targetChainId)
  const address = lookup
    ? await lookup(name, coinType)
    : await getEnsAddress(config, {
        chainId: ENS_REGISTRY_CHAIN_ID,
        coinType,
        name,
      })

  if (!address || isAddressEqual(address, zeroAddress)) {
    throw new EnsNameNotFoundError(name)
  }

  return { input, address: getAddress(address), ensName: name }
}

/**
 * Resolve an address-or-name immediately before a write. If the caller supplies
 * the address shown in its preview, a changed ENS record stops the write so the
 * user can review the new destination.
 */
export const resolveAccountIdentifierNow = async (
  config: Config,
  input: string,
  targetChainId: number,
  previewAddress?: Address | null,
  lookup?: EnsAddressLookup
): Promise<ResolvedAccountIdentifier> => {
  const parsed = parseAccountIdentifier(input)

  if (parsed.kind === 'address') {
    return {
      input,
      address: getAddress(parsed.address.toLowerCase()),
      ensName: null,
    }
  }
  if (parsed.kind !== 'ens') throw new InvalidAccountIdentifierError(input)

  const resolved = await resolveEnsNameNow(
    config,
    parsed.name,
    targetChainId,
    lookup
  )
  if (previewAddress && !isAddressEqual(previewAddress, resolved.address)) {
    throw new EnsResolutionChangedError(
      parsed.name,
      previewAddress,
      resolved.address
    )
  }
  return resolved
}

export const getAccountIdentifierErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return 'Could not resolve that account. Please try again.'
}
