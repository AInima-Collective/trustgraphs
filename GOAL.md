# GOAL — Cleanup & share-readiness

Status: ACTIVE 2026-07-24 (all open questions resolved — see Decisions at the bottom).
Branch: `zk`.

Sequencing: this cleanup runs **first**; the instance factory
(`research/INSTANCE_FACTORY.md`) is a separate program that builds afterwards on the
cleaned base. Where the factory will replace something anyway (the static
`networks.json` catalog machinery), this program deletes or leaves alone — it does not
polish scheduled demolition.

External reviewers (experienced DAO-governance people) want to read this repo. Right now a
fresh clone greets them with a WAVS-template fossil layer, generated artifacts committed at
repo root, a README that contradicts `docs/PROGRAMS.md`, and a `spike/` folder whose name says
"throwaway" but whose fixtures are load-bearing. This program makes the repo something we are
proud to hand to an outsider, without changing what the system does.

## Ground rules

1. **Zero functional change.** No contract, guest-program, or derivation behavior changes.
   Hard invariant after every milestone: per-program vkeys unchanged (`task zk:vkey`),
   `zk-parity` CI green for all four programs, `cargo test --workspace` green,
   `forge test` green.
2. **Delete, don't deprecate.** Git history (and the upstream fork) is the archive. The one
   exception is superseded research docs, which move to `research/archive/` with their
   status headers intact — they document why the architecture changed.
3. Anything that deviates from this plan gets a line in `docs/DEVIATIONS.md`.
4. Every milestone leaves the tree shippable; milestones land as separate commits/PRs so
   each is reviewable on its own.

## M0 — Dead infra: finish the WAVS removal

The code moved to SP1; the tooling didn't fully follow.

- [ ] `docker-compose.dev.yml`: delete the `warg-server` service (lines 10–22). Dev stack
      becomes anvil (host) + `ipfs` + `ponder-db`.
- [ ] `taskfile/services.yml`: fix `start-all` description and the stop trap (lines 5, 38) —
      no more WARG; remove the reference to nonexistent `telemetry/docker-compose.yml`
      (line 57). Same wording fix in `Taskfile.yml:51` and `CLAUDE.md:19`.
- [ ] `taskfile/env.yml:52-64`: delete `get-registry` (WASI registry lookup, zero callers).
- [ ] `taskfile/merkle.yml`: delete (57 lines; superseded duplicate of the reward tasks in
      `eas-forge.yml`, referenced by no doc). Remove its include from `Taskfile.yml`.
