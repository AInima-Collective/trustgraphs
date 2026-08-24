# GOAL: make the operator something a stranger can run

> The whole design rests on one claim: `submitProof` is permissionless, so nobody has to
> trust us to keep their scores fresh. `run-a-prover.md` opens by saying exactly that.
> But the instruction we actually ship is "clone an 11,600-line Rust workspace, install a
> custom RISC-V toolchain, build for twenty minutes, and keep the source tree on the box
> forever." This program closes the distance between the promise and the command. It ends
> with one image, one config file, two secrets, and a health endpoint that says whether it
> is alive.

**Status:** opened 2026-08-24, on `main` at `b13035d`. **M0, M1, M2 and M5 are done and green;
M3 and M4 are built but cannot be verified on this box** (no SP1 toolchain, and the Docker socket
is root-owned — the same constraint SEPOLIA_GOAL 1.1 carries). M6 is blocked on the first tag,
because there is no published image to follow the instructions against yet.

Commits on `main`, unpushed: `e5b06bb` (M0-M2), `4814857` (M3-M4), `8cd0cc5` (M5 reorg + the three
defects running it found), `206b515` (M5 soak + four release-workflow defects).

**First tag, `v0.0.1`, failed at the gate — as designed, and on a real bug of mine.** `--docker`
bind-mounts a guest's OWN cargo workspace, and every guest here is a detached workspace whose path
dependencies reach up into `crates/`, so the container resolved `../../crates/contributions-core`
to `/crates/contributions-core` and found nothing. `sp1_build`'s `workspace_directory` is what
widens the mount; I read the field and did not use it. Fixed on both build paths. One good piece of
news came out of the same run: the aarch64 leg ran the amd64 SP1 image under QEMU without
complaint and reached the identical error at the identical point, so the "the pinned image may be
amd64-only" risk in the ledger is answered.

**Gates.** The *reproducibility* gate is not met until `guest-reproducibility.yml` actually runs
green — the mechanism exists and has now demonstrated it fails loudly, which is half of what a gate
is for. The *hostable* gate needs that plus a published
image. The *production* gate's two runnable legs are met (soak and reorg green, journal restore
tested); it is otherwise waiting on hostable. The *self-host* gate waits on M6.

**Measured while doing this, worth carrying forward:** guest vkey derivation is 68 seconds of CPU
for seven programs and was being done every tick; the operator's ambiguous window is as wide as the
proving call, so 25 kills produced one unresolved request; and the state directory costs about
34 KB per checkpoint (1.4 KB of it journal), which answers ledger item 4 — a 5 GB Hobby volume is
roughly a hundred thousand checkpoints of headroom.

**Sibling program:** [SEPOLIA_GOAL.md](SEPOLIA_GOAL.md), which deploys the contracts. Its M7
configures the operator for Sepolia and assumes it can be run somewhere. This program is
what makes that true. They can proceed in parallel: nothing here touches a contract, and
nothing there depends on the packaging below except at the moment the daemon actually starts.

**Predecessor:** the proof-scheduler build program, closed 2026-07-28. That program built the
decision engine and proved it works. This one is about everything around it.

---

## What is already true

Worth stating plainly, because the gap list below is short and specific, and the reflex on
reading it is to assume the operator needs a rewrite. It does not.

- **The hard part is done and tested.** Every decision that can be wrong lives in
  `crates/operator-core` (3,714 lines), a plain root-workspace crate CI tests against a fake
  chain. The sp1-sdk adapter in `zk/operator` (7,900 lines) is deliberately thin.
- **Crash safety is real, not aspirational.** Append-only journal keyed
  `(chain_id, instance_id, checkpoint_id)`, fsynced intent before request, re-attach on
  restart. `tests/e2e/fork.sh` kills it mid-proof and confirms no second request.
- **The money paths are guarded.** Rolling loss budgets that halt rather than bleed,
  simulate-before-send, a basefee gate, deterministic-revert abandonment, and a front-run
  test showing the fee follows the journal's recipient rather than `msg.sender`.
