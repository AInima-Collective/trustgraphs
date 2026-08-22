import { getPonderQueryOptions } from '@ponder/react'
import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import { Hex } from 'viem'
import { getEnsNameQueryOptions } from 'wagmi/query'

import { ENS_REGISTRY_CHAIN_ID, getEnsCoinType } from '@/lib/ens-query'
import { ponderClient } from '@/lib/ponder'
import { nullable } from '@/lib/ponder-query'
import { makeQueryClient } from '@/lib/query'
import { getTargetChainId, makeWagmiConfig } from '@/lib/wagmi'
import { ponderQueryFns } from '@/queries/ponder'

import { AttestationDetailPage } from './component'

// Incremental Static Regeneration
export const dynamic = 'force-static'

export default async function AttestationDetailPageServer({
  params,
}: {
  params: Promise<{ uid: Hex }>
}) {
  const { uid } = await params

  const queryClient = makeQueryClient()

  // `nullable` so an unknown uid is a miss, not a thrown query. The `.catch` below would swallow
  // it either way, but it would swallow it into the DEHYDRATED cache as an error, so the client
  // re-fetches on hydration and a plain "not found" costs a round trip and a console stack.
  const attestation = await queryClient
    .fetchQuery(
      nullable(
        getPonderQueryOptions(ponderClient, ponderQueryFns.getAttestation(uid))
      )
    )
    .catch(() => null)

  // Resolve ENS names.
  if (attestation) {
    const wagmiConfig = makeWagmiConfig()
    await Promise.all([
      queryClient.prefetchQuery(
        getEnsNameQueryOptions(wagmiConfig, {
          address: attestation.attester,
          chainId: ENS_REGISTRY_CHAIN_ID,
          coinType: getEnsCoinType(getTargetChainId()),
        })
      ),
      queryClient.prefetchQuery(
        getEnsNameQueryOptions(wagmiConfig, {
          address: attestation.recipient,
          chainId: ENS_REGISTRY_CHAIN_ID,
          coinType: getEnsCoinType(getTargetChainId()),
        })
      ),
    ])
  }

  const dehydratedState = dehydrate(queryClient)

  return (
    <HydrationBoundary state={dehydratedState}>
      <AttestationDetailPage uid={uid} />
    </HydrationBoundary>
  )
}
