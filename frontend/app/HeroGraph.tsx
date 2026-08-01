'use client'

import dynamic from 'next/dynamic'

import { Network } from '@/lib/types'
import { cn } from '@/lib/utils'

import { HeroGraphUnavailable } from './HeroGraphUnavailable'

/**
 * The live graph in the hero, and the only client island on the landing page.
 *
 * Everything else on `/` is server-rendered marketing copy, so keeping the
 * graph behind its own boundary is what stops a static page from shipping the
 * whole sigma/graphology/WebGL stack to a visitor who came for a sentence.
 *
 * THIS FILE IS DELIBERATELY THIN. It imports a type and one component that
 * touches nothing; everything with a dependency graph lives in `HeroGraphLive`,
 * behind `next/dynamic`. The reason is measured: while `NetworkProvider` was
 * imported here statically, the landing page's eager script set carried the EAS
 * SDK and ethers v6 — 1.1 MB raw, 316 KB over the wire, 41% of everything `/`
 * downloads — because `NetworkContext` reaches `SchemaEncoder` through
 * `ponderQueries` → `intoAttestationsData` → `SchemaManager`. A `dynamic()` call
 * one level down does nothing about that: a static import at the top of a module
 * is eager however lazily the module imports things further in. The boundary has
 * to sit above the import, which is what this file is.
 *
 * THE `<figure>` STAYS ON THE SERVER, and that is not incidental. It carries the
 * hero's whole height budget (`HERO_FIGURE` in page.tsx). Moving it inside the
 * `ssr: false` island would have left the grid cell at zero height in the server
 * HTML and grown it on hydration, which is a layout shift on the first screen a
 * stranger sees, on a page currently measuring CLS 0.00000. So the box is
 * server-rendered and the island fills it.
 *
 * `<figcaption>` only names its figure when it is a DIRECT child, so
 * `HeroGraphLive` returns the caption as a sibling of the canvas rather than
 * wrapping them: the fragment lands directly inside this `<figure>`.
 *
 * Sigma paints through WebGL, which does not exist on the server, hence
 * `ssr: false`. The graph runs one short force-atlas pass on mount and then
 * holds still: it is moving when the page arrives, which is the point, and it is
 * not animating afterwards, which is what makes it safe under reduced motion.
 */
const HeroGraphLive = dynamic(() => import('./HeroGraphLive'), { ssr: false })

export function HeroGraph({
  network,
  className,
}: {
  network: Network
  className?: string
}) {
  return (
    // The flex column lives on the figure rather than inside the island, so the
    // canvas and its caption are both direct children of it.
    <figure className={cn('flex flex-col gap-2.5', className)}>
      <HeroGraphLive network={network} />
      {/* With JavaScript off the island never mounts, and a caption describing
       * a graph that is not there is the same lie in smaller type. This panel
       * is what a reader without JS gets, and it is true.
       *
       * `display: contents` because `<noscript>` is inline-level: the panel's
       * `h-full` resolved against an auto-height inline box and drew 175px of
       * bordered panel inside a 464px figure, with 289px of empty frame under
       * it. Dissolving the wrapper makes the panel a flex child of the figure,
       * where `h-full` means what it says. */}
      <noscript className="contents">
        <HeroGraphUnavailable />
      </noscript>
    </figure>
  )
}
