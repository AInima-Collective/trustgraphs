'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Address, type Hex, isAddress } from 'viem'
import { useConfig, useEnsAddress, useEnsName } from 'wagmi'
import { getEnsAddressQueryOptions, getEnsNameQueryOptions } from 'wagmi/query'

import { normalizeEnsName } from '@/lib/ens'
import {
  ENS_REGISTRY_CHAIN_ID,
  EnsResolutionChangedError,
  getEnsAddressCoinType,
  getEnsCoinType,
  resolveAccountIdentifierNow,
} from '@/lib/ens-query'
import { REVIEW_FIXTURES_ENABLED } from '@/lib/review-fixture-query'
import { getTargetChainId, makeWagmiConfig } from '@/lib/wagmi'

export const ENS_DISPLAY_STALE_TIME = 5 * 60 * 1000
export const ENS_DISPLAY_GC_TIME = 30 * 60 * 1000
export const ENS_EAGER_ADDRESS_LIMIT = 100
export const ENS_MAX_CONCURRENCY = 8

export type EnsResolutionStatus =
  | 'idle'
  | 'loading'
  | 'resolved'
  | 'not-found'
  | 'invalid'
  | 'error'

export interface EnsData {
  address: string
  name: string | null
  isLoading: boolean
  status: EnsResolutionStatus
  error: Error | null
}

interface UseEnsOptions {
  enableName?: boolean
  cacheDuration?: number
  /** The chain whose address record should be read (Sepolia on the public testnet). */
  targetChainId?: number
}

const useDebouncedValue = (value: string, delay: number) => {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timeout)
  }, [delay, value])

  return debounced
}

/** Resolve an address's verified primary name for display. */
export function useEns(
  address: string | undefined,
  options: UseEnsOptions = {}
): EnsData {
  const enabled = options.enableName ?? true
  const targetChainId = options.targetChainId ?? getTargetChainId()
  const cacheDuration = options.cacheDuration ?? ENS_DISPLAY_STALE_TIME
  const validAddress = Boolean(address && isAddress(address, { strict: false }))

  const query = useEnsName({
    address: validAddress ? (address as Address) : undefined,
    chainId: ENS_REGISTRY_CHAIN_ID,
    coinType: getEnsCoinType(targetChainId),
    query: {
      enabled: !REVIEW_FIXTURES_ENABLED && enabled && validAddress,
      staleTime: cacheDuration,
      gcTime: ENS_DISPLAY_GC_TIME,
      retry: 1,
    },
  })

  const isLoading = query.isPending && query.fetchStatus === 'fetching'
  const status: EnsResolutionStatus = !validAddress
    ? 'invalid'
    : !enabled || REVIEW_FIXTURES_ENABLED
      ? 'idle'
      : isLoading
        ? 'loading'
        : query.isError
          ? 'error'
          : query.data
            ? 'resolved'
            : 'not-found'

  return {
    address: validAddress ? address! : '',
    name: query.data ?? null,
    isLoading,
    status,
    error: query.error,
  }
}

/** Resolve a user-entered ENS name for a preview, with input debouncing. */
export function useResolveEnsName(
  input: string,
  options: UseEnsOptions & { debounceMs?: number } = {}
): EnsData {
  const enabled = options.enableName ?? true
  const targetChainId = options.targetChainId ?? getTargetChainId()
  const cacheDuration = options.cacheDuration ?? ENS_DISPLAY_STALE_TIME
  const normalizedName = normalizeEnsName(input)
  const debouncedName = useDebouncedValue(
    normalizedName ?? '',
    options.debounceMs ?? 300
  )
  const isDebouncing = Boolean(
    normalizedName && debouncedName !== normalizedName
  )

  const query = useEnsAddress({
    name: debouncedName || undefined,
    chainId: ENS_REGISTRY_CHAIN_ID,
    coinType: getEnsAddressCoinType(targetChainId),
    query: {
      enabled: Boolean(
        !REVIEW_FIXTURES_ENABLED && enabled && debouncedName && !isDebouncing
      ),
      staleTime: cacheDuration,
      gcTime: ENS_DISPLAY_GC_TIME,
      retry: 1,
    },
  })

  const isLoading = Boolean(
    normalizedName &&
      enabled &&
      !REVIEW_FIXTURES_ENABLED &&
      (isDebouncing || (query.isPending && query.fetchStatus === 'fetching'))
  )
  const status: EnsResolutionStatus = !input.trim()
    ? 'idle'
    : !normalizedName
      ? 'invalid'
      : !enabled || REVIEW_FIXTURES_ENABLED
        ? 'idle'
        : isLoading
          ? 'loading'
          : query.isError
            ? 'error'
            : query.data
              ? 'resolved'
              : 'not-found'

  return {
    address: query.data ?? '',
    name: query.data ? normalizedName : null,
    isLoading,
    status,
    error: query.error,
  }
}

