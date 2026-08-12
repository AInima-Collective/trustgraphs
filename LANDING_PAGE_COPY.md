# trustgraphs landing page copy

Sections are in page order. `[brackets]` are design direction, not copy.
Every claim below is something the code does today unless the line says otherwise.

---

## Hero

**Graph eyebrow:** Live example · Demo Co-op / Example · Demo Co-op

**Headline:** Your community already knows who to trust.

**Graph inspector heading:** One trustgraph

**Graph introduction:** This live example turns community vouches into reputation. It is one
trustgraph among many.

**Graph legend:** node = member · area = score · edge = vouch · weight = confidence

**Graph links:** Open Demo Co-op · Explore the idea

`[The live graph remains the entire hero. The upper-left overlay carries the platform claim;
the lower-left inspector identifies this graph as one concrete example and holds the two ways
forward. On interaction, that same inspector becomes node or edge detail.]`

---

## Platform idea

**Eyebrow:** The primitive

**Section heading:** There is no one trustgraph.

Each community, application, or protocol defines its own graph, its own rules, and the result it
needs.

Anyone can run the computation. A proof lets everyone else check the result without trusting the
machine that produced it.

trustgraphs compose. Scores from one graph can weight relationships in another, producing a new,
verifiable result.

`[the definition is one ruled editorial field: the claim has its own column, while the lead and
the two supporting ideas form a measured reading column. It should feel like a primitive being
specified, not another marketing card.]`

**Composition:**

- 01 · Source graph: Community vouches become reputation scores.
- ×
- 02 · Compose with: Peer evaluations give trusted reviewers more weight.
- =
- 03 · New trustgraph: Contribution funding produces a proven split of a shared pool.

**Composition caption (assistive):** A community vouch graph produces reputation scores. Those
scores weight peer evaluations in a contribution graph, which produces a proven funding split.

`[one restrained composition formula on paper, using × and = instead of workflow arrows. On wide
screens it reads left to right; on small screens it reads top to bottom. The result gets one quiet
surface step. This is a concrete composition that exists in the contributions program, not a
generic promise about proof recursion.]`

---

## One concrete example

**Eyebrow:** Working example

**Section heading:** One example: a web of trust.

Demo Co-op asks who its community trusts, then turns the answer into something other apps can
use.

**1. Vouch**
Sign a public, weighted vouch. Update or revoke it at any time.

**2. Score**
Trust compounds: vouches from trusted people carry more weight.

**3. Use**
Commit each round on-chain, so contracts can verify the scores.

`[three panels, each with its own ink figure pinned to the bottom so all three
sit on one baseline. 1: one account pointing at another, a weight on the edge,
and a dashed return path for taking it back. 2: the bot island, a dense cluster
sitting dark next to a lit graph. 3: a ranked scoreboard read by three
contracts.]`

---

## Use cases

**Eyebrow:** Use cases

**Section heading:** Different graphs. Different questions.

**01. Community reputation**
Find standing that comes from relationships, not token balance or a platform-owned rating.
Graph data: Vouches between people
Proven result: A score for earned trust

**02. Contribution funding**
Let trusted peer judgment direct a shared pool toward valuable work.
Graph data: Claims, peer evaluations, and rater reputation
Proven result: A funding allocation

**03. Impact discovery**
Surface credible work from public records without trusting a private ranking service.
Graph data: AT Protocol follows, claims, evaluations, and acknowledgements
Proven result: Scores for people and work

**04. Signer rotation**
Rotate a Safe's signers with the graph, not a hand-managed admin list.
Graph data: A proven score ranking and a signer threshold
Proven result: A Safe multisig's signer set

`[four substantial editorial rows rather than cards. Each use case names both the graph data and
the proven result so the section expands the visitor's model of a trustgraph rather than listing
four abstract market verticals.]`

---

## The proof

**Eyebrow:** Verification

**Section heading:** Don’t trust the computer. Check the proof.

The rules are public, so anyone can recompute the result. A short zero-knowledge proof shows every
committed input was included and the result matches those rules.

`[an inverted section gives the proof its own visual register. inputs → proof → chain, with
the rejected path drawn.]`

**Diagram, accepted path:** Every record in the graph → One short proof → The verifier checks
the result

**Diagram, rejected path:** An input dropped, or one invented → No valid proof exists

`[both rows sit on the same three columns so the second reads as the first with
something changed. The rejected row gets a figure too: the same receipt, drawn
as an empty dashed outline and struck through.]`

**Diagram caption:** A result is accepted only when the proof matches the graph and its rules.

---

## Roadmap

**Eyebrow:** Roadmap

**Section heading:** More inputs. Less exposure.

trustgraphs should work wherever useful graph data lives, then reveal only what the result needs.

The path runs from public on-chain attestations, through flexible off-chain sources, to fully
private graphs that remain verifiable.