- [ ] `.taskrc.yml`: drop the `REMOTE_TASKFILES` experiment and `remote.insecure: true` —
      every include in `Taskfile.yml` is a local file. Remove `TASK_X_REMOTE_TASKFILES` from
      `.github/workflows/contracts.yml`. (An `insecure: true` in the repo root is a red flag
      to exactly the reviewers we're inviting.)
- [ ] `README_SETUP.md:84-121`: delete the entire Cargo-component / wasm32-wasip2 / warg /
      wkg install section. The stack needs Docker, Task, Node+pnpm, Foundry, Rust, SP1.
- [ ] `Cargo.toml:10`: `repository` still points to `Lay3rLabs/wavs` → point at this repo.
- [ ] `frontend/abis/`: delete unreferenced template ABIs — `PredictionMarketController.json`
      (full of `IWavsServiceHandler`/eigenlayer types), `RewardDistributor.json`,
      `MockUSDC.json`, `TEST.json`, `GnosisSafeProxy.json` (verify zero refs before each rm).
- [ ] `frontend/config.production.json:4` + `frontend/scripts/generate-config.ts:32`: the
      production ponder endpoint is hardcoded to `https://trust-graph.wavs.xyz/ponder`.
      No production deployment is live today (decision 3), so this becomes an env-driven
      value with an obvious placeholder default (`https://ponder.example.com/ponder`).

**Done when:** `grep -ri "warg\|wavs" --include="*.{yml,yaml,toml,json,ts,tsx,sol,rs,md}"`
returns hits only in docs that describe the migration as history (`README.md`, `CLAUDE.md`,
runbooks, `research/`), and `task services:start-all` brings up only live services.

## M1 — Generated artifacts: one directory, fully ignored

Today prover/exporter outputs are bare-filename `fs::write` calls that land in whatever CWD
the tool ran from — which is why root holds `input.json`, `anchors.txt`, `hypercerts_*.json`,
`.witness-archive/`, and why four generated files are *committed*.

Target layout — `.trustgraph/` (decision 4; single new gitignore line: `.trustgraph/`):

```
.trustgraph/
  trust-graph/     input.json, blob.json, proof.bin, public_values.bin
  signer-sync/     signer_input.json, signer_proof.bin, signer_public_values.bin
  hypercerts/      hypercerts_input.json, blob/skips/bundle .json, proof/public_values .bin,
                   anchors.txt, witness-archive/
  contributions/   contributions_input.json, blob, proof, public_values
```

- [ ] `packages/input-exporter/src/main.rs:57`: `--out` default →
      `.trustgraph/trust-graph/input.json` (resolved from repo root, not CWD — anchor on a
      workspace-root lookup or document "run from repo root" in the CLI help).
- [ ] `zk/prover` programs: route every hardcoded output filename through a per-program
      `--out-dir` (default `.trustgraph/<program>/`): `trust_graph.rs:119-134`,
      `signer.rs:93-94`, `hypercerts.rs:288,318,343-361`, `contributions.rs:189,262-277`.
- [ ] `zk/prover/src/witness/atproto.rs:30`: `DEFAULT_ARCHIVE_DIR` `.witness-archive` →
      `.trustgraph/hypercerts/witness-archive`.
- [ ] `git rm` the committed generated artifacts: `contributions_input.json` (root),
      `hypercerts_bundle.json` (root **and** `zk/prover/`), `zk/prover/hypercerts_blob.json`,
      `zk/prover/contributions_blob.json`. Check `docs/hypercerts/REPRODUCE.md` first — if a
      committed bundle is intentionally pinned for reproduction, move it to
      `test/golden/` instead of deleting.
- [ ] `.gitignore`: add `.trustgraph/`; collapse the now-redundant per-file rules
      (lines 5–9, 47–52) once the defaults move.
- [ ] Update every consumer of the old paths: `taskfile/{core,zk,contributions}.yml`,
      `indexer/src/contributions.ts:427`, `indexer/src/contributions-shared.ts:90`,
      `indexer/src/anchor.ts` (`HYPERCERTS_BUNDLE_PATH` example values), `test/e2e/run.sh`,
      and the walkthroughs (`LOCAL_TESTING.md`, `CONTRIBUTIONS_LOCAL_TESTING.md`,
      `docs/*/LOCAL_TESTING.md`, `docs/*/RUNBOOK.md`, `README.md`).
- [ ] `params.json` / `params.contributions.json` **stay at repo root**: they are
      human-seeded, deploy-mutated config (like `foundry.toml`), already gitignored, with
      env overrides (`PARAMS_JSON`, `CONTRIBUTIONS_PARAMS_PATH`) for anyone who disagrees.
- [ ] Foundry (`out/`, `cache/`, `broadcast/`), Cargo (`target/`), go-task (`.task/`) keep
      their tool-owned locations.

**Done when:** after a full local round (trust-graph e2e + one contributions round +
hypercerts local test), `git status` is clean and everything generated sits under
`.trustgraph/`.

## M2 — Localism Fund: remove entirely (decision 1)

Localism Fund was the pilot customer; it lives on in the upstream fork, and this repo is
generic TrustGraph tooling now. All Localism-specific code and config goes. The one
capability worth keeping — "this network has somewhere to apply" — survives as a generic
optional field, not a bespoke integration (decision 2).

Remove:
- [ ] `indexer/src/api/localism-fund.ts` — Notion "Expert Network" sync route, plus its
      mount in `indexer/src/api/index.ts:10,27`.
- [ ] `localismFundApplication` table in `indexer/offchain.schema.ts:280` and
      `frontend/offchain.schema.ts:280` (no live production DB depends on it — decision 3).
- [ ] `frontend/queries/ponder.ts:43-44,379-398` — per-address application-URL query +
      fetcher.
- [ ] `frontend/app/account/[address]/page.tsx:55-67` and `component.tsx:108-112,322-325` —
      application-link prefetch + render (replaced by the generic field below).
- [ ] `frontend/app/component.tsx:140` — hardcoded `localism.fund/expert-network` marketing
      copy → generic copy.
- [ ] `frontend/next.config.mjs:29` — `/interest` redirect to the OpenCivics Notion page.
- [ ] `indexer/.env.example:21-23` — `LOCALISM_FUND_NOTION_*` vars.
- [ ] `config/networks.production.json` — delete; no production deployment exists today
      (decision 3). Production config is documented by
      `config/networks.development.template.json` plus `docs/PRODUCTION.md`; a real prod
      file reappears when there is a real prod network.

Replace with generic (decision 2):
- [ ] Optional `applicationUrl` field on the network config entry (and template): when
      present, the network/account pages render an "apply to join" link to it. Static
      per-network URL — no per-address lookup, no offchain table, no third-party sync.
      This is also the shape the future factory expects (a link inside instance
      `metadataURI`), so nothing built here gets thrown away.
- [ ] `config/networks.development.template.json`: default network becomes a neutral
      example (`example-network` with placeholder name/about/criteria/`applicationUrl`),
      not Localism-specific copy.

Explicitly out of scope (factory Phase B replaces the static catalog wholesale): the
positional template-index coupling in `deploy/env.ts:157-215`, the `anchor` table's
deferred `instanceId` dimension, and any polishing of the `networks.json` →
`deployment_summary.json` pipeline beyond the deletions above.

**Done when:** `grep -ri localism` hits only `paper/` case-study prose and research docs —
no application code, no config.

## M3 — Docs: one front door, per-program guides, archived research

`docs/` already has the right shape (per-program `ARCHITECTURE`/`RUNBOOK`/`LOCAL_TESTING`).
The problem is nine root-level `.md` files, a stale README, and 19 dangling `GOAL.md` links.

Root shrinks to `README.md`, `CLAUDE.md`, `GOAL.md` (this file, while active), `LICENSE`:
- [ ] **Rewrite `README.md`** — the highest-value single item. Current one lists 3 programs
      and calls hypercerts "Planned"; `docs/PROGRAMS.md` (source of truth) has 4 programs
      with hypercerts and contributions **Built**. New shape: what TrustGraph is (2–3
      paragraphs, link `ELI5`), the four-program table (mirroring PROGRAMS.md), quickstart
      (setup → local round), doc map, license.
- [ ] `README_SETUP.md` → `docs/SETUP.md` (post-M0, WASI section already gone).
- [ ] `README_PROD.md` → `docs/PRODUCTION.md`; fix its links that land on the `zk/RUNBOOK.md`
      redirect stub, then delete the stub (also fix the same stub link in
      `research/ZK_ARCHITECTURE.md`).
- [ ] `LOCAL_TESTING.md` → `docs/trust-graph/LOCAL_TESTING.md` (matches the hypercerts and
      contributions pattern; covers signer-sync too — cross-link from
      `docs/signer-sync/`).
- [ ] `CONTRIBUTIONS_LOCAL_TESTING.md`: merge with `docs/contributions/LOCAL_TESTING.md`
      (they overlap); one guide survives, at the docs path.
- [ ] `ELI5.md` → `docs/ELI5.md`; `TRUST_GRAPH.md` → `docs/ALGORITHM.md` after a freshness
      pass (it's the oldest doc — either update to mention epochs/ZK in one closing section
      or trim to pure algorithm spec and say so up front). Both linked from README.
- [ ] `TODO.md`: delete (8-line scratchpad; convert live items to issues first).
- [ ] `research/`: add `research/archive/` and move superseded docs —
      `OPTIMISTIC_ARCHITECTURE.md`, `PRIVACY_ARCHITECTURE.md` (both still describe WAVS as
      current) — keeping their status banners. Fix stale status lines on
      `CONTRIBUTION_FUNDING.md` ("not committed to build" → Built),
      `HYPERCERTS_ATPROTO_PLAN.md`, `MULTI_PROGRAM_PLATFORM.md` (Planning → realized).
      Remove the dangling `PRODUCER_TRADEOFFS.md` link from the archived optimistic doc.
- [ ] **Resolve the 19 dangling `GOAL.md` references.** Past milestone GOALs were never
      committed. Sweep every `](../GOAL.md)` / "see GOAL.md Mn" reference and reword to
      point at what exists: `docs/PROGRAMS.md` for program status, `docs/DEVIATIONS.md` for
      the deviation log, or plain prose ("the M3 build plan") where it's historical
      narration. Going forward, active GOALs live at root and are deleted (not archived)
      when done — history lives in git and DEVIATIONS.
- [ ] `docs/contributions/AUDIT_M6.md` → `docs/contributions/audits/2026-07-M6.md` (it's a
      point-in-time audit artifact, not evergreen operator docs — the rename makes that
      legible).
- [ ] Add a short `docs/README.md` index: per-program map + where research/paper live.

**Done when:** repo root has ≤4 markdown files; README agrees with PROGRAMS.md; no dangling
links (`lychee` or a grep pass over `](` targets).

## M4 — Code pruning: spike/, packages/pagerank, dead scripts

- [ ] **`spike/` is mis-named, not disposable.** Three of four subdirs are load-bearing test
      fixtures consumed by shipped crates (`packages/envelopes` tests, `hypercerts-core`
      tests/examples, `zk/prover` conformance):
      - `spike/mst/fixtures/`, `spike/conformance-fixtures/`, `spike/hypercerts-fixture/` →
        move to `test/fixtures/atproto/{repos,interop,hypercerts}/` and update the path
        constants in the consuming tests. Keep the fixture generators
        (`hypercerts-fixture/gen`, `walk`) next to the fixtures they produce, and resolve
        the `#[path]`-includes of `spike/mst/src` modules (either promote the MST walker
        into a small internal crate or move the modules with the generator).
      - `spike/crypto/` → delete. Throwaway SP1 benchmark; results are recorded in
        `research/offchain/05-spike-results.md`.
      - Guard: fixture *content* must not change (some fixtures pin proven repos) — moves
        only, byte-identical, `cargo test --workspace` + `zk-parity` prove it.
- [ ] `packages/pagerank`: verify it's the pre-reorg duplicate of `pagerank-core` (check
      Cargo dependents and `frontend/lib/pagerank` imports); if nothing depends on it,
      delete crate + its README and drop it from the workspace members.
