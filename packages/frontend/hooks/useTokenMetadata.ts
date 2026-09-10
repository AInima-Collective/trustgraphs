'use client'

import { useMemo } from 'react'
import { type Hex, erc20Abi, isAddress, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'

import {
  financialReadState,
  verifiedTokenMetadata,
} from '@/lib/financial-state'
import { getTargetChainId } from '@/lib/wagmi'

/** Metadata belongs to a token on the deployment chain, never the wallet's current chain. */
export function useTokenMetadata(tokens: readonly string[]) {
  const chainId = getTargetChainId()
  const addresses = useMemo(
    () =>
      [...new Set(tokens.map((token) => token.toLowerCase()))].filter(
        (token) => isAddress(token) && token !== zeroAddress
      ) as Hex[],
    [tokens]
  )
  const query = useReadContracts({
    contracts: addresses.flatMap((address) => [
      { address, chainId, abi: erc20Abi, functionName: 'symbol' as const },
      { address, chainId, abi: erc20Abi, functionName: 'decimals' as const },
    ]),
    query: { enabled: addresses.length > 0 },
  })
  const get = (token: string) => {
    if (token.toLowerCase() === zeroAddress)
      return { symbol: 'ETH', decimals: 18 }
    // Retained metadata may be displayed after a failed refresh, but never treated as ready.
    const index = addresses.indexOf(token.toLowerCase() as Hex)
    return index < 0
      ? undefined
      : verifiedTokenMetadata(
          token,
          query.data?.[index * 2],
          query.data?.[index * 2 + 1]
        )
  }
  const state = (token: string) => {
    if (token.toLowerCase() === zeroAddress) return 'ready' as const
    if (!isAddress(token)) return 'error' as const
    const status = financialReadState([query])
    return status === 'ready' && !get(token) ? ('error' as const) : status
  }
  return { get, state, refetch: query.refetch, isFetching: query.isFetching }
}
