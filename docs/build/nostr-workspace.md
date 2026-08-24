# Nostr workspace

The Nostr workspace program turns authenticated activity from a member-scoped Buzz/Nostr
workspace into verifiable scores. It supports communities that coordinate in a private or
restricted workspace but want to publish a public, auditable score result.

## How data reaches a proof

An authorized collector exports the workspace history and creates an immutable witness package.
Only the package commitment is anchored onchain. The prover then verifies the signed events,
membership and identity rules, replacements and deletions, and the program's supported workspace
signals before computing scores.

The current roster defines who is eligible. Conflicting or invalid identity bindings are rejected,
and deleted or superseded events do not reappear through older history.

## Privacy and verification

The score proof does not make the source workspace public by itself. Operators still need a secure
process for collecting, storing, and granting access to witness data. The published root and score
file are verifiable, while access to the underlying workspace remains governed by the community.

Choose this program only when the workspace export and witness process match your privacy model.
For public Ethereum vouches, use the [trust graph](./trust-graph.md).
