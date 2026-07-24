# Programs — the TrustGraph platform index

TrustGraph is a **platform of ZK-proven graphs**, not one program. This file indexes every SP1 program
in the repo, its status, its verification key, its docs, and its live instances.

## Program vs. instance

Two axes get conflated when we say "support multiple zk programs" (see
[`../research/MULTI_PROGRAM_PLATFORM.md`](../research/MULTI_PROGRAM_PLATFORM.md) §1):

- A **program** = one guest binary + the core-crate semantics it compiles + one journal shape + one
  params schema. Each program has its own vkey and its own golden-vector family.
- An **instance** = one *deployment* of a program: a chain + a contract set (snapshot/verifier +
  accumulator/registry) + a params set + an indexer/frontend view. The same program can run as many
  instances with **zero code changes**.

The reorg target, and the platform claim: **adding a program costs a core crate + a guest bin + prover
subcommands + golden vectors; adding an instance costs only a deployment.**

## Index

| Program | Status | vkey | Docs | Instances |
|---|---|---|---|---|
| **trust-graph** (root producer) | **Live** | `0x00aa4b4bec3cec5d3207be6a5bcea74a924ea059b4e848b8700c6e87c293c334` (M4 re-derivation) | [architecture](./trust-graph/ARCHITECTURE.md) · [runbook](./trust-graph/RUNBOOK.md) | v1 Optimism deployment — **frozen on journal v1**, never migrated (retains vkey `0x00a3d155…`) |
| **signer-sync** (Safe owner rotation) | **Built** | `0x00e06fc3677ab9f30e499dd4d47970945b47083c398158c4e009712e26e784dc` (M4 re-derivation) | [architecture](./signer-sync/ARCHITECTURE.md) · [runbook](./signer-sync/RUNBOOK.md) | consumer `SignerSyncZkModule` on the trust-graph instance (reuses its accumulator + `paramsHash`) |
| **hypercerts** (AT-proto graph) | **Built** — GOAL.md M4 | `0x007b0fc964221d8496f4fae791235afe12b7790575f5b8c4c7287f319766d9b0` (M4, SP1 6.3.1) | [architecture](./hypercerts/ARCHITECTURE.md) · [runbook](./hypercerts/RUNBOOK.md) · [partner brief](./hypercerts/PARTNER_BRIEF.md) | pilot on Optimism (GOAL.md M5; OP Sepolia rehearsal first) |
| **contributions** (rep-weighted funding split) | **Built — GOAL.md M5** | `0x0065cd065fabfe54a357afb4a22f2c44a5b88519421292bfc41e9c5c2fec1d90` (M2, SP1 6.3.1 — box-derived; see the reproducibility caveat below) | [architecture](./contributions/ARCHITECTURE.md) · [runbook](./contributions/RUNBOOK.md) · [interfaces](./contributions/INTERFACES.md) · [local testing](./contributions/LOCAL_TESTING.md) | local anvil dev (full round proven + paid out, wei-exact vs the golden fixture) |

> **vkeys:** M0's reorg changed each existing guest's ELF layout (semantics didn't change — vectors are
> byte-identical to pre-reorg), so the trust-graph and signer vkeys above were re-derived at M0 exit
> (`task zk:vkey PROGRAM=…`). They will rotate again at M2 (patched-crate additions change the ELFs).
> **Reproducibility caveat (measured at M4):** the vkey depends on the exact `succinct` toolchain
> build — a toolchain reinstall shifted the trust-graph/signer vkeys with zero source change, and
> adding a guest bin WITHOUT new crypto patches does NOT rotate sibling vkeys (byte-diff-verified
> both ways). Deployment-grade vkeys must be derived on the pinned toolchain recorded in the deploy
> runbook, not an arbitrary box.
> The frozen v1 Optimism trust-graph deployment keeps its already-deployed vkey and is never migrated;
> the re-derived vkeys apply to fresh deployments. Vkey rotations for the live stack are **batched** to
> M2's deploy through the constitutional-timelock path (GOAL.md ground rule 7).

## Layout

- `packages/zk-core` — shared, program-agnostic byte encodings (words/fold/merkle/fixed/cid/journal),
  the single source of truth for the primitives. Extracted at M0; every core crate re-exports it.
- `packages/pagerank-core` — trust-graph + signer semantics and their Params/Journal encodings; its
  public API survives the extraction by re-exporting `zk-core`.
- `zk/program` — one multi-bin guest crate; `build.rs` builds every `[[bin]]`.
- `zk/prover` — one host CLI (`trustgraph-prover`) with clap program groups.
- `test/golden/<program>.json` — one golden-vector file per program (four-way parity: native Rust /
  SP1 guest / Solidity / TS).
- `docs/<program>/` — how to operate each program today (runbooks, params, addresses). `research/`
  holds *why* (design provenance).

## Adding a fourth program

Per [`../research/MULTI_PROGRAM_PLATFORM.md`](../research/MULTI_PROGRAM_PLATFORM.md) §3 / §8, a new
program (call it `foo`) is exactly these additions — no change to any existing program's semantics:

1. **Core crate** — `packages/foo-core/`: the record→edge mapping, weight normalization, and the
   program's own `Params`/`Journal` + byte encodings, depending on `packages/zk-core` (and
   `packages/envelopes` if it ingests a lane-2 substrate). Same discipline as every core crate: no
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
5. **Docs dir** — `docs/foo/` with `ARCHITECTURE.md` (pointer to the research design) and `RUNBOOK.md`,
   plus a new row in this table.

Task/CI plumbing: `zk:{vkey|execute|prove|parity}` are generic via `PROGRAM=foo`; `zk:vectors` needs a
per-program branch (each program writes its own vector file — see the hypercerts branch added at M4),
and the frontend `pnpm test` script must be extended to compile+run the new program's golden suite.
The prover's `Cargo.toml` also gains the new core crate as a dependency (step 3's clap group needs it).
The CI parity job runs for every program on every PR touching `packages/` or `zk/`.

**Contracts are reuse, not new code.** A new program deploys a fresh labeled `SP1JournalVerifier`
instance (same bytecode, its own immutable vkey) against the same SP1 gateway, reuses `MerkleSnapshot`
on journal v2, and adds a `ParamsCodec` twin golden-locked to its crate's `params_hash`. Standing up
another *instance* of an existing program costs only a deployment (a new contract set + params +
indexer/frontend view) — no Rust, no guest, no vectors.
