'use client'

import Clarity from '@microsoft/clarity'
import { PonderProvider } from '@ponder/react'
import { QueryClientProvider } from '@tanstack/react-query'
import PlausibleProvider from 'next-plausible'
import React from 'react'
import { WagmiProvider } from 'wagmi'

import { CatalogProvider } from '@/contexts/CatalogContext'
import { type Catalog } from '@/lib/catalog'
import { ponderClient } from '@/lib/ponder'
import { makeQueryClient } from '@/lib/query'
import { makeWagmiConfig } from '@/lib/wagmi'

import { BreadcrumbSync } from './BreadcrumbSync'
import { Toaster } from './toasts/Toaster'
import { WalletConnectionProvider } from './WalletConnectionProvider'

Clarity.init('tjxevwhvhb')

const queryClient = makeQueryClient()
const wagmiConfig = makeWagmiConfig()

export function Providers({
  children,
  // The trust-graph catalog as the server read it (`lib/catalog.server.getCatalog`). Passing it
  // down means the first paint already lists every network that exists on chain, instead of the
  // build-time seed followed by a flash.
  catalog,
}: {
  children: React.ReactNode
  catalog?: Catalog
}) {
  return (
    <PlausibleProvider
      domain="trustgraph.network"
      taggedEvents
      trackOutboundLinks
    >
      <WagmiProvider config={wagmiConfig}>
        <PonderProvider client={ponderClient}>
          <QueryClientProvider client={queryClient}>
            <CatalogProvider initial={catalog}>
              <WalletConnectionProvider>
                {children}

                <Toaster />
                <BreadcrumbSync />

                {/* {process.env.NODE_ENV === "development" && (
                <ReactQueryDevtools initialIsOpen={false} />
              )} */}
              </WalletConnectionProvider>
            </CatalogProvider>
          </QueryClientProvider>
        </PonderProvider>
      </WagmiProvider>
    </PlausibleProvider>
  )
}
