# CONTRIBUTIONS_GOAL — The round as one live page (see the work, rate it, submit yours, claim your share)

Rebuild the contributions round UX from the contributor's and rater's
perspective, at product quality:

> **A contributor lands on the round page and in one screen sees what the
> community has built and what each piece is worth right now. They rate inline
> and save once. They submit their own work through one primary button. If a
> contribution names them, the page says so; nobody else ever sees that flow.
> When the round settles, the same header hands them a Claim button with a
> number on it. Money visibly follows peer judgment, and the page can say why
> the number is right: the scores are proven, not administered.**

This file is the execution spec. The design system is normative and already
exists: `frontend/app/tokens.css` (ink only, no hue, square, hairlines) with
`globals.css` re-pointing the shadcn names at it. The scoring math is
normative and already exists: `frontend/lib/contributions/` is the
parity-locked TS twin of the audited recompute, held to the guest by
`golden.test.ts`. Nothing in this program invents a colour, a radius, or a
score.

**Target: five screens become two.** Today a round is five routes
(`/networks/[id]` + `contribute` + `respond` + `rate` + `payout`), a tab row,
and a duplicate action-button row. It becomes the round page (feed with
everything inline) and a claim page, with zero tabs.

---

## Ground rules

1. **The plain-reader test governs every sentence.** A normal DeFi user
   understands each line on first read. No internal numbering in the DOM, no
   leading with merkle roots or SP1. Jargon is defined in place or cut. No
   em-dashes in UI copy: colon, comma, or two sentences.
2. **One meaning per word.** "Submit" is what you do with work. "Claim" is
   what you do with money. The contribution-claim vocabulary
   (`ClaimView`, `claimUID`, schema names) survives in code and stays out of
   the DOM. No button, heading, or helper sentence may use "claim" for a
   contribution.
3. **The audited math is the only source of numbers.** Every score,
   projection, and re-split preview comes from `lib/contributions/` (or the
   indexer routes that assert against it). No approximations, no float math,
   no second implementation. `golden.test.ts` stays green and untouched.
4. **Projections are labelled and never fabricated.** "If the round settled
   now" is the only tense a projection speaks in. When an input is missing
   (indexer down, no trust edges, no proven root), the number is absent with
   one honest line, never a skeleton that implies it is loading, never a
   guess.
5. **Every page renders with the indexer down.** On-chain data (claims,
   ratings, responses, distributions) keeps working; round window, pool, and
   scores degrade visibly. This already holds on the round page; it must
   survive the merge.
6. **Ink only.** No new hue. The rating-power bar's current
   `hsl(${index * 63}...)` rainbow (`rate/component.tsx`) does not survive
   into the new page; distinguish slices by tone, hatch, or label, not hue.
   Hue remains reserved for the success/warn/error triad.
7. **Mobile is the design target.** 390px first-class, nothing horizontal at
   320px, tap targets clear 44px. Sliders must be draggable with a thumb, and
   the sticky save bar must not eat the fold.
8. **Accessibility is a gate.** Sliders keyboard-operable with visible focus
   and announced values, the feed's expand/collapse reachable, heading order
   intact, contrast floors held, `prefers-reduced-motion` honoured by the
   re-split animation.
9. **Frontend only.** Nothing under `src/`, `packages/`, `zk/`, or the
   indexer changes. Permitted non-frontend edits: `next.config.mjs`
   redirects and doc links broken by the route retirement.
10. **Lint what you touch.** `frontend/lib/pagerank/*` carries ~150
    pre-existing lint errors; chase only your own.

---

## Interface freeze (IF) — merges first, everything hangs off it

**IF-1 — The round phase model and the new header.**
One derivation, one place, that every milestone keys off:

- `roundPhase()` in `contributions-shared.tsx`: **Open** (window active) →
  **Settling** (window closed, no distribution against the current root yet)
  → **Claimable** (a distribution exists) → plus **Upcoming** and the honest
  **Unknown** (round API unreachable). Inputs it already has: `round.status`,
  `round.root`, the distributions table, `latestSnapshot`.
- The round header rebuilt around it: round name, one line linking the trust
  network that weights the raters (replacing the cross-instance tab), a
  window progress line ("closes in 6 days"), the pool as the hero number, and
  **one primary CTA decided by phase** — Submit while open, a quiet "scores
  being proven" line while settling, "Claim your share" when claimable.
- The five `StatisticCard`s collapse into that header. Contribution and
  rating counts become small inline text; they are trivia, not statistics.
- **The tab row and the action-button row are deleted from the round page.**
  `ContributionsNav` stops rendering on contributions routes;
  `contributionsTabs` in `lib/network-nav.ts` shrinks to what remains
  reachable (the trust network's own tabs still offer "Contributions" — that
  link is unaffected). The old sub-routes stay live and reachable by URL
  until M5 retires them; they lose nothing but the tab bar.

