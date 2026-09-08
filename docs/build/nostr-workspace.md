# Nostr workspace

The Nostr workspace program turns authenticated activity from a member-scoped Buzz/Nostr
workspace into verifiable scores. It supports communities that coordinate in a private or
restricted workspace but want to publish a public, auditable score result.

## How data reaches a proof

The program supports two authenticated witness paths: relay-authorized Buzz audit histories and
member self-committed Nostr logs. The relevant history commitment is anchored onchain, and the
prover supplies the corresponding witness package. The guest verifies signed events, membership
and identity rules, replacements and deletions, and the supported workspace signals before
computing scores.

The current roster defines which activity participants are eligible. Governance-configured seeds
remain in the scoring universe even when absent from that roster; a roster change cannot switch
a seeded network into unseeded scoring. Conflicting or invalid identity bindings are rejected,
and deleted or superseded events do not reappear through older history.

For each anchored identity, the guest selects the latest anchor at its highest committed count
before inspecting witness availability. Every fresh selected head requires its complete valid
witness. Missing or invalid bytes abort proving; an older head cannot substitute for it. Expired
heads are dropped using only committed anchor timestamps and the configured maximum age, with
the drop included in the proof's skipped digest. Operators must retain required witness data:
an unavailable current head can stop proving until a valid replacement is anchored or the head
expires relative to later anchor timestamps.

## Privacy and verification

The score proof does not make the source workspace public by itself. Operators still need a secure
process for collecting, storing, and granting access to witness data. The published root and score
file are verifiable, while access to the underlying workspace remains governed by the community.

Choose this program only when the workspace export and witness process match your privacy model.
For public Ethereum vouches, use the [trust graph](./trust-graph.md).
