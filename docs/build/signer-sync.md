# Signer sync

Signer sync is an optional program and Safe module for a standard, onchain-only vouch network. It
recomputes canonical trust scores from the checkpointed vouch history, combines them with recent
direct-governance activity and the Safe's current state, and proves a proposed owner set and
threshold.

It does not consume the network's published score root and does not alter that root.

## What the proof checks

The signer guest receives:

- the complete folded vouch history and pinned scoring parameters;
- the complete direct-vote activity history through its activity checkpoint;
- the configured owner-count, threshold, inactivity, and witness rules; and
- the Safe's current owners, threshold, and prior-rotation state.

It runs the same deterministic trust scoring pipeline as the standard root producer, filters for
accounts with fresh direct-vote activity, ranks eligible accounts by score, and derives the target
owner set and threshold. The journal binds both the current and proposed Safe state, so a proof
prepared before another owner change cannot be applied afterwards.

The onchain module verifies the proof before changing the Safe.

## Activity safety gate

Score alone cannot trigger owner removal. The activity checkpoint must include enough distinct,
recent direct voters. Before the first rotation, those witnesses must be positively scored
accounts; after initialization, enough of them must be current Safe owners.

A direct governance vote is evidence that an account was recently active. It is not an approval of
the proposed signer rotation, and a delegated vote does not count as the principal's direct
activity. If the activity gate is not satisfied, the program preserves the current owner set and
threshold.

## Support boundary

Signer sync is offered only at creation for compatible standard networks. The current signer
journal does not authenticate strict offchain EAS inputs, and weighted-prior and composition
creation do not support the module.

Treat signer sync as governance automation. The governed Safe decides whether to install it and
which immutable or governed selection rules it may enforce; a network can use Trustgraphs without
automated owner rotation.

For the standard score computation, see [Vouch scoring algorithm](../concepts/algorithm.md).
