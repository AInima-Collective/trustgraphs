# Nostr workspace verification

> Internal verification procedure. This page is not part of the public product documentation.

Run the focused gates before the full repository matrix:

```sh
cargo fmt --all --check
cargo test -p nostr-envelope -p nostr-workspace-core
CARGO_BUILD_JOBS=1 cargo test --features witness-nostr --lib --manifest-path zk/prover/Cargo.toml
cargo test --locked --manifest-path zk/nostr-program/Cargo.toml
forge test --match-path 'contracts/test/unit/golden/*'
forge test --match-contract NostrWorkspaceCompositionCaptureTest
pnpm --dir packages/indexer test
pnpm --dir packages/frontend test
task zk:parity PROGRAM=nostr-workspace
task zk:nostr-workspace-e2e
```

The S4 e2e uses the production detached ELF, host semantics, immutable archive verifier, real
`AnchorRegistry`, `MerkleSnapshot`, `SP1JournalVerifier`, `InstanceRegistry`, params authority,
publication CID checks, the indexer's authenticated artifact-to-row validation boundary, and
`CompositionSourceAdapter`. The index boundary runs twice per epoch and reproduces the program
route, canonical bytes, CID, total, actor/owner/binding provenance, skip digest, and output root
before any database write. `MockSP1Gateway` stubs only the expensive SNARK verification; both proof
invocations still execute locally, verify public values, and pin the frozen vkey. A real
Groth16/network-gateway leg is an S5 pilot requirement when credentials or a 16–32 GiB proving host
are available.

Expected frozen facts:

- vkey `0x00a1d93b8f040284bf86841331064987bfb9fc282075963f153ec75ca87c1eed`;
- params hash `0xaf83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd`;
- epoch-1 production execution: 6,845,293 cycles, root
  `0xc4de11709437734678cc026014c6162ffb7cda01b5aac93c8ba5a8091bd96678`;
- epoch-2 withheld-C execution: 8,477,214 cycles, root
  `0xf262dbe32bec8dc313f731ba1276cf4959d852eb36b9715461720a213171462f`.

After focused gates, run the complete verification matrix in
[`research/plans/nostr-workspace.md`](../../../research/plans/nostr-workspace.md). Known
unrelated workspace typecheck failures are not waivers: either classify them with evidence or fix
them before S5 release sign-off.

The requirement-by-requirement local status and the explicit S5 handoff are recorded in
[`completion-audit.md`](./completion-audit.md).
