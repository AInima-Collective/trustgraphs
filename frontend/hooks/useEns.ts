'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { Hex } from 'viem'
import { normalize } from 'viem/ens'
import { useEnsAddress, useEnsAvatar, useEnsName } from 'wagmi'
import { getEnsAvatarQueryOptions, getEnsNameQueryOptions } from 'wagmi/query'

import { REVIEW_FIXTURES_ENABLED } from '@/lib/review-fixture-query'
import { makeWagmiConfig } from '@/lib/wagmi'

interface EnsData {
  address: string
  name: string | null
  avatar: string | null
  isLoading: boolean
}

interface UseEnsOptions {
  /** Enable ENS name resolution */
  enableName?: boolean
  /** Enable ENS avatar resolution */
  enableAvatar?: boolean
  /** Cache duration in milliseconds */
  cacheDuration?: number
  /** Whether to persist cache in localStorage */
  persistCache?: boolean
  /** Custom chain ID for ENS resolution */
  chainId?: number
}

const DEFAULT_OPTIONS: Required<UseEnsOptions> = {
  enableName: true,
  enableAvatar: true,
  cacheDuration: 5 * 60 * 1000, // 5 minutes
  persistCache: true,
  chainId: 1, // Mainnet for ENS
}

// Local cache for ENS data to persist across sessions
const ENS_CACHE_KEY = 'ens-cache'
const MAX_CACHE_SIZE = 500 // Maximum number of addresses to cache

interface CacheEntry {
  address: string
  name: string | null
  avatar: string | null
  timestamp: number
  expiresAt: number
}

class EnsCacheManager {
  private static instance: EnsCacheManager | null = null
  /**
   * Map of addresses to ENS data
   */
  private cache: Record<string, CacheEntry> = {}
  /**
   * Map of ENS names to addresses
   */
  private nameCache: Record<string, string | null> = {}
  private initialized = false

  static getInstance(): EnsCacheManager {
    if (!EnsCacheManager.instance) {
      EnsCacheManager.instance = new EnsCacheManager()
    }
    return EnsCacheManager.instance
  }

  private constructor() {
    if (typeof window !== 'undefined') {
      this.loadFromStorage()
      this.initialized = true
    }
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(ENS_CACHE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, CacheEntry>
        // Filter out expired entries
        const now = Date.now()
        this.cache = Object.fromEntries(
          Object.entries(parsed).filter(([, entry]) => entry.expiresAt > now)
        )
        this.nameCache = Object.fromEntries(
          Object.entries(this.cache)
            .filter(([, entry]) => entry.name)
            .map(([address, entry]) => [normalize(entry.name!), address])
        )
      }
    } catch (error) {
      console.warn('Failed to load ENS cache from localStorage:', error)
      this.cache = {}
    }
  }

  private saveToStorage() {
    if (!this.initialized) return

    try {
      // Limit cache size by removing oldest entries
      const entries = Object.entries(this.cache)
      if (entries.length > MAX_CACHE_SIZE) {
        const sorted = entries.sort(([, a], [, b]) => b.timestamp - a.timestamp)
        this.cache = Object.fromEntries(sorted.slice(0, MAX_CACHE_SIZE))
      }

      localStorage.setItem(ENS_CACHE_KEY, JSON.stringify(this.cache))
    } catch (error) {
      console.warn('Failed to save ENS cache to localStorage:', error)
    }
  }

  get(address: string): CacheEntry | null {
    const entry = this.cache[address.toLowerCase()]
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
      delete this.cache[address.toLowerCase()]
      this.saveToStorage()
      return null
    }

    return entry
  }

  getByName(name: string): CacheEntry | null {
    const address = this.nameCache[normalize(name)] || null
    if (!address) {
      return null
    }
    return this.get(address)
  }

  set(
    address: string,
    name: string | null,
    avatar: string | null,
    cacheDuration: number
  ) {
    const now = Date.now()
    const lowerAddress = address.toLowerCase()
    const cacheEntry: CacheEntry = {
      address: lowerAddress,
      name,
      avatar,
      timestamp: now,
      expiresAt: now + cacheDuration,
    }
    this.cache[lowerAddress] = cacheEntry
    if (name) {
      this.nameCache[normalize(name)] = lowerAddress
    }
    this.saveToStorage()
  }

  clear() {
    this.cache = {}
    this.nameCache = {}
    this.saveToStorage()
  }
}

