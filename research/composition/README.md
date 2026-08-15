# Trust composition V1

This directory contains both the accepted Phase-0 decision evidence from issue #36 and the
independent TypeScript oracle for the production core/guest boundary implemented in issue #63.
Atomic onchain capture, factory/deployment wiring, operator/indexer integration, and product UI
remain separate child issues.

## Production V1 implementation

The implementation deliberately isolates the new program from every legacy guest:

- `packages/composition-core` is the exact Rust consensus core. It validates complete canonical
  source blobs and their CID/SHA-256/Merkle/total commitments, validates the frozen capture and
  static policy, performs two-stage uint128 Hamilton allocation with uint256 products, and emits
  the canonical output blob/CID/root plus per-source attribution.
- `zk/composition-program` is the dedicated SP1 6.3.1 guest. `zk/prover/src/programs/composition.rs`
  is its native adapter and refuses any guest/native journal difference.
- `src/contracts/params/TrustComposeParamsCodec.sol` and `TrustComposeValidator.sol` freeze the
  policy/params boundary for the later capture/factory issue.
- `production.ts` and `test/golden/trust-compose.json` independently pin every byte consumed by
  Rust, SP1, and Solidity.

V1 fixes `keccak256("trust-compose")` as the program ID, `eip155-address` as the identity domain,
`allocation` as the output kind, and `trustgraphs.output.trust-compose-account.v1` as the output
domain. `TGCP` is the compact static source-policy manifest; `TGCM` is the exact captured-state
manifest. The 20-word params tuple commits both policy forms, all workload caps, program/output
domains, source count, output pool, accumulator, and chain. The common 12-word journal commits the
params hash, exact `TGCM` SHA-256, source count, output root/blob/CID/total, recipient, and instance
domain.

The pinned guest artifact is:

| Artifact    | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| SP1 vkey    | `0x002781fb8a17a5586cec2eb47f891d9d292b25f9547e8f0a0309b67efb82d641` |
| ELF SHA-256 | `849686538f413704772b6a17a5a6e3c50d2722aa9ff0a3e4b838d5db234be0bb`   |
| ELF size    | 382,280 bytes                                                        |
| Params hash | `0xd478cf921cb1705b099106a86ac1db696090ec4ec9e6d9dfae0ebad72ba6ea24` |
| Policy root | `0x5277895eac537c6d45c091967cdc3f86e548039a00cfc9faf31e4e3d39eaa334` |

Run the production gates from the repository root:

```sh
cargo test -p composition-core
node --import tsx --test \
  research/composition/reference.test.ts research/composition/production.test.ts
forge test --match-path 'test/unit/TrustCompose*.t.sol'
forge test --match-path 'test/unit/golden/TrustComposeGoldenVectors.t.sol'
SP1_SKIP_PROGRAM_BUILD=true cargo run --manifest-path zk/prover/Cargo.toml \
  --release --example trust_compose_guest_scenarios
SP1_SKIP_PROGRAM_BUILD=true cargo run --manifest-path zk/prover/Cargo.toml \
  --release --example trust_compose_guest_rejections
```

`task zk:build` builds the detached composition guest alongside the legacy and weighted guests;
`task zk:parity PROGRAM=trust-compose` regenerates the independent vector and runs the aggregate
cross-language gate.

## SP1 measurements

Measurements were taken on 2026-08-15 under Linux/aarch64 with 8 Apple virtual CPUs, Rust 1.97.1,
Node 22.23.1, the repository-pinned SP1 6.3.1 dependencies/toolchain, and the release profile.
Inputs use disjoint accounts, so aggregate entries equal the union size. The checked-in raw rows
are in `sp1-benchmarks.csv`.