- **A drifting guest ELF fails safe.** The operator derives its own vkeys at startup
  (`zk/operator/src/run.rs:1777`) and compares them per instance against the deployed
  verifier (`run.rs:1078`), producing a `VerifierRotated` hold and an alert instead of
  spending. The failure mode is a loud outage, not a wasted proof.
- **Observability exists, on disk.** `status.json` is a scrapable heartbeat, `journal.jsonl`
  is the money record, and the log narrates changes rather than every tick.
- **CI already builds the guests.** `.github/workflows/zk-parity.yml` installs the pinned SP1
  toolchain and builds every guest family on a standard runner, then fans out a parity matrix
  across all seven programs. A release flow is that job plus packaging, not new ground.
- **The docs are ahead of most projects' code.** `research/operations/run-a-prover.md` has an
  alert-by-alert response table, a recovery section, and a §7 that says what has *not* been
  run. Most of this program's gap list came from that section rather than from discovering
  anything.

---

## What is actually wrong

Four things, all in the layer between "the daemon decides correctly" and "a person other
than its author can operate it."

### 1. It needs a Rust compiler at runtime

`zk/operator/src/handlers.rs` shells out to `cargo run` to reconstruct each round's input:
line 179 (trust-graph, via `input-exporter`), 216 (signer), 251 (contributions, via
`zk/prover --features fetch`), 289 (weighted), 367 (nostr, `--features witness-nostr`), and
418 (the strict Envelope0 preflight, via the `envelope0-preflight` binary).

The subprocess boundary itself is correct and should stay: `zk/operator` is a *detached*
workspace, on purpose, so that sp1-sdk's dependency graph never unifies with the root
workspace's alloy graph (the reason is written into `zk/operator/Cargo.toml`). Calling
`input-exporter` as a library would undo that. The problem is only that the subprocess is
`cargo` rather than a binary, which drags the entire source tree, a toolchain, and a warm
`target/` into production.

Note the scope: the two lanes Sepolia runs, trust-graph and signer, need exactly one extra
binary (`input-exporter`, from the root-workspace crate `crates/input-exporter`). The heavier
prover binaries are only needed for contributions and nostr.

### 2. Its state is wherever you happened to `cd`

`zk/operator/src/config.rs:340` and its neighbours default to `./.trustgraph/operator/…` for
the journal, the status file, the Envelope0 cache, and the weighted-manifest cache. Only
`release_manifest` is resolved relative to the config file (`config.rs:453`); everything else
is relative to the working directory. Combined with the `--manifest-path zk/prover/Cargo.toml`
arguments above, the daemon silently requires that you start it from the repo root.

That is a footgun anywhere and a data-loss bug on a platform with an ephemeral filesystem,
because `journal.jsonl` is the one file whose loss costs money: the runbook's own recovery
table says a lost journal means re-requesting proofs already paid for.

### 3. There is no way to ask it whether it is alive

The operator has no HTTP surface. The only liveness signal is `tick_at` inside a file on its
local disk, which means a container healthcheck cannot see it and neither can an uptime
check.

This also strands a feature that is already built on the other side: the frontend's
`packages/frontend/app/api/operator-status/[instanceId]/route.ts` accepts either
`OPERATOR_STATUS_PATH` (a shared volume) or `OPERATOR_STATUS_URL` (remote), and sanitizes
the heartbeat down to an explicit allowlist before it reaches a browser. The URL mode has no
server to point at. The volume mode does not survive contact with a platform that allows one
volume per service.

### 4. It has never been packaged, and some claims have never been run

There is no Dockerfile for the operator, no systemd unit, and no published image. The only
things that start it are `taskfile/demo.yml` and `tests/e2e/`, both via `cargo run` from the
repo root. The distance is shorter than it looks, though: the `guest-elfs` job in
`.github/workflows/zk-parity.yml` already builds all five guest families on a stock
`ubuntu-latest` runner with SP1 pinned at v6.3.1, which is the part everyone assumes will be
the problem.

And §7 of the runbook is honest about four things nobody has executed:

