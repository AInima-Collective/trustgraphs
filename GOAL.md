# GOAL — The product surface (a landing page people believe, a directory of live networks, an FAQ that carries the caveats)

Build the three public pages, at product quality:

> **A stranger who has never heard of trustgraphs lands on `/`, and in one
> screen knows what it is, why the scoreboard can be trusted, and what they
> could turn on. `/networks` shows every network that exists right now,
> including one created thirty seconds ago. `/faq` answers what they ask
> before they trust a scoreboard, and carries the caveats. All three hold up
> on a phone, in either theme, with the indexer down.**

This file is the execution spec. Two documents are normative and are the only
source of words on these pages:

- [`LANDING_PAGE_COPY.md`](LANDING_PAGE_COPY.md) — hero, how it works, the
  proof, why, features, start one, ending CTA, footer, live-module microcopy,
  voice notes.
- [`FAQ_PAGE_COPY.md`](FAQ_PAGE_COPY.md) — the four question groups, including
  the Status group that now carries the honesty disclosure on its own.

The design system is normative too, and it already exists:
`frontend/app/tokens.css` (ink only, no hue, square, hairlines) with
`frontend/app/globals.css` re-pointing the shadcn names at it. The mark is
`chord`. Nothing in this program invents a colour, a radius, or a shadow.

**Target: the current landing page is deleted, not refactored.** Its hero, its
networks table, its four-item FAQ accordion and its `/interest` card
(`frontend/app/component.tsx`, 233 lines) all go. The proof loop, the factory
and the daemon are built; this program is the first time a visitor can see any
of it without being handed a runbook.

---

## Ground rules

1. **The copy docs are normative.** Every sentence that ships appears verbatim
   in one of the two files. If a line needs to change, the `.md` changes in the
   same commit. No page invents copy, and no copy lands only in TSX.
2. **Voice rules, enforced by review, not memory.** Brand is `trustgraphs`,
   lowercase in prose; `Trustgraphs` only in the wordmark and `<title>`. The
   unit is *a trustgraph*. No em-dashes: colon, comma, or two sentences. No
   internal numbering in the DOM (no ADR-*, INV-*, "disclosure 4"). Never lead
   with PageRank, merkle roots, SP1, or epochs.
3. **No claim the code does not do today.** Every feature line traces to
   shipped code, and lane 5 of the review panel is an adversary whose whole job
   is to refute the page against the repo. Anything designed-but-unbuilt is cut
   or labelled, never implied.
4. **Ink only.** No brand hue: `--accent` is the text colour, so accent means
   inversion. Hue survives only in the success/warn/error triad. New tokens go
   in `tokens.css`; no inline hex anywhere in this program.
5. **Every page renders with the indexer down.** Marketing content is static.
   Live data is progressive enhancement with an honest degraded state: never a
   fabricated number, never an infinite skeleton, never a list that implies it
   is complete when the read failed. The hero graph is live or it says it is
   not.
6. **Mobile is the design target, not the adaptation.** 390px is a first-class
   review viewport, checked before 1280. Nothing scrolls horizontally at 320px.
   Tap targets clear 44px. The hero must not hand a phone a full screen of
   unreadable graph.
7. **Accessibility is a gate.** Keyboard-complete with visible focus, heading
   order intact, landmarks present, the measured contrast floors held
   (`--text-subtle` is the 4.5:1 floor: do not lighten it in dark or darken it
   in light), `prefers-reduced-motion` honoured by anything that moves, and
   pinch-zoom restored (see Known defects 2).
8. **Frontend only.** Nothing under `src/`, `packages/`, `zk/`, or the indexer
   schema changes. The permitted non-frontend edits are `next.config.mjs`
   redirects, the two copy docs, and doc links that the route move breaks.
9. **Lint what you touch.** `frontend/lib/pagerank/*` carries ~150 pre-existing
   prettier/sort-import errors. Lint the files you edited or you will chase
   ghosts all day.

