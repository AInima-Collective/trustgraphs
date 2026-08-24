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
import { MIN_STARS_SHOWN, formatStars, getRepoStars } from '@/lib/github.server'
import { socialCard } from '@/lib/metadata'
import { cn } from '@/lib/utils'

import { HeroGraph } from './HeroGraph'
import { HeroGraphUnavailable } from './HeroGraphUnavailable'

/**
 * The landing page.
 *
 * This file is the copy's source of record. The `LANDING_PAGE_COPY.md` design
 * doc it used to mirror is retired (see git history) — the page had converged
 * on it, and a page and a copy doc that quietly disagree is worse than either
 * alone. The voice rules it carried live on in CONTRIBUTING.md, "Copy and
 * voice".
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

const REPO_URL = 'https://github.com/JakeHartnell/trustgraphs'

/**
 * The slug of the demo network in `config/networks.<env>.json`. The landing
 * graph resolves this id specifically rather than grabbing whichever network
 * the catalog happens to list first.
 */
const DEMO_NETWORK_ID = 'demo-co-op'

/**
 * The one site description, used for search results and share cards on every
 * page.
 *
 * It is NOT the hero subhead. Setting the subhead here made the doc's site
 * description copy that renders nowhere, and put a definition of a trustgraph
 * in the slot that wants the pitch.
 */
const DESCRIPTION =
  'Trustgraphs turn graph data into results anyone can verify, compose, and use.'

/**
 * The hero is the graph. It takes the first screen after the nav, with a cap on
 * very tall displays and a shorter guard for landscape phones. The page owns
 * this budget so the live graph and honest failure state occupy exactly the
 * same box and hydration never shifts the sections below it.
 */
const HERO_FIGURE =
  'h-[calc(100svh-7.5rem)] min-h-[32rem] max-h-[52rem] w-full [@media(max-height:520px)]:h-[calc(100svh-5.5rem)] [@media(max-height:520px)]:min-h-[20rem]'

/**
 * The roadmap steps, in order. A plain array rather than four inline JSX
 * elements because the stepper layout needs each item's index and the total
 * count, to know which connecting-line segments to draw.
 */
type RoadmapStatus = 'Current' | 'Pilot' | 'Research'

const ROADMAP: Array<{
  n: string
  status: RoadmapStatus
  title: string
  description: string
}> = [
  {
    n: '01',
    status: 'Current',
    title: 'On-chain EAS',
    description:
      'Public attestations, with every update committed before the graph is computed.',
  },
  {
    n: '02',
    status: 'Pilot',
    title: 'Off-chain EAS',
    description:
      'Signed attestations without a transaction per edge, anchored so the prover can’t choose the inputs.',
  },
  {
    n: '03',
    status: 'Pilot',
    title: 'Nostr',
    description:
      'Prove over signed events from relays, using follows and notes people already publish.',
  },
  {
    n: '04',
    status: 'Pilot',
    title: 'AT Protocol',
    description:
      'Verify repo history and records before computing over social and impact data.',
  },
  {
    n: '05',
    status: 'Research',
    title: 'Private graphs',
    description:
      'Keep relationships and scores hidden while proving the result is correct.',
  },
]