| claim | current evidence |
| --- | --- |
| survives a multi-day run | never run |
| survives a real reorg | synthetic unit test on the block-hash check only |
| resolves `RequestOutcomeUnknown` against the live prover network | read off the pinned SDK source in §3, not executed |
| schedules a Contributions round unattended | `DEVIATIONS` #23, still open |

### 5. The guest ELF is not reproducible, and we already knew

Found by asking whether CI could publish the image, which is a question that only has a good
answer if two machines building one commit agree.

Succinct's documentation says `cargo prove build` "may not generate a reproducible ELF" and
points production builds at `--docker`. Every guest build here uses the plain path.
`research/operations/addresses-and-vkeys.md` already records the consequence in our own words:
"a toolchain reinstall has been observed to shift vkeys with zero source change," and it warns
readers that their value "may legitimately differ from another machine's."

This is the only item on this list with a deadline, because the Sepolia verifier pins a vkey
at construction and the factory pins the verifier. M3 covers it.

---

## Decisions

- **D1 — The subprocess seam stays; only the executable changes.** Prebuilt binaries invoked
  by path, not `cargo run`. The detached-workspace split that forces a subprocess is load
  bearing and is not being undone.
- **D2 — The dev loop must not regress.** `task demo`, `tests/e2e/operator.sh` and
  `tests/e2e/fork.sh` run from a source checkout and must keep working unchanged. Tool
  resolution therefore falls back to `cargo run` when no prebuilt binary is configured or
  adjacent, rather than requiring every developer to pre-build.
- **D3 — The HTTP surface is read-only and off by default.** No control plane, no way to
  trigger or halt anything over the network. Binding it is opt-in, and what it serves is the
  same allowlist the frontend adapter already enforces, so the boundary holds on both sides
  instead of trusting the reader to sanitize.
- **D4 — The image pins the ELF; it does not rebuild it.** Guests are built once, in a build
  stage, with the SP1 toolchain pinned at v6.3.1. The runtime stage carries no toolchain. The
  ELF digest is recorded as an image label and logged at startup, so "which guest is this
  container running" is answerable without starting it.
- **D6 — Releases are cut by CI, from a tag, and attested.** Not from anyone's laptop. A vkey
  that gets pinned into an immutable verifier should trace to a public workflow run on a public
  commit, which is also what `research/UPGRADE_GOVERNANCE.md:30` already asks for. This is only
  worth anything on top of D7.
- **D8 — The GHCR package is public.** Ruled 2026-08-24. Anonymous `docker pull` with no
  GitHub account is the difference between "you may self-host" and "you may self-host if you
  are one of us," and §5 of the runbook makes the first claim. It also lets anyone verify the
  build provenance attestation against a public commit without credentials.
- **D7 — Guests are built reproducibly, via `--docker`.** Accepting slower builds and a Docker
  dependency, because without it "the published vkey differs from mine" and "the published
  image is not what it claims" are indistinguishable.
- **D5 — Scope fence: this program does not change any decision the operator makes.**
  No policy edits, no budget changes, no new holds. `crates/operator-core` should come out of
  this program byte-identical except where a path or a metric forces a signature change. If a
  behavioural change looks necessary, it belongs in its own program.

---

## Delivery plan

### M0 — Prebuilt tools instead of a compiler

- [x] A tool resolver: look for the binary in a configured `[ops].tool_dir`, then next to the
      running executable, then fall back to `cargo run` with today's arguments (D2).
- [x] Convert all six call sites in `handlers.rs` to it: `input-exporter`,
      `envelope0-preflight`, and the three prover feature builds.
- [x] Keep `SP1_SKIP_PROGRAM_BUILD=true` set on every spawned child, as `run_tool`
      (`handlers.rs:1059`) already does. That env var is what stops a child from rebuilding the
      guests mid-tick and returning a proof under a vkey no verifier pinned.
- [x] A test that runs the trust-graph lane with `tool_dir` set and `cargo` removed from
      `PATH`, so the "no compiler at runtime" claim is enforced rather than asserted.

**Exit:** `tests/e2e/operator.sh` passes twice, once via the fallback and once via `tool_dir`
with no `cargo` on `PATH`.