*Exit:* the round page has zero tab rows and one phase-correct primary CTA in
each of the five phases; every later milestone builds against `roundPhase()`.

---

## Milestones

Lanes marked ∥ are independent after their stated prerequisite.

### M0 — The review harness learns wallets and phases *(prereq: none; ∥ IF-1)*

`frontend/scripts/shots.mjs` exists and its hard lessons are already encoded
(production build, port-group kill, `data-settling`, no `networkidle`). Two
capabilities are missing and this program is graded on both:

- **Connected-wallet fixtures.** A wagmi mock connector behind an env flag,
  with three personas: a stranger (no claims, no ratings), a rater with saved
  ratings, and a nominee (named on a claim, no response yet). Without this,
  the respond banner, the sliders, and the claim CTA are unreviewable.
- **Phase fixtures.** Env-switched round states: upcoming, open-empty,
  open-with-claims, settling, claimable, indexer-down. The demo seed
  (`scripts/contribution-round.ts`) already produces open-with-claims; the
  others are fixture data, not live stacks.

*Exit:* one command produces the matrix (route × viewport × theme × persona ×
phase) for the round and claim pages from a cold checkout.

### M1 — The feed: rate where you read *(prereq: IF-1)*

Merge `rate/component.tsx` into the round page's `ClaimCard`. The two pages
already render near-identical card headers; there is one card now.

- Slider inline on every card that is not yours; your own cards show score
  only, with the "you can't rate your own" line demoted to a tooltip-weight
  note. The expandable audit view (contributors, filtered ratings, the
  plain-language reasons) survives the merge untouched — it is the
  transparency nobody else has.
- The rating-power budget becomes a **compact sticky strip** that appears
  once a draft exists: your voice split across what you've rated, recomputed
  live via `ratingPowerPreview`, plus the save action (per-card save until
  M6 batches it).
- Default sort: unrated-by-you first, then by community score. A small
  control offers newest and top-scored. Disconnected users just see the feed
  sorted by score.
- `/rate` keeps working (it is not retired until M5) but stops being linked.

*Exit:* a rater can land on the round page, rate five things, and never
navigate; the budget strip agrees with what `/rate` showed before, on the
same fixture.

### M2 — Submit: one button, two tabs *(prereq: IF-1; ∥ M1)*

The header's Submit CTA opens a modal (house `Modal` component;
`CreateAttestationModal` is the precedent) replacing the `/contribute` page.

- **Tab 1, "Your work" (default):** title, link, and a collapsed "Add
  collaborators" section. You are prefilled at 100%; the share editor appears
  only when a collaborator is added. The content-fingerprint field moves
  behind the collapse too: power-user furniture, not first-run furniture.
- **Tab 2, "Nominate someone":** you are excluded from the contributor list
  by design, and the card explains the consequence once, in the canonical
  phrasing (see Decisions): they accept, decline, or count at half weight.
- The window-closed warning and all validation move in unchanged.
- **Post-submit lands you in the feed, not at a redirect:** the modal closes
  and the new claim appears at the top of the feed optimistically, marked
  pending until the index catches up.

*Exit:* the 99% path (self-submission, no collaborators) is title + link +
one button; a nomination cannot be made by accident; the submitted claim is
visible without a manual refresh.

### M3 — Named? The page tells you *(prereq: M1)*

`/respond` becomes a conditional surface instead of a destination.

- A banner under the round header, rendered **only** when connected and
  named with no response yet: "2 contributions name you. Accept to receive
  your share." It anchors to the relevant cards.
- Accept / Decline move inline onto those claim cards, with the current
  status line (accepted / declined / half weight) in the card's contributor
  row where it already renders.
- Everyone else never sees a trace of this flow.

*Exit:* the nominee persona sees the banner and can respond without leaving
the feed; the stranger persona's page contains no respond UI at all.

### M4 — Claim: your money first *(prereq: IF-1; ∥ M1–M3)*

`/payout` is renamed and inverted. Route becomes `/networks/[id]/claim`.

- Leads with **"Your share: 412 USDC"** and one Claim button, resolved from
  the payout bundle / merkle-entry fallback exactly as today. Zero share,
  already claimed, and not-connected each get their own honest line.
- The distributions table stays, as history below the fold.
- **Funding demotes to a disclosure** at the bottom: "Fund this round" opens
  the existing approve/deposit form. It stays on the page because funding is
  permissionless, but it stops being the headline. Paused state unchanged.
- The round header's Claimable-phase CTA links here.

*Exit:* a contributor with an unclaimed share reaches their money in two
clicks from the round page; the funder path still works end to end.

### M5 — Money made visible *(prereq: M1, M4)*

The reframe milestone: attach the pool to the scores, live.

