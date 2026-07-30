# trustgraphs landing page copy

Sections are in page order. `[brackets]` are design direction, not copy.
Every claim below is something the code does today unless the line says otherwise.

---

## Hero

**Eyebrow:** Vouch · Score · Prove · Use

**Headline:** Reputation you can't buy.

**Subhead:** A trustgraph maps who vouches for whom. That map becomes a score any app or
contract can read, so votes and money follow the people your community actually trusts.

**Primary button:** Open the Demo Co-op

`[the live graph is the hero image. It should be moving before anyone scrolls.]`

---

## How it works

**Section heading:** Three moves.

**1. Vouch**
Sign a public statement that you trust an account, with a weight on it. Change it or take
it back whenever you want.

**2. Score**
Trust starts at a handful of accounts your community picked and flows outward along the
vouches. A vouch from a trusted account carries weight. A thousand bots vouching for each
other carry none, because no trust ever reaches them.

**3. Use**
Each round, the scoreboard is published on-chain. Any contract can read it: voting weight,
funding splits, access, whatever you need a real member count for.

`[three panels. Panel 2 wants the bot island: a dense cluster sitting dark next to a lit graph.]`

---

## The proof

**Section heading:** Anyone can run the math.

Most scoring systems ask you to trust whoever owns the server. This one doesn't have a
server to trust. The rules are public and exact, so anyone can run them and get the same
answer down to the last digit.

Whoever submits a scoreboard attaches a zero-knowledge proof: a short receipt the chain
checks by itself. Drop a vouch you dislike, invent one that never happened, or round a
number your way, and no valid receipt exists.

You never trust the person who did the math. You check the receipt.

`[if one thing on this page gets a diagram, it's this. inputs → proof → chain, with the
rejected path drawn.]`

---

## Why

**Section heading:** What this is for.

**Give away control without giving away the keys.**
A founder with most of the tokens can hand governance to the people who earned it, and
watch the graph do the deciding.
`[one heavy node dissolving into a network]`

**Count more than tokens.**
Contributions, endorsements, history, on-chain and off. Weight is computed from the graph,
not from a balance.

**One reputation, many contexts.**
Score the same people different ways for different questions. Reputation earned in one
place can be read in another.

---

## Features

**Section heading:** What you can turn on.

**Trust-weighted voting**
Votes weigh by score instead of tokens, through a module on your existing Safe.

**Score-weighted payouts**
Split a pot by score, or run a round where peers rate the work and the split follows.

**Self-updating multisig**
The top accounts by score become your Safe owners, and the set keeps up with the graph.

**Published criteria**
Say what a vouch means in your network, and where newcomers apply.

**Exportable scoreboards**
Every round downloads as CSV or JSON, proofs included. Use it off-chain too.

**Mixed sources**
Vouches on Ethereum today, plus reputation proven over AT-Protocol accounts.

`[six-up grid, two rows. no icons unless they can be ink-only.]`

---

## Start one

**Section heading:** Bring your own community.

Create a network in one transaction. Nobody approves it, and it shows up in the app seconds
later. A prover picks it up on its own schedule, so there is no operator to hire and no
server for you to run.

Proving costs real money. Fund your network's tank and whoever produces your scoreboard
gets paid out of it.

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

**Network table:** Network · Members · Attestations

**Empty state:** No networks yet. Create the first one.

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