### M1 — One state directory, resolved explicitly

- [x] A single `[ops].state_dir`, with journal, status, and both caches defaulting inside it.
      Existing explicit paths keep working so no deployed config breaks.
- [x] Resolve every relative path in the config against the config file's directory, the way
      `release_manifest` already is (`config.rs:453`), so cwd stops being load bearing.
- [x] Refuse to start when the state directory is missing or not writable, alongside the
      existing startup refusals for an empty `rpc` and a zero `registry`.
- [x] A documented and tested journal backup and restore: take a copy, restore it onto a
      fresh box, confirm re-attach rather than re-request.

**Exit:** the daemon runs correctly from an arbitrary working directory, and a restored
journal re-attaches to in-flight work.

### M2 — A read-only health and heartbeat listener

- [x] `[ops].listen` (default unset). When set, serve three routes and nothing else:
      `/health` (the process is up), `/ready` (`tick_at` is fresher than a small multiple of
      `cadence.tick_seconds`), and the sanitized heartbeat.
- [x] The heartbeat body is the frontend adapter's allowlist and no more: `head_block`,
      `tick_at`, per-instance health, and the explicit `settings` projection. RPC and IPFS
      endpoints, webhook URLs, filesystem paths, keys and unresolved journal entries never
      appear. A test asserts absence by scanning the serialized body for known-secret values.
- [x] Point `OPERATOR_STATUS_URL` at it in the local demo, so the mode the frontend already
      supports is actually exercised before Sepolia depends on it.

**Exit:** `curl /ready` fails while the daemon is wedged and succeeds while it is ticking,
and the demo frontend renders operator status from the URL rather than a shared volume.

### M3 — A guest ELF that two machines can agree on

This is the milestone with a deadline attached, and it is the one that came out of asking
whether CI could publish the image.

Succinct's own documentation says it plainly: "Running `cargo prove build` may not generate a
reproducible ELF which is necessary for verifying that your binary corresponds to given
source code," and directs production builds at the `--docker` path instead. Every guest build
in this repo uses the plain path: `taskfile/zk.yml`, the five `sp1_build::build_program` calls
in `zk/prover/build.rs`, and the `guest-elfs` job in `.github/workflows/zk-parity.yml`.

We already knew, and wrote down, that this bites. `research/operations/addresses-and-vkeys.md`
records that "a toolchain reinstall has been observed to shift vkeys with zero source change,"
with the measurements in `research/VKEY_NOTES.md`, and tells readers "your value may
legitimately differ from another machine's." Its stated mitigation is to derive deployment
vkeys "on a pinned toolchain as part of the deploy ceremony," but pinning the toolchain
*version* does not fix a drift that was observed across a reinstall *at* a pinned version.

Two consequences that matter right now:

- **A CI-published image and a locally-derived vkey would simply disagree**, and nobody could
  tell "not reproducible" apart from "compromised." That collapses the whole point of
  publishing.
- **`research/UPGRADE_GOVERNANCE.md:30` already promises a "reproducible-build artifact so
  anyone can check vkey ↔ source before the window closes"** as a Lane C requirement. Today
  we cannot produce one.

- [x] Switch to `build_program_with_args` with `docker: true` and a pinned tag, in
      `zk/prover/build.rs`, `taskfile/zk.yml`, and `zk-parity.yml`.
- [ ] **BLOCKED (no Docker here).** Verify rather than assume: build the same commit on two
      architectures and
      assert byte-identical ELF digests and equal vkeys. The flag is trivial; this check is the
      milestone.
- [x] Rewrite the caveat in `addresses-and-vkeys.md` to describe what is then true.
- [ ] **BLOCKED (no Docker here).** Measure the cost. Docker guest builds are slower, and both CI and a self-hoster now need
      Docker present to build guests from source.

**Exit:** two independent builds of one commit, on different architectures, produce identical
ELF digests and identical vkeys.

