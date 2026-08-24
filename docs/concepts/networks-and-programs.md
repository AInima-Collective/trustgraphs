# Networks and programs

A **network** is a community's deployed scoring system: its inputs, parameters, governance, proof
history, and current score root. A **program** is the deterministic set of rules used to turn a
network's committed inputs into an output.

Many networks can use the same program. They still remain independent because each network has its
own contracts, governance, data, and proof history.

## Available programs and extensions

| Program or extension | Purpose |
| --- | --- |
| [Trust graph](../build/trust-graph.md) | Scores an Ethereum vouch graph. |
| [Weighted prior](../build/weighted-prior.md) | Seeds a vouch graph with an explicit starting allocation. |
| [Score compositions](../build/composition.md) | Combines several accepted score sets under a governed allocation policy. |
| [Signer sync](../build/signer-sync.md) | Uses proven scores and activity to manage a Safe owner set. |
| [Hypercerts](../build/hypercerts.md) | Builds scores from authenticated Hypercerts AT Protocol records. |
| [Nostr workspace](../build/nostr-workspace.md) | Builds scores from authenticated activity in a member-scoped Nostr workspace. |
| [Contributions](../build/contributions.md) | Allocates a funding pool using assessments weighted by proven reputation. |
| [Off-chain EAS attestations](../build/offchain-attestations.md) | Adds a gasless, signed input path to the trust graph. |

Some entries produce score roots directly; others extend a network or consume roots produced by
another program. Their individual pages explain that boundary.

## What identifies a program

Every proving program has a program identifier and verification key. The network pins the expected
values, and its verifier accepts only a proof produced by the matching program. A proof from a
different program or network cannot be substituted just because its output has the same shape.

Changing consensus behavior creates a new program version and verification key. Existing accepted
roots remain verifiable under the version that produced them.

## What identifies a network

A network has a stable instance ID and a registered contract set. The registry lets indexers,
provers, and applications discover the network without trusting a hand-maintained list. The
network's proof statement also includes an instance-specific domain so that two identically
configured deployments cannot accept one another's proofs.

To deploy an existing program, see [Create a network](../build/create-a-network.md). To implement a
new one, see [Add a program](../build/add-a-program.md).