export const metadata: Metadata = {
  // `absolute` so the root page is "Trustgraphs" rather than "trustgraphs | trustgraphs".
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

  // Social proof for the repository CTA. `null` whenever GitHub cannot be read,
  // and deliberately hidden while the number is small enough to argue against
  // the button it decorates — see MIN_STARS_SHOWN.
  const stars = await getRepoStars()
  const starLabel =
    stars !== null && stars >= MIN_STARS_SHOWN ? formatStars(stars) : null

  return (
    <div className="flex flex-col gap-20 sm:gap-28 lg:gap-36">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section aria-label="Live trust graph" className="relative">
        <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)] border-l-2 border-ink bg-surface/90 px-3 py-2.5 backdrop-blur-md sm:max-w-[34rem] sm:px-4 sm:py-3">
          <p className="text-[9px] uppercase tracking-wider text-text-subtle">
            {graphReachable ? 'Live example' : 'Example'} · Demo Co-op
          </p>
          <h1 className="mt-1 max-w-[22ch] text-xl leading-[1.05] text-text text-balance sm:text-3xl">
            Your community already knows who to trust.
          </h1>
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

      {/* ── Platform idea and composition ───────────────────────── */}
      <section
        id="what-is-a-trustgraph"
        className="scroll-mt-8 border-t border-border"
      >
        <div className="grid lg:grid-cols-[minmax(15rem,0.82fr)_minmax(0,1.18fr)]">
          <div className="py-8 lg:pr-16 lg:py-12">
            <p className="tg-label">The primitive</p>
            <h2 className="mt-4 max-w-[12ch] text-4xl leading-[0.98] text-balance sm:text-5xl">
              There is no one trustgraph.
            </h2>
          </div>

          <div className="border-t border-border py-8 lg:border-l lg:border-t-0 lg:py-12 lg:pl-16">
            <p className="max-w-[32ch] text-xl leading-snug text-text sm:text-2xl">
              Each community, application, or protocol defines its own graph,
              its own rules, and the result it needs.
            </p>

            <p className="mt-8 max-w-prose border-t border-border pt-7 text-text-muted">
              Anyone can run the computation. A proof lets everyone else check
              the result without trusting the machine that produced it.
            </p>
          </div>
        </div>

        <Composition />
      </section>

      {/* ── One concrete example ────────────────────────────── */}
      <Section
        id="how-it-works"
        eyebrow="Working example"
        heading="One example: a web of trust."
        standfirst={
          <p className="max-w-[72ch] text-lg text-text-muted">
            Demo Co-op asks who its community trusts, then turns the answer into
            something other apps can use.
          </p>
        }
      >
        <div className="grid gap-px border border-border bg-border shadow-[var(--shadow-elevated)] lg:grid-cols-3">
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
            Trust compounds: vouches from trusted people carry more weight.
          </Move>

          {/* "Check", not "read". `MerkleSnapshot` stores a root, not scores,
           * and `verifyProof(account, value, proof)` needs the caller to hold
           * both already. There is no enumeration on chain. */}
          <Move n="3" title="Use" figure={<UseFigure />}>
            Apps can use verified scores for voting power, incentive
            distribution, or gated chats.
          </Move>
        </div>
      </Section>

      {/* ── Use cases ─────────────────────────────────────────────────────── */}
      <Section
        eyebrow="Use cases"
        heading="Different graphs. Different questions."
      >
        <ul className="list-none border-y border-border p-0">
          <UseCase
            n="01"
            title="Community reputation"
            input="Vouches between people"
            output="A score for earned trust"
          >
            Find standing that comes from relationships, not token balance or a
            platform-owned rating.
          </UseCase>
          <UseCase
            n="02"
            title="Contribution funding"
            input="Claims, peer evaluations, and rater reputation"
            output="A funding allocation"
          >
            Let trusted peer judgment direct a shared pool toward valuable work.
          </UseCase>
          <UseCase
            n="03"
            title="Impact discovery"
            input="AT Protocol follows, claims, evaluations, and acknowledgements"
            output="Scores for people and work"
          >
            Surface credible work from public records without trusting a private
            ranking service.
          </UseCase>
          <UseCase
            n="04"
            title="Signer rotation"
            input="A proven score ranking and a signer threshold"
            output="A Safe multisig's signer set"
          >
            Rotate a Safe’s signers with the graph, not a hand-managed admin
            list.
          </UseCase>
        </ul>
      </Section>

      {/* ── Verification ──────────────────────────────────────── */}
      <section className="bg-ink px-6 py-10 text-ink-fg shadow-[var(--shadow-elevated)] sm:px-10 sm:py-12 lg:px-14 lg:py-16">
        <div className="grid gap-8 lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.28fr)] lg:gap-16">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-ink-fg opacity-55">
              Verification
            </p>
            <h2 className="mt-4 max-w-[16ch] text-3xl leading-[1.02] text-ink-fg text-balance sm:text-4xl">
              Don’t trust the computer. Check the proof.
            </h2>
          </div>
          <p className="max-w-[62ch] self-end text-lg text-ink-fg opacity-70">
            The rules are public, so anyone can recompute the result. A short
            zero-knowledge proof shows every committed input was included and
            the result matches those rules.
          </p>
        </div>

        <ProofDiagram tone="inverse" className="mt-12 sm:mt-16" />
      </section>

      {/* ── Roadmap ───────────────────────────────────────────────────────── */}
      <Section
        eyebrow="Roadmap"
        heading="More inputs. Less exposure."
        standfirst={
          <>
            <p className="text-lg text-text">
              Trustgraphs should work wherever useful graph data lives, then
              reveal only what the result needs.
            </p>
            <p>
              The path runs from public on-chain attestations, through flexible
              off-chain sources, to fully private graphs that remain verifiable.
            </p>
          </>
        }
      >
        {/* Five steps rather than four, so the stepper needs both the extra
            track and a little more width to keep each description readable.
            The connecting-line halves are index-driven and need no change. */}
        <ol className="mx-auto max-w-6xl list-none border-t border-border p-0 lg:grid lg:grid-cols-5 lg:items-start lg:gap-0 lg:pt-10">
          {ROADMAP.map((item, index) => (
            <RoadmapItem
              key={item.n}
              {...item}
              index={index}
              total={ROADMAP.length}
            />
          ))}
        </ol>
      </Section>

      {/* ── Start one ─────────────────────────────────────────────────────── */}
      <section className="grid overflow-hidden border border-ink shadow-[var(--shadow-elevated)] lg:min-h-[30rem] lg:grid-cols-[minmax(0,1.55fr)_minmax(19rem,0.65fr)]">
        <div className="flex flex-col p-6 sm:p-10 lg:p-14">
          <p className="tg-label">Start here</p>
          <h2 className="mt-4 max-w-[13ch] text-4xl leading-[0.98] text-balance sm:text-5xl">
            Build the next trustgraph.
          </h2>

          <div className="mt-8 flex max-w-[62ch] flex-col gap-4 text-text-muted sm:mt-10">
            <p className="text-lg text-text">
              Start a community vouching network today. Choose its starting
              accounts, define what a vouch means, and tune how trust flows.
            </p>
            <p className="max-w-prose">
              The proof system is permissionless. The platform stays open to new
              graph programs as the input layer grows.
            </p>
          </div>

          <div className="mt-auto flex w-full flex-col gap-3 pt-10 sm:w-auto sm:flex-row">
            <ButtonLink href="/create" prefetch={false} size="lg">
              Create a vouching network
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

        <div className="flex flex-col bg-ink p-6 text-ink-fg sm:p-10 lg:p-12">
          <p className="text-[10px] uppercase tracking-widest text-ink-fg opacity-55">
            Open source
          </p>
          <h2 className="mt-4 max-w-[10ch] text-3xl leading-none text-ink-fg text-balance sm:text-4xl">
            Open source. Take it apart.
          </h2>
          <p className="mt-6 max-w-[34ch] text-sm text-ink-fg opacity-70">
            Every contract, circuit and page is in the open. Read how it works,
            then read the code that does it.
          </p>

          {/* Two CTAs where there was one, and the repository takes the filled
           * treatment: on this panel it is the ask, and an outline button
           * beside an outline button asks for nothing in particular. */}
          <div className="mt-10 flex flex-col gap-3 lg:mt-auto">
            <ButtonLink
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              size="lg"
              variant="custom"
              className="w-full shrink-0 border-ink-fg bg-ink-fg text-ink hover:opacity-90 active:opacity-80"
            >
              Star on GitHub
              {starLabel && (
                <span className="ml-1 border-l border-ink/25 pl-3 tabular-nums">
                  {starLabel}
                </span>
              )}
            </ButtonLink>
            <ButtonLink
              href="/docs"
              prefetch={false}
              size="lg"
              variant="custom"
              className="w-full shrink-0 border-ink-fg/45 text-ink-fg hover:bg-ink-fg hover:text-ink"
            >
              Read the docs
            </ButtonLink>
          </div>
        </div>
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
  eyebrow,
  heading,
  standfirst,
  children,
}: {
  id?: string
  eyebrow: string
  heading: string
  standfirst?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      // Anchored sections keep clear of the rule above them when jumped to, so
      // the section reads as a section rather than as a heading with no top.
      className="flex scroll-mt-8 flex-col gap-10 border-t border-border pt-6 sm:gap-12 sm:pt-8"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.28fr)] lg:gap-16">
        <div>
          <p className="tg-label">{eyebrow}</p>
          <h2 className="mt-4 max-w-[18ch] text-3xl leading-[1.02] text-balance sm:text-4xl">
            {heading}
          </h2>
        </div>
        {standfirst && (
          <div className="flex max-w-[72ch] flex-col gap-5 self-end text-text-muted">
            {standfirst}
          </div>
        )}
      </div>
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
    <div className="relative flex min-h-80 flex-col overflow-hidden bg-surface p-6 sm:p-8 lg:min-h-[26rem]">
      <span
        className="tg-display pointer-events-none absolute right-4 top-3 text-6xl leading-none text-text opacity-[0.045]"
        aria-hidden="true"
      >
        {n}
      </span>
      <span className="tg-marker">Step {n}</span>
      <h3 className="mt-3 text-2xl">{title}</h3>

      <div className="mt-4 flex flex-1 flex-col gap-8 sm:flex-row sm:items-start sm:justify-between lg:flex-col lg:items-stretch lg:gap-0">
        <p className="max-w-prose text-text-muted">{children}</p>
        <div className="shrink-0 text-text sm:self-end lg:mt-auto lg:w-full lg:self-auto lg:pt-10 [&>svg]:h-auto [&>svg]:w-64 [&>svg]:max-w-full lg:[&>svg]:w-full lg:[&>svg]:max-w-[24rem]">
          {figure}
        </div>
      </div>
    </div>
  )
}

