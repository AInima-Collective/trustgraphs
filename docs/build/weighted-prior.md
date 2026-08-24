# Weighted prior

A weighted-prior network uses the same vouch graph and proof system as a standard trust graph, but
starts the scoring calculation with an explicit allocation of influence. It is useful when a
community already has a reviewed membership list, election result, or reputation distribution
that should seed the graph.

## The prior and the graph are different inputs

The prior assigns a starting weight to selected accounts. Vouches still determine how trust flows
through the graph after that starting point. Adding or revoking a vouch changes the graph; it does
not silently edit the prior.

The creation flow shows the exact account-and-weight manifest before it is signed. Its hash, root,
and entry count are committed to the network parameters so the prover cannot substitute a
different list.

## Updating a prior

A prior update is a governance action, not routine member activity. The network's configured
authority proposes a replacement manifest, and the update follows the controller's review and
activation rules. The settings page shows the active proposal and its status. Ordinary users
cannot replace the prior simply by submitting a new list.

Use a prior update when the community has made a deliberate decision to replace its starting
allocation—for example, after a new election or membership review. Use vouches and revocations for
normal changes in trust between members.

## Verifiable output

Every proof binds the active prior, graph checkpoint, scoring parameters, and published score file.
Consumers verify scores against the accepted onchain Merkle root in the same way as a standard
trust graph.

See [Create a network](./create-a-network.md) for the creation workflow and
[Governance](../learn/governance.md) for how protected changes are controlled.
