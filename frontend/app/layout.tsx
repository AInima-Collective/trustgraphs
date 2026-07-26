import './globals.css'

import clsx from 'clsx'
import type { Metadata, Viewport } from 'next'
import {
  Cormorant_Garamond,
  EB_Garamond,
  Instrument_Serif,
  Newsreader,
  Spectral,
} from 'next/font/google'
import localFont from 'next/font/local'
import { ReactNode } from 'react'

import { Footer } from '@/components/Footer'
import { Nav } from '@/components/Nav'
import { Providers } from '@/components/providers'
import { getCatalog } from '@/lib/catalog.server'

// PaperMono is TrustGraph's own face and carries every label, control, and
// number. It does not change across the [data-type] axis — only the display
// serif does, so a lab comparison isolates exactly one variable.
const paperMono = localFont({
  src: '../public/fonts/PaperMono-Regular.woff2',
  variable: '--font-paper-mono',
  display: 'swap',
})

// The five display candidates. All five ship until the type axis is settled on
// /lab; once it is, delete the four that lost and the payload drops with them.
// See app/tokens.css for what each one is for.
const instrument = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument',
  display: 'swap',
})
const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
})
const ebGaramond = EB_Garamond({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-garamond',
  display: 'swap',
})
const spectral = Spectral({
  subsets: ['latin'],
  weight: ['200', '300', '400', '500'],
  style: ['normal', 'italic'],
  variable: '--font-spectral',
  display: 'swap',
})
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
  display: 'swap',
})

const fontVariables = [
  paperMono.variable,
  instrument.variable,
  cormorant.variable,
  ebGaramond.variable,
  spectral.variable,
  newsreader.variable,
]

// Restores the [data-type] selection before first paint. next-themes already
// does this job for [data-theme]; the type axis needs its own two lines. Kept
// inline and dependency-free so it runs ahead of any bundle.
const TYPE_BOOT = `try{var t=localStorage.getItem('tg-type');if(t)document.documentElement.setAttribute('data-type',t)}catch(e){}`

export const metadata: Metadata = {
  metadataBase: new URL('https://trustgraph.network'),
  title: 'TrustGraph',
  description: 'Mapping trust networks through attestations.',
  applicationName: 'Trust Graph',
  icons: [
    {
      url: '/images/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
    },
    {
      url: '/images/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
    },
  ],
  openGraph: {
    type: 'website',
    url: 'https://trustgraph.network',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  // The trust-graph directory is a RUNTIME read now (GOAL.md M3): networks are created by
  // `TrustGraphFactory` at any moment, so the app asks the indexer which ones exist rather than
  // shipping a list. Reading it once here means every screen — client and server — shares one
  // fetch per request and renders the same set. `getCatalog` never throws; on an indexer failure
  // it degrades to the shipped list and flags the error for the UI to show.
  const catalog = await getCatalog()

  return (
    // suppressHydrationWarning: next-themes and the type-boot script both stamp
    // attributes on <html> before React hydrates, which is a deliberate
    // mismatch rather than a bug.
    // The font variable classes belong on <html>, not <body>: tokens.css builds
    // --mono-family / --display-family at :root, and a var() that resolves to
    // nothing there makes the whole declaration invalid at computed-value time
    // — which silently drops the page to a system sans.
    <html
      lang="en"
      data-type="instrument"
      className={clsx(fontVariables)}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: TYPE_BOOT }} />
      </head>
      <body className="font-mono text-foreground">
        <div className="min-h-screen root flex flex-col p-safe-or-2 sm:p-safe-or-4 md:p-safe-or-6 max-w-7xl mx-auto">
          <Providers catalog={catalog}>
            {/* Account for the footer, but make sure to push it down below the initial page */}
            <div className="flex flex-col min-h-[calc(100vh-2rem)]">
              <Nav />

              <main className="p-2 mt-4 sm:px-0 sm:py-4 sm:mt-6 flex-1 grow">
                {children}
              </main>
            </div>

            <Footer />
          </Providers>
        </div>
      </body>
    </html>
  )
}
