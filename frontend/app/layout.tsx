import './globals.css'

import clsx from 'clsx'
import type { Metadata, Viewport } from 'next'
import { Instrument_Serif } from 'next/font/google'
import localFont from 'next/font/local'
import { ReactNode } from 'react'

import { Footer } from '@/components/Footer'
import { Nav } from '@/components/Nav'
import { Providers } from '@/components/providers'
import { getCatalog } from '@/lib/catalog.server'

// Two families ship, and that is the whole type system. PaperMono carries
// every label, control, and number; Instrument Serif carries the display voice
// (page titles, the hero, pull quotes). The four other serifs and the runtime
// [data-type] switcher they were loaded for came down with /lab once the
// direction was chosen. See app/tokens.css.
const paperMono = localFont({
  src: '../public/fonts/PaperMono-Regular.woff2',
  variable: '--font-paper-mono',
  display: 'swap',
})

// Roman only. The italic was loaded, preloaded and never painted: `.tg-serif-italic` has
// no call sites and the app's `italic` classes are all on mono text. It was 27% of the
// preloaded font bytes on every page.
const instrument = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-instrument',
  display: 'swap',
})

const fontVariables = [paperMono.variable, instrument.variable]

const DESCRIPTION =
  'trustgraphs turn graph data into results anyone can verify, compose, and use.'

// No `icons` key on purpose. Next picks up app/icon.svg, app/apple-icon.png and
// app/favicon.ico from the file conventions, and a manual `icons` array
// silently replaces all three — which is how the old blue asterisk PNGs
// outlived the mark they were drawn from. Same for `openGraph.images`:
// app/opengraph-image.png and app/twitter-image.png are wired automatically.
// Regenerate every one of them with `pnpm run brand:assets`.
export const metadata: Metadata = {
  metadataBase: new URL('https://trustgraph.network'),
  title: {
    default: 'Trustgraphs',
    template: '%s | Trustgraphs',
  },
  description: DESCRIPTION,
  applicationName: 'Trustgraphs',
  openGraph: {
    type: 'website',
    url: 'https://trustgraph.network',
    siteName: 'Trustgraphs',
    title: 'Trustgraphs',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    site: '@trustgraphs',
    creator: '@trustgraphs',
    title: 'Trustgraphs',
    description: DESCRIPTION,
  },
}

// No `maximumScale` and no `userScalable: false`. Locking zoom is a WCAG 1.4.4
// failure on every page, and the reason it usually gets added — iOS zooming in
// when a text input takes focus — is already handled properly by the 16px
// input rule in globals.css.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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

  // THE REASON DOES NOT CROSS THE CLIENT BOUNDARY. `Providers` is a client
  // component, so whatever it is handed is serialized into the RSC flight
  // payload embedded in the HTML — and `components/CatalogUnavailable.tsx`
  // spends fifteen lines establishing that this exact string must never reach
  // the DOM, "not in the card, not in a title attribute". It was reaching it
  // one layer above the component that refuses it, on every request, on all
  // three routes including a questions page that has nothing to do with the
  // catalog: `"error":"fetch failed"` in 27 of 27 sampled responses.
  //
  // Nothing on the client reads the reason, only whether there was one, and
  // `live` already carries that. So the flag survives and the diagnostic stays
  // in the server log, which is where whoever is debugging this is looking.
  const clientCatalog = catalog.error
    ? { ...catalog, error: 'unavailable' }
    : catalog

  return (
    // suppressHydrationWarning: next-themes stamps [data-theme] on <html>
    // before React hydrates, which is a deliberate mismatch rather than a bug.
    // The font variable classes belong on <html>, not <body>: tokens.css builds
    // --mono-family / --display-family at :root, and a var() that resolves to
    // nothing there makes the whole declaration invalid at computed-value time
    // — which silently drops the page to a system sans.
    <html lang="en" className={clsx(fontVariables)} suppressHydrationWarning>
      <body className="font-mono text-foreground">
        <div className="min-h-screen root flex flex-col p-safe-or-2 sm:p-safe-or-4 md:p-safe-or-6 max-w-7xl mx-auto">
          <Providers catalog={clientCatalog}>
            {/* Account for the footer, but make sure to push it down below the initial page */}
            <div className="flex flex-col min-h-[calc(100vh-2rem)]">
              <Nav />

              {/* Vertical padding only. `main` used to carry `p-2` below `sm`
               * inside an already-padded frame, which inset every rule and word
               * on the page 8px further than the nav rule above them and the
               * footer rule below them. One gutter, owned by the frame. */}
              <main className="py-2 mt-4 sm:py-4 sm:mt-6 flex-1 grow [@media(max-height:480px)]:mt-2 [@media(max-height:480px)]:py-1">
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
