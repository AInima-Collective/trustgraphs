# Hypercerts

The Hypercerts program builds a trust graph from authenticated AT Protocol records published by
the Hypercerts ecosystem. It is intended for communities whose useful reputation signals already
live in evaluations, endorsements, attributions, badges, and follows rather than Ethereum vouches.

## From records to scores

Repository heads are anchored onchain. The proof verifies the anchored history, applies the
program's deterministic record-to-edge rules, resolves supported identity links, and computes a
score root with the same integer ranking system used by other trustgraphs programs.

Canonical scores are keyed by program node ID. A supported AT Protocol identity maps to that node
domain; when a valid EVM binding exists, the program adds an address-domain leaf to the same Merkle
root. Applications request the proof appropriate to the identity domain and verify it against the
accepted root.

## Trust boundary

The operator cannot add an unanchored record or choose an older convenient history without
changing the committed input. The latest anchored repository head for each identity is selected
before inspecting private witness availability. If it is fresh, its complete authenticated
repository witness is required; missing or invalid bytes abort the proof. An expired head is
dropped based only on committed anchor timestamps and the configured maximum age, and the drop
is included in the proof's skipped digest. An older head cannot replace a required current head.

Every badge award also requires the exact CID-verified badge definition. Only an authenticated
definition that omits `allowedIssuers` permits open issuance; withholding the definition cannot
disable its issuer restrictions. Operators must retain these referenced blocks along with the
repository witness. A malformed or unavailable admitted current head can stop proving until a
new valid head is anchored or the head expires relative to later anchor timestamps.

Use this program when Hypercerts records are the source of reputation. Use the standard
[trust graph](./trust-graph.md) when members express trust through Ethereum vouches.
