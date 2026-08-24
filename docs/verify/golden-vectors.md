# Golden vectors and program parity

Trustgraphs has several proving programs, not one algorithm copied everywhere. Golden vectors lock
their consensus encodings and expected outputs so that a change cannot silently make the host,
guest, contracts, or application disagree.

## Sources of truth

Each proof-producing program has a canonical deterministic Rust core and an SP1 guest. Shared
primitives such as fixed-point arithmetic, accumulator folds, journal fields, Merkle construction,
and CID encoding live in `crates/zk-core` and `crates/pagerank-core`; specialized programs also own
their own parameter, authentication, reconciliation, and output semantics.

The strongest full-computation parity check executes the real guest ELF and byte-compares its
public output with the native Rust result. The verification key then identifies the exact guest
binary a deployed verifier accepts.

Other parity layers cover narrower boundaries:

- Solidity golden tests rederive parameter hashes, journal digests, Merkle leaves, and other
  contract-side encodings.
- TypeScript implementations support browser previews and verification. Their scope varies by
  program: the standard trust graph and several address programs mirror their computation, while
  Hypercerts and Nostr use documented reduced recomputation over already-derived records rather
  than independently authenticating the complete source witness.
- The composition program also has an independent TypeScript reference implementation used as an
  oracle for its vectors.

A passing reduced browser test does not replace guest-versus-native parity or prove that the
browser authenticated the original data source.

## Vector files

`tests/golden/` contains:

- `trust-graph.json`, including the signer-sync vector family;
- `weighted-prior.json`;
- `trust-compose.json`;
- `contributions.json`;
- `hypercerts.json`; and
- `nostr-workspace.json`.

The files record the consensus material relevant to each program, such as parameter encodings,
input commitments, output leaves and roots, journal bytes and digest, canonical blob, and CID.
Programs do not need identical intermediate fields to participate in the parity gate.

## Run the parity gate

Build the pinned guest ELFs first:

```bash
task zk:build
```

Then run one program's aggregate gate. Supported values are `trust-graph`,
`trust-graph-weighted`, `trust-compose`, `signer`, `hypercerts`, `contributions`, and
`nostr-workspace`:

```bash
task zk:parity PROGRAM=trust-graph
```

The task:

1. regenerates the selected vector and fails if the tracked file drifts;
2. runs the Rust core tests;
3. runs Solidity golden tests;
4. runs the relevant TypeScript oracle and frontend tests; and
5. executes the selected guest and asserts byte equality with the native result.

Individual checks are also available:

```bash
cargo test -p pagerank-core
forge test --match-path "contracts/test/unit/golden/*"
cd packages/frontend && pnpm test
task zk:execute PROGRAM=trust-graph
```

CI builds the pinned guest families once, then runs the aggregate parity task for every supported
program.

## What parity establishes

Golden vectors show that the tested implementations and contract encodings agree on frozen
fixtures. Property and differential tests cover broader inputs, and guest execution confirms the
actual proof binary agrees with the native host.

They do not establish that a program's social rules are appropriate, that an offchain witness is
available, or that governance selected the right verifier. For an accepted checkpoint on a
provenance-enabled deployment, compare the recorded verifier code hash and program key with the
guest build you tested.
