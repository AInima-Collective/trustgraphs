# Programs — the TrustGraph platform index

TrustGraph is a **platform of ZK-proven graphs**, not one program. This file indexes every SP1 program
in the repo, its status, its verification key, its docs, and its live instances.

## Program vs. instance

"Program" and "instance" are different axes, and conflating them muddles every
multiple-zk-programs conversation (see
[`../research/MULTI_PROGRAM_PLATFORM.md`](../research/MULTI_PROGRAM_PLATFORM.md) §1):

- A **program** = one guest binary + the core-crate semantics it compiles + one journal shape + one
  params schema. Each program has its own vkey and its own golden-vector family.
- An **instance** = one *deployment* of a program: a chain + a contract set (snapshot/verifier +
  accumulator/registry) + a params set + an indexer/frontend view. The same program can run as many
  instances with **zero code changes**.

The platform claim (realized by the platform refactor): **adding a program costs a core crate + a guest bin + prover
subcommands + golden vectors; adding an instance costs only a deployment.**

## Index

| Program | Status | vkey | Docs | Instances |
|---|---|---|---|---|
| **trust-graph** (root producer) | **Built** | `0x00d573370235fb42281f4b15682de43080cafac3ed34b759ddceea71fa09385f` (params-schema v2; box-derived, see the reproducibility caveat below) | [architecture](./trust-graph/ARCHITECTURE.md) · [runbook](./trust-graph/RUNBOOK.md) | **The only production deployment**: a legacy v1 instance on Optimism, frozen on journal v1 with its original vkey (`0x00a3d155…`) and never migrated — the current codebase targets fresh deployments (see [PRODUCTION.md](./PRODUCTION.md)) |
| **signer-sync** (Safe owner rotation) | **Built** | `0x003d711d740e0b590cc955afe815edcb9b2e892b961d8054b05a374a7341c022` (params-schema v2; box-derived, see the reproducibility caveat below) | [architecture](./signer-sync/ARCHITECTURE.md) · [runbook](./signer-sync/RUNBOOK.md) | consumer `SignerSyncZkModule` on the trust-graph instance (reuses its accumulator + `paramsHash`) |
| **hypercerts** (AT-proto graph) | **Built** | `0x00dd6884c5e7e591822ee4f3c8a48bb03d3f6997056a084cf4731c8fd6e9db96` (SP1 6.3.1, box-derived) | [architecture](./hypercerts/ARCHITECTURE.md) · [runbook](./hypercerts/RUNBOOK.md) · [partner brief](./hypercerts/PARTNER_BRIEF.md) | pilot on Optimism planned (OP Sepolia rehearsal first) |
| **contributions** (rep-weighted funding split) | **Built** | `0x00b66125a047f991056446fc6d8d2cc9d9408357d0b55978c35690d995210f08` (SP1 6.3.1, box-derived; rotated by params-schema v2 — its stage-1 twin is `pagerank_core::Params`) | [architecture](./contributions/ARCHITECTURE.md) · [runbook](./contributions/RUNBOOK.md) · [interfaces](./contributions/INTERFACES.md) · [local testing](./contributions/LOCAL_TESTING.md) | local anvil dev (full round proven + paid out, wei-exact vs the golden fixture) |

> **vkeys:** a vkey identifies one exact guest binary, so it changes whenever the guest ELF
> changes — including refactors that don't change semantics (the platform reorg rotated the
> trust-graph and signer vkeys even though golden vectors stayed byte-identical). Re-derive with
> `task zk:vkey PROGRAM=…`.
> **Reproducibility caveat (measured):** the vkey also depends on the exact `succinct` toolchain
> build — a toolchain reinstall shifted the trust-graph/signer vkeys with zero source change, and
> adding a guest bin WITHOUT new crypto patches does NOT rotate sibling vkeys (byte-diff-verified
> both ways). Deployment-grade vkeys must be derived on the pinned toolchain recorded in the deploy
> runbook, not an arbitrary box; the values above are from this repo's dev box.
> The frozen v1 Optimism trust-graph deployment keeps its already-deployed vkey and is never
> migrated; re-derived vkeys apply to fresh deployments. Rotate live instances' vkeys in
> **batches** through the constitutional-timelock path — don't dribble one rotation per change.
>
> **params-schema v2 (2026-07-24), measured per program.** The instance factory appended
> `accumulator` + `chainId` to the trust-graph params (`docs/trust-graph/FACTORY.md` §1). ELFs were
> byte-diffed across the change on one toolchain, baseline vs. after:
>
> | Program | ELF | vkey |
> |---|---|---|
> | trust-graph | changed | `0x00aa4b4b…` → `0x0033a6fa…` |
> | signer-sync | changed (reuses the trust-graph `paramsHash`) | `0x005f28ed…` → `0x0075a449…` |
> | hypercerts | **byte-identical** — its params schema is its own | `0x00daa9ad…` (unchanged) |
> | contributions | changed — `compute::trust_params` builds a `pagerank_core::Params` | `0x0065cd06…` → `0x00ac5ded…` |
>
> Two of the four *baseline* values also differed from what this table previously recorded
> (signer-sync `0x00e06fc3…`, hypercerts `0x007b0fc9…`) with no source change between them — the
> reproducibility caveat above, observed again. Treat every value here as this box's, and derive
> deployment vkeys on the pinned toolchain in the deploy runbook.
>
> **Overflow backstop (2026-07-24, same build).** The M6 security review found that
> `zk_core::fixed::mul_div` truncated an over-256-bit quotient instead of failing, so a
> badly-tuned instance proved WRONG scores and disagreed with the browser's arbitrary-precision
> port. It now asserts, and the rank loop's accumulations are checked. Because `zk-core` is shared
> by every program, this rotated **all four** vkeys — unlike the params change above, hypercerts
> included. The values in the table are post-fix; the params-schema-v2-only values were
> trust-graph `0x0033a6fa…`, signer `0x0075a449…`, contributions `0x00ac5ded…`, hypercerts
> `0x00daa9ad…`.

## Layout

- `packages/zk-core` — shared, program-agnostic byte encodings (words/fold/merkle/fixed/cid/journal),
  the single source of truth for the primitives. Extracted at M0; every core crate re-exports it.
- `packages/pagerank-core` — trust-graph + signer semantics and their Params/Journal encodings; its
  public API survives the extraction by re-exporting `zk-core`.
- `zk/program` — one multi-bin guest crate; `build.rs` builds every `[[bin]]`.
- `zk/prover` — one host CLI (`trustgraph-prover`) with clap program groups.
- `test/golden/<program>.json` — one golden-vector file per program (four-way parity: native Rust /
  SP1 guest / Solidity / TS). Exception: signer-sync shares `trust-graph.json` (same attestation
  feed; its vectors live under that file's `signer` key).
- `docs/<program>/` — how to operate each program today (runbooks, params, addresses). `research/`
  holds *why* (design provenance).

## Adding a fourth program

Per [`../research/MULTI_PROGRAM_PLATFORM.md`](../research/MULTI_PROGRAM_PLATFORM.md) §3 / §8, a new
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
