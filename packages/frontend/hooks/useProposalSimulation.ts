'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { usePublicClient } from 'wagmi'

import { useNetwork } from '@/contexts/NetworkContext'
import {
  type SafeAction,
  describeRevertData,
  governanceActionContextFor,
} from '@/lib/actions'
import { simulateGovernanceActions } from '@/lib/governance-simulation'
import { getTargetChainId } from '@/lib/wagmi'

/** Dry-run the encoded legs from the network Safe; re-runs when the legs change. */
export function useProposalSimulation(
  actions: readonly SafeAction[],
  enabled: boolean
) {
  const { network } = useNetwork()
  const chainId = getTargetChainId()
  const publicClient = usePublicClient({ chainId })
  const context = useMemo(() => governanceActionContextFor(network), [network])
  const safe = context.treasurySafe
  const fingerprint = JSON.stringify(
    actions.map((action) => [
      action.target,
      action.value,
      action.data,
      action.operation,
    ])
  )
  return useQuery({
    queryKey: ['governance-simulation', chainId, safe, fingerprint],
    queryFn: () =>
      simulateGovernanceActions(publicClient!, {
        safe: safe!,
        actions,
        describeRevert: (data) => describeRevertData(context, data),
      }),
    enabled: enabled && !!publicClient && !!safe && actions.length > 0,
    staleTime: 30_000,
    retry: false,
  })
}