**Do this before Sepolia.** Switching build modes changes every vkey. Right now every
deployment vkey in `addresses-and-vkeys.md` reads "none yet," so the change is free. After the
verifier is deployed it is a new verifier *and* a new factory, because the factory pins the
verifier. This is exactly the window SEPOLIA_GOAL opens by pointing at.

### M4 — Built and published by CI

Most of this already exists. `.github/workflows/zk-parity.yml` builds all five guest families
on a stock `ubuntu-latest` runner with SP1 pinned at v6.3.1 and uploads the ELFs as an
artifact. The release flow is that job plus a packaging stage.

The repository is public, which makes the economics trivial: standard runners are free,
GHCR hosting for public images is free, and build provenance attestation is free. Publishing
needs only `GITHUB_TOKEN` with `packages: write`, so it adds no secret to manage and nothing
that has to live outside GitHub.

- [x] `.github/workflows/release.yml`, triggered on a `v*` tag. There are no tags on this
      repository yet, so this also defines the release convention.
- [x] Reuse the guest build, then build the operator and tool binaries with
      `SP1_SKIP_PROGRAM_BUILD=true`, assemble the runtime image, and push to
      `ghcr.io/jakehartnell/trustgraphs-operator`.
- [x] Publish, as a release asset, a table of every program's ELF sha256 and vkey against the
      source commit. That asset is the Lane C reproducible-build artifact
      `research/UPGRADE_GOVERNANCE.md:30` already commits us to.
- [x] `actions/attest-build-provenance` on the image, so it is cryptographically traceable to
      a workflow run and a commit rather than to a person's laptop.
- [x] Build `linux/amd64` (what Railway runs) and `linux/arm64` (Apple Silicon self-hosters) on
      native runners rather than under QEMU.
- [x] A guard step that re-derives the vkeys inside the release job and fails the release if
      they disagree with the published table.
- [x] Assert the package is anonymously pullable (D8): a `docker pull` in a job with no
      registry credentials. A private package is the silent default, so this has to be tested
      rather than assumed.
- [x] Watch runner disk. A cold Rust build of this size across several feature sets, plus
      Docker layers, on a runner with roughly 14 GB free is the likeliest failure, and freeing
      space is a known one-line action if it bites.

**Exit:** pushing a tag produces a pullable multi-arch image, a provenance attestation, and a
published vkey and digest table, with no human step in between.

### M5 — Run the things that have never been run

- [x] **Soak.** A harness against anvil with restarts and RPC failures injected,
      asserting no duplicate requests, no journal corruption, and bounded growth of the
      journal and both caches.
- [x] **Reorg.** A real one, using anvil snapshot and revert, deep enough to remove a
      checkpoint the operator has already decided to spend on. Today only the block-hash
      finality check is covered, and only against a synthetic case.
- [ ] **BLOCKED (needs a funded Succinct key).** **`RequestOutcomeUnknown`.** The hold is now
      PRODUCED and handled locally — the soak's 25 kills made one — but resolving it against the live prover
      network, then resolve by `public_values_hash` through `get_filtered_proof_requests`, as
      §3 of the runbook says is possible. This is the one leg that needs a funded Succinct key.
- [x] **Contributions, unattended.** Restated in `DEVIATIONS` #23 with a current reason: the
      obstacle is now the demo harness taking over a checkout, not the daemon. Close the remaining half of `DEVIATIONS` #23, or restate
      the deviation with a current reason if the setup cost still outweighs what it buys.
- [x] Update §7 of the runbook so each row moves from "not run" to what was actually observed.

**Exit:** §7 contains no claim that rests on reading source rather than running it, except
where a deviation is explicitly restated.

### M6 — Follow our own instructions

- [ ] **BLOCKED (no published image yet — needs the first tag).** Provision a clean machine with no checkout and no GitHub account. Using only the
      published image and the published doc, bring up a daemon that proves a real instance, and
      write down every place the instructions were wrong or incomplete.
- [ ] **BLOCKED (same).** Verify the published vkey independently, from source, on that machine. M3 is what makes
      that a meaningful check rather than a coin flip.
- [ ] **BLOCKED (same).** Fix what was wrong, then have the walkthrough repeated by someone who did not write the
      fixes.