- **The pool-split bar** in the round header: one horizontal stacked bar,
  the pool divided by current score share, each slice labelled with its
  claim and projected payout. Ink-only treatment per ground rule 6.
- **Projected payout on every card:** "~120 USDC if the round settled now",
  next to the community score, computed from the indexer's asserted scores ×
  the pool.
- **Optimistic re-split while rating:** dragging a slider recomputes scores
  client-side via `computeContributions` (it needs the trust edges of the
  sibling network plus the records the page already has; fetch edges once,
  behind the same query layer) and animates the bar before anything is
  saved. If the inputs aren't all present, the bar simply doesn't preview;
  the honest degrade is stillness, not a spinner.
- One quiet line under the bar, phase-aware: "Final scores are proven, not
  administered." linking to the FAQ's proof answer.
- **Parity guard:** a test asserts the page's projection for the demo
  fixture equals the indexer's recompute for the same inputs, so the
  optimistic path can never drift from the audited one.
- **Route retirement lands here** (the last feature that touches the old
  pages): `contribute`, `rate`, `respond` → 308 to the round page, `payout`
  → 308 to `claim`, following the `next.config.mjs` pattern. In-app
  references sweep with it (`lib/network-nav.ts`, `BackToRound`, doc links).

*Exit:* rating something visibly moves money toward it; the projection
matches the audited recompute on the golden fixture; no old route renders a
page.

### M6 — One signature, all your ratings *(prereq: M1; ∥ M4, M5)*

Five ratings today is five wallet popups. EAS `multiAttest` is already in
`lib/contract-abis.ts` and `intoAttestationsData` already encodes batches.

- `useAttestation` gains a batch path (`createAttestations`) targeting
  `multiAttest`, same toast/error handling as the single path.
- The sticky strip's save action becomes **"Save N ratings"**: all dirty
  drafts, one transaction. Per-card save buttons go away.
- Partial-failure honesty: if the transaction reverts, no rating is marked
  saved; drafts survive.

*Exit:* a rater with five dirty drafts signs once; the feed and budget strip
reconcile to chain state afterwards.

### M7 — The gauntlet, then ship *(prereq: all of the above)*

The panel below runs against the M0 matrix, one agent per lane, in parallel.
**Loop until two consecutive rounds surface nothing new.** Every finding
carries screenshot path, viewport, theme, persona, phase, `file:line`, and
what fixed looks like. A second agent tries to refute each finding before it
becomes work. Taste goes on a list for Jake, not into a commit.

Then ship:

- Metadata for the round and claim routes; sitemap already excludes app
  routes.
- `npx tsc --noEmit` (filtering the two indexer-copied schema files), lint on
  touched files, `pnpm test` in `frontend/` — the contributions golden tests
  and the new parity guard both green.
- Commits in milestone order, each one green.

*Exit:* every Done-when item below is true.

---

## The review panel — six lanes

| # | Lane | What it is looking for |
|---|---|---|
| 1 | **Aesthetics & typography** | Reads as designed, not assembled. The feed's rhythm with sliders inline, the header hierarchy (pool number vs. phase line), serif/mono split held, the sticky strip earning its permanence. |
| 2 | **Mobile & responsive** | 320 stress, 390, 414, 768. Sliders thumb-draggable, sticky strip not eating the fold, pool-split bar legible or honestly simplified, modal usable on a phone keyboard. |
| 3 | **Accessibility** | Sliders keyboard-complete with announced values, modal focus trap, banner announced, reduced motion stills the re-split, contrast floors held. |
| 4 | **Copy & terminology** | Plain-reader test per sentence. The submit/claim vocabulary split enforced across every string. The half-weight rule stated once, canonically, everywhere it appears. |
| 5 | **Numbers audit (adversarial)** | Refute every number on the page against the audited recompute: projections, budget shares, claimable amounts, the re-split preview. Refute the phase model against fixture states. Default to refuted when uncertain. |
| 6 | **Correctness & performance** | Hydration safety, indexer-down behaviour per phase, redirect coverage, batch-save reconciliation after revert, no stale draft ghosts, feed performance at 50 claims. |

Lanes 1–3 read screenshots. Lanes 4–6 read code and fixtures. All six run per
round.

---

## Known defects, found while planning

Live in shipped code, fixed by this program, listed so they cannot quietly
survive it:

1. **Triple navigation on the round page.** Site nav + `ContributionsNav`
   tab row + a four-button action row pointing at the same routes
   (`contributions.tsx:296-312`). Three surfaces for five screens.
2. **The edge case is the primary CTA.** "Claim a contribution" leads the
   action row and `/respond` holds a permanent tab, though most visitors are
   never nominated and see only "No contributions name you yet."
3. **"Claim" means two opposite things.** "Claim a contribution" (submitting
   work) and the payout table's "Claim" button (receiving money) share one
   word across adjacent screens.
