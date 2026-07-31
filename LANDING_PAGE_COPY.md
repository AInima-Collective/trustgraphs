# trustgraphs landing page copy

Sections are in page order. `[brackets]` are design direction, not copy.
Every claim below is something the code does today unless the line says otherwise.

---

## Hero

**Eyebrow:** Vouch · Score · Prove · Use

**Headline:** Reputation you can’t buy.

**Subhead:** A trustgraph maps who vouches for whom. That map becomes a score any app can
read and any contract can check, so votes and money follow the people your community
actually trusts.

`[a contract checks one pair, it does not read a board. This is the same correction the Use
panel got: the subhead was carrying the old wording, and it is also the site's meta
description, so it was the sentence in every search result.]`

**Primary button:** Open the Demo Co-op

**Secondary button:** How it works

`[the live graph is the hero image. It should be moving before anyone scrolls.]`

`[two buttons, because a stranger wants one of two things: to poke at a real
network, or to be told what this is first. The second is an anchor to "Three
moves.", not a route.]`

---

## How it works

**Section heading:** Three moves.

**1. Vouch**
Sign a public statement that you trust an account, with a weight on it. Change it or take
it back whenever you want.

**2. Score**
Trust starts at a handful of accounts your community picked and flows outward along the
vouches. A vouch from a trusted account carries weight. A bot island has no trust flowing
into it, so vouching for itself earns it nothing. Whether it keeps a share anyway is a dial
when you create the network, and its default leaves it one.

`[the last sentence is not decoration. The node set is built from the edges
(pagerank-core/src/reconcile.rs), so vouching for each other is exactly how an island
becomes a set of scored accounts, and calculate_generic still credits every one of them
their slice of the head start you did not reserve. The wizard reserves 15% by default.
Saying "a bot island gains nothing" without this is backwards, not merely incomplete.]`

**3. Use**
When a round is proven, its scoreboard is committed on-chain. Any contract can check a
score against it: voting weight, funding splits, access, whatever you need a real member
count for.

`[a contract checks, it does not read. MerkleSnapshot stores a root, not scores
(MerkleState in src/contracts/merkle/MerkleSnapshot.sol), and the only entry point is
verifyProof(account, value, proof) — the caller has to already hold both.]`

`[three panels, each with its own ink figure pinned to the bottom so all three
sit on one baseline. 1: one account pointing at another, a weight on the edge,
and a dashed return path for taking it back. 2: the bot island, a dense cluster
sitting dark next to a lit graph. 3: a ranked scoreboard read by three
contracts.]`

---

## The proof

**Section heading:** Anyone can run the math.

Most scoring systems ask you to trust whoever owns the server. This one doesn’t have a
server you have to believe. The rules are public and exact, so anyone can run them and get the same
answer down to the last digit.

Whoever submits a scoreboard attaches a zero-knowledge proof: a short receipt the chain
checks by itself. Drop a vouch you dislike, invent one that never happened, or round a
number your way, and no valid receipt exists.

You never trust the person who did the math. You check the receipt.

`[that last line is the sentence the section exists to earn, so it is set as a
pull quote beside the argument rather than as its third paragraph.]`

`[if one thing on this page gets a diagram, it's this. inputs → proof → chain, with the
rejected path drawn.]`

**Diagram, accepted path:** Every vouch in the round → One short proof → The chain checks
the proof

**Diagram, rejected path:** A vouch dropped, or one invented → No proof exists to check

`[both rows sit on the same three columns so the second reads as the first with
something changed. The rejected row gets a figure too: the same receipt, drawn
as an empty dashed outline and struck through.]`

**Diagram caption:** The vouches go in, one short proof comes out, and the chain checks the
proof by itself. Change the vouches and there is no proof to check.

---

## Why

**Section heading:** What this is for.

**Give away control without giving away the keys.**
A founder with most of the tokens can hand governance to the people who earned it, and
watch the graph do the deciding.
`[one heavy node dissolving into a network]`

**Count more than tokens.**
Contributions, endorsements, history, all of it on-chain. Weight is computed from the
graph, not from a balance.