**01. Current · On-chain EAS**
Public attestations, with every update committed before the graph is computed.

**02. Integrating · Off-chain EAS**
Signed attestations without a transaction per edge, anchored so the prover can't choose the
inputs.

**03. Pilot · AT Protocol**
Verify repo history and records before computing over social and impact data.

**04. Research · Private graphs**
Keep relationships and scores hidden while proving the result is correct.

`[a horizontal stepper on wide screens: four steps on one connecting line, not a card grid and not
a dated promise. Collapses to the original stacked rows below the lg breakpoint. The status tags
distinguish the current public path, integration work, the AT Protocol pilot, and privacy research
without inventing ship dates.]`

---

## Start one

**Eyebrow:** Start here

**Section heading:** Build the next trustgraph.

Start a community vouching network today. Choose its starting accounts, define what a vouch
means, and tune how trust flows.

The proof system is permissionless. The platform stays open to new graph programs as the input
layer grows.

**Button:** Create a vouching network

**Secondary button:** Read current status

---

## Ending CTA

**Eyebrow:** Open source

**Heading:** Open source. Take it apart.

**Button:** Star on GitHub

`[start and open source share one framed final block: action on paper, invitation to inspect the
code in the inverted rail.]`

---

## Footer

**Colophon:** trustgraphs · Trust, made legible

**Links:** FAQ · Docs · GitHub · X

`[FAQ copy lives in FAQ_PAGE_COPY.md, route /faq.]`

---

## Live module microcopy

**Graph caption:** Demo Co-op, live. Each line is a vouch. Size is score.

**Graph caption, before the data arrives or when it does not:** Demo Co-op. Each line is a
vouch. Size is score.

`[the word "live" is a claim about data that has actually arrived. The caption drops it
until the graph has something in it.]`

**Hero graph, the canvas itself (assistive):** Demo Co-op vouching graph

`[not the caption. They were the same string, so a screen reader announced the sentence as
the image's name and then read it again as the caption. The name says what the thing is and
the caption says how to read it.]`

**Graph unavailable, and shown when the network has nothing in it yet:** The demo graph is
temporarily unavailable. You can still browse published networks.

`[the empty case used to fall through to the graph component's own panel, which says "No
attestations yet" on the first screen a stranger sees, using a word the landing page never
defines.]`

**Graph, while it is loading:** Building graph

---

## Site chrome

Shared by all three pages, so it belongs here rather than on any one of them.

**Nav, wordmark:** Trustgraphs

**Nav, home link label (assistive):** Trustgraphs, home

**Nav, links:** Networks · Create a network

`[below sm the create link shortens to "Create": "NETWORK" on its own sat next to "NETWORKS"
and meant nothing.]`

**Nav, wallet button:** Connect account

**Nav, wallet button while connecting:** Connecting…

**Nav, wallet button once connected (assistive):** Account menu, <shortened address>

`[the name has to CONTAIN the visible label. A bare "Account menu" over a button reading
0x123..abc is a WCAG 2.5.3 failure: voice control repeats what it can see.]`

**Nav, theme toggle (assistive):** Switch to light theme / Switch to dark theme

**Nav, theme toggle before the page hydrates (assistive):** Switch theme

`[the toggle cannot know which theme it is switching to until next-themes has
resolved, and guessing then correcting shifts the nav. "Switch theme" is what a
reader with no JavaScript gets, and it is true in both directions.]`

**Nav, main landmark (assistive):** Main

**Nav, wordmark below 410px:** hidden, the mark carries the link on its own.

**Wallet picker, one row per wallet:** Browser wallet · Porto · MetaMask · Coinbase Wallet ·
WalletConnect, plus any other wallet the browser announces, under its own name.

`[the configured list is a floor, not the set: wagmi's EIP-6963 discovery is on by default
and appends whatever the browser advertises, so a reader with Rabby or Frame installed gets
extra rows under names this app does not choose.]`

`[Porto only appears off the local chain, which is why a local build shows four. "Browser
wallet" replaces wagmi's connector id, which shipped as the literal string "Injected".]`

`["Browser wallet" replaces wagmi's connector id, which shipped as the literal
string "Injected". It is one click from the nav on all three pages and a normal
reader has no way to know what it means.]`

**Wallet picker, no wallets:** No wallets available in this browser.

**Wallet menu:** <chain name> balance · Copy address · View profile · Disconnect

`[the chain name is read from the app's own config. It was hardcoded to "Optimism Balances"
on every deployment including the local one, where it was simply false.]`

**Wallet panel (assistive):** Choose a wallet / Account

**Page titles**, from a template: Networks | Trustgraphs · Questions | Trustgraphs.
The landing page is Trustgraphs alone, not Trustgraphs | Trustgraphs.

