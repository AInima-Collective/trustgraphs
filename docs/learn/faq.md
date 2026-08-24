# Questions

What people ask before they trust a scoreboard. New here? Start with
[What is trustgraphs?](./what-is-trustgraphs.md)

## Basics

**What is an attestation?**
A signed public statement about someone, recorded on-chain through the Ethereum
Attestation Service. A vouch is one kind. You can revoke it later.

**Who picks the starting accounts?**
Your community does, when the network is created. They anchor the whole graph, so choosing
them well is the real work. Changing them later is a settings change made through the
network's own governance. Who controls those settings is part of the network's trust
model.

**How often do scores update?**
In rounds. Each round freezes the set of vouches at a cut-off, someone proves the new
scores, and the result goes on-chain. Every network sets its own pace, and a settled
round is never recalculated.

## Trust and gaming

**Can someone buy a high score?**
Not with money. Buying score means getting genuinely trusted people to vouch for you. What
no algorithm stops is a trusted person vouching badly, which is a problem every community
already has.

**Why don't bot armies work?**
Score comes from trust flowing out of the starting accounts. A thousand bots vouching for
each other form an island with lots of arrows and nothing flowing in, so none of those
vouches earns any trust. The create form reserves the full starting share by default, which
leaves a disconnected island at zero. A community can lower that advanced setting, but
then every other account gets an equal slice of the remainder and a big enough island can
hold a real share.

**Is my data private?**
No. Vouches, rules, code, and scores are all public. That is what makes the scoreboard
checkable by anyone.

**Then what does the zero-knowledge proof hide?**
Nothing. It isn't there for privacy. It's there so a whole scoreboard can be verified in
one cheap on-chain check instead of everyone recomputing millions of scores.

**How do you know a prover didn't leave someone out?**
The chain keeps a running commitment to every attestation as it lands. A proof only
verifies if it consumed exactly that set, so a prover can't quietly drop the vouches they
dislike or add ones that never happened.

## Running a network

**Who can create one?**
Anyone. It takes one transaction and nobody approves it.

**What does it cost?**
Creating and using a network costs transaction fees. Producing a score root also costs
compute, publication, and submission gas. A network can fund a proving vault so an
operator is paid for accepted work, or its community can run a prover directly.

**Do I have to run a server?**
Not necessarily. Proving is permissionless, so any compatible operator can freeze a round
and submit its result. Run your own prover if you need independent availability or if no
operator has agreed to cover your network.

**Can I use the scores somewhere else?**
Yes. A vouching network's scoreboard downloads as CSV or JSON, and any contract can check
one account's score against the on-chain root, given the score and its proof.

## Status

**Is this ready for production?**
Trustgraphs is still pre-production. Review the contracts, deployment configuration, and
operational assumptions before using a network for decisions with material consequences.

**Has it been audited?**
Not by an outside firm. Point a network at something you can afford to get wrong.

**Where do I read the details?**
The code and specifications are open. Start with the introduction,
[What is trustgraphs?](./what-is-trustgraphs.md), then the
[algorithm spec](../concepts/algorithm.md).
