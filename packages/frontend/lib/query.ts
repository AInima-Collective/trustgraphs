import { QueryClient } from '@tanstack/react-query'
import { hashFn } from 'wagmi/query'

export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // Consider data stale after 30 seconds (data may change each block).
        staleTime: 30 * 1000,
        // Cache data for 5 minutes
        gcTime: 5 * 60 * 1000,
        // Retry on failure
        retry: 3,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
        // Refetch on page load and window focus to keep data fresh.
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        // Serialize BigInts in parameters
        queryKeyHashFn: hashFn,
      },
      mutations: {
        // Retry mutations once on failure
        retry: 1,
      },
    },
  })
