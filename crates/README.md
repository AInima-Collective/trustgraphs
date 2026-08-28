# Rust crates

These crates are the members of the root Cargo workspace (the workspace manifest is the
repository root's `Cargo.toml`). They contain the native implementations,
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
| `eas-offchain` | Strict EAS offchain payload (format version 2) and typed-head verification — envelope 0 |
| `envelopes` | Authenticated AT Protocol repo-commit envelope verification — envelope 1 |
| `hypercerts-core` | Hypercert record semantics, trust-edge derivation, and journal encodings |
| `input-exporter` | CLI and library for reconstructing proof inputs from onchain state |
| `nostr-envelope` | Verification for authenticated Nostr and Buzz audit envelopes — envelope 2 |
| `nostr-workspace-core` | Deterministic Nostr workspace scoring and journal encodings |
| `operator-core` | Pure decision engine for proof-operator scheduling and safety checks |
| `pagerank-core` | Canonical fixed-point trustgraph ranking and byte encodings |
| `trustgraph-core` | Strict hybrid trustgraph statement layered over the canonical scorer |
| `weighted-prior-core` | Weighted-prior manifest, scoring, and journal encodings |
| `zk-core` | Program-agnostic ZK primitives, commitments, Merkle trees, and journals |

The corresponding SP1 workspaces live under [`zk/`](../zk/). Changes to a core crate can change a
guest ELF and verification key even when the guest source itself is untouched. Follow the vkey and
golden-vector process in
[`docs/concepts/networks-and-programs.md`](../docs/concepts/networks-and-programs.md) when changing
consensus-sensitive code or encodings.

> **Stale-ELF warning:** After editing anything under `crates/`, run `task zk:build` before any
> guest-side check. `sp1_build` does not watch Cargo path dependencies, so an ordinary Cargo build
> can silently reuse a guest ELF that predates your change. `task zk:build` rebuilds the guests and
> makes the prover pick up the new ELFs.

Non-shipping graph-reputation and weighted-prior experiments live under [`research/`](../research/)
with standalone manifests. They are intentionally outside this production workspace.