---

## Interface freeze (IF) — merges first, everything hangs off it

Two sweeping renames. Both touch files that every later milestone edits, so
they land alone, first, in one commit each.

**IF-1 — Lock the type axis, and retire the lab.** *(Jake, this session)*
The design has landed, so the scaffolding that was holding both axes open comes
down with it.
- Delete Cormorant, EB Garamond, Spectral and Newsreader from
  `frontend/app/layout.tsx:32-73`, the five `[data-type]` blocks from
  `tokens.css:199-258`, and the `TYPE_BOOT` script (`layout.tsx:78`).
  `--display-family` and the three compensation variables stay in `:root` with
  the Instrument values, so every `calc(... * var(--display-scale))` call site
  keeps working untouched.
- Delete `app/lab/` (384 lines) and `lib/labTheme.ts` (145 lines) outright.
- Prune `components/BrandMark.tsx` (336 lines) to `chord` alone: the 15 losing
  geometries, the `mark` prop, `MARK_META`, and the `useMarkId` hook all go.
  Its three real call sites (`Nav.tsx:24`, `Footer.tsx:14`,
  `NetworkGraph.tsx:322`) pass only `size` and `className`, so the prop can
  leave without touching them.
- `scripts/generate-brand-assets.mjs` carries its own copy of the `chord`
  geometry and does not import either file, so the asset pipeline is unaffected.
  Its header comment points at `DEFAULT_MARK in lib/labTheme.ts` and must be
  repointed at `BrandMark.tsx`, or the next person will go looking for a file
  that is gone.

*Exit:* two font families ship (PaperMono + Instrument), no `data-type`
attribute anywhere, `/lab` 404s, `BrandMark` exports one mark, `next build`
clean, and `pnpm run brand:assets` still regenerates the icon set.

**IF-2 — Move the directory and the detail pages to `/networks/*`.**
*(Jake, this session)* `app/network/` becomes `app/networks/`, and
`next.config.mjs` gains permanent 308 redirects for `/network` and
`/network/:path*`. The 31 in-app references across 17 files move with it. The
ones that are easy to miss:
`lib/network-nav.ts:52` and `:92` (the `base` templates every tab hangs off,
one per program), `hooks/usePushBreadcrumb.ts:33` and `:54` (two
`startsWith('/network/')` tests),
`app/api/revalidate/[networkId]/route.ts`,
`app/create/steps/SuccessStep.tsx` (the post-creation link),
`components/NetworkFeatures.tsx`, `app/account/[address]/component.tsx`, and
the six route paths listed in the `CATALOG_REVALIDATE_SECONDS` comment
(`lib/catalog.server.ts:29-35`), which must be rewritten as it is the only
index of which pages share that literal. Six references outside the frontend
(docs, taskfile) move too.
*Exit:* no `/network/` string remains outside `next.config.mjs`; every tab,
breadcrumb, and post-create link resolves; the redirects answer 308.

---

## Milestones

Lanes marked ∥ are independent after their stated prerequisite.

### M0 — The review harness *(prereq: IF)*

Agents cannot review a design they cannot see. Build the seeing.

- `frontend/scripts/shots.mjs`: launches the **globally installed** playwright
  (`NODE_PATH=/usr/lib/node_modules`, chromium already in
  `~/.cache/ms-playwright` — verified working this session), walks a matrix of
  route × viewport × theme, writes PNGs to `.trustgraph/shots/<label>/`.
  Viewports: 390 (phone), 414 (large phone), 768 (tablet), 1280, 1600. Themes:
  dark and light. Full-page and above-fold shots for each.
- **It must run against a production build, not `next dev`.** The dev server
  OOMs in this box partway through a multi-route sweep. `next build && next
  start` on `NEXT_DIST_DIR=.next-shots`, so a running dev server is not
  trampled.
