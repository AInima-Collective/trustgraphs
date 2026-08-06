import { BrandMark } from '@/components/BrandMark'

/**
 * What the hero shows when there is no demo network to show, or when reading it
 * failed.
 *
 * Either way the honest answer is that this one thing is unreachable, not that
 * trustgraphs is empty, so the panel says so and does not get a caption
 * describing a graph that is not there.
 *
 * ITS OWN MODULE, and a server component, so the landing page can render it
 * without pulling anything from the data layer. It is reached from three places
 * that must not share a bundle: `page.tsx` on the server when the catalog read
 * already failed, `HeroGraphLive` on the client when the network read failed,
 * and the `<noscript>` block in `HeroGraph`.
 */
export function HeroGraphUnavailable() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-border p-6 text-center">
      <BrandMark size="lg" className="text-text-subtle/40" />
      <p className="max-w-[40ch] text-text-muted">
        The demo graph is temporarily unavailable. You can still browse
        published networks.
      </p>
    </div>
  )
}
