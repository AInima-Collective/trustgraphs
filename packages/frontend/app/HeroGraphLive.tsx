'use client'

import dynamic from 'next/dynamic'

import { NetworkProvider, useNetwork } from '@/contexts/NetworkContext'
import { Network } from '@/lib/types'

import { HeroGraphUnavailable } from './HeroGraphUnavailable'

/**
 * Everything about the hero that needs the network data layer.
 *
 * Loaded by `HeroGraph.tsx` through `next/dynamic`, which is the whole point of
 * the file existing: the single static `import { NetworkProvider }` used to sit
 * one level up and dragged the EAS SDK and ethers v6 into the landing page's
 * eager script set. See the note in `HeroGraph.tsx` for the import chain.
 *
 * Renders a FRAGMENT, not a `<figure>`. The figure is server-rendered by the
 * parent so the hero's height exists before hydration, and `<figcaption>` only
 * names its figure as a direct child, so both halves land directly inside it.
 */
const NetworkGraph = dynamic(
  () => import('@/components/NetworkGraph').then((mod) => mod.NetworkGraph),
  { ssr: false }
)

/**
 * The canvas's own name, deliberately NOT the caption.
 *
 * The name says what the thing is; the caption explains how to read it, which
 * is the division of labour a `<figcaption>` exists for.
 */
export default function HeroGraphLive({ network }: { network: Network }) {
  return (
    <NetworkProvider network={network}>
      <HeroGraphFigure />
    </NetworkProvider>
  )
}

function HeroGraphFigure() {
  // `graphLoading`, NOT the context's aggregate `isLoading`. That one folds in
  // the Gnosis Safe read, which this page never displays and which retries four
  // times against an indexer that is not answering: measured, the graph's own
  // data settled at 7.7s and the figure stayed "loading" until 18.4s because of
  // a number nobody here shows. It held the caption in its pending state and
  // kept `data-settling` set — the attribute the screenshot harness waits on —
  // so the review matrix was shooting a hero that had been ready for eleven
  // seconds. The polling itself is a shared-code problem and has its own issue.
  const { network, graphLoading, error, accountData } = useNetwork()
  const settled = !graphLoading && !error

  // "live" is a claim about data that has actually arrived, so it is asked of
  // the data and not of a loading flag.
  const live = !error && accountData.length > 0

  // The landing page owns its own failure state rather than borrowing the
  // graph's. `NetworkGraph`'s error panel is right where it lives, on a
  // network's own page: an error-toned border and the raw fetch message are
  // what an operator needs. On the first screen a stranger ever sees, that same
  // panel is a red box reading "Failed to fetch", which reads as broken
  // software rather than as an unreachable read.
  //
  // Same for the EMPTY state, which is reachable and was not handled: with the
  // instance list answering but the network read 404ing, `error` is null and
  // the accounts array is empty, so `NetworkGraph` settled into its own panel
  // reading "No attestations yet. The first attestation in this network will
  // draw the first edge." That is undocumented copy on the first screen, and it
  // says "attestation" twice on a page that never defines the word.
  if (error || (settled && accountData.length === 0)) {
    return <HeroGraphUnavailable />
  }

  const caption = `${network.name}${live ? ', live' : ''}. Each line is a vouch. Size is score.`

  return (
    <>
      {/* The labelled group makes the WebGL graph understandable without
       * flattening the inspector's real links into an inaccessible image. The
       * direct figcaption below supplies the reading key. `chrome={false}`
       * avoids exposing controls for a canvas a keyboard user cannot traverse.
       * Camera gestures are off as well: a nearly full-screen graph must never
       * capture an attempt to scroll to the next section.
       *
       * `data-settling` marks the figure as not-yet-ready for the screenshot
       * harness, which waits for every such node to clear before it shoots. */}
      <div
        className="min-h-0 flex-1"
        role="group"
        aria-label={`${network.name} vouching graph`}
        data-settling={graphLoading ? 'true' : undefined}
      >
        <NetworkGraph
          title={network.name}
          initialZoom={1.08}
          chrome={false}
          inspector
          cameraControls={false}
          guide={{
            heading: 'Example Network',
            description:
              'This live example turns community vouches into reputation. It is one trustgraph among many.',
            actions: [
              {
                href: `/networks/${network.id}`,
                label: 'Open Network',
              },
              {
                href: '#what-is-a-trustgraph',
                label: 'Explore the idea',
              },
            ],
          }}
        />
      </div>
      {/* A DIRECT CHILD of the server-rendered `<figure>`, which is the only
       * position from which a `<figcaption>` names anything. */}
      <figcaption className="sr-only">{caption}</figcaption>
    </>
  )
}
