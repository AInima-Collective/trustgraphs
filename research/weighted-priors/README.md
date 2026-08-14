# Weighted-prior benchmark and fixture evidence

This directory contains the original issue #34 research evidence and the release benchmark record
for the isolated weighted V1 implementation from issue #52. The research artifacts remain
non-production; production code consumes only the promoted golden under `test/golden`.

## Reproduce

```sh
cargo test -p weighted-prior-research
pnpm exec tsx research/weighted-priors/verify-fixture.ts
forge test --match-path test/unit/WeightedPriorResearchFixture.t.sol -vv

cd research/weighted-priors/zk-program && cargo prove build
cd ../../.. && cargo run --release --manifest-path zk/prover/Cargo.toml \
  --example weighted_prior_bench -- \
  research/weighted-priors/zk-program/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/trustgraph-weighted-prior-research \
  2048 4 40
forge script script/research/WeightedPriorGas.s.sol:WeightedPriorGas \
  --sig 'run(uint256)' 2048 -vv
pnpm exec tsx research/weighted-priors/benchmark-client.ts
cd frontend && pnpm test
```

The research script above preserves the original architecture spike. The promoted production
validator and lifecycle gates are reproduced with:

```sh
forge test --match-path test/unit/WeightedPriorValidator.t.sol -vv
forge test --match-path test/unit/factory/WeightedPriorParamsController.t.sol
forge test --match-path test/unit/factory/WeightedPriorLifecycleInvariant.t.sol
forge test --match-path test/unit/factory/WeightedTrustgraphsFactory.t.sol
forge build --sizes
```

The frontend production importer runs the #52 fixture plus its CSV/JSON, ENS, error-boundary, and
2,048-entry preview gates inside `pnpm test`. Its current CI-class measurement is recorded in
[`frontend-benchmarks.csv`](./frontend-benchmarks.csv). Because the exact production path exceeds
the 100 ms synchronous target on that host, the UI always uses a Web Worker with progress and
cancel controls in supported Chrome and Firefox; correctness and usability do not depend on a
browser-specific timing pass.

On 2026-08-14, the production 2,048-row `proposePrior` path measured 3,579,477 execution gas and
448,484 calldata gas. Adding 21,000 intrinsic gas gives a 4,048,961-gas L1 upper bound. This is the
real validation, pending-version/provenance storage, and event path; the lower-level validator/store
harness measured 3,349,958 execution and 3,819,070 total gas. The Forge tests fail unless execution
stays below 5 million and the same total accounting stays below 4.5 million. Full instance creation
additionally deploys and wires the resolver, snapshot, controller, schema, roles, and registry row;
it is deliberately outside this manifest-ingestion benchmark.

## Production V1 release gates

The final exact, mass-conserving implementation has a separate guest and a separate benchmark
command. The benchmark byte-compares all 384 public-value bytes against native computation before
enforcing the cycle ceiling.

```sh
cd zk/weighted-program && cargo prove build
cd ../prover
cargo run --release --example weighted_prior_guest_scenarios
cargo run --release --example weighted_prior_guest_rejections
cargo run --release --example weighted_prior_production_bench -- 2048 16 40
```

The 2026-08-14 release result is recorded in
[`production-benchmarks.csv`](./production-benchmarks.csv): the constitutional 2,048-entry,
degree-16, 40-iteration fixture uses **923,463,928 cycles**, below the strict 1,000,000,000-cycle
gate. The release ELF SHA-256 is
`001925fb2bd9a4392329fbfc782ce6fbbfc3b252b414bc32bd268ca6d0261a94`; its SP1 bytes32
verification key is `0x00f0f5e01928bfa9f530392ff7b9cab1efae6ec513eb156cb44d15f5a37b0ed2`.

Production cycle evidence uses the SP1 6.3.1 minimal executor's exact global instruction clock,
without trace-construction overhead. The command fails on any native/guest byte mismatch and uses a
strict `< 1,000,000,000` postcondition. Native microseconds are informational and host-dependent.

### Legacy guest isolation proof

The four existing guests were rebuilt after the weighted guest was added. Their release ELF
SHA-256 values exactly equal the values recorded from the issue branch point:

| Existing program | Branch-point ELF SHA-256 | Post-change ELF SHA-256 | Vkey on this pinned build |
|---|---|---|---|
| trust-graph | `060815e935c7af480d3cdbb36a3e74c717de1468d61d1f0b7e49e011802a6191` | same | `0x00b03a595faf3ff9ddcfc1e49755ae78e5cd6927c8ddc1535db49f027cc02641` |
| signer-sync | `1f1130bb18138962f47e01ba960062b7e362121c98b91ecdf3876a03b74e74b6` | same | `0x0098646cd3b6258ef98061eef6998339abaf9809734a172f8ebcbd58d56c35bf` |
| contributions | `4070bc253a9f24055e4a92862186ac2af088cc9ed44b57b46e0067cf152150e9` | same | `0x00a1e5091d68c08be1859c7848961ed33543b103acee2a111b3761459db9dced` |
| hypercerts | `8dfd82a247f7603d87eff1ee56e0338d555a83ea54ec65bb3c1cc49ac86dc579` | same | `0x005213c243f0849f38b9954e027ff0d18d260b855b55c51e3afb1797451a11e6` |

The vkey is derived from the ELF by SP1 setup; exact ELF-byte equality on the same toolchain proves
the existing vkeys did not rotate. The weighted guest's crypto patches live only in its detached
Cargo workspace and therefore cannot enter an existing guest dependency graph.

Repeat the SP1 and Forge commands with the rows in [`benchmarks.csv`](./benchmarks.csv). The
benchmark guest is a detached Cargo package: building it cannot alter any production ELF. The SP1
benchmark always byte-compares the guest commitment with the native result. Use `--release`: a
debug SDK executor is dominated by host instrumentation and is not a useful latency measurement.

## Measurement boundary

Measurements were taken on 2026-08-14 in the repository Linux/aarch64 container with eight cores,
SP1/cargo-prove 6.3.1, Forge 1.7.1, Node 22.23.1, and pnpm 10.18.3.

- `json_witness_bytes` is the benchmark input serialized with `serde_json`; a production operator
  may use a denser transport.
- `rust_core_live_bytes` is the deterministic live-set floor for the prior/edge vectors, outgoing
  counts, and two rank vectors (`52*N + 8*E`). It excludes allocator, JSON parser, ELF, and SP1 SDK
  overhead and is not an RSS claim.
- `native_micros` measures only the experimental sparse kernel on this host. SP1 cycles are the
  SDK's `ExecutionReport::total_instruction_count()` and are machine-independent.
- EVM execution gas is the `gasleft()` delta for validation, sorted-pair Merkle construction,
  SHA-256, and three storage writes. `calldata_gas` counts every encoded byte at 4/16 gas; the total
  adds 21,000 intrinsic gas. It is a conservative L1-style comparison, not an Optimism fee quote.
- The client benchmark includes canonical normalized weights, leaf/root construction, and a
  40-iteration sparse preview. Node/V8 is a browser-engine proxy, not a browser service-level
  result; the implementation issue must repeat it in supported Chrome and Firefox builds.
- The experimental kernel demonstrates sparse scaling but does not implement the ADR's final
  mass-conserving apportionment. The 1-billion-cycle implementation acceptance ceiling deliberately
  leaves more than 2.2x headroom over the measured worst shape (445,972,213 cycles).
