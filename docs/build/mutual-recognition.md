# Mutual recognition

A mutual-recognition network scores only _reciprocated_ trust. Its `trust-graph-mutual` program
consumes the same EAS vouch stream and weighted-prior manifest as `trust-graph-weighted`, but a
vouch from `a` to `b` carries weight only when `b` also vouches for `a`. It is useful when a
community wants rank to reflect confirmed relationships — mutual endorsements, completed
exchanges, peer acknowledgements — rather than unilateral signals anyone can emit.

## The mutual gate happens before ranking, not after

Reconciliation is unchanged: replacements and revocations resolve in fold order until each
`(attester, recipient)` pair has one live weight. Then the gate applies: a directed edge survives
only if the reverse edge is also live, and both directions are assigned
`min(forward, reverse)`. One-way vouches, self-vouches, and asymmetric-pair edges are removed from
the scored graph entirely — they are not zero-weighted, they are absent.

This is a different consensus rule than filtering the published score list afterwards. A node
that never reciprocates contributes nothing to anyone else's rank either, because its outgoing
edges are dropped before PageRank runs. The gate is part of the proven computation, so the
output root commits to it.

## The prior still anchors the graph

The program keeps the weighted-prior semantics: an explicit, reviewed account-and-weight manifest
distributes the restart mass on every iteration, committed by root, entry count, and file digest
in the network parameters. Only accounts reachable from the prior-connected component receive
rank; a mutual pair with no path to the prior scores zero. With no surviving mutual edges the
proven output still distributes the prior's mass according to its normalized weights.

## Verifiable output

Every proof revalidates the canonical manifest, applies the same checkpoint/params/score
bindings, and commits the post-gate ranked output under the `mutual-trust-graph-account-v1`
output domain (`eip155-address` key encoding). Consumers verify scores against the accepted
onchain Merkle root exactly as they do for a standard or weighted trust graph — the domain
identifier is what distinguishes which semantics produced the root.

See [Create a network](./create-a-network.md) for the creation workflow,
[Weighted prior](./weighted-prior.md) for how the prior manifest is governed, and
[Networks and programs](../concepts/networks-and-programs.md) for the full program index.
