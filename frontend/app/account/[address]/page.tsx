import { getPonderQueryOptions } from '@ponder/react'
import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import { notFound, redirect } from 'next/navigation'
import { type Hex, isAddress } from 'viem'
import { getEnsNameQueryOptions } from 'wagmi/query'

import { normalizeEnsName } from '@/lib/ens'
import {
  ENS_REGISTRY_CHAIN_ID,
  EnsNameNotFoundError,
  getEnsCoinType,
  resolveEnsNameNow,
} from '@/lib/ens-query'
import { ponderClient } from '@/lib/ponder'
import { makeQueryClient } from '@/lib/query'
import { REVIEW_FIXTURES_ENABLED } from '@/lib/review-fixture-query'
import { getTargetChainId, makeWagmiConfig } from '@/lib/wagmi'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

import { AccountProfilePage } from './component'

// Incremental Static Regeneration
export const dynamic = 'force-static'
export const revalidate = 900 // 15 minutes

export default async function AccountProfilePageServer({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address: _address } = await params

  const queryClient = makeQueryClient()
  const wagmiConfig = makeWagmiConfig()

  let address: Hex
  if (isAddress(_address, { strict: false })) {
    address = _address.toLowerCase() as Hex
    if (_address !== address) redirect(`/account/${address}`)
  } else {
    const name = normalizeEnsName(_address)
    if (!name || REVIEW_FIXTURES_ENABLED) notFound()

    const resolved = await resolveEnsNameNow(
      wagmiConfig,
      name,
      getTargetChainId()
    ).catch((error: unknown) => {
      if (error instanceof EnsNameNotFoundError) notFound()
      throw error
    })
    redirect(`/account/${resolved.address.toLowerCase()}`)
  }

  const [ensName] = await Promise.all([
    // ENS name
    queryClient
      .fetchQuery(
        getEnsNameQueryOptions(wagmiConfig, {
          address,
          chainId: ENS_REGISTRY_CHAIN_ID,
          coinType: getEnsCoinType(getTargetChainId()),
        })
      )
      .catch(() => null),

    // Account stats
    queryClient.prefetchQuery(
      getPonderQueryOptions(
        ponderClient,
        ponderQueryFns.getAttestationsGiven({ address })
      )
    ),
    queryClient.prefetchQuery(
      getPonderQueryOptions(
        ponderClient,
        ponderQueryFns.getAttestationsReceived({ address })
      )
    ),

    // Attestations
    queryClient.prefetchQuery(
      getPonderQueryOptions(
        ponderClient,
        ponderQueryFns.getAttestations({ account: address })
      )
    ),

    // Networks
    queryClient.prefetchQuery(ponderQueries.accountNetworkProfiles(address)),
    queryClient.prefetchQuery(ponderQueries.accountAgents(address)),
  ])

  const dehydratedState = dehydrate(queryClient)

  return (
    <HydrationBoundary state={dehydratedState}>
      <AccountProfilePage address={address} ensName={ensName} />
    </HydrationBoundary>
  )
}
