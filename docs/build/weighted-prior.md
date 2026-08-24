# Weighted prior

A weighted-prior network combines the EAS vouch graph with an explicit account-and-weight
allocation. Its separate `trust-graph-weighted` program uses that allocation as a persistent
personalized PageRank prior. It is useful when a community already has a reviewed membership list,
election result, or reputation distribution that should anchor the graph unequally.

## The prior and the graph are different inputs

The prior distributes the program's restart mass on every iteration, not only at network creation.
Vouches determine how influence flows away from that distribution. Adding or revoking a vouch
changes the graph; it does not silently edit the prior. With no active vouches, the proven output
matches the normalized prior.

The creation flow shows the exact account-and-weight manifest before it is signed. Its hash, root,
and entry count are committed to the network parameters so the prover cannot substitute a
different list.

## Updating a prior

A prior update is a protected controller action, not routine member activity. On a governed
weighted network, the DAO must approve the replacement manifest before it enters the weighted
controller's proposal and activation delay. On a wallet-owned weighted network, the controller
admin proposes it directly. The settings page shows the pending version and its status. An
ordinary user cannot replace the prior simply by submitting a new list.

Use a prior update when the community has made a deliberate decision to replace its starting
allocation—for example, after a new election or membership review. Use vouches and revocations for
normal changes in trust between members.

## Verifiable output

Every proof revalidates the canonical prior manifest against its committed root, entry count, and
file digest, then binds the active prior, graph checkpoint, scoring parameters, and published score
file. The exact active manifest therefore remains required prover input. Consumers verify scores
against the accepted onchain Merkle root in the same way as a standard trust graph.

See [Create a network](./create-a-network.md) for the creation workflow and
[Governance](../learn/governance.md) for how protected changes are controlled.
