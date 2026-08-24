# What is trustgraphs?

Trustgraphs is a reputation system where people publicly vouch for each other, and math
that anyone can check turns those vouches into scores that fake accounts can't inflate.

## The problem

The internet has a fake-account problem. Anywhere reputation matters, someone will
manufacture it: a thousand bot accounts all vouching for each other until they look like a
crowd of real people. If reputation decides who gets votes or rewards, faking it pays.

Trustgraphs is built to resist that. It gives every account a score based on who vouches
for whom, in a way that fake accounts can't inflate, and it publishes those scores so that
anyone can check the math.

## Vouching

The basic action in trustgraphs is a vouch: one account publicly saying "I trust this
account", with a weight attached. These vouches are recorded on a blockchain as
**attestations** (a standard format for signed public statements, using the Ethereum
Attestation Service). You can vouch for someone, and you can take it back later.

All the vouches together form a web: accounts connected by arrows of trust. That web is
the trust graph the name comes from. Each community runs its own **network**: its own
copy of trustgraphs, with its own members, its own vouches, and its own scoreboard.

## From vouches to scores, in one breath

Counting vouches doesn't work, because bots can vouch endlessly. Instead, imagine trust as
a liquid that starts at a few accounts the community picked as starting points and flows
outward along the vouch arrows. Your score is how much of that liquid reaches you. A bot
army is an island no trusted arrow points at, so no trust flows in and all its vouches
move nothing. [How scoring works](./how-scoring-works.md) tells this story properly.

## Keep reading

- [How scoring works](./how-scoring-works.md): vouches, trusted seeds, why bot armies
  fail, and how scores land on-chain.
- [Why you can trust the scores](./proofs.md): nobody special runs the math, and a
  cryptographic receipt keeps everyone honest.
- [Governance](./governance.md): how the rules can change over time without anyone
  moving the goalposts on you.
- [FAQ](./faq.md): what people ask before they trust a scoreboard.

When you want the mechanics, the [algorithm spec](../concepts/algorithm.md) goes all the
way down.