- [ ] `script/examples/*.md` (EAS-era usage docs): quick freshness check; keep if the
      direct-EAS flow still works, else delete.
- [ ] Sweep `frontend/`, `indexer/`, `script/`, `deploy/` for zero-reference files with a
      dead-code pass (`knip`/`ts-prune` for TS is optional tooling; manual grep is fine).

**Done when:** `spike/` no longer exists; workspace members all have dependents or are
published entry points; full test matrix green with identical vkeys.

## M5 — Outside-reader pass

The point of the whole program. After M0–M4:

- [ ] Fresh-clone walkthrough on a clean machine/container: follow README → setup → local
      trust-graph round → contributions round, fixing every wrong command or missing step
      hit along the way.
- [ ] A reviewer pass reading as the target audience (DAO-governance-literate, new to this
      repo): README → ELI5 → PROGRAMS → one runbook. Fix confusion points; jargon defined
      at first use.
- [ ] `CONTRIBUTING.md`: short — dev setup pointer, test matrix expected green, PR
      conventions, where design docs live.
- [ ] GitHub repo hygiene: description, topics, pinned README sections current.

**Done when:** the walkthrough completes with zero dead ends, and we'd send the repo link
to the governance folks without a disclaimer.

## Task-runner verdict (researched, no milestone)

