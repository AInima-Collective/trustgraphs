# TrustGraph, Explained Simply

This is the plain-language guide. For the full algorithm spec see
[`ALGORITHM.md`](./ALGORITHM.md), and for the deep design docs see
[`research/`](../research/).

## The problem

The internet has a fake-account problem. Anywhere reputation matters, someone will
manufacture it: a thousand bot accounts all vouching for each other until they look like a
crowd of real people. If reputation decides who gets votes or rewards, faking it pays.

TrustGraph is a reputation system built to resist that. It gives every account a score
based on who vouches for whom, in a way that fake accounts can't inflate, and it publishes
those scores so that anyone can check the math.

## Vouching

The basic action in TrustGraph is a vouch: one account publicly saying "I trust this
account", with a weight attached. These vouches are recorded on a blockchain as
**attestations** (a standard format for signed public statements, using the Ethereum
Attestation Service). You can vouch for someone, and you can take it back later.

All the vouches together form a web: accounts connected by arrows of trust. That web is
the trust graph the project is named after.

## Turning vouches into scores

Counting vouches doesn't work: bots can vouch endlessly. Instead, TrustGraph uses the same
idea Google used to rank web pages, called PageRank: **a vouch is worth more when it comes
from someone who is themselves trusted.**

Imagine trust as a liquid. It starts at a small set of **trusted seeds**: accounts the
community has chosen as starting points. (It's the way you might anchor a rumor by asking
"who told *you*?" until you reach someone you actually know.) Trust flows out from the
seeds along the vouch arrows, splits where arrows split, and fades as it travels. Your score is
how much of that liquid ends up pooled at your account.

This is why bot armies fail. A thousand bots vouching for each other form an island: lots
of arrows, but no trust flowing in, because no trusted account points at the island. All
those vouches move zero liquid. The only way to gain score is for trust to actually reach
you from the real community.

## Who runs the math? Nobody special.

Here's the unusual part. Most scoring systems ask you to trust whoever runs the computer:
Google computes your rank, a credit bureau computes your score, and you take their word
for it.

TrustGraph doesn't have that. The scoring rules are public and exact: same inputs, same
scores, every time, down to the last digit. Anyone can run the computation. And when
someone submits the results, they attach a **zero-knowledge proof**: a small cryptographic
receipt showing "these scores are what you get when you run the published rules on the
published vouches, without skipping any." The blockchain checks the receipt automatically.
A wrong answer, or an answer that quietly ignored someone's vouch, produces no valid
receipt and gets rejected.

So you never trust the person who did the math. You check the receipt. Since anyone can
produce a valid one, no company or operator sits in the middle.

## The scoreboard

Publishing every score on-chain would be expensive, so TrustGraph publishes a
**fingerprint** of the whole scoreboard instead (a merkle root, for the technically
inclined). Your score comes with a short receipt proving "this score is part of that
fingerprint." Contracts and apps check your receipt against the published fingerprint,
which takes a moment, instead of storing millions of scores.

Scores refresh in rounds called **epochs**. Each round, the set of vouches is frozen at a
cut-off, someone proves the new scores, and the new fingerprint goes on-chain. Each network
chooses its own cadence (a weekly rhythm is the working assumption; the development default
is unscheduled — anyone can start a round at any time). Past rounds are never recalculated:
whatever your score was when a round settled, it stays settled.

## What scores are for

Two things, so far:

- **Voting weight.** A governance module can weigh votes by trust score instead of by
  token balance. Influence follows earned trust, not wallet size.
- **Rewards.** A distributor contract can split a pot of funds by score. You claim your
  share by showing your score receipt.

Anything else that needs a sybil-resistant "how trusted is this account?" signal can read
the same scoreboard.

## What keeps it honest

- **Everything is public.** The vouches, the rules, the code, the scores. There's nothing
  to leak because nothing is hidden.
- **Nothing can be omitted.** The chain keeps a running tally of every vouch ever made
  (and every one revoked). The proof must account for the complete tally, so a prover
  can't quietly leave out the vouches they dislike.
- **No trusted middleman.** The proof replaces the operator. If every server run by the
  project vanished tomorrow, anyone could recompute the scores from public data and prove
  them.
- **Honest limits, too.** The trusted seeds are chosen by people, and choosing them well
  matters: they're the anchor of the whole system. And no algorithm stops a real,
  well-trusted human from vouching corruptly; it only stops manufactured crowds from
  faking their way in.

## How it changes over time

Rules that give out money and votes will eventually need updating, and "who gets to change
the scoring rules?" is its own attack surface. The short version of TrustGraph's answer:

- **Versions are sealed.** A published version of the rules is never edited. Changes ship
  as a new version alongside the old one, and everyone can see both.
- **Small dials move fast, big changes move slow.** Routine tuning happens within hard,
  pre-agreed limits after a short delay. Changing the algorithm itself requires a public
  dress rehearsal (the new rules score everyone in parallel so you can see exactly what
  would change) and a long waiting period.
- **You can always leave first.** No change takes effect before the people affected have
  had time to object, switch versions, or exit. An emergency brake exists for genuine
  bugs, but it can only stop the machine, never change the rules.

One honest caveat: only part of this is running today. Sealed, governed parameter
versions are built — including a preview that shows how a proposed change would move
everyone's scores before it takes effect. The rest of the machinery, including the slow
path for changing the algorithm itself, is **designed but not yet implemented**. The full
design is in [`research/UPGRADE_GOVERNANCE.md`](../research/UPGRADE_GOVERNANCE.md).

## In one paragraph

TrustGraph turns public vouches into spam-resistant reputation scores using
trust-weighted PageRank, lets anyone compute the scores and prove them correct with a
zero-knowledge receipt instead of trusting an operator, publishes a compact fingerprint of
the scoreboard on-chain every epoch, and feeds those proven scores into voting and reward
contracts. Fake crowds can't reach a high score, hidden operators can't fudge one, and the
rules can only change slowly, visibly, and with an exit door open.
