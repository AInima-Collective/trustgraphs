'use client'

import dynamic from 'next/dynamic'

import { BrandMark } from '@/components/BrandMark'
import { NetworkProvider, useNetwork } from '@/contexts/NetworkContext'
import { Network } from '@/lib/types'

/**
 * The live graph in the hero, and the only client island on the landing page.
 *
 * Everything else on `/` is server-rendered marketing copy, so keeping the
 * graph behind its own boundary is what stops a static page from shipping the
 * whole sigma/graphology/WebGL stack to a visitor who came for a sentence.
 *
 * Sigma paints through WebGL, which does not exist on the server, hence
 * `ssr: false`. The graph runs one short force-atlas pass on mount and then
 * holds still: it is moving when the page arrives, which is the point, and it
 * is not animating afterwards, which is what makes it safe under reduced
 * motion.
 *
 * This component owns the `<figure>` rather than taking one from the page.
 * `<figcaption>` only names its figure when it is a DIRECT child, and with the
 * figure on the server and the caption two divs down inside the island, the
 * hero was a canvas with no accessible name at all.
 */
const NetworkGraph = dynamic(
  () => import('@/components/NetworkGraph').then((mod) => mod.NetworkGraph),
  { ssr: false }
)

const CAPTION_LIVE = 'Demo Co-op, live. Each line is a vouch. Size is score.'
const CAPTION_PENDING = 'Demo Co-op. Each line is a vouch. Size is score.'

export function HeroGraph({
  network,
  className,
}: {
  network: Network
  className?: string
}) {
  return (
    <NetworkProvider network={network}>
      <HeroGraphFigure className={className} />
    </NetworkProvider>
  )
}

function HeroGraphFigure({ className }: { className?: string }) {
  const { isLoading, error, accountData } = useNetwork()
  const live = !isLoading && !error && accountData.length > 0

  // The landing page owns its own failure state rather than borrowing the
  // graph's. `NetworkGraph`'s error panel is right where it lives, on a
  // network's own page: an error-toned border and the raw fetch message are
  // what an operator needs. On the first screen a stranger ever sees, that same
  // panel is a red box reading "Failed to fetch", which reads as broken
  // software rather than as an unreachable read.
  if (error) {
    return (
      <figure className={className}>
        <HeroGraphUnavailable />
      </figure>
    )
  }

  const caption = live ? CAPTION_LIVE : CAPTION_PENDING

  return (
    <figure
      className={className}
      // Marks the whole figure as not-yet-settled for the screenshot harness,
      // which waits for every `[data-settling]` node to clear before it shoots.
      // It lives here, not on `NetworkGraph`, because that component is loaded
      // with `ssr: false` and so is absent from the server HTML entirely: a
      // harness checking on first paint found nothing and shot the spinner.
      data-settling={isLoading ? 'true' : undefined}
    >
      <div className="flex h-full flex-col gap-2.5">
        {/* `role="img"` with the caption as its label: Sigma paints to a canvas
         * that is not in the accessibility tree, so without this the largest
         * element on the page announces as nothing. `chrome={false}` drops the
         * zoom/fullscreen/layout controls, which were five keyboard tab stops
         * between the primary CTA and the rest of the page, every one of them
         * operating something a keyboard user cannot read. */}
        <div className="min-h-0 flex-1" role="img" aria-label={caption}>
          <NetworkGraph chrome={false} />
        </div>
        <figcaption className="shrink-0 text-xs text-text-subtle">
          {caption}
        </figcaption>
      </div>
    </figure>
  )
}

/**
 * What the hero shows when there is no demo network to show, or when reading it
 * failed.
 *
 * Either way the honest answer is that this one thing is unreachable, not that
 * trustgraphs is empty, so the panel says so and does not get a caption
 * describing a graph that is not there.
 */
export function HeroGraphUnavailable() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-border p-6 text-center">
      <BrandMark size="lg" className="text-text-subtle/40" />
      <p className="max-w-[40ch] text-text-muted">
        The Demo Co-op is not reachable right now. Every network on the
        directory is still live on chain.
      </p>
    </div>
  )
}