/**
 * Custom hook for ENS resolution with advanced caching and performance optimizations
 */
export function useEns(
  address: string | undefined,
  options: UseEnsOptions = {}
): EnsData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const cache = EnsCacheManager.getInstance()

  const normalizedAddress = address?.toLowerCase()
  const isValidAddress = Boolean(
    address && address.startsWith('0x') && address.length === 42
  )

  // Check cache first
  const cachedData = useMemo(() => {
    if (!isValidAddress || !opts.persistCache) return null
    return cache.get(normalizedAddress!)
  }, [normalizedAddress, isValidAddress, opts.persistCache])

  // ENS name resolution
  const {
    data: ensName,
    isLoading: nameLoading,
    error: nameError,
  } = useEnsName({
    address: address as `0x${string}`,
    chainId: opts.chainId,
    query: {
      enabled: Boolean(
        !REVIEW_FIXTURES_ENABLED &&
          opts.enableName &&
          isValidAddress &&
          !cachedData?.name
      ),
      staleTime: opts.cacheDuration,
      gcTime: opts.cacheDuration * 2,
      retry: (failureCount) => failureCount < 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    },
  })

  // ENS avatar resolution (only if name exists)
  const {
    data: ensAvatar,
    isLoading: avatarLoading,
    error: avatarError,
  } = useEnsAvatar({
    name: ensName || cachedData?.name || undefined,
    chainId: opts.chainId,
    query: {
      enabled: Boolean(
        !REVIEW_FIXTURES_ENABLED &&
          opts.enableAvatar &&
          !!(ensName || cachedData?.name) &&
          !cachedData?.avatar
      ),
      staleTime: opts.cacheDuration,
      gcTime: opts.cacheDuration * 2,
      retry: (failureCount) => failureCount < 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    },
  })

  // Update cache when we get new data
  const updateCache = useCallback(() => {
    if (!isValidAddress || !opts.persistCache) return

    const newName = ensName || cachedData?.name || null
    const newAvatar = ensAvatar || cachedData?.avatar || null

    // Only update cache if we have new data or if cache is missing
    if (
      !cachedData ||
      newName !== cachedData.name ||
      newAvatar !== cachedData.avatar
    ) {
      cache.set(normalizedAddress!, newName, newAvatar, opts.cacheDuration)
    }
  }, [
    isValidAddress,
    opts.persistCache,
    opts.cacheDuration,
    ensName,
    ensAvatar,
    cachedData,
    normalizedAddress,
  ])

  // Update cache when data changes
  useMemo(() => {
    if (ensName !== undefined || ensAvatar !== undefined) {
      updateCache()
    }
  }, [ensName, ensAvatar, updateCache])

  // Return combined data
  return useMemo(() => {
    if (!isValidAddress) {
      return {
        address: '',
        name: null,
        avatar: null,
        isLoading: false,
      }
    }

    // Use cached data if available
    if (cachedData && !nameLoading && !avatarLoading) {
      return {
        address: cachedData.address,
        name: cachedData.name,
        avatar: cachedData.avatar,
        isLoading: false,
      }
    }

    return {
      address: normalizedAddress!,
      name: ensName || cachedData?.name || null,
      avatar: ensAvatar || cachedData?.avatar || null,
      isLoading: nameLoading || avatarLoading,
    }
  }, [
    isValidAddress,
    cachedData,
    ensName,
    ensAvatar,
    nameLoading,
    avatarLoading,
    nameError,
    avatarError,
  ])
}