**Per-page share cards.** Each route sets its own description for search results,
Open Graph and X together. `/` uses the site description below, `/networks` uses
its standfirst, `/faq` uses "What people ask before they trust a scoreboard."

`[all three have to move together. The root layout sets an openGraph block AND a
twitter block, so overriding only one gave a page whose Slack unfurl and whose X
card carried two different sentences for the same URL.]`

**Site description**, used for search results and share cards on every page:
trustgraphs turn graph data into results anyone can verify, compose, and use.

---

## Networks directory

Route `/networks`, linked from the nav. Three different programs share this page and they do
not score the same thing, so each gets a heading and a line saying what it scores. A section
with nothing in it is left out rather than shown empty.

**Page title:** Networks

**Standfirst:** Networks on this chain, and what each one counts.

`["Every" was three things it is not. The vouching section reads one page of the registry,
capped at 200. The funding-round and repo sections are filtered slices of the shipped
config file, not a chain read, so a stranger's instance in either program appears only when
someone edits that JSON. Issue filed for the cap.]`

**Section: Vouching networks**
Members vouch for each other, and the vouches become a score.
Columns: Network · Accounts · Vouches · Scores proven

`["Members" in the sentence and "Accounts" in the column three lines below it is deliberate,
not a leftover. The sentence is about a community of people. The column is a count off the
proven tree, which includes every address the round scored, most of them at zero. They are
different populations and the page is more honest for using different words: the whole
reason the column stopped saying "Members" is that a bot island was being counted as
membership.]`

**Section: Funding rounds**
Members claim work and rate each other, and the pot follows the ratings.
Columns: Round · Contributions · Scores proven

**Section: Published work**
Accounts are scored on the impact claims and evaluations they have published.
Columns: Instance · Accounts · Scores proven

`["Repo reputation" and "the repositories they have actually worked on" described a
different program. The hypercerts graph runs over AT-Protocol records: evaluations,
endorsements, attributions and badges. "Repo" there is a PDS data repository, not source
code, and nobody is scored on repositories they worked on.]`

**Column note:** Accounts and the date come from the last proven scoreboard. The vouch count
is up to date, and covers only accounts that scored above zero on that scoreboard.

`[two corrections, one sentence. "Members" was the whole tree, zero-scored accounts and all,
which is the same number a bot island inflates: the page cannot boast about isolating an
island in one section and count it as members in another. And "counted live" was true of the
clock and not of the set. The count is taken at query time, so a revocation drops out
straight away, but only between accounts that scored above zero in the last root: a vouch
involving anyone who joined since, or anyone the round left at zero, is not in it. Counting
one vouch per pair is not a defect, but the reason is narrower than it first looks:
re-vouching OUTRANKS the earlier attestation rather than replacing it. Revocation excludes
by uid, so revoking the newer one brings the older one back at its original weight. The live
count is still one per pair; the resurrection is a product defect and has an issue.]`

**Never proven:** Not proven yet

**Unreadable:** Unknown

**Row figures on a phone, where there are no column headers to inherit a label from:**
48 accounts · 214 vouches · proven 3 days ago

**Row figures, nothing proven yet:** Not proven yet

**Row figures, read failed:** Scores unknown

**Search placeholder:** Filter networks

**No search results:** Nothing matches that.

**Empty state heading:** No networks yet. Create the first one.

**Empty state body:** Creating one takes a single transaction, and nobody has to approve it.

**Ending CTA heading:** Bring your own community.

**Ending CTA button:** Create a network

**Degraded heading:** Showing a partial list

**Degraded body:** The service that lists networks could not be reached, so this page is
showing only the networks the app shipped with. The ones below are still real.

`["networks created recently are missing" named the wrong set, and named it too kindly. The
fallback is the shipped config file, imported at build time, so what is missing is every
network ever created through the factory, whatever its age. The page has never seen any of
them, so it could not say which were recent even if it wanted to.]`

`[the underlying error string does not reach the page at all. It rendered in the card
first, then in a title attribute, which is worse: a browser draws that as a tooltip for
every sighted reader. "fetch failed" is the one line on the public surface that fails the
plain-reader test, so it is logged server-side and nowhere else.]`

---

## Voice notes

- The brand is **trustgraphs**, lowercase in copy. The unit is **a trustgraph**. Leading
  cap only in the wordmark and page titles.
- Short declaratives. No em-dashes.
- Say "vouch" to a newcomer, "attestation" once you've defined it. Never lead with
  PageRank, merkle roots, SP1, or epochs. Those belong in the docs.
- The differentiator is the receipt, not the ZK. Lead with what it prevents.
- Don't promise what isn't built. The Status section is the reason the rest of the page
  gets believed.

## Headline alternates

- Trust, counted.
- Sybils don't get a vote.
- Vouched for, not bought.