`["and off" was not available to any network a stranger can create: TrustGraphFactory
reverts Lane2NotSupported and the wizard hard-codes lane 2 off. Mixed sources, below,
already says off-chain is a second program and not self-serve.]`

**One reputation, many contexts.**
Score the same people different ways for different questions. Reputation earned in one
place can be read in another.

---

## Features

**Section heading:** What you can turn on.

**Trust-weighted voting**
A Safe module weighs votes by score instead of tokens. Connecting it is a manual deployment
today.

**Score-weighted payouts**
Split a pot by score, and let anyone claim their share against the published scoreboard.

**Self-updating multisig**
A module can rotate a Safe’s owners to the top accounts by score. Wiring it is a manual
deployment today.

**Published criteria**
Say what a vouch means in your network, and where newcomers apply.

**Exportable scoreboards**
A network’s scoreboard downloads as CSV or JSON, so you can use the scores off-chain. The
file carries the scores, not the proofs.

`["the published scoreboard" was doing work the export does not: the button writes whatever
the page is currently showing, which the simulation toggle beside it can change. Issue
filed. The claim here is only about the file's contents, which is true either way.]`

**Mixed sources**
Vouches on Ethereum today. Reputation over AT-Protocol accounts is a second program, proven
the same way, and not self-serve yet.

`[six-up grid, two rows. no icons unless they can be ink-only.]`

---

## Start one

**Section heading:** Bring your own community.

Create a network in one transaction. Nobody approves it, and it shows up in the app once
the indexer catches up. Proving is permissionless, so anyone can produce your scoreboard
and no operator can lock you out.

Proving costs real money. Your network has a tank to pay whoever produces its scoreboard,
though it pays nothing until the tank is funded, its per-round limit is set by contract
call, and we have priced networks of that size. You can also prove it yourself: the prover
is open source, and the bill is your own machine and gas.

`[four gates, not one. The vault account does not exist until someone deposits, so
setPolicy reverts UnknownInstance before a first deposit; maxPerRootUsd must be non-zero;
the fee band must be priced by us; and the ETH/USD feed must be fresh. Saying "one contract
call" read as sufficient.]`

`[both sentences were stronger than the code. "No server for you to run" implies somebody
else runs one; permissionless only means nobody can stop you. And the tank cannot pay
anything until maxPerRootUsd is set: TrustGraphFactory forwards the deposit and never calls
ProvingVault.setPolicy, so _settle short-circuits to PolicyDisabled and the operator holds
Unfunded. "Free forever" also skipped the 16-32 GiB and the gas. Issue filed for the
policy gap.]`

**Button:** Create a network

---

## Ending CTA

**Heading:** Open source. Take it apart.

**Button:** Star on GitHub

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

**Graph unavailable, and shown when the network has nothing in it yet:** The Demo Co-op is
not reachable right now. Every network on the directory is still live on chain.

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
WalletConnect

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
Reputation you can’t buy. A trustgraph turns the vouches your community already makes into
a score anyone can verify, published on-chain each round.

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
Columns: Network · Members · Vouches · Scores proven

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

**Column note:** Members and the date come from the last proven scoreboard. Vouches are
counted live.

`[the first draft said every number came off the same scoreboard as its date. It doesn't:
the indexer counts attestations that are un-revoked at query time, among the accounts in the
latest root. Members and the date are as-of-root, vouches are live.]`

**Never proven:** Not proven yet

**Unreadable:** Unknown

**Row figures on a phone, where there are no column headers to inherit a label from:**
48 members · 214 vouches · proven 3 days ago

**Row figures, nothing proven yet:** Not proven yet

**Row figures, read failed:** Scores unknown

**Search placeholder:** Filter networks

**No search results:** Nothing matches that.

**Empty state heading:** No networks yet. Create the first one.

**Empty state body:** Creating one takes a single transaction, and nobody has to approve it.

**Ending CTA heading:** Bring your own community.

**Ending CTA button:** Create a network

**Degraded heading:** Showing a partial list

**Degraded body:** The service that lists networks could not be reached, so networks created
recently are missing from this page. The ones below are still real.

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
- Your community already knows who to trust.
- Sybils don't get a vote.
- Vouched for, not bought.