/**
 * Return the uncached resolver used immediately before transactions. If a name
 * changed after its preview, refresh that preview cache before surfacing the
 * error so the UI displays the new destination for the required second review.
 */
export function useEnsResolver() {
  const config = useConfig()
  const queryClient = useQueryClient()
  const targetChainId = getTargetChainId()

  return useCallback(
    async (input: string, previewAddress?: Address | null) => {
      if (REVIEW_FIXTURES_ENABLED && normalizeEnsName(input)) {
        throw new Error('ENS resolution is disabled in review fixtures.')
      }
      try {
        return await resolveAccountIdentifierNow(
          config,
          input,
          targetChainId,
          previewAddress
        )
      } catch (error) {
        if (error instanceof EnsResolutionChangedError) {
          const options = getEnsAddressQueryOptions(config, {
            chainId: ENS_REGISTRY_CHAIN_ID,
            coinType: getEnsAddressCoinType(targetChainId),
            name: error.ensName,
          })
          queryClient.setQueryData(options.queryKey, error.currentAddress)
        }
        throw error
      }
    },
    [config, queryClient, targetChainId]
  )
}

/** Resolve a bounded, deduplicated set of primary names with limited fan-out. */
export function useBatchEnsQuery(
  addresses: Hex[],
  options: UseEnsOptions = {}
) {
  const targetChainId = options.targetChainId ?? getTargetChainId()
  const cacheDuration = options.cacheDuration ?? ENS_DISPLAY_STALE_TIME
  const lookupAddresses = useMemo(
    () =>
      [
        ...new Map(
          addresses.map((address) => [address.toLowerCase(), address])
        ).values(),
      ].slice(0, ENS_EAGER_ADDRESS_LIMIT),
    [addresses]
  )
  const canonicalAddresses = useMemo(
    () =>
      [...lookupAddresses].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase())
      ),
    [lookupAddresses]
  )
  const queryKey = useMemo(
    () => ['batch-ens', targetChainId, canonicalAddresses] as const,
    [canonicalAddresses, targetChainId]
  )

  return useQuery({
    queryKey,
    queryFn: async ({ client }) => {
      const results: Record<string, EnsData> = {}
      let nextIndex = 0

      const worker = async () => {
        while (nextIndex < lookupAddresses.length) {
          const address = lookupAddresses[nextIndex++]
          try {
            const name = await client.fetchQuery({
              ...getEnsNameQueryOptions(makeWagmiConfig(), {
                address,
                chainId: ENS_REGISTRY_CHAIN_ID,
                coinType: getEnsCoinType(targetChainId),
              }),
              staleTime: cacheDuration,
              gcTime: ENS_DISPLAY_GC_TIME,
            })
            const data: EnsData = {
              address,
              name: name ?? null,
              isLoading: false,
              status: name ? 'resolved' : 'not-found',
              error: null,
            }
            results[address] = data
            results[address.toLowerCase()] = data
            client.setQueryData(queryKey, { ...results })
          } catch (cause) {
            const error =
              cause instanceof Error ? cause : new Error('ENS lookup failed')
            const data: EnsData = {
              address,
              name: null,
              isLoading: false,
              status: 'error',
              error,
            }
            results[address] = data
            results[address.toLowerCase()] = data
            client.setQueryData(queryKey, { ...results })
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(ENS_MAX_CONCURRENCY, lookupAddresses.length) },
          worker
        )
      )
      return results
    },
    enabled: !REVIEW_FIXTURES_ENABLED && lookupAddresses.length > 0,
    staleTime: cacheDuration,
    gcTime: ENS_DISPLAY_GC_TIME,
  })
}