- **The ISR trap, solved rather than documented.** With no indexer on `:65421`,
  `/` currently 500s once its 10s ISR window expires: the first request serves
  prerendered HTML, then revalidation fails. A stub indexer returning
  `{instances: []}` makes it worse, because an empty-but-successful response
  suppresses the static-seed fallback. The harness sets a long revalidate via
  env for the shot build; the pages read it from one place so the literal is
  not edited by hand.
- **Fixture states.** An env-switched catalog source that renders the directory
  as: many networks (12+), one network, zero networks, and catalog-read-failed.
  These are the four states M2 is graded on and no live stack produces them on
  demand.
- `task shots` wires it up from the repo root.

*Exit:* one command produces the full matrix for `/`, `/networks`, `/faq` plus
the four directory states, from a cold checkout with nothing else running.

### M1 — The landing page *(prereq: M0)*

`app/page.tsx` + `app/component.tsx`, rebuilt against `LANDING_PAGE_COPY.md` in
page order. Jake's direction: **big hero graph to the right.**

- **Hero.** Left column: eyebrow (`tg-marker`, "Vouch · Score · Prove · Use"),
  headline (`tg-hero`, "Reputation you can't buy."), subhead at
  `max-w-prose`, one primary button. Right column: the graph, large, already
  moving before anyone scrolls, captioned "Demo Co-op, live. Each line is a
  vouch. Size is score."
- **The button must never be dead.** "Open the Demo Co-op" resolves through the
  catalog to `/networks/demo-co-op`; with an empty or failed catalog it falls
  back to `/networks` rather than rendering a link to nothing.
- **The graph on a phone.** Below `lg` it moves under the hero copy with a
  bounded height. The current `h-[66vh]` (`component.tsx:165`) gives a phone a
  full screen of graph nobody can read. Static under `prefers-reduced-motion`.
- **How it works**: three panels. Panel 2 wants the bot island: a dense cluster
  sitting dark beside a lit graph.
- **The proof**: the one diagram on the page. Inputs → proof → chain, with the
  rejected path drawn, as a `<figure>` with a real text equivalent.
- **Why**: three items. **Features**: six-up grid, 3/2/1 columns, no icons
  unless they can be ink-only.
- **Start one**: the honest pair of paragraphs (one transaction, nobody
  approves it; proving costs real money, fund the tank) and the
  `Create a network` button to `/create`.
- **Ending CTA**: "Open source. Take it apart." → the repo.
- **Illustrations are inline SVG.** One sigma instance on the page, in the
  hero. The bot island and the proof diagram are hand-drawn ink SVG, not a
  second graph engine.
