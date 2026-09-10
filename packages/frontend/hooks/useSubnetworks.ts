import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'

import {
  fetchSubnetworkChildren,
  fetchSubnetworkParent,
} from '@/lib/subnetwork'

export const useSubnetworkParent = (childInstanceId: Hex | undefined) =>
  useQuery({
    queryKey: ['subnetwork-parent', childInstanceId?.toLowerCase()],
    queryFn: () => fetchSubnetworkParent(childInstanceId!),
    enabled: !!childInstanceId,
    refetchInterval: 30_000,
  })

export const useSubnetworkChildren = (
  parentInstanceId: Hex | undefined,
  status: 'active' | 'pending' = 'active'
) =>
  useQuery({
    queryKey: ['subnetwork-children', parentInstanceId?.toLowerCase(), status],
    queryFn: () => fetchSubnetworkChildren(parentInstanceId!, status),
    enabled: !!parentInstanceId,
    refetchInterval: 30_000,
  })