function Composition() {
  return (
    <figure className="flex flex-col gap-4 sm:gap-5">
      <div className="grid border-x border-b border-border bg-surface md:grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,1fr)_4.5rem_minmax(0,1fr)]">
        <CompositionTerm n="01" marker="Source graph" title="Community vouches">
          become reputation scores.
        </CompositionTerm>
        <CompositionOperator>×</CompositionOperator>
        <CompositionTerm n="02" marker="Compose with" title="Peer evaluations">
          give trusted reviewers more weight.
        </CompositionTerm>
        <CompositionOperator>=</CompositionOperator>
        <CompositionTerm
          n="03"
          marker="New trustgraph"
          title="Contribution funding"
          result
        >
          produces a proven split of a shared pool.
        </CompositionTerm>
      </div>
      <figcaption className="text-center text-text-muted text-balance">
        <em>
          Trustgraphs compose: scores from one graph weight relationships in
          another, producing a new, verifiable result.
        </em>
      </figcaption>
    </figure>
  )
}

function CompositionTerm({
  n,
  marker,
  title,
  result = false,
  children,
}: {
  n: string
  marker: string
  title: string
  result?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={
        result
          ? 'flex min-h-44 flex-col justify-center gap-3 bg-surface-2 p-6 sm:min-h-52 sm:p-8'
          : 'flex min-h-44 flex-col justify-center gap-3 p-6 sm:min-h-52 sm:p-8'
      }
    >
      <p className="text-[10px] uppercase tracking-widest text-text-subtle">
        {n} · {marker}
      </p>
      <div>
        <h3 className="max-w-[16ch] text-2xl leading-tight">{title}</h3>
        <p className="mt-3 max-w-prose text-sm text-text-muted">{children}</p>
      </div>
    </div>
  )
}

