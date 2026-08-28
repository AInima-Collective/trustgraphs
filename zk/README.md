# ZK programs and hosts

The SP1 guests and their host processes live here. These are deliberately detached Cargo
workspaces: dependency isolation prevents work on one program from silently rotating the
verification keys of another.

| Workspace | Responsibility |
|---|---|
| `program/` | Multi-bin guest workspace (`trustgraph-guests`) for the signer-sync, hypercerts, contributions, and conformance programs |
| `trust-graph-program/` | The trust-graph guest: the root producer proven for `MerkleSnapshot.submitProof` (strict two-lane statement from `crates/trustgraph-core`) |
| `weighted-program/` | Weighted-prior guest |
| `composition-program/` | Trust-composition guest |
| `nostr-program/` | Isolated Nostr guest and native conformance host |
| `prover/` | Host CLI for reconstructing inputs and producing proofs |
| `operator/` | Long-running proof operator service |

Use the repository tasks rather than building arbitrary guests by hand:

```sh
task zk:build
task zk:parity PROGRAM=trust-graph
```

Core logic shared with native execution lives in [`crates/`](../crates/). Guest or core changes can
change an ELF and verification key; follow
[`docs/concepts/networks-and-programs.md`](../docs/concepts/networks-and-programs.md) before shipping
one.
