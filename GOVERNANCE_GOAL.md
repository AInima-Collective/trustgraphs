# GOVERNANCE_GOAL — Proposals are the page (one network header, one modal pattern, numbers a human can read)

Rebuild the network governance UX from the voter's perspective, at product
quality:

> **A member clicks the Governance tab and stays on the network's page: same
> header, same tabs, new content. The first thing they see is the proposals,
> with the ones that need their vote on top and a plain sentence saying when
> each closes. One primary button opens the new-proposal modal at a URL they
> can share. A proposal's page shows whether it will pass: quorum progress
> against the whole network's voting power, who voted and how. Every number
> is human-scaled and every time is a time, not a block height.**

The design system is normative and already exists: `frontend/app/tokens.css`
(ink only, no hue, square, hairlines) with `globals.css` re-pointing the
shadcn names at it. The success/warn/error triad is the only hue.

**Target: the reference material gets out of the way.** Today the governance
page spends six stat cards and a contract-address block before the first
proposal, and Parameters + Contracts duplicate what the Settings tab already
shows from the chain. Proposals move to the top; the duplicates are deleted,
not demoted.

---

## Ground rules

1. **The plain-reader test governs every sentence.** A normal DeFi user
   understands each line on first read. "Decentralized decision making with
   merkle proof verification" does not survive. No em-dashes in UI copy:
   colon, comma, or two sentences.
2. **Times are times.** No block number is ever the primary display. Convert
   via chain block time to "Ends in ~2 days" / "Opens ~Aug 12" with the block
   number available as secondary detail (tooltip or fine print). One helper,
   used everywhere.
3. **Voting power is 18-decimal fixed point and is always formatted.**
   `formatBigNumber(value, 18)` like every sibling page. No raw 1e18 integer
   reaches the DOM: not in the table, not in vote results, not in "your
   voting power".
4. **One vocabulary: For / Against / Abstain.** The `VoteType.Yes/No` enum
   stays in code; the DOM never says Yes/No, never SHOUTS FOR, and the old
   "◆ YOU NEED VOTING POWER ◆" aesthetic is gone.
5. **One feedback channel.** `txToast` already reports success and failure.
   The page-level and card-level green banners (and their 5s `setTimeout`s)
   are deleted, not restyled.
6. **Ink only.** No new hue. Result bars distinguish For/Against/Abstain by
   the existing success/error/neutral tokens only.
7. **Mobile is the design target.** 390px first-class, nothing horizontal at
   320px, tap targets clear 44px. The proposals table becomes cards on small
   screens; the modal is usable with a phone keyboard.
8. **Accessibility is a gate.** Modal focus trap, vote radiogroup keyboard-
   complete (already is: keep it), heading order intact under the shared
   header, quorum bar readable by screen reader (text equivalent), contrast
   floors held.
9. **Frontend only.** Nothing under `src/`, `packages/`, `zk/`, or the
   indexer changes. The votes the detail page needs are already indexed and
   already queryable (`getGovModuleVotes` without a voter filter).
10. **Lint what you touch.**

---

## Interface freeze (IF) — merges first, everything hangs off it

**IF-1 — `NetworkHeader`.**
One component: network name as the h1, the same one-line network descriptor
on every tab, then `NetworkNav`. Byte-identical markup on Overview,
Governance, Distribute, and Settings, so a tab click reads as a tab click.
Tab pages lose their own h1s ("Governance", "Network settings"); their
titles become section headings in the content. The governance `layout.tsx`
renders it once for the whole subtree, which also restores the tabs on the
proposal detail page (breadcrumb sits below the header). Page-specific
explainer copy lives above that page's content, not in the header.

**IF-2 — `useRouteModal(key)`.**
The app-wide route-with-modal convention: a URL parameter drives the house
`Modal` (`?new=1` on the governance page). Linkable, survives refresh as the
modal over the list, back button closes it. Built here, adopted by the
contributions submit modal (CONTRIBUTIONS_GOAL M2) and eligible for
`CreateAttestationModal` later. If Jake prefers the `/governance/new` path
spelling, this swaps to Next intercepting routes; the call sites don't care.

**IF-3 — `blocksToTime` helper.**
Block→approximate-time conversion (block delta × chain block time, anchored
at the current block), returning both the human string and the block number
for secondary display. Honest about approximation ("~").