function CompositionOperator({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-center border-y border-border bg-background py-3 text-text-subtle md:border-x md:border-y-0 md:py-0"
      aria-hidden="true"
    >
      <span className="tg-display text-3xl leading-none">{children}</span>
    </div>
  )
}

function UseCase({
  n,
  title,
  input,
  output,
  children,
}: {
  n: string
  title: string
  input: string
  output: string
  children: React.ReactNode
}) {
  return (
    <li className="grid gap-5 border-b border-border py-7 first:border-t-0 sm:px-5 sm:py-9 lg:grid-cols-[4rem_minmax(13rem,0.7fr)_minmax(0,1.3fr)] lg:gap-8">
      <span className="tg-display text-3xl leading-none text-text-subtle">
        {n}
      </span>
      <div>
        <h3 className="max-w-[16ch] text-2xl">{title}</h3>
        <p className="mt-3 max-w-[42ch] text-text-muted">{children}</p>
      </div>

      <dl className="grid gap-5 self-center sm:grid-cols-2 lg:gap-8">
        <div className="border-l border-hairline-strong pl-4">
          <dt className="tg-label">Graph data</dt>
          <dd className="mt-2 max-w-[32ch] text-xs leading-relaxed text-text">
            {input}
          </dd>
        </div>
        <div className="border-l border-hairline-strong pl-4">
          <dt className="tg-label">Proven result</dt>
          <dd className="mt-2 max-w-[28ch] text-xs leading-relaxed text-text">
            {output}
          </dd>
        </div>
      </dl>
    </li>
  )
}

