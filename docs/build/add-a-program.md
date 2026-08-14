# Adding a new program

A *program* is one provable scoring pipeline: a guest binary, the core-crate semantics it compiles,
one journal shape, and one params schema, with its own verification key and golden vectors
(trust-graph, signer-sync, hypercerts and contributions are the four that exist; the program vs.
instance distinction is defined in
[`../concepts/networks-and-programs.md`](../concepts/networks-and-programs.md)). This page is for
contributors extending the platform itself: if you only want another network of an existing
program, you never touch any of this, because that costs one factory transaction
([`./create-a-network.md`](./create-a-network.md)).

Per [`../../research/MULTI_PROGRAM_PLATFORM.md`](../../research/MULTI_PROGRAM_PLATFORM.md) §3 / §8, a new
program (call it `foo`) is exactly these additions — no change to any existing program's semantics:

1. **Core crate** — `packages/foo-core/`: the record→edge mapping, weight normalization, and the
   program's own `Params`/`Journal` + byte encodings, depending on `packages/zk-core` (and
   `packages/envelopes` if it ingests a *lane-2* substrate — off-chain signed data, like atproto repos, anchored on-chain by digest rather than attested via EAS). Same discipline as every core crate: no
   floats, `BTreeMap` only, no non-deterministic iteration.
2. **Guest `[[bin]]`** — add `zk/program/src/foo.rs` (a ~25-line shell) and its `[[bin]]` entry. The
   single `build.rs` (`sp1_build::build_program("../program")`) builds it automatically.
   *Consequence:* adding a bin (and any new `[patch.crates-io]` crypto patches it needs) recompiles the
   **existing** bins' ELFs → the trust-graph and signer vkeys rotate at the next deploy. Batch that
   rotation through the constitutional-timelock path; don't dribble it.
3. **Prover subcommand group** — `zk/prover/src/programs/foo.rs` adding a `foo {vkey | paramshash |
   [fetch] | execute | prove}` clap group that shares the existing proof-writing plumbing
   (`abi.encode(publicValues, seal)`, blob export, local verify). Lane-2 programs also add host-only
   witness assembly under `zk/prover/src/witness/` behind a feature gate.
4. **Golden vector file** — `test/golden/foo.json`, written by the core crate's `export_golden`
   example, plus a per-program `test/unit/golden/FooGoldenVectors.t.sol` and a TS `golden.test.ts`. An
   encoding change without a regenerated vector file in the same PR is a CI failure (now enforced per
   program).
5. **Docs dir** — `docs/build/foo/` with `architecture.md` (pointer to the research design) and
   `runbook.md`, following the per-program directories already under `docs/build/`
   (`trust-graph/`, `signer-sync/`, `hypercerts/`, `contributions/`), plus a new row in the program
   index in [`../concepts/networks-and-programs.md`](../concepts/networks-and-programs.md).

Task/CI plumbing: `zk:{vkey|execute|prove|parity}` are generic via `PROGRAM=foo`; `zk:vectors` needs a
per-program branch (each program writes its own vector file — see the existing hypercerts branch),
and the frontend `pnpm test` script must be extended to compile+run the new program's golden suite.
The prover's `Cargo.toml` also gains the new core crate as a dependency (step 3's clap group needs it).
The CI parity job runs for every program on every PR touching `packages/` or `zk/`.

**Contracts are reuse, not new code.** A new program deploys a fresh labeled `SP1JournalVerifier`
instance (same bytecode, its own immutable vkey) against the same SP1 gateway, reuses `MerkleSnapshot`
on journal v3, and adds a `ParamsCodec` twin golden-locked to its crate's `params_hash`. Standing up
another *instance* of an existing program costs only a deployment (a new contract set + params +
indexer/frontend view) — no Rust, no guest, no vectors.

## Registering the score program and output domain

Score-blob dispatch is consensus-facing. Before a program can publish a root, add one reviewed row
to `frontend/lib/score-program.ts` containing all of the following:

- the exact `programId` written to `InstanceRegistry` (`keccak256("foo")` by convention);
- a new, versioned `outputDomain` (`keccak256("trustgraphs.output.foo-subject.v1")`);
- the canonical key encoding (`eip155-address` or `bytes32`);
- its one ingestion decoder, table family, and allowed HTTP namespace.

Never reuse an output domain merely because two subjects have the same byte width. Hypercerts node
IDs and ERC-8004 agent keys are both 32 bytes and deliberately have different domains. Likewise,
TrustGraph accounts, Contributions recipients, and composition outputs may all be EVM addresses
while retaining different semantic domains. Changing a shipped domain is a versioned program
migration, not a refactor.

The deployer/factory must register `(program, snapshot, verifier, registryOrAccumulator,
paramsHash)` in the configured on-chain `InstanceRegistry` before the snapshot can emit a root. The
indexer consumes only `InstanceRegistered`/`InstanceUpdated` and governed
`InstanceParamsHashUpdated` events from that configured registry, checks the snapshot's live
`zkVerifier()` against the record, and stores the source block/log/transaction in API provenance.
A catalog name, deployment-summary `program` string, contract name, score-key
length, or first blob entry is never an admissible discriminator. Unknown programs, reused
snapshots, program/domain mismatches, wrong API namespaces, and registered-but-not-enabled decoders
all fail closed.

Indexer additions are therefore explicit:

1. Add the stable registry row, decoder/table/API declarations, and colliding-key fixtures.
2. Add nullable discriminator/provenance columns plus a Drizzle migration.
3. Enable the decoder only after its schema and API exist.
4. Expose and runtime-validate `scoreProgram` on every score response.
5. Add the frontend page type only after the authenticated response can dispatch it.

For an existing database, deploy in this order: apply the nullable migration; deploy/replay the new
indexer so `score_program_binding` is rebuilt from registry events; run
`pnpm --dir indexer programs:backfill` (dry-run) and then
`pnpm --dir indexer programs:backfill --apply`; deploy the new frontend last. Old frontends ignore
additive provenance fields. A new frontend against an old
indexer refuses the response rather than guessing its type. Keep the dry-run output with the
release evidence and audit all `409` responses before publishing the frontend.

A legacy snapshot with no registry event must first be registered through the registry's governed
operator path with its historical verifier/accumulator/params tuple. The backfill intentionally
refuses it until that event exists; a hand-edited catalog label is not a migration.