/**
 * Custom hook for ENS name resolution with advanced caching and performance optimizations
 */
export function useResolveEnsName(
  name: string,
  options: UseEnsOptions = {}
): EnsData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const cache = EnsCacheManager.getInstance()

  let normalizedName: string | undefined
  try {
    normalizedName = name && normalize(name)
  } catch {}

  // Check cache first
  const cachedData = useMemo(() => {
    if (!normalizedName || !opts.persistCache) return null
    return cache.getByName(normalizedName)
  }, [normalizedName, opts.persistCache])

  // ENS address resolution
  const {
    data: address,
    isLoading: isResolvingEnsAddress,
    error: ensAddressError,
  } = useEnsAddress({
    name: normalizedName,
    chainId: opts.chainId,
    query: {
      enabled: Boolean(
        !REVIEW_FIXTURES_ENABLED &&
          opts.enableName &&
          normalizedName &&
          !cachedData
      ),
      staleTime: opts.cacheDuration,
      gcTime: opts.cacheDuration * 2,
      retry: (failureCount) => failureCount < 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    },
  })

  const resolvedEns = useEns(address || undefined, opts)

  return useMemo(
    () =>
      cachedData
        ? {
            address: cachedData.address,
            name: cachedData.name,
            avatar: cachedData.avatar,
            isLoading: false,
          }
        : isResolvingEnsAddress || ensAddressError
          ? {
              address: '',
              name: null,
              avatar: null,
              isLoading: isResolvingEnsAddress,
            }
          : resolvedEns,
    [isResolvingEnsAddress, ensAddressError, resolvedEns, cachedData]
  )
}

/**
 * Hook for batch ENS resolution of multiple addresses
 */
export function useBatchEnsQuery(
  addresses: Hex[],
  options: UseEnsOptions = {}
) {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  return useQuery({
    queryKey: ['batch-ens', addresses, opts],
    queryFn: async ({ client }) => {
      const results: Record<string, EnsData> = {}

      // Process addresses in batches to avoid overwhelming the RPC
      const batchSize = 10
      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize)

        await Promise.all(
          batch.map(async (address) => {
            try {
              const cache = EnsCacheManager.getInstance()
              const cached = cache.get(address)

              if (cached) {
                results[address] = {
                  address,
                  name: cached.name,
                  avatar: cached.avatar,
                  isLoading: false,
                }
              } else {
                const wagmiConfig = makeWagmiConfig()
                const ensName = await client.fetchQuery(
                  getEnsNameQueryOptions(wagmiConfig, {
                    chainId: opts.chainId,
                    address,
                  })
                )
                const ensAvatar = ensName
                  ? await client.fetchQuery(
                      getEnsAvatarQueryOptions(wagmiConfig, {
                        chainId: opts.chainId,
                        name: ensName,
                      })
                    )
                  : null

                cache.set(
                  address.toLowerCase(),
                  ensName,
                  ensAvatar,
                  opts.cacheDuration
                )

                results[address] = {
                  address,
                  name: ensName,
                  avatar: ensAvatar,
                  isLoading: false,
                }
              }
            } catch {
              results[address] = {
                address,
                name: null,
                avatar: null,
                isLoading: false,
              }
            }
          })
        )
      }

      return results
    },
    enabled: !REVIEW_FIXTURES_ENABLED && addresses.length > 0,
    staleTime: opts.cacheDuration,
    gcTime: opts.cacheDuration * 2,
  })
}

/**
 * Utility function to clear ENS cache
 */
export function clearEnsCache() {
  EnsCacheManager.getInstance().clear()
}

/**
 * Hook that returns ENS utilities
 */
export function useEnsUtils() {
  return {
    clearCache: clearEnsCache,
    isValidAddress: (address: string) =>
      address && address.startsWith('0x') && address.length === 42,
  }
}
