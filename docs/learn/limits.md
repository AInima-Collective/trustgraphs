# Honest limits

Trustgraphs makes strong guarantees about the math and deliberately makes none about
people. This page collects the limits worth knowing before you rely on a scoreboard: the
things the system does not solve, stated plainly.

## Humans choose the seeds

Every network starts from a small set of **trusted seeds**: the accounts trust flows out
from. People choose them, and choosing them well matters, because they're the anchor of
the whole system. Pick seeds that represent one clique and the scoreboard will faithfully,
provably reflect that clique's view of who matters. The math guarantees the scores follow
from the seeds and the vouches; it can't guarantee the seeds were a good choice. That
judgment stays human, and it is the real work of setting up a network.

## It stops manufactured crowds, not corrupt humans

The algorithm's promise is precise: fake accounts can't manufacture trust that was never
given. It says nothing about trust that real people give badly. A genuinely well-trusted
human can vouch corruptly (for a friend, for a bribe, for a bad judgment), and their vouch
will carry exactly the weight their standing gives it. That's a problem every community
already has, and trustgraphs doesn't claim to fix it. What it removes is the cheap
version of the attack: buying a crowd instead of earning one.

## Bots still land on the scoreboard

Bot armies can't attract trust, but they aren't invisible either. Every network gives
accounts a small "head start" of baseline trust, and any of it not reserved for the
starting accounts is split equally among everyone else, bots included. So a large enough
island of fake accounts can pool a real share of that baseline even though nobody vouched
for them from outside. A network that reserves the full head start for its starting
accounts closes that door, at the cost of newcomers starting from exactly zero.

## Nothing here is private

Vouches, rules, code, and scores are all public: that's what makes the scoreboard
checkable by anyone. It also means who you vouch for, who vouched for you, and your score
are visible to the world, forever. If that map of relationships is something you need to
keep private, this is the wrong tool.

## Someone still holds keys

Each network has a governance account that can change its settings, including re-pinning
the scoring parameters and replacing the contract that checks the proofs. Score-weighted
proposals can exercise those powers, but so can the wallet that created the network,
which starts as that account's only signer. Until a network broadens that control, "the
math is checked on-chain" sits downstream of a key that could swap out the checker. The
[governance page](./governance.md) describes the designed answer; it isn't all built yet.

## Not production-ready

Nothing is deployed to a production chain today: the system runs end to end on a test
chain, and Ethereum mainnet is the target. It has not been audited by an outside firm.
Point a network at something you can afford to get wrong.

---

Questions this page raised are probably in the [FAQ](./faq.md).
