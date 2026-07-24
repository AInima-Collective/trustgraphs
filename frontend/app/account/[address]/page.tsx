import { getPonderQueryOptions } from '@ponder/react'
import { HydrationBoundary, dehydrate } from '@tanstack/react-query'
import { Hex } from 'viem'
import { getEnsAddressQueryOptions, getEnsNameQueryOptions } from 'wagmi/query'

import { ponderClient } from '@/lib/ponder'
import { makeQueryClient } from '@/lib/query'
import { mightBeEnsName } from '@/lib/utils'
import { makeWagmiConfig } from '@/lib/wagmi'
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

  const [[address, ensName]] = await Promise.all([
    Promise.resolve(
      mightBeEnsName(_address)
        ? queryClient
            .fetchQuery(
              getEnsAddressQueryOptions(wagmiConfig, {
                name: _address,
                chainId: 1,
              })
            )
            .then((address) => address as Hex)
            .catch(() => _address as Hex)
        : (_address as Hex)
    ).then((address) =>
      Promise.all([
        address,

        // ENS name
        queryClient
          .fetchQuery(
            getEnsNameQueryOptions(wagmiConfig, {
              address,
              chainId: 1,
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
            ponderQueryFns.getAttestations({
              account: address,
            })
          )
        ),

        // Networks
        queryClient.prefetchQuery(
          ponderQueries.accountNetworkProfiles(address)
        ),
      ])
    ),
  ])

  const dehydratedState = dehydrate(queryClient)

  return (
    <HydrationBoundary state={dehydratedState}>
      <AccountProfilePage address={address} ensName={ensName} />
    </HydrationBoundary>
  )
}