/**
 * One roadmap step.
 *
 * Below `lg` this is the original stacked row: a numbered box left of its
 * content, rows divided by a hairline. At `lg` it becomes one step in a
 * horizontal stepper: the same markup switches to a column (circle above
 * text) and a connecting line is drawn behind the circle from two half
 * segments — left-to-centre and centre-to-right — so adjacent steps meet
 * exactly at each circle's centre without hardcoding pixel widths. The line
 * sits at `z-0` and the circle at `z-10` with an opaque fill, which is what
 * masks the line inside a hollow (non-current) circle instead of drawing a
 * stray line straight through it.
 */
function RoadmapItem({
  n,
  status,
  title,
  description,
  index,
  total,
}: {
  n: string
  status: RoadmapStatus
  title: string
  description: string
  index: number
  total: number
}) {
  const statusStyles: Record<RoadmapStatus, { marker: string; badge: string }> =
    {
      Current: {
        marker: 'border-ink bg-ink text-ink-fg',
        badge: 'bg-ink text-ink-fg',
      },
      Pilot: {
        marker: 'border-ink bg-ink-soft text-text',
        badge: 'border border-ink bg-ink-soft text-text',
      },
      Research: {
        marker: 'border-hairline-strong bg-background text-text-muted',
        badge: 'border border-hairline-strong text-text-muted',
      },
    }
  const tone = statusStyles[status]

  return (
    <li className="relative flex gap-5 border-b border-border py-7 last:border-b-0 sm:gap-7 sm:py-9 lg:flex-col lg:items-center lg:gap-4 lg:border-b-0 lg:px-4 lg:py-0 lg:text-center">
      {index > 0 && (
        <span
          aria-hidden="true"
          className="absolute left-0 right-1/2 top-6 z-0 hidden h-px bg-border lg:block"
        />
      )}
      {index < total - 1 && (
        <span
          aria-hidden="true"
          className="absolute left-1/2 right-0 top-6 z-0 hidden h-px bg-border lg:block"
        />
      )}

      <div
        className={cn(
          'relative z-10 flex h-10 w-10 shrink-0 items-center justify-center border text-[10px] tracking-wider sm:h-12 sm:w-12',
          tone.marker
        )}
      >
        {n}
      </div>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-col lg:justify-center lg:gap-2">
          <h3 className="text-2xl lg:text-xl">{title}</h3>
          <span
            className={cn(
              'px-2.5 py-1 text-[9px] uppercase tracking-widest',
              tone.badge
            )}
          >
            {status}
          </span>
        </div>
        <p className="mt-3 max-w-[62ch] text-sm text-text-muted lg:mx-auto lg:max-w-[24ch]">
          {description}
        </p>
      </div>
    </li>
  )
}
