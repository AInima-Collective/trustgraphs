# Nostr workspace architecture

> Internal implementation reference. This page is not part of the public product documentation.

The operational trust boundary and archive lifecycle are specified in
[`witness-operations.md`](./witness-operations.md): collection/export is privileged, anchoring reads
only verified immutable manifests, and checkpoint assembly is the last networked step before
credential-free execution/proving.

`nostr-workspace` turns authenticated Buzz/Nostr history into a journal-v3 score root. Its program
id is `keccak256("nostr-workspace")`; its output domain is
`keccak256("trustgraphs.output.nostr-member.v1")`. Neither value is inferred from the score-blob
shape.

## Consensus pipeline

1. Rule Φ selects the newest usable signed anchor state per node. A higher signed count with a
   missing or invalid witness is `DROPPED`; an older count is never resurrected.
2. Envelope 2 verifies bounded canonical TGNW bytes, the SHA-256 data commitment, Option-A audit
   completeness or the Option-C self-log head, every NIP-01 id/signature, NIP-OA ownership,
   roster state, NIP-33 replacement, and NIP-09 deletion.
3. Exact event ids shared by A and C are deduplicated. The strongest provenance wins without
   changing the earliest lifecycle order; cryptographic verification is cached by exact event.
4. `nostr-workspace-core` resolves V1 vouches, G1 two-sided merges, J1 completed jobs, F1 positive
   forum votes, author-level Nostr/EVM binding state, weights, caps, and self-edge exclusions.
5. The shared integer PageRank/distribution code emits node-id leaves and, for a live binding, the
   existing address leaf as well. The sorted score blob, CID, skip fold, params hash, and journal
   use the same Rust implementation as the guest.

The current roster defines the member universe. A NIP-OA agent is eligible only when its uniquely
resolved owner is in that roster. Conflicting owners make the agent ineligible. Binding is newest
valid state per Nostr author: a rebind supersedes the prior address, and tombstoning the newest
coordinate is terminal rather than exposing an older address.

## Package and guest isolation

The goal-mandated verifier sources live at `crates/envelopes/src/nostr/`, but compile through the
separate `nostr-envelope` package. The legacy `envelopes` crate manifest and module graph remain
unchanged. This is necessary because even adding a disabled feature changes Rust crate identity and
can rotate every legacy SP1 consumer.

`zk/nostr-program` is a detached workspace with one lockfile. It pins `sp1-sdk`, `sp1-zkvm`, and
all resolved `sp1-*`/`slop-*` components to 6.6.0 and contains:

- `nostr-conformance`, which commits the six Envelope-2 conformance words;
- `nostr-workspace`, which commits the common 12-word journal v3;
- a host that byte-compares valid native/guest output and requires a re-committed signed-byte
  mutation to fail in both.

The production prover CLI exposes `nostr-workspace {vkey|paramshash|execute|prove}`. The program is
also wired into the generic `zk:{build|vectors|vkey|execute|prove|parity}` tasks.

## Four-way parity boundary

Rust owns authenticated semantics and all consensus bytes. Solidity independently reproduces the
39-word params codec, node/address leaves, Merkle root, anchor/skip folds, and journal. The browser
port is explicitly reduced-tier: starting from authenticated envelope-verified rows and published
binding metadata, it recomputes V1/G1/J1/F1, rank, score blob/CID, root, skips, params, and journal;
it does not claim to re-run BIP-340, NIP-OA, or Buzz audit verification.

The frozen production vector is [`tests/golden/nostr-workspace.json`](../../../tests/golden/nostr-workspace.json).
