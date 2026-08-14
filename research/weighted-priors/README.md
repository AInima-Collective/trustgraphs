# Weighted-prior benchmark and fixture evidence

This directory is the reproducible evidence package for issue #34. Nothing here is imported by a
production contract, program, operator command, or frontend route.

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
```

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
