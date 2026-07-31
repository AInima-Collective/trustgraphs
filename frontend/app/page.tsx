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

import { HeroGraph, HeroGraphUnavailable } from './HeroGraph'

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
 * The slug of the demo network in `config/networks.<env>.json`.
 *
 * The hero button says "Open the Demo Co-op" by name, so it resolves this id
 * specifically rather than grabbing whatever the catalog happens to list first:
 * a button whose label names one network and whose href points at another is a
 * worse failure than a button that falls back to the directory.
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
  'Reputation you can’t buy. A trustgraph turns the vouches your community already makes into a score anyone can verify, published on-chain each round.'

/**
 * The hero figure's height budget, owned by the page and handed to whatever
 * fills it — the live graph or the panel that says it is unreachable. One
 * constant because the two must be the same size: a hero that changes height
 * depending on whether the indexer answered is a page that jumps.
 *
 * The desktop step is deliberately short of a full screen. At `min(70vh,38rem)`
 * the hero owned every pixel above the fold on a laptop and nothing suggested
 * there was a page under it.
 */
const HERO_FIGURE =
  'h-[42vh] max-h-[360px] min-h-[min(16rem,42vh)] w-full lg:h-[min(56vh,29rem)] lg:max-h-none'

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
  // `getCatalog` never throws: an unreachable indexer degrades to the shipped seed with an error
  // set, so this read cannot take the page down. If the demo is missing either way, the hero says
  // so and the button falls back to the directory rather than linking to nothing.
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
      <section className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12">
        {/* Copy first in the DOM, so a phone shows a sentence before it shows a
         * constellation. At `lg` the grid puts the graph back on the right. */}
        <header className="flex flex-col items-start gap-5 [@media(max-height:480px)]:gap-3">
          <span className="tg-marker">Vouch · Score · Prove · Use</span>

          <h1 className="tg-hero max-w-[14ch] text-balance">
            Reputation you can’t buy.
          </h1>

          <p className="max-w-prose text-lg text-text-muted">
            A trustgraph maps who vouches for whom. That map becomes a score any
            app can read and any contract can check, so votes and money follow
            the people your community actually trusts.
          </p>

          {/* Two ways in, because a stranger arrives wanting one of two things:
           * to poke at a real network, or to be told what this is first. The
           * second is a same-page anchor rather than a route, so it costs
           * nothing and cannot 404. */}
          <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
            <ButtonLink
              href={demo ? `/networks/${demo.id}` : '/networks'}
              size="lg"
            >
              Open the Demo Co-op
            </ButtonLink>
            <ButtonLink href="#how-it-works" size="lg" variant="outline">
              How it works
            </ButtonLink>
          </div>
        </header>

        {/* The graph is the product, so it renders on every screen. It just does
         * not get to own a phone's first one: bounded to roughly 40vh below
         * `lg`, and given the room it deserves above it. */}
        {/* The <figure> is rendered BY the island, not around it: a
         * <figcaption> only names its figure as a direct child, and "live" is a
         * claim about data that has arrived, which only the client knows. The
         * page owns the height budget and hands it over. See HeroGraph.tsx. */}
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
            Sign a public statement that you trust an account, with a weight on
            it. Change it or take it back whenever you want.
          </Move>

          {/* The last sentence is not a hedge. `reconcile.rs` builds the node
           * set from the EDGES, so a clique vouching for each other is exactly
           * how it becomes a set of scored accounts, and `calculate_generic`
           * still credits every one of them their slice of the head start you
           * did not reserve. The wizard reserves 15% by default. "A bot island
           * gains nothing" is backwards, not merely incomplete. See issue #18. */}
          <Move n="2" title="Score" figure={<ScoreFigure />}>
            Trust starts at a handful of accounts your community picked and
            flows outward along the vouches. A vouch from a trusted account
            carries weight. A bot island has no trust flowing into it, so
            vouching for itself earns it nothing. Whether it keeps a share
            anyway is a dial when you create the network, and its default leaves
            it one.
          </Move>

          {/* "Check", not "read". `MerkleSnapshot` stores a root, not scores,
           * and `verifyProof(account, value, proof)` needs the caller to hold
           * both already. There is no enumeration on chain. */}
          <Move n="3" title="Use" figure={<UseFigure />}>
            When a round is proven, its scoreboard is committed on-chain. Any
            contract can check a score against it: voting weight, funding
            splits, access, whatever you need a real member count for.
          </Move>
        </div>
      </Section>

      {/* ── The proof ─────────────────────────────────────────────────────── */}
      <Section heading="Anyone can run the math.">
        {/* Prose above, diagram full width below. Setting the diagram in a
         * half-width column squeezes three labelled panels and two connectors
         * into about 600px, which is where the labels start setting two words
         * to a line. */}
        <div className="flex flex-col gap-10">
          {/* The argument on the left, the line it lands on set as a pull quote
           * on the right. It is the sentence the whole section exists to earn,
           * and buried as the third paragraph of a narrow column it read as a
           * footnote. `.tg-display` is the serif's opt-in for copy that is not
           * a heading. */}
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] lg:gap-12">
            <div className="flex max-w-prose flex-col gap-4 text-text-muted">
              <p>
                Most scoring systems ask you to trust whoever owns the server.
                This one doesn’t have a server you have to believe. The rules
                are public and exact, so anyone can run them and get the same
                answer down to the last digit.
              </p>
              <p>
                Whoever submits a scoreboard attaches a zero-knowledge proof: a
                short receipt the chain checks by itself. Drop a vouch you
                dislike, invent one that never happened, or round a number your
                way, and no valid receipt exists.
              </p>
            </div>

            {/* The leading is pinned at the call site, not left to `.tg-display`.
             * Moving the `.tg-*` classes into `@layer components` was the right
             * fix for the FAQ nav, and it hands every size utility here the
             * power to reset line-height along with font-size, which is exactly
             * what `text-xl` does. Naming the token keeps the value in one
             * place and keeps the quote at its designed 1.15. */}
            <p className="tg-display max-w-[22ch] self-center border-l border-border pl-5 text-xl leading-[var(--leading-tight)] text-balance sm:text-2xl lg:pl-8">
              You never trust the person who did the math. You check the
              receipt.
            </p>
          </div>

          <ProofDiagram />
        </div>
      </Section>

      {/* ── Why ───────────────────────────────────────────────────────────── */}
      <Section heading="What this is for.">
        {/* The one open section between two bordered grids, and it stays open
         * on purpose: this is the human argument, not a spec board. It just
         * gets more air than a panel would, so it reads as a lighter beat
         * rather than as the section nobody finished. */}
        <div className="grid gap-10 lg:grid-cols-3 lg:gap-12">
          <Reason title="Give away control without giving away the keys.">
            A founder with most of the tokens can hand governance to the people
            who earned it, and watch the graph do the deciding.
          </Reason>
          {/* The list that used to open this line ("contributions, endorsements,
           * history") named three things a network a stranger can create does
           * not count. `TrustGraphFactory` hard-codes one vouch schema and binds
           * it inside the creating transaction, after which a foreign schema
           * reverts; contributions are a separate program with no factory and no
           * wizard path; "history" traced to nothing in the repo at all. An
           * earlier round cut "and off" from the end of the same sentence and
           * left the nouns standing, which is the tell that it was the list and
           * not the preposition doing the lying. Mixed sources, below, is where
           * other programs get named. */}
          <Reason title="Count more than tokens.">
            Weight comes from who vouches for whom, not from what an account
            holds.
          </Reason>
          <Reason title="One reputation, many contexts.">
            Score the same people different ways for different questions.
            Reputation earned in one place can be read in another.
          </Reason>
        </div>
      </Section>

      {/* ── Features ──────────────────────────────────────────────────────── */}
      <Section heading="What you can turn on.">
        {/* The same hairline grid as "Three moves.", on purpose: this page has
         * one way of drawing a set of panels, and six switches laid out as a
         * loose list of underlined rows read as leftovers rather than as a
         * board. Six items divide evenly at one, two and three columns, so no
         * breakpoint leaves a ragged cell. */}
        <ul className="grid list-none grid-cols-1 gap-px border border-border bg-border p-0 sm:grid-cols-2 lg:grid-cols-3">
          <Feature title="Trust-weighted voting">
            A Safe module weighs votes by score instead of tokens. Connecting it
            is a manual deployment today.
          </Feature>
          <Feature title="Score-weighted payouts">
            Split a pot by score, and let anyone claim their share against the
            published scoreboard.
          </Feature>
          <Feature title="Self-updating multisig">
            A module can rotate a Safe’s owners to the top accounts by score.
            Wiring it is a manual deployment today.
          </Feature>
          <Feature title="Published criteria">
            Say what a vouch means in your network, and where newcomers apply.
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
          <Feature title="Exportable scoreboards">
            A vouching network’s scoreboard downloads as CSV or JSON, so you can
            use the scores off-chain. The file carries the scores, not the
            proofs.
          </Feature>
          <Feature title="Mixed sources">
            Vouches on Ethereum today. Reputation over AT-Protocol accounts is a
            second program, proven the same way, and not self-serve yet.
          </Feature>
        </ul>
      </Section>

      {/* ── Start one ─────────────────────────────────────────────────────── */}
      <Section heading="Bring your own community.">
        <div className="flex flex-col items-start gap-8">
          {/* Two paragraphs, two columns. One measure-capped column under a
           * full-width heading left two thirds of the section empty and made
           * the last thing before the call to action look like an afterthought. */}
          <div className="grid gap-4 text-text-muted lg:grid-cols-2 lg:gap-12">
            {/* Both sentences were stronger than the code, twice over. "No
             * server for you to run" implies somebody else runs one, and
             * permissionless only means nobody can stop you: for a network made
             * through the app, the only working tier is self-prove. And the
             * tank cannot pay anything until `maxPerRootUsd` is set, which
             * `TrustGraphFactory` never does and this app has no screen for, so
             * `_settle` short-circuits to `PolicyDisabled` and the operator
             * holds `Unfunded`. "Free forever" also skipped the 16-32 GiB and
             * the gas. */}
            {/* The appearance clause is gone rather than softened. The indexer
             * switches factory discovery off whenever the deploy environment is
             * production, so on the chain this app ships against a
             * factory-created network is never indexed and never listed: not
             * slowly, not at all. "Once the indexer catches up" promised a wait
             * that ends. Issue filed against the indexer. */}
            <p className="max-w-prose">
              Create a network in one transaction. Nobody approves it. Proving
              is permissionless, so anyone can produce your scoreboard and no
              operator can lock you out.
            </p>
            <p className="max-w-prose">
              Proving costs real money. Your network has a tank to pay whoever
              produces its scoreboard, though it pays nothing until the tank is
              funded, its per-round limit is set by contract call, and we have
              priced networks of that size. You can also prove it yourself: the
              prover is open source, and the bill is your own machine and gas.
            </p>
          </div>

          <ButtonLink href="/create" size="lg">
            Create a network
          </ButtonLink>
        </div>
      </Section>

      {/* ── Ending CTA ────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-start gap-5 border border-border bg-surface p-6 sm:flex-row sm:items-center sm:justify-between sm:p-10">
        <h2 className="max-w-[20ch] text-balance">
          Open source. Take it apart.
        </h2>
        <ButtonLink
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          size="lg"
          variant="outline"
          className="shrink-0"
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

function Reason({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-balance">{title}</h3>
      {/* Capped, because this grid is one column below `lg` and 14px mono run
       * the full 720px of a tablet is about ninety characters to a line. */}
      <p className="max-w-prose text-text-muted">{children}</p>
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