---

## M1 — Restructure the governance page

- New order: `NetworkHeader` → one-line purpose copy ("Propose and vote on
  how {network} spends its treasury.") → context strip → proposals.
- Context strip: treasury balance and your voting power (with % of total),
  one slim row, not stat cards. Disconnected wallet shows a connect nudge in
  the voting-power slot, not "?".
- **Delete** the Parameters section, the Contracts section, and the "Total
  proposals" stat. One quiet "Voting rules and contracts" link points at the
  Settings tab, which already shows all of it live from the chain.
- Zero-voting-power members see the earn path in plain words where the
  create button would invite them ("You need a trust score in this network
  to propose. Earn one by receiving trust attestations.").

## M2 — Proposals you can read

**List.**
- Active proposals group first (needing your vote flagged), then everything
  else newest-first.
- Each row: title, status, compact stacked result bar (one bar, three
  segments, not three numbers), time ("Ends in ~2 days"), proposer.
  ID and action count demote to the detail page.
- Cards on small screens; no horizontal scroll at 320px.

**Detail.**
- The proposal title is the h1-level heading (under `NetworkHeader`);
  "Proposal #4" becomes fine print.
- Quorum progress: votes cast vs required quorum of total voting power, with
  the threshold marked, plus a majority readout (For vs Against). The
  current bars (percent of votes cast) are misleading, one lonely For vote
  renders 100% green, and do not survive.
- Voter list: address, choice, power, from the existing indexer query. The
  dead `getProposalVotes` stub is replaced, not kept.
- Timing per rule 2; state banners per rule 5; vocabulary per rule 4.
- Execution block explains what execution does in one sentence and links the
  transaction after it lands.

## M3 — Creation worth trusting

- The inline toggled form becomes the `?new=1` modal (IF-2).
- **Action templates.** Default flow: "Send ETH from the treasury" (recipient
  + ETH amount, correct ETH→wei conversion). "Custom contract call" (target,
  calldata, value) lives behind an advanced disclosure; the DelegateCall
  option lives only there, with a warning.
- **Fixes the value-unit bug:** today the form labels wei as "ETH Value"
  (`BigInt(action.value)` in `useGovernance.createProposal`) while
  `ProposalCard` re-reads the stored wei as ETH (`parseUnits(value, 18)`).
  After M3 the form takes ETH and converts; the card formats wei with
  `formatBigNumber(value, 18)`. Decimal input no longer throws.
- Can't-propose users never see the form: the modal trigger is replaced by
  the M1 earn-path copy.
- The optional propose-with-vote keeps working (it saves a transaction) but
  reads as one clear choice, with formatted voting power.
- Title is validated like description (today only the HTML `required` guards
  it).

## Debt deleted along the way

- `VotingPowerCard.tsx` (unused).
- `queueProposal` stub and its threading through both pages.
- Local success-banner state everywhere (rule 5).
- The `router.push('../')` not-found redirect flash on the detail page:
  render the not-found state, don't navigate.

---

## Verification

| # | Gate | What it checks |
|---|------|----------------|
| 1 | Reader pass | Every sentence on all governance screens passes the plain-reader test; vocabulary audit finds no Yes/No/FOR in the DOM. |
| 2 | Mobile | 320 stress, 390, 414, 768 via the screenshot harness; list-as-cards, modal with keyboard open. |
| 3 | Accessibility | Modal focus trap, radiogroup semantics kept, heading order under the shared header, quorum bar text equivalent. |
| 4 | Numbers | No raw 1e18 value and no primary block number anywhere on the three screens; ETH action round-trips form → chain → display at the same magnitude. |
| 5 | Cross-tab | Header byte-identical across Overview/Governance/Distribute/Settings; tab click does not repaint the header. |

## Done when

1. Proposals are the first content on the governance page; Parameters and
   Contracts sections no longer exist there.
2. Every trust-graph tab and the proposal detail page share one
   `NetworkHeader`.
3. `?new=1` opens the creation modal, survives refresh, and back closes it.
4. A "send ETH" proposal created through the template executes and displays
   the same amount everywhere.
5. A proposal detail page answers, without scrolling on desktop: what is it,
   when does it close, will it pass (quorum + majority), did I vote, who
   else voted.
6. Gates 1–5 pass.
