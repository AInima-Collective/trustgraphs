# Contributing

## Dev setup

System tools + toolchains (Docker, go-task, Node 21+/pnpm, Foundry, Rust, SP1) are covered in
[`docs/SETUP.md`](./docs/SETUP.md). Then:

```bash
task -y setup       # pnpm install + forge install
task build:forge
```

The fastest proof the stack works on your machine is `task e2e` (throwaway anvil, full
trust-graph loop, `E2E PASS` at the end).

## Test matrix — expected green before a PR

| Check | Command |
|---|---|
| Solidity (contracts + golden vectors) | `forge test` |
| Rust cores | `cargo test --workspace` |
| Cross-language parity, per program | `task zk:parity PROGRAM=<trust-graph\|signer\|hypercerts\|contributions>` |
| Frontend golden tests | `cd frontend && pnpm test` |
| On-chain e2e (needs anvil + SP1) | `task e2e` |

Two hard rules inherited from the codebase:

- **`packages/pagerank-core` (and each program's core crate) is the single source of truth.**
  No floats, `BTreeMap` only — the guest must be byte-reproducible everywhere.
- **An encoding change without regenerated golden vectors in the same PR is a CI failure.**
  Regenerate with `task zk:vectors PROGRAM=<name>`; the vkey consequences of guest changes are
  documented in [`docs/PROGRAMS.md`](./docs/PROGRAMS.md).

## PR conventions

- Keep PRs scoped to one concern; note any plan deviation in
  [`docs/DEVIATIONS.md`](./docs/DEVIATIONS.md) (what changed, why, which plan section).
- `task fmt` before committing (forge fmt + cargo fmt); frontend/indexer use
  `pnpm run format`.
- Generated artifacts belong under the gitignored `.trustgraph/` directory — never commit
  prover outputs, reconstructed inputs, or witness archives.

## Where things live

- Operator docs: [`docs/`](./docs/README.md) (per-program `ARCHITECTURE`/`RUNBOOK`/`LOCAL_TESTING`)
- Design docs / provenance: [`research/`](./research/) (superseded designs in `research/archive/`)
- Active build plan (when one is in flight): `GOAL.md` at the repo root — deleted when the
  program closes; history lives in git and `docs/DEVIATIONS.md`
