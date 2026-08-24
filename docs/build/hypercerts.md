# Hypercerts

The Hypercerts program builds a trust graph from authenticated AT Protocol records published by
the Hypercerts ecosystem. It is intended for communities whose useful reputation signals already
live in evaluations, endorsements, attributions, badges, and follows rather than Ethereum vouches.

## From records to scores

Repository heads are anchored onchain. The proof verifies the anchored history, applies the
program's deterministic record-to-edge rules, resolves supported identity links, and computes a
score root with the same integer ranking system used by other trustgraphs programs.

The accepted result can include scores keyed by AT Protocol identity and, where a valid binding is
present, by Ethereum address. Applications can request a Merkle proof for an individual score and
verify it against the onchain root.

## Trust boundary

The operator cannot add an unanchored record or choose an older convenient history without
changing the committed input. Missing or stale source data is handled by explicit rules and is
committed in the proof output rather than hidden from consumers.

Use this program when Hypercerts records are the source of reputation. Use the standard
[trust graph](./trust-graph.md) when members express trust through Ethereum vouches.