- [x] Rewrite §5 (Self-hosting) around `docker pull` rather than around `cargo run`.

**Exit:** a self-hoster's first successful root, from a standing start, without reading Rust.

---

## Gates

**Reproducibility gate (blocks SEPOLIA_GOAL 1.1, and therefore its M0):** M3. Deriving a
deployment vkey from a build we know is not reproducible, and pinning it into an immutable
verifier, is the one mistake here that cannot be undone cheaply.

**Hostable gate (blocks putting the operator on Railway, and blocks SEPOLIA_GOAL M7 from
being called done):** M0 through M4, and the published image runs from a config plus two
secrets with no repo checkout.

**Production gate (blocks pointing it at a public chain we tell people about):** the hostable
gate, plus M5's soak and reorg legs green, plus a tested journal restore.

**Self-host gate (blocks telling strangers to run it):** the production gate, plus M6.

---

## Operator ledger

1. **M3 should land before you derive the vkeys in SEPOLIA_GOAL 1.1.** Otherwise 1.1 gets done
   twice, and the version that counts is the second one. If Sepolia needs to move first, say
   so and we deploy on a non-reproducible vkey deliberately, with the redeploy cost written
   down, rather than by accident.
2. **The funded Succinct key unblocks one M5 leg.** The live `RequestOutcomeUnknown` rehearsal
   cannot be run without it. It is the same key as SEPOLIA_GOAL's 1.5, so this costs nothing
   extra beyond agreeing it may be used to deliberately abandon a request.
3. **One click, once, after the first release publishes.** A GHCR package pushed by
   `GITHUB_TOKEN` is created **private**, regardless of the repository being public, and the
   visibility has to be flipped by hand in the package settings the first time. D8 is not in
   effect until you do that, and the symptom if it is missed is a `docker pull` that asks a
   stranger to authenticate. I will point at the exact package URL when the first tag lands.
4. **Confirm the Railway plan.** Volumes are 5 GB on Hobby and 50 GB on Pro. The journal is
   append-only and the weighted-manifest cache is bounded at 16 MiB, so Hobby is almost
   certainly enough for a testnet, but bounded growth is an M5 assertion rather than a
   measurement today.
5. **A deliberate non-ask.** No decisions about budgets, cadence, curated membership or
   pricing belong to this program. Those were ruled in SEPOLIA_GOAL D5 and are fenced out by
   D5 here.

---

## Landmines

- **`cargo prove build` is not reproducible, and this repo has already measured that.**
  Until M3 lands, a vkey is a property of the machine that built it as much as of the source.
  Do not compare vkeys across machines and conclude anything from a mismatch.
- **`task zk:build` is the only thing in this repo that builds the guests.** Everything else
  exports `SP1_SKIP_PROGRAM_BUILD=true`, so a fresh checkout that has never built them fails
  at `include_elf!` with a missing-file error that reads like a broken repo.
- **`sp1_build` does not watch path dependencies.** Edit anything under `crates/` and cargo
  will happily reuse an ELF that predates the change. `taskfile/zk.yml` touches
  `zk/prover/build.rs` to force the pickup; any new build path needs the same defence.
- **A journal is bound to one chain.** `WorkKey` is `(chain_id, instance_id, checkpoint_id)`,
  and a restarted devnet reproduces all three, so an old journal's `landed` record matches new
  work exactly and wedges the planner. Never carry a journal across chains, and never restore
  a backup taken from a different one.
- **Never run two operators against one journal or one submitter key.** A Railway volume
  forces the old deployment down before the new one starts, which is what we want. Do not
  raise the replica count, and do not raise `cadence.max_per_instance` above 1.
- **`registry_from_block` left at 0 produces no catalog at all**, not a slow one: the scan
  issues thousands of empty `eth_getLogs` calls and most providers reject the range outright.
- **This sandbox has no SP1 toolchain and no Docker**, so M3 and M4 cannot be verified here.
  Both need a machine with `cargo-prove` v6.3.1, which is the same constraint as
  SEPOLIA_GOAL's 1.1, or a CI run.
