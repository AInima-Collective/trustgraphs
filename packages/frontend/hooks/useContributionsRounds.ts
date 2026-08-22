import { useQuery } from '@tanstack/react-query'
import { type Hex } from 'viem'

import {
  fetchContributionsInstances,
  toContributionsNetwork,
} from '@/lib/contributions-catalog'
import { ContributionsNetwork } from '@/lib/types'

/**
 * The contribution rounds hung on one trust network (by `parentInstanceId`), newest first, from
 * the indexer's round catalog. Client-side counterpart of `loadContributionsCatalog`: an
 * unreachable indexer degrades to an empty list plus `isError`, never a crash.
 */
export const useContributionsRounds = (
  parentInstanceId: Hex | undefined
): { rounds: ContributionsNetwork[]; isLoading: boolean; isError: boolean } => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['contributions-rounds', parentInstanceId?.toLowerCase()],
    queryFn: async () => {
      const rows = await fetchContributionsInstances(parentInstanceId)
      return rows.map(toContributionsNetwork)
    },
    enabled: !!parentInstanceId,
    refetchInterval: 30_000,
  })
  return { rounds: data ?? [], isLoading, isError }
}
