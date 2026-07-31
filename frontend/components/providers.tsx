'use client'

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

/**
 * Session recording, started from an effect rather than from module scope.
 *
 * At module scope this ran during import, which meant a first-time visitor
 * reading the questions page had already been beaconed to three Microsoft
 * hosts (`clarity.ms` twice plus `c.bing.com`) before they had done anything at
 * all, on a page with no account, no wallet and nothing to record. An effect
 * runs after paint, in the browser only, and can be skipped where it makes no
 * sense: a preview deploy is not a session worth recording, and a developer's
 * localhost certainly is not.
 */
function useClarity() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (window.location.hostname !== 'trustgraph.network') return
    let cancelled = false
    import('@microsoft/clarity').then((mod) => {
      if (!cancelled) mod.default.init('tjxevwhvhb')
    })
    return () => {
      cancelled = true
    }
  }, [])
}

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
  useClarity()

  // PER-RENDER, NOT PER-MODULE. At module scope one QueryClient is shared by
  // every server render for the life of the process: React Query writes the
  // query into that cache on the first render and thereafter ignores
  // `initialData`, so the `catalog` prop this component is handed stops being
  // read on the server after request #1. The client half wants one instance per
  // browser session, which is what the lazy initialiser gives it.
  const [queryClient] = React.useState(makeQueryClient)

  // Same lazy treatment, for a different reason: building the config
  // instantiates every connector, and the Coinbase SDK alone is 460 KB that
  // used to download on a route with no wallet UI on it.
  const [wagmiConfig] = React.useState(makeWagmiConfig)

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