- **Deleted, not moved:** the networks table (it is M2's page now), the
  four-item FAQ accordion (M3's page), and the `/interest` card, whose route
  does not exist (Known defects 1).
- **Nothing on the landing says "experimental".** *(Jake, this session.)* The
  Status answers live on the FAQ and the footer links to it.

*Exit:* the page renders from a static build with no indexer, every sentence
matches the copy doc verbatim, no dead links, and the M0 matrix is clean at
390 in both themes. One review round (lanes 1, 2, 4) before it is called done.

### M2 — The networks directory *(prereq: IF; ∥ M1)*

`app/networks/page.tsx`, rebuilt. Today it is a two-up grid of cards carrying a
name, a paragraph, and "VIEW NETWORK →", with hypercerts and contributions
instances concatenated in as though they were the same kind of thing
(Known defects 3).

- **Rows, not cards.** A directory is a list: name, one line of what it is for,
  members, attestations, when the scores were last proven, and where to go.
  Numbers are tabular and right-aligned; the existing `Table` component and
  `ponderQueries.network` already provide both.
- **Programs are distinguished.** A hypercerts instance scores atproto repos
  and a contributions round scores a funding round: neither is a vouching
  network. Group or badge them, and never let a reader think one row means the
  same thing as the row above it.
- **Freshness is stated, not implied.** `RootFreshness` already speaks in
  "scores refreshed 3 days ago". A network whose scores have never been proven
  says so.
- **The four states, all designed:** many (12+, and the point at which search
  earns its place), one, none ("No networks yet. Create the first one." from
  the copy doc), and catalog-read-failed (`CatalogDegradedNotice`, with the
  list never implying completeness).
- **Newly created networks appear.** The page keeps the 10s ISR contract and
  the uncached per-id fallback, so a network minted thirty seconds ago is not
  reported as non-existent.
- **The page ends in the create CTA**, because a directory of other people's
  networks is where someone decides they want their own.

*Exit:* all four fixture states screenshot clean at 390 and 1280 in both
themes; a factory-minted network appears without a rebuild; no row lies about
what program it belongs to.

### M3 — The FAQ page *(prereq: M0; ∥ M1, M2)*

`app/faq/page.tsx` from `FAQ_PAGE_COPY.md`, plus the footer link.

- **A server component with no client JS.** Questions are
  `<details>/<summary>`: keyboard-native, findable by in-page search when open,
  printable, and working with JS disabled. The current accordion is a
  `useState` button that is none of those things.
- One column at a reading measure, ruled rows, group headings via
  `SectionHeading`, no hero. Page title "Questions" (serif, sentence case),
  standfirst under it.
- **Every question gets a stable `id`** so an answer can be linked directly,
  and the four group names sit at the top as anchors. The Status group is the
  only place the caveats live now, so it has to be reachable in one click, not
  found by scrolling.
- `frontend/components/Footer.tsx` gains the FAQ link ahead of Docs, GitHub, X.
  It currently carries only the colophon and two icons.
- Metadata: `title: 'Questions'` (the layout template appends `| Trustgraphs`),
  description drawn from the standfirst.

*Exit:* renders and opens with JS disabled; every question deep-links; the copy
matches the doc verbatim; the footer link works from all three pages.

### M4 — The review gauntlet *(prereq: M1, M2, M3)*

The panel below runs against the M0 screenshot matrix, in parallel, one agent
per lane. Then it runs again. **Loop until two consecutive rounds surface
nothing new**, which is the only stopping rule that catches the tail.

Each finding must carry: the screenshot path, viewport, theme, `file:line`,
what is wrong, and what fixed looks like. A finding with no screenshot and no
line number is not a finding.

**Before a finding becomes work, a second agent tries to refute it.** Confirmed
defects get fixed. **Taste, however well argued, goes on a short list for Jake
rather than into a commit** — this is his product's face, and a panel of agents
re-deciding the aesthetic is exactly the failure mode to avoid.

*Exit:* two dry rounds; every surviving finding fixed or on the taste list with
a reason.

### M5 — Ship *(prereq: M4)*

- Per-route metadata and OG titles for `/`, `/networks`, `/faq`. The generated
  brand assets do not change (the mark is unchanged), so `brand:assets` is not
  re-run.
- `sitemap.ts` and `robots.ts`: three public routes, no app routes.
- Final matrix archived under `.trustgraph/shots/final/`.
- `npx tsc --noEmit` (filtering the two indexer-copied schema files, which have
  a pre-existing missing dep), lint on touched files, `pnpm test` in
  `frontend/` so the golden vectors prove nothing under `lib/` was disturbed.
- Commits in milestone order, each one green.

*Exit:* every Done-when item below is true.

---

## The review panel — six lanes

| # | Lane | What it is looking for |
|---|---|---|
| 1 | **Aesthetics & typography** | Does it read as designed or as assembled? Hierarchy, vertical rhythm, line measure (65-75ch), optical alignment, the serif/mono split held (serif = page titles and hero, mono = labels, data, controls, never all-caps serif), whitespace that is a decision rather than a default. |
| 2 | **Mobile & responsive** | 320 stress, 390, 414, 768, and landscape. No horizontal scroll, no clipped hero, no 44px-under tap target, no sticky element eating the fold, safe-area insets respected, the graph usable or honestly absent. |
| 3 | **Accessibility** | Landmarks, heading order, focus order and visible focus, keyboard-complete flows, contrast against the measured floors, `alt`/`aria` on every figure, `prefers-reduced-motion`, 200% zoom, and the viewport lock from Known defects 2. |
| 4 | **Copy fidelity & voice** | Word-for-word against the two copy docs. Em-dash sweep. Brand casing. Plain-reader test: a normal DeFi user understands each sentence on first read. No spec numbering in the DOM. |
| 5 | **Claim audit (adversarial)** | Take each sentence and try to refute it against the repo. Does the code do this today, for a stranger, without us running anything by hand? Default to refuted when uncertain. Anything unsupported is cut or qualified. |
| 6 | **Performance & correctness** | Font payload after IF-1, JS shipped to the marketing route, LCP and CLS, hydration mismatches, SSR safety, ISR behaviour with the indexer down, and a link check that no route 404s. |

Lanes 1-3 read screenshots. Lanes 4-6 read code and copy. All six run per round.

---

## Known defects, found while planning

Live in shipped code, fixed by this program, listed so they cannot quietly
survive it:

1. **The landing page's only secondary CTA is a 404.** `component.tsx:185`
   links to `/interest`; there is no `app/interest/` route and no redirect.
   All four references to the interest form in the repo (`component.tsx:156`,
   `:180`, `:185`, `:192`) sit inside the file M1 replaces, so killing the
   concept costs nothing beyond writing the new page. No redirect is added: a
   form that never existed does not get a tombstone.
2. **Pinch-zoom is disabled sitewide.** `layout.tsx:113-119` sets
   `maximumScale: 1, userScalable: false`. That is a WCAG 1.4.4 failure on
   every page, not just these three.
3. **The directory conflates three programs.** `app/network/page.tsx:28-32`
   concatenates trust-graph, hypercerts and contributions instances into one
   grid with identical cards, and its only heading is an `<h1 class="text-2xl">`
   with no page-title treatment.
4. **The hero graph takes a whole phone screen.** `component.tsx:165` is
   `h-[66vh]` at every breakpoint, so on mobile the fold is a graph too small
   to read and too big to scroll past.
5. **The lab outlived both decisions it was built to hold open.** Five serif
   families and 16 brand marks still ship for a switcher nobody uses now that
   the mark is `chord` and the face is Instrument. Retired by IF-1.

---

## Decisions (locked)

**Jake, this session:**
- **Type axis: Instrument Serif, prune the rest.** The other four families and
  the `[data-type]` machinery are deleted.
- **Routes: `/networks/*`**, with 308 redirects from `/network/*`.
- **No disclosure on the landing page.** The FAQ's Status group carries "not
  production ready" and "not audited by an outside firm", and the footer links
  to it.
- **One direction, hero graph big and to the right.** No three-way bake-off at
  `/lab`; build the best version of this.
- **The lab is retired.** The design has landed, so `/lab`, `labTheme`, the 15
  losing marks and the four losing serifs all go in IF-1.
- **The interest form is killed, not relocated.** Nothing on the public surface
  collects an email.

**Mine, on Jake's "figure it out" (the three defects he handed back):**
- **Pinch-zoom comes back by deletion.** `maximumScale` and `userScalable` are
  removed from the viewport export entirely; `width: device-width`,
  `initialScale: 1` and `viewportFit: 'cover'` stay. The usual reason for that
  lock is iOS zooming on input focus, and that is already handled properly by
  the `font-size: 16px` rule on text inputs (`globals.css:376-381`), so nothing
  regresses by removing it.
- **The directory groups by program, it does not badge.** Rows sit under a
  heading per program with one line saying what that program scores: vouching
  networks first, then funding rounds, then repo reputation. A badge in a mixed
  list asks the reader to notice a difference; a heading tells them. Groups
  with nothing in them are omitted, not rendered empty.
- **The hero graph never owns a phone's first screen.** Below `lg` it becomes a
  bounded panel of roughly 40vh, capped near 360px, placed after the headline,
  subhead and button, keeping its caption. It still renders, because it is the
  product, but the first thing a phone shows is a sentence rather than an
  unreadable constellation. Under `prefers-reduced-motion` the layout settles
  once and then holds still.

**Mine, unless overruled:**
- **The app frame stays.** These pages live inside the same `max-w-7xl`
  hairline frame as the rest of the product rather than becoming a full-bleed
  marketing site. One instrument, one chrome; rules bleed to the frame edge and
  that is the whole liberty taken.
- **FAQ is `<details>`, not an accordion component.** Works without JS,
  keyboard-native, deep-linkable.
- **One graph engine per page**, in the hero. Everything else that looks like a
  graph is inline SVG.
- **`/` keeps its 10s ISR** with a static-safe fallback: no data fetch blocks
  first paint, and a failed read degrades visibly rather than 500ing.
- **The old landing sections are deleted, not relocated.** The networks table
  becomes M2's page and the accordion becomes M3's page, both rewritten.

---

## Parallelization map

```
IF-1 ─┐
IF-2 ─┴─> M0 ─┬─> M1 (landing) ────┐
              ├─> M2 (directory) ──┼─> M4 (gauntlet) ─> M5 (ship)
              └─> M3 (faq) ────────┘
```

IF-1 and IF-2 are sequential (both edit `layout.tsx` and the route tree). M1,
M2 and M3 are genuinely independent once M0 exists: separate routes, no shared
components beyond `Footer` (M3 owns that edit) and `Nav` (M2 owns the Networks
link).

---

## Execution notes — model allocation

**Main session:** the hero and the proof diagram (the two places where getting
it wrong is most expensive and most visible), the claim-audit acceptance in
lane 5, and every taste call the panel escalates.

**Subagent lanes:** the M0 harness; M2's directory states; M3's FAQ page; the
six review lanes, run in parallel per round; the IF-2 rename sweep, which is
mechanical and wide.

Frame review prompts as refutation, not opinion: "refute: this page renders
correctly at 390px", "refute: every sentence in the Features section is
supported by shipped code". A lane that returns "looks good" has not run.

---

## Bug capture

Anything the panel finds that is not a page defect but a product defect (a
contract, an indexer, or a copy-doc claim that turns out false) gets a GitHub
issue rather than a quiet fix in a TSX file. Findings that contradict the copy
docs are edits to those docs in the same commit, never a silent divergence
between what the page says and what the doc says.

---

## Done when

1. **All three pages ship** and render from a production build with no indexer
   running, in both themes, at 390 / 414 / 768 / 1280 / 1600, with no
   horizontal scroll and no fabricated data.
2. **Every sentence** on the three pages appears verbatim in
   `LANDING_PAGE_COPY.md` or `FAQ_PAGE_COPY.md`, and lane 5 could not refute a
   single claim against the repo.
3. **The three CTAs work:** Open the Demo Co-op, Create a network, Star on
   GitHub. No route on the public surface 404s, and `/interest` is gone.
4. **The directory tells the truth in all four states**, distinguishes the
   three programs, and shows a network created thirty seconds ago.
5. **The FAQ opens with JS disabled**, deep-links per question, and carries the
   Status answers that no longer appear anywhere else.
6. **Accessibility gate passed:** keyboard-complete, visible focus, heading
   order intact, contrast floors held, reduced motion honoured, pinch-zoom
   restored.
7. **The gauntlet ran dry twice**, and every surviving finding is fixed or on
   the taste list with a reason.
8. **Two font families ship**, `/lab` and `labTheme` are gone, `BrandMark`
   carries one mark, `pnpm run brand:assets` still works, `next build` is
   clean, touched files lint clean, and the frontend golden tests are green.
