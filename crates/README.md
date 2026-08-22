# Rust crates

This directory is the root Cargo workspace. The crates here contain the native implementations,
shared encodings, and host-side tools used by the SP1 programs, contracts, and TypeScript code.
Run workspace commands from the repository root:

```sh
cargo check --workspace
cargo test --workspace
cargo fmt --all --check
```

| Crate | Responsibility |
|---|---|
| `composition-core` | Canonical score-composition model, encodings, and computation |
| `contributions-core` | Contribution claims, reconciliation, funding allocation, and journal encodings |
| `eas-offchain-v2` | Strict EAS offchain v2 payload and typed-head verification |
| `envelopes` | Authenticated offchain envelope verification, including AT Protocol and Nostr |
| `graph-reputation-core` | Shared graph-reputation types and computation primitives |
| `hypercerts-core` | Hypercert record semantics, trust-edge derivation, and journal encodings |
| `input-exporter` | CLI and library for reconstructing proof inputs from onchain state |
| `nostr-envelope` | Verification for authenticated Nostr and Buzz audit envelopes |
| `nostr-workspace-core` | Deterministic Nostr workspace scoring and journal encodings |
| `operator-core` | Pure decision engine for proof-operator scheduling and safety checks |
| `pagerank` | General Trust Aware PageRank implementation and WASM-compatible library |
| `pagerank-core` | Canonical fixed-point trustgraph ranking and byte encodings |
| `trustgraph-core` | Strict hybrid trustgraph statement layered over the canonical scorer |
| `weighted-prior-core` | Weighted-prior manifest, scoring, and journal encodings |
| `weighted-prior-research` | Non-published reference helpers used by research and host tooling |
| `zk-core` | Program-agnostic ZK primitives, commitments, Merkle trees, and journals |

The corresponding SP1 workspaces live under [`zk/`](../zk/). Changes to a core crate can change a
guest ELF and verification key even when the guest source itself is untouched. Follow the vkey and
golden-vector process in
[`docs/concepts/networks-and-programs.md`](../docs/concepts/networks-and-programs.md) when changing
consensus-sensitive code or encodings.
