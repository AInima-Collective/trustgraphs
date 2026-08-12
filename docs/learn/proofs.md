# Why you can trust the scores

Most scoring systems ask you to trust whoever runs the computer: Google computes your
rank, a credit bureau computes your score, and you take their word for it. Trustgraphs is
built so you never have to do that.

This page assumes you know [how scoring works](./how-scoring-works.md).

## Who runs the math? Nobody special.

The scoring rules are public and exact: same inputs, same scores, every time, down to the
last digit. There is no randomness, no hidden tuning, no "our systems have determined."
Anyone can download the vouches, run the published rules, and get byte-for-byte the same
scoreboard as everyone else.

That determinism is what makes the next part possible.

## The receipt

When someone submits a round's scores, they attach a **zero-knowledge proof**: a small
cryptographic receipt showing "these scores are what you get when you run the published
rules on the published vouches, without skipping any." The blockchain checks the receipt
automatically. A wrong answer, or an answer that quietly ignored someone's vouch,
produces no valid receipt and gets rejected.

Despite the name, the proof isn't there to hide anything: vouches, rules, and scores are
all public. "Zero-knowledge" proof technology is used here for a different reason: it
compresses an enormous computation into one receipt the chain can check cheaply, so a
whole scoreboard is verified in a single step instead of everyone recomputing millions of
scores.

## Nothing can be omitted

A subtler attack than faking scores is leaving vouches out: a prover who could quietly
drop the vouches they dislike could tilt the scoreboard while still "running the rules."

Trustgraphs closes this. The chain keeps a running tally of every vouch ever made (and
every one revoked), updated the moment each attestation lands. The proof must account for
exactly that tally: consume the complete set, nothing missing, nothing invented. A proof
built on a doctored input set simply doesn't verify.

## No trusted middleman

Put those pieces together and there is no operator to trust. Anyone can compute a round's
scores and prove them; the chain accepts whoever shows up with a valid receipt. If every
server run by the project vanished tomorrow, anyone could recompute the scores from
public data and prove them. You never trust the person who did the math. You check the
receipt.

## What keeps it honest

- **Everything is public.** The vouches, the rules, the code, the scores. There's nothing
  to leak because nothing is hidden.
- **Nothing can be omitted.** The proof must account for the complete on-chain tally of
  vouches, so no one can be silently erased.
- **No trusted middleman.** The proof replaces the operator. Producing scores is
  permissionless; checking them is automatic.

One status note: today this loop runs end to end on a test chain, and nothing is deployed
to a production chain yet (Ethereum mainnet is the target). The [FAQ](./faq.md) keeps the
current status honest.

---

Don't take this page's word for it either: [reproduce an epoch from public
data](../verify/reproduce-an-epoch.md) walks through checking a round yourself.
