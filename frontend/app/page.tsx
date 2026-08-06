import type { Metadata } from 'next'

import { ButtonLink } from '@/components/Button'
import {
  ScoreFigure,
  UseFigure,
  VouchFigure,
} from '@/components/marketing/MoveFigures'
import { ProofDiagram } from '@/components/marketing/ProofDiagram'
import { resolveNetwork } from '@/lib/catalog'
import { getCatalog } from '@/lib/catalog.server'
import { socialCard } from '@/lib/metadata'

import { HeroGraph } from './HeroGraph'
import { HeroGraphUnavailable } from './HeroGraphUnavailable'

/**
 * The landing page.
 *
 * Every sentence here appears verbatim in `LANDING_PAGE_COPY.md`, which is the
 * source of the words. Change one and change the other in the same commit;
 * a page and a copy doc that quietly disagree is worse than either alone.
 *
 * SERVER COMPONENT, deliberately. The only client code on this route is the
 * hero graph, behind its own dynamic boundary in `HeroGraph.tsx`. Everything
 * else is HTML: it renders with the indexer down, it renders with JavaScript
 * off, and it does not hand a first-time visitor a megabyte of WebGL to read
 * a paragraph.
 */

// Must be a literal — Next statically analyses this export. Keep it equal to
// `CATALOG_REVALIDATE_SECONDS` in lib/catalog.server.ts.
export const revalidate = 10

const REPO_URL = 'https://github.com/JakeHartnell/ZkTrustGraph'

/**
 * The slug of the demo network in `config/networks.<env>.json`. The landing
 * graph resolves this id specifically rather than grabbing whichever network
 * the catalog happens to list first.
 */
const DEMO_NETWORK_ID = 'demo-co-op'

/**
 * The site description, per LANDING_PAGE_COPY.md, which specifies one string
 * for search results and share cards on every page.
 *
 * It is NOT the hero subhead. Setting the subhead here made the doc's site
 * description copy that renders nowhere, and put a definition of a trustgraph
 * in the slot that wants the pitch.
 */
const DESCRIPTION =
  'Turn community vouches into reputation scores that apps can use and contracts can verify.'

/**
 * The hero is the graph. It takes the first screen after the nav, with a cap on
 * very tall displays and a shorter guard for landscape phones. The page owns
 * this budget so the live graph and honest failure state occupy exactly the
 * same box and hydration never shifts the sections below it.
 */
const HERO_FIGURE =
  'h-[calc(100svh-7.5rem)] min-h-[32rem] max-h-[52rem] w-full [@media(max-height:520px)]:h-[calc(100svh-5.5rem)] [@media(max-height:520px)]:min-h-[20rem]'

export const metadata: Metadata = {
  // `absolute` so the root page is "Trustgraphs" rather than "Trustgraphs | Trustgraphs".
  title: { absolute: 'Trustgraphs' },
  ...socialCard({
    title: 'Trustgraphs',
    description: DESCRIPTION,
    path: '/',
  }),
}