| Sources | Entries | Witness bytes | Native µs | Peak RSS KiB | RSS delta KiB | Guest cycles | Proof gate            |
| ------: | ------: | ------------: | --------: | -----------: | ------------: | -----------: | --------------------- |
|       2 |     128 |         7,622 |       244 |        3,440 |           116 |    2,616,399 | execution             |
|       4 |   1,024 |        53,015 |     1,680 |        3,848 |           392 |   24,312,132 | mock Groth16 verified |
|       8 |   4,096 |       207,675 |     7,101 |        5,208 |         1,472 |  105,652,691 | execution             |
|       8 |   8,192 |       412,097 |    15,137 |        7,328 |         3,160 |  222,311,301 | mock Groth16 verified |

All shapes remain below the explicit one-billion-cycle gate, including the accepted maximum of
8 sources / 8,192 aggregate and union entries. The proof rows use the SP1 mock backend with the
Groth16 wrapping path and verify the exact program/public values locally; their 512-byte blobs are
not production cryptographic proofs or proof-time measurements. Production wrapping and gas
measurements belong to deployment integration. No cap was raised from the accepted design.

The guest rejection gate independently rejects capture commitment drift, unavailable/wrong source
bytes, stale sources, an unadmitted program, a required source receiving zero quota, and raised
caps. Scenario execution covers sparse overlap, unequal pools, exact source reproduction,
address-remainder ties, source enumeration independence, post-trigger updates, and a representative
eight-source shape. Native validation additionally covers malformed/noncanonical blobs, wrong
CID/root/total, duplicate sources, optional sources, aggregate/union/byte caps, and uint128
overflow.

## Reproduce

```sh
node --import tsx --test research/composition/reference.test.ts
pnpm exec tsc research/composition/*.ts --noEmit \
  --module esnext --moduleResolution bundler --target es2022 --skipLibCheck --strict \
  --types node --typeRoots indexer/node_modules/@types
pnpm exec tsx research/composition/simulate.ts
pnpm exec tsx research/composition/export-fixture.ts
pnpm exec tsx research/composition/export-production-fixture.ts
```

`reference.ts` is an exact BigInt reference for the selected two-stage, source-aware Hamilton
policy. It strictly re-encodes complete canonical score blobs, checks their SHA-256/CID/OZ Merkle
root/total, validates frozen provenance and freshness, and emits the existing address/value blob
and Merkle shape. `fixture-builder.ts` uses the repository's existing TrustGraph golden output as
source A and two deliberately unequal, sparse sources as B and C. `golden.json` pins source and
composite commitments, exact quotas, per-source attribution, output, invalid cases, and a source
update after trigger.

`production.ts` freezes the implementation boundary for issue #63: the compact static `TGCP`
source-policy manifest/root, exact captured `TGCM` bytes, program/output/identity domains, params
tuple, common 12-word journal, output leaf/proof, and post-trigger capture. Its generated
`test/golden/trust-compose.json` is the independent TypeScript target for Rust, SP1, and Solidity.

`simulate.ts` is the A/B/C weight-simplex explorer and adversarial/scaling harness. It prints all
36 positive 10%-grid policies; pairwise overlap, correlation, and Jensen-Shannon disagreement;
leave-one-source-out changes; a compromised source; clone-family amplification; a personalized
meta-referral cartel; comparison with a single-stage ideal-mass Hamilton candidate; and bounded
synthetic measurements. The checked-in `simulation-summary.json` and `benchmarks.csv` record the
decision run while keeping volatile timing out of the golden tests.

## Phase-0 measurement boundary

Measurements were taken on 2026-08-14 with Node 22.23.1 on Linux/aarch64. Timing covers complete
reference validation and composition after synthetic source construction, with five samples and
the median reported. `deterministic_live_bytes_floor` counts exact source bytes plus 36 bytes for
each address/u128 record in the validated source, attribution, union, and output vectors. It is not
RSS, SP1 cycles, proof time, or an Optimism gas quote.

At the selected aggregate cap of 8,192 canonical address/u128 records, even the worst literal JSON
shape is below 0.75 MiB; the 1 MiB byte cap is independently enforced. The measured representative
8-source/8,192-record shape used 425,035 source bytes, a 1,346,635-byte deterministic live-data
floor, and a 293.9 ms native median. These results selected the conservative implementation
ceiling; the SP1 measurements above subsequently validated it without raising any limit.
