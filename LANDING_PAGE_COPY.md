# trustgraphs landing page copy

Draft for the redesign. Everything below is page copy, in page order. ~730 words.

**Naming:** always lowercase. The unit is *a trustgraph*: what a community creates, and
what the app currently calls a network. Avoid the brand as a sentence subject.

---

## Hero

**Eyebrow:** Vouch. Score. Prove. Use.

**Headline:** Reputation you can't buy.

*(Alternate headline: "Ask the people who'd know.")*

**Subhead:** A trustgraph is a map of who vouches for who. It turns what your community
already knows into a score, so influence and money flow to the people the network
actually trusts.

**Buttons:** See a live trustgraph · Start your own

---

## How it works

**1. Vouch.** A member signs a public statement: "I trust this account," with a weight.
They can change it or take it back at any time.

**2. Score.** Trust flows out from a small set of accounts your community picked as
starting points. It follows the vouches, splits where they split, and fades as it
travels. Your score is how much trust pools up at your account. This is the idea behind
Google search, pointed at people instead of web pages: a vouch counts for more when it
comes from someone trusted, and counts for nothing when it comes from nowhere.

**3. Use.** The scoreboard is published on-chain each round, where any app or contract
can read it.

---

## What you can do with a scoreboard

**Govern without a token.** Anyone with a score can open a proposal and vote on it,
weighted by that score. Quorum is measured against the whole scoreboard, and a proposal
that passes executes straight from your Safe.

**Share out a pot of money.** Fund a distribution in ETH or any token, and members claim
their share against the published scores. Set a deadline, and whatever goes unclaimed
returns to whoever funded it.

**Pay for contributions.** Members post work they did, or nominate someone else's.
Others rate what it was worth, and the pot is split by those ratings, weighted by each
rater's own reputation. Reviewers earn a slice too, because reviewing is work.

**Keep a multisig in step with the community.** The highest-scoring accounts become the
signers on your Safe, and that set rotates as trust shifts, with nobody hand-picking it.

**Hand over concentrated power safely.** If one founder, whale, or multisig holds most of
the votes, that power can point at the scoreboard instead and follow the graph from
there. No tokens move. Trust that pooled in one place gets spread back across the people
who earned it.

All of them read the same scoreboard. The first four are built today. The fifth is in
design.

---

## Why it's hard to game

**Bot armies get zero.** A thousand fake accounts vouching for each other form an
island. No trust ever flows in, so none of those vouches move the needle. The only way
up is for real members to point at you.

**Nobody to take at their word.** Most scores ask you to trust whoever runs the
computer. Here the rules are public and exact, anyone can run them, and every published
scoreboard carries a cryptographic receipt (a zero-knowledge proof) that the blockchain
checks by itself. A wrong answer produces no valid receipt, and gets rejected.

**Nothing can be left out.** The chain keeps a running tally of every vouch ever made. A
scoreboard only counts if it accounted for all of them, so nobody can quietly drop the
vouches they'd rather ignore. Payouts work the same way: the whole path from vouch to
payment is proven end to end.

---

## Start your own

Name it, choose a handful of accounts to trust as starting points, sign one transaction.
Members can vouch straight away, and scores start publishing round by round. Add the
voting, funding, and multisig pieces when you want them.

**Button:** Create a trustgraph

---

## FAQ

**Do I need to buy a token?**
No. Taking part costs an ordinary transaction fee and nothing else.

**What if a trusted member vouches for the wrong people?**
Their vouches carry their weight, and everyone can see them. Nothing here stops a real
person from making a bad call. What it stops is a manufactured crowd faking its way in.

**Who's behind the numbers?**
Nobody in particular, by design. The vouches, the rules, the code, and the scores are
all public, and anyone can recompute the whole scoreboard and prove it.

---

## Footer

Early and experimental. The code is open, one trustgraph is live, and the voting,
funding, and payout pieces are built. If you want to try it, test early prototypes, or
just follow along, leave your details.

**Button:** Open interest form