4. **The payout page leads with the funder's form.** The contributor's own
   money is a table column ("YOUR SHARE") below an approve/deposit card
   (`payout/component.tsx:407-475`).
5. **One transaction per rating.** Each slider save is its own wallet popup;
   rating a ten-claim round is ten signatures.
6. **The half-weight rule is phrased three different ways** (contribute
   nomination card, respond header, claim-card contributor rows), so a
   reader can meet it three times and think it is three rules.
7. **The rating-power bar invents hue** (`hsl(${index * 63}…)`) in an
   ink-only design system.

---

## Decisions (locked)

**Jake, this session:**
- **Submit-first.** One primary "Submit contribution" flow; nomination is a
  secondary tab inside it, never a peer action.
- **Respond is invisible until you are named.** No route, no tab, no button
  for everyone else.
- **No second tab row.** The round page carries no tabs; round and rate are
  one page.
- **Payout becomes Claim**, oriented to the contributor; funding the round
  demotes to an organizer-shaped disclosure.
- **The money-visible direction is in**: pool-split bar, projected payouts,
  optimistic re-split, batch save.

**Mine, unless overruled:**
- **Terminology split: "submit" for work, "claim" for money**, enforced by
  lane 4. Code identifiers keep the EAS "claim" vocabulary; the DOM never
  does.
- **The canonical half-weight sentence** (one phrasing, reused verbatim):
  "If they accept, they receive their share. If they decline, it is removed.
  Until they answer, it counts at half weight."
- **Old routes retire via 308s** in `next.config.mjs`, in M5, after their
  replacements exist. `BackToRound` and `contributionsTabs` sweep with them.
- **Funding stays on the claim page** behind a disclosure rather than moving
  to settings: it is permissionless, and a funder following a link should
  not need to know our information architecture.
- **The fingerprint field is power-user furniture**: collapsed by default in
  the submit modal, never required.
- **Optimistic re-split degrades to stillness.** No inputs, no preview, one
  honest line; never a spinner pretending to compute.
- **Phase names in copy:** Upcoming, Open, Scores being proven, Ready to
  claim. "Settling" is internal vocabulary.

---

## Parallelization map

```
M0 (harness) ─────────────┐
IF-1 (phase + header) ─┬─> M1 (feed) ─┬─> M3 (named banner) ──┐
                       ├─> M2 (submit modal) ∥ ───────────────┤
                       └─> M4 (claim page) ∥ ─┐               ├─> M7 (gauntlet + ship)
                                              ├─> M5 (money visible + route retirement)
                            M1 ───────────────┘               │
                            M1 ─> M6 (batch save) ∥ ──────────┘
```

IF-1 and M0 are independent and both come first. M1, M2, M4 are independent
after IF-1. M3, M5, M6 hang off M1 (M5 also off M4). M7 gates on everything.

---

## Execution notes — model allocation

**Main session:** IF-1 (the phase model and header set the tone for
everything), the M5 pool-split bar and its parity guard (the most visible
and the most refutable work in the program), and every taste call the panel
escalates.

**Subagent lanes:** M0 harness capabilities; M2's modal; M3's banner; M4's
inversion; M6's batch path; the six review lanes per round; the M5 route
sweep, which is mechanical and wide.

Frame review prompts as refutation: "refute: this projection equals the
audited recompute", "refute: the nominee persona can respond without
navigating". A lane that returns "looks good" has not run.

---

## Bug capture

Anything the panel finds that is a product defect rather than a page defect
(an indexer route, a schema, a scoring rule that surprises us) gets a GitHub
issue, not a quiet workaround in TSX. If the optimistic recompute and the
indexer ever disagree on a fixture, that is a stop-the-line finding, never a
rounding note.

---

## Done when

1. **Two screens.** The round page (feed, submit modal, conditional respond,
   phase header with pool-split bar) and the claim page. Zero tab rows on
   either. The four old routes 308 to their successors.
2. **The 99% path is frictionless:** submit is title + link + one button;
   rating five contributions is five drags and one signature.
3. **Respond UI exists only for the named**, verified by persona fixtures:
   the stranger's DOM contains none of it.
4. **The claim page leads with the contributor's number**, and the funder
   path still works end to end behind its disclosure.
5. **Every number survives the adversarial lane:** projections, budget
   shares, claimable amounts, and the re-split preview all trace to the
   audited recompute; the parity guard is green in CI with the golden tests.
6. **All five phases render honestly** with the indexer up and down, in both
   themes, at 390/768/1280, for all three personas.
7. **The terminology split holds everywhere:** no DOM string uses "claim"
   for work or "submit" for money; the half-weight rule appears in exactly
   one phrasing.
8. **The gauntlet ran dry twice**, every surviving finding fixed or on the
   taste list with a reason, `tsc` and touched-file lint clean, frontend
   tests green, commits in milestone order.