export default async function LandingPage() {
  // `getCatalog` never throws: an unreachable indexer degrades to the shipped
  // seed with an error set, so this read cannot take the page down. If the demo
  // is missing either way, the hero renders its honest unavailable state.
  const { networks, error } = await getCatalog()
  const demo = resolveNetwork(networks, DEMO_NETWORK_ID)

  // If the catalog read failed, the indexer is unreachable, and the graph reads
  // from the same indexer. Rendering the island anyway downloads 156 KB of
  // sigma and WebGL to draw a spinner that resolves to "not reachable" six
  // seconds later. The server already knows the answer, so it gives it.
  const graphReachable = demo !== undefined && !error

  return (
    <div className="flex flex-col gap-16 sm:gap-24">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section aria-label="Live trust graph" className="relative">
        <div className="pointer-events-none absolute left-3 top-3 z-20 border-l-2 border-ink bg-surface/90 px-3 py-2 backdrop-blur-md">
          <p className="text-[9px] uppercase tracking-wider text-text-subtle">
            {graphReachable ? 'Live trustgraph' : 'Example trustgraph'}
          </p>
          <h1 className="mt-0.5 text-lg leading-none text-text">Demo Co-op</h1>
        </div>
        {/* The graph is the product, so it gets the whole first screen. The
         * figure is rendered BY the island, not around it: a figcaption only
         * names its figure as a direct child, and "live" is a claim about data
         * that has arrived, which only the client knows. */}
        {graphReachable ? (
          <HeroGraph network={demo} className={HERO_FIGURE} />
        ) : (
          <figure className={HERO_FIGURE}>
            <HeroGraphUnavailable />
          </figure>
        )}
      </section>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <Section id="how-it-works" heading="Three moves.">
        <div className="grid gap-px border border-border bg-border lg:grid-cols-3">
          {/* One hairline grid rather than three floating boxes: the gap IS the
           * rule, so the three panels read as one figure in three parts.
           *
           * Every panel carries a figure, and every figure is pinned to the
           * bottom of its panel (see `Move`). Two of the three used to be text
           * alone next to a drawing, which read as one finished panel and two
           * that had not been got to yet. */}
          <Move n="1" title="Vouch" figure={<VouchFigure />}>
            Sign a public, weighted vouch. Update or revoke it at any time.
          </Move>

          <Move n="2" title="Score" figure={<ScoreFigure />}>
            Trust flows from accounts your community chooses, giving more weight
            to vouches from trusted people.
          </Move>

          {/* "Check", not "read". `MerkleSnapshot` stores a root, not scores,
           * and `verifyProof(account, value, proof)` needs the caller to hold
           * both already. There is no enumeration on chain. */}
          <Move n="3" title="Use" figure={<UseFigure />}>
            Commit each round on-chain, where apps and contracts can verify
            scores for voting, payouts, or access.
          </Move>
        </div>
      </Section>

      {/* ── The proof ─────────────────────────────────────────────────────── */}
      <Section heading="Don’t trust the scorer. Check the proof.">
        {/* Prose above, diagram full width below. Setting the diagram in a
         * half-width column squeezes three labelled panels and two connectors
         * into about 600px, which is where the labels start setting two words
         * to a line. */}
        <div className="flex flex-col gap-10">
          <p className="max-w-[72ch] text-lg text-text-muted">
            The rules are public, so anyone can recompute a round. A
            zero-knowledge proof shows that every vouch was included and every
            score followed those rules.
          </p>

          <ProofDiagram />
        </div>
      </Section>

      {/* ── Features ──────────────────────────────────────────────────────── */}
      <Section heading="Put trust to work.">
        {/* The same hairline grid as "Three moves.": this page has one visual
         * language for product capabilities, and four items make a balanced
         * two-by-two board at wider breakpoints. */}
        <ul className="grid list-none grid-cols-1 gap-px border border-border bg-border p-0 sm:grid-cols-2">
          <Feature title="Trust-weighted voting">
            Weight votes by reputation instead of token balance. Safe setup is
            manual today.
          </Feature>
          <Feature title="Score-weighted payouts">
            Split a pool by score and let each account claim its share.
          </Feature>
          <Feature title="Self-updating multisig">
            Rotate a Safe’s owners to the highest-scoring accounts. Setup is
            manual today.
          </Feature>
          {/* Twice corrected. It never carried proofs (issue #17), and it is
           * not necessarily "the published scoreboard" either: the button
           * writes whatever the page is currently showing, and the simulation
           * toggle beside it can change that. The claim here is only about what
           * lands in the file, which is true either way. */}
          {/* "A network's" was wider than the button. `ExportButton` renders in
           * exactly one place, the vouching network page, and this page
           * advertises three programs: a reader who opened a funding round
           * looking for the download found nothing. */}
          <Feature title="Portable scoreboards">
            Export scores as CSV or JSON for use off-chain.
          </Feature>
        </ul>
      </Section>

      {/* ── Start one ─────────────────────────────────────────────────────── */}
      <Section heading="Bring your own community.">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:gap-12">
          <div className="flex max-w-[72ch] flex-col gap-4 text-text-muted">
            <p className="text-lg text-text">
              Create a network in one transaction. Choose its starting accounts,
              define what a vouch means, and tune how trust flows.
            </p>
            <p className="max-w-prose">
              Proving is permissionless. Run the open-source prover yourself, or
              fund the network’s proving tank as managed support rolls out.
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row lg:flex-col">
            <ButtonLink href="/create" prefetch={false} size="lg">
              Create a network
            </ButtonLink>
            <ButtonLink
              href="/faq#status"
              prefetch={false}
              size="lg"
              variant="outline"
            >
              Read current status
            </ButtonLink>
          </div>
        </div>
      </Section>

      {/* ── Ending CTA ────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-start gap-5 border border-ink bg-ink p-6 text-ink-fg sm:flex-row sm:items-center sm:justify-between sm:p-10">
        <h2 className="max-w-[20ch] text-balance">
          Open source. Take it apart.
        </h2>
        <ButtonLink
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          size="lg"
          variant="custom"
          className="shrink-0 border-ink-fg text-ink-fg hover:bg-ink-fg hover:text-ink"
        >
          Star on GitHub
        </ButtonLink>
      </section>
    </div>
  )
}

/**
 * A landing section: a hairline, a serif heading, and the room under it.
 *
 * Headings here are sentences with full stops, so they take the display voice
 * in sentence case rather than the app's `SectionHeading`, which uppercases in
 * CSS. A serif set in all-caps loses its case contrast, its ascenders and its
 * descenders, which is everything that makes it a serif.
 */
function Section({
  id,
  heading,
  children,
}: {
  id?: string
  heading: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      // Anchored sections keep clear of the rule above them when jumped to, so
      // the section reads as a section rather than as a heading with no top.
      className="flex scroll-mt-8 flex-col gap-6 border-t border-border pt-5 sm:gap-8"
    >
      <h2 className="max-w-[24ch] text-balance">{heading}</h2>
      {children}
    </section>
  )
}

/**
 * One of the three panels.
 *
 * The figure is a slot rather than part of `children` because where it belongs
 * changes with the width. Three columns at `lg`: the drawing goes under the
 * paragraph and is pinned to the bottom of the panel, so all three sit on one
 * baseline however long the text above them runs. One column between `sm` and
 * `lg`: the panel is a wide band, so the drawing moves to the right of the
 * paragraph and the paragraph keeps a readable measure instead of running the
 * whole 720px. On a phone it is a column again.
 *
 * `h-auto` on the svg rather than a fixed height: a fixed height letterboxes
 * the drawing inside its own box and leaves it floating small in the middle of
 * a wide panel. All three share a viewBox, so sizing by width keeps them at the
 * same scale as each other at every breakpoint.
 */
function Move({
  n,
  title,
  figure,
  children,
}: {
  n: string
  title: string
  figure: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col bg-background p-5 sm:p-6">
      <span className="tg-marker">{n}</span>
      <h3 className="mt-2">{title}</h3>

      <div className="mt-3 flex flex-1 flex-col gap-8 sm:flex-row sm:items-start sm:justify-between lg:flex-col lg:items-stretch lg:gap-0">
        <p className="max-w-prose text-text-muted">{children}</p>
        <div className="shrink-0 text-text sm:self-end lg:mt-auto lg:self-auto lg:pt-8 [&>svg]:h-auto [&>svg]:w-60 [&>svg]:max-w-full">
          {figure}
        </div>
      </div>
    </div>
  )
}

function Feature({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="flex flex-col gap-2 bg-background p-5 sm:p-6">
      <h3 className="tg-label-strong">{title}</h3>
      <p className="max-w-prose text-text-muted">{children}</p>
    </li>
  )
}