Keep go-task. The repo drives four toolchains (Cargo, pnpm, Foundry, SP1) and ~1,100 lines
of task glue, of which only ~90 are dead (removed in M0); CI depends on `task setup` and
`task zk:parity`. `just` would be marginally terser with no functional gain; cargo-xtask or
pnpm scripts can't span the stack. Not worth a migration.

## Decisions (Jake, 2026-07-24)

1. **Localism Fund: remove entirely.** Not needed any more; this is generic TrustGraph
   tooling now. (Shapes M2.)
2. **Application link: keep as a generic optional `applicationUrl`** per network, replacing
   the bespoke Notion sync. (M2.)
3. **No production config for now** — local testing only; a template/placeholder is fine.
   Deletes `networks.production.json`, makes the frontend prod ponder endpoint an
   env-driven placeholder. (M0, M2.)
4. **Generated-output directory is `.trustgraph/`.** (M1.)

## Order

1. **Now, as parallel PRs:** M0 (dead infra), M1 (`.trustgraph/`), M4 (spike/ + pagerank
   pruning) — independent quick wins.
2. **Then:** M2 (localism removal) → M3 (docs) → M5 (outside-reader pass), in that order
   (M3 documents the post-M2 paths; M5 walks the finished thing).
3. **After this program closes:** the instance factory (`research/INSTANCE_FACTORY.md`) as
   its own program on the cleaned base.
