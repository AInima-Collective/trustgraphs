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
import { ThemeProvider } from './theme-provider'
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
      {/* Dark is the default, not a preference we infer: the trustgraphs ramp is
       * designed against the near-black canvas and the graph is tuned for it.
       * enableSystem would hand first-time visitors the light theme roughly
       * half the time, which is the wrong first impression. Light stays one
       * click away in the nav. */}
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="dark"
        enableSystem={false}
        disableTransitionOnChange
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
      </ThemeProvider>
    </PlausibleProvider>
  )
}
