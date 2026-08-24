# How scoring works

Scores in trustgraphs come from one simple action, vouching, run through one simple idea:
a vouch is worth more when it comes from someone who is themselves trusted. This page
walks through the whole path from a vouch to a score you can use.

New here? Start with [What is trustgraphs?](./what-is-trustgraphs.md)

## Vouching

A vouch is one account publicly saying "I trust this account", with a weight attached: a
strong vouch for a close collaborator, a lighter one for an acquaintance. Vouches are
recorded on a blockchain as **attestations** (signed public statements in a standard
format, using the Ethereum Attestation Service), so anyone can see who vouched for whom,
and nobody can forge a vouch in your name. A vouch is not forever: you can revoke it
later, and the next scoring round will reflect that.

All the vouches together form the trust graph: accounts connected by weighted arrows of
trust.

## A vouch is worth more from a trusted account

Counting vouches doesn't work: bots can vouch endlessly. Instead, trustgraphs uses the
same idea Google used to rank web pages, called PageRank: **a vouch is worth more when it
comes from someone who is themselves trusted.**

Imagine trust as a liquid. It starts at a small set of **trusted seeds**: accounts the
community has chosen as starting points. (It's the way you might anchor a rumor by asking
"who told *you*?" until you reach someone you actually know.) Trust flows out from the
seeds along the vouch arrows, splits where arrows split, and fades as it travels. Your
score is how much of that liquid ends up pooled at your account.

So a single vouch from a well-trusted community member moves more trust to you than a
hundred vouches from accounts nobody trusts. And trust you receive flows onward through
your own vouches, which is what makes your vouch valuable in turn.

## Why bot armies fail

A thousand bots vouching for each other form an island: lots of arrows, but no trust
flowing in, because no trusted account points at the island. All those vouches move zero
liquid. The only way to gain score is for trust to actually reach you from the real
community.

One honest detail. The create form reserves all baseline trust for the starting accounts
by default, so a disconnected account starts at zero. A community can lower that advanced
setting. If it does, the remainder is split equally among everyone else, and a large
enough island of bots can pool a real share of that baseline even with no vouches from
outside. The network's seed selection and baseline settings therefore remain important
governance decisions.

## The scoreboard and its fingerprint

Publishing every score on-chain would be expensive, so trustgraphs publishes a
**fingerprint** of the whole scoreboard instead (a merkle root, for the technically
inclined): a short string that changes if even one score changes. Your score comes with a
short receipt proving "this score is part of that fingerprint." Contracts and apps check
your receipt against the published fingerprint, which takes a moment, instead of storing
millions of scores.

## Epochs: scoring in rounds

Scores refresh in rounds called **epochs**. Each round, the set of vouches is frozen at a
cut-off, someone computes and proves the new scores, and the new fingerprint goes
on-chain. Each network chooses its own cadence; a network may also allow anyone to start a round
when its inputs have changed.

Past rounds are never recalculated: whatever your score was when a round settled, it
stays settled. Between rounds, new vouches queue up for the next cut-off.

## What scores are for

Two things, so far:

- **Voting weight.** A governance module can weigh votes by trust score instead of by
  token balance. Influence follows earned trust, not wallet size.
- **Rewards.** A distributor contract can split a pot of funds by score. You claim your
  share by showing your score receipt.

Anything else that needs a sybil-resistant "how trusted is this account?" signal can read
the same scoreboard.

---

Next: [Why you can trust the scores](./proofs.md). For the exact rules, down to the last
digit, see the [algorithm spec](../concepts/algorithm.md).
