# ERC-8004 proof-completeness miniature

This directory is the executable evidence for issue #60. It specifies an activation-scoped,
registry-cooperating event accumulator; it does **not** make the deployed ERC-8004 proxies complete,
ship an agent-reputation guest, or weaken the no-go recorded by issue #59.

The frozen leaf commits the source chain, registry proxy, source block, global sequence, reviewed
implementation code hash, event-set version, and exact EVM topic/data hashes. A second fold proves
the exporter possessed every source preimage. The checkpoint binds both registry proxies, the
activation/range boundary, final block hash, cumulative head/count, both active implementation
hashes, and the preimage fold. [`golden.json`](./golden.json) is independently reproduced by:

- [`reference.ts`](./reference.ts), the exporter/guest-shaped TypeScript reference;
- [`rust/src/lib.rs`](./rust/src/lib.rs), the detached future-prover/guest reference; and
- [`ERC8004CompletenessResearch.t.sol`](../../test/unit/research/ERC8004CompletenessResearch.t.sol),
  the Solidity mirror/checkpoint twin.

The fixture starts two reviewed implementation epochs, imports two activation-state wallet
bindings, covers registration/URI/wallet/transfer and feedback/revocation/response/admin events,
rotates a reviewer wallet, and upgrades the Reputation implementation. Its tests reject deletion,
insertion, reorder, duplication, range truncation, a non-final fork, unavailable preimages,
unreviewed upgrades, and recovery-boundary traversal. Feedback attribution is derived from the
same ordered trace, never current wallet state.

## Reproduce

```sh
pnpm exec tsx research/erc8004-completeness/generate.ts
node --import tsx --test research/erc8004-completeness/reference.test.ts
pnpm exec tsc -p research/erc8004-completeness/tsconfig.json
pnpm exec eslint research/erc8004-completeness/*.ts
cargo test --manifest-path research/erc8004-completeness/rust/Cargo.toml
forge test --match-path test/unit/research/ERC8004CompletenessResearch.t.sol -vv --gas-report

cd research/erc8004-completeness/zk-program && cargo prove build
cd ../../..
cargo run --release --manifest-path zk/prover/Cargo.toml \
  --example erc8004_completeness_bench -- \
  research/erc8004-completeness/zk-program/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/erc8004-completeness-research-program \
  16384 256
```

## Measurements and boundary

[`benchmarks.csv`](./benchmarks.csv) records the 2026-08-14 Linux/aarch64 run with Forge 1.7.1,
SP1/cargo-prove 6.3.1, Node 22.23.1, pnpm 10.18.3, and Rust 1.97.1. The detached research ELF SHA-256
is `df7b015429986262185ba8a69b2ddcb3584a3c65c5fb7c651e34b15dec5b82ee`.

- A steady registry-to-sidecar append measured 51,674 execution gas; a checkpoint measured 83,128.
  These are L2 execution-gas units, not an OP fee quote, and do not include the registry's existing
  mutation or L1 data fee.
- The isolated guest folds 16,384 events with 256-byte data preimages in 192,335,661 cycles. At
  65,536 it reaches 770,469,301 cycles and a 37,027,848-byte bincode witness. This is only the
  completeness adapter: policy filtering, wallet replay state, scoring, Merkle output, and proof
  wrapping remain additional work.
- Therefore 16,384 new canonical events is the research maximum per automatic count milestone.
  The implementation child must benchmark the complete guest and may lower, never raise, that cap
  without new evidence. The sidecar must create automatic count milestones so an event burst cannot
  strand an oversized interval before an operator checkpoints it.

The deployed Optimism registry interval from Identity deployment block 147,514,947 through the
experiment cutoff 155,551,592 spans 8,036,646 blocks. Even the impossible best case of only one
receipt per block contains 2,057,381,376 bytes (1.916 GiB) of fixed 256-byte receipt blooms before
RLP, logs, MPT nodes, headers, or proof machinery. That lower bound is why this miniature does not
pretend exhaustive legacy receipt replay is a practical production adapter.
