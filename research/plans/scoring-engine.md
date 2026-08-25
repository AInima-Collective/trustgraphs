# GOAL: a scoring engine that can carry a real network

> A trustgraph should be able to grow past the demo. Two hundred people vouching
> for each other should cost cents to prove, not $2.67; a stranger with two
> hundred fabricated accounts should hold nothing at any setting; and the number
> the operator uses to decide whether it can afford a snapshot should be the
> number the snapshot actually costs. None of that is true today, and all of it
> is fixable before anything is deployed where it would have to be migrated.

**Status:** completed 2026-08-23. Opened and scoped down 2026-08-22, after a
first draft that had six milestones and four open decisions: see the program
log. **All four milestones and their local release gates are complete.** The
remaining real-prover, deployment, and operating-profile choices are launch
actions outside this program.

**Theme:** every change here is free today and a migration tomorrow. Nothing is
deployed to a public chain: the Optimism path is retiring, Sepolia has not
happened, mainnet is the target. The testnet deploy is the door closing.

**Evidence record:**
[research/SCORING_PRODUCTION_PLAN.md](../SCORING_PRODUCTION_PLAN.md) — the
engine findings, measured against the production Rust and the real SP1 executor.
[research/SCORING_NEXT_STEPS.md](../SCORING_NEXT_STEPS.md) — the mechanism
half: the admission gate, the founder floor, closed loops, complaints.
[research/scoring-sim/](../scoring-sim/) — the model that reproduces the
shipped payouts digit for digit.
[research/operations/sepolia.md](../../research/operations/sepolia.md) — the deployment-path work this
program does *not* cover, and the SP1 6.3.1 compatibility gate it shares.
Cross-agent review outcomes — recorded in the program log below, threads `F1`-`F9`.

Convention: this file would normally be deleted when the program closes. It is
retained here as the closeout record; the program log below records rulings that
supersede the research docs.

---

## Why this program exists, and why now

1. **The rank loop is quadratic in accounts, and the guest pays for it.**
   `crates/pagerank-core/src/pagerank.rs:132` walks every attester for every
   recipient and re-sums that attester's whole outgoing row, once per recipient
   per iteration. Measured in the SP1 executor, all runs passing
   `guest == native`: 25 accounts = 72.7M cycles, 100 = 714.8M,
   **200 accounts = 2.67 billion.** The browser port has the same shape and would
   hang a tab.

2. **The operator's cost model is linear, so its guards fail open.**
   `crates/operator-core/src/types.rs:247` estimates `2M + inputs x 40k`. At 200
   accounts it quotes 49.8M and is billed 2.67B, off by 54x, with the error
   doubling every time membership doubles. The guard compares the *estimate*
   against the limit, so the operator accepts a job it priced at fifty million
   cycles and is charged for two and a half billion.

3. **The admission gate is open in every template.** With 40 real members and 160
   fabricated accounts the fabricated bloc holds **32.3%** at the shipped
   settings, and **44.5%** if the boost is fixed on its own, because the two
   defects have been partly cancelling each other. A reachability gate takes it
   to **0.00%** at any starting share. The creation wizard already defaults to
   100% and warns twice; `contracts/script/examples/CreateInstance.s.sol:58`,
   `contracts/script/DeployEasOffchainE2E.s.sol:82`, `params.contributions.json`
   and all seven reference vectors are still at 15%.

4. **The deployment script we would run for Sepolia has a role bug in it.**
   `contracts/script/DeployTimelocks.s.sol` uses one address for both tiers and
   comments the zero admin as "roles are fixed to (proposer, executor) at
   deploy". OpenZeppelin 5.4.0 grants the timelock authority over itself
   unconditionally and grants `CANCELLER_ROLE` to every proposer. One party ends
   up able to block every proposal, including the proposal that would remove
   them.

5. **Research code was swept into the production tree during the reorg.**
   `crates/graph-reputation-core` is 725 lines with zero dependents, plus a
   reference vector nothing reads and docs pages implying it ships. Seven files
   cite a `PLAN.md` that does not exist, including the header of `pagerank-core`
   itself.

---

## Decisions

| | Question | Ruling |
|---|---|---|
| **D1** | Remove `trustMultiplierFp` from the parameter tuple now? | **Yes.** Four codecs, five programs, 103 files, one day. Free before the first public deployment and never free again. Add a schema/domain version word to the params-hash preimage at the same time: today nothing identifies the schema to an offline consumer, and after this there will be a 16-word and a 17-word tuple in the wild with no way to tell them apart. |
| **D3** | `graph-reputation-core`: delete or relocate? | **Move to `research/`** with its vector and docs, preserving provenance. `crates/` should mean shipped. |
| **D4** | `crates/pagerank`: keep the float crate? | **Fold the fixture into `pagerank-core`'s test module and delete the crate.** Not to be confused with the M1 differential oracle, which is the current *fixed-point* kernel. |
| **D5** | Governance quorum default (formerly 4% of voting power over decisive votes)? | **15%, final.** Under M2, the largest of three founders holds 10.75%, the largest of five holds 6.24%, and a disconnected 160-account fabricated bloc holds 0%; 10% therefore failed its own rule by letting one three-founder signer clear quorum alone. The production scenario table and its operating precondition are published in `docs/build/create-a-network.md`. |
| **D6** | Browser parity: WebAssembly, or differential fuzzing? | **Fuzz.** Seven fixed vectors can only sample a hand-written port of a consensus-critical algorithm. WebAssembly is a bigger change with a build cost and no forcing reason now. |
| **D7** | Distance decay default | **No change.** A per-network setting (ruled 2026-08-21). M3 publishes the trade-off table next to it. |
| **D8** | Is exhausting `maxIterations` a valid result, or must the guest refuse an unconverged one? | **Fixed-iteration semantics.** `maxIterations` is already hashed into `paramsHash`, so it is already normative. `converged`, `iterations_run` and `final_max_delta` are telemetry, not journal fields. Paired with `MIN_TOLERANCE_FP = 1e6`, fixed with an **explicitly empirical** margin: real limit cycles exist at the shipped damping on periodic graphs, measured amplitude 0-6 fixed-point units flat from V=10 to V=2,000, but a finite sweep is not a no-cycle proof. Fail-closed would reintroduce the "a governed parameter change makes this instance unprovable" cliff M2 exists to delete. |

**Withdrawn** (2026-08-22, on the scope-down): D2 and D9 existed only to order a
single-core rewrite that is no longer in the plan. D10 and D11 were consequences
of two mechanisms that are now out of scope; see the program log for why.

---

## Product contract

Invariants that hold across every milestone. A change that breaks one of these is
not in this program.

- **The score is a share, not a quantity.** Everyone's share totals 100%. Nothing
  in this program changes that, and any future mechanism that needs to withhold
  standing owes an explicit committed accounting rather than an unexplained gap.
- **Cross-language parity never weakens.** Rust, the SP1 guest, the Solidity
  golden tests and the browser agree byte for byte, and every milestone that
  changes an encoding updates all seven vectors in the same commit.
- **A release either changes scores or it does not, and it says which.** M0 and
  M1 change no score anywhere; their correctness argument is that the output is
  identical, and that argument does not survive being bundled with M2.
- **The scoring changes that cancel each other ship together.** Starting share,
  the reachability gate and the boost removal are one release. Shipping any of
  them alone makes the network measurably worse.
- **The guest never panics on parameters the validator accepts**, and after M2
  that holds by construction (total standing cannot grow) rather than by a
  Solidity growth heuristic.
- **Cost is knowable before proving, and the guard errs upward.** The admission
  estimate models the whole guest with its parameters and **never falls below
  actual cycles** inside the supported envelope. Erring low is a correctness
  failure for a guard, not an imprecision.
- **Operator policy fails loudly; the protocol stays permissive.** A hosted
  operator refuses visibly and attributably, and someone else can still produce
  the proof. Policy is cheap to change; a pinned verification key is not.
- **No role, parameter, or accounting choice may disable the only governance path
  that can change or remove it.** An intentional brake needs a recovery path
  whose authorization and threshold do not depend on the suppressed role or
  quantity. The M0 timelock is an instance of this.
- **Nothing lands without a reference vector.** New behaviour gets a golden; a
  golden nothing reads gets deleted.

---

## Delivery plan

M0 and M1 are independent of each other and of everything else. M2 needs M1
landed first so its diff is legible, and ships with it. M3 is two independent
items and gates value rather than testnet.

### M0 — Clear the desk, and fix the script we will deploy with

- [x] Relocate `crates/graph-reputation-core` per D3, with
      `tests/golden/graph-reputation.json` and `docs/build/graph-reputation/`.
- [x] Retire `crates/pagerank` per D4; delete the `[profile.release]` block at
      `Cargo.toml:29` that warns on every workspace command.
- [x] Fix the seven `PLAN.md` citations: point each at the document that actually
      holds that contract, or write the one that is missing.
- [x] Relocate `crates/weighted-prior-research` (one consumer,
      `zk/prover`; the name says research and the location says production).
- [x] **Split the timelock roles** in `contracts/script/DeployTimelocks.s.sol`:
      separate proposer from canceller, per tier, and correct the comment at line
      82 to describe what OpenZeppelin 5.4.0 actually does.
- [x] Delete the 4.0 GB of untracked `target/` output under `research/`
      (done 2026-08-22; `research/` is now 2.4 MB).

**Exit:** the only warning from `cargo check --workspace` is the transitive
`proc-macro-error2` notice; no file cites a document that does not exist; every
crate in `crates/` has at least one consumer; a hostile single proposer can no
longer veto its own removal; all 343 tests still green.

---

### M1 — The engine, with the numbers unchanged

**A review boundary, not a deployment boundary.** No public launch happens on M1
semantics alone; the verifier swap is rehearsed locally and on a fork, and M1 and
M2 deploy as one audited bundle.

**Prerequisite commit:** land the measured push candidate, its graph generators
and exact seeds, and a **test-only copy of the current fixed-point pull kernel**
as the differential oracle. The oracle must exist before the change it polices,
or it is a description of the new behaviour rather than a check on it.

- [x] Push instead of pull in `crates/pagerank-core/src/pagerank.rs`, with each
      account's outgoing ratios precomputed once, outside the iteration.
      Measured bit-identical on the shipped reference vector and ten further
      configurations including graphs with unreachable components; 6x to 169x
      faster over 100 to 3,200 accounts, gap widening with size.
- [x] **Carry the decay factor on the BFS frontier** rather than calling
      `decay_pow` once per node. `decay[child] = fp_mul(decay[parent], base)` is
      bit-identical by construction and removes the last quadratic term in the
      precompute: measured 25x at V=600 and **123x at V=4,000** on a path graph.
- [x] The same changes in `packages/frontend/lib/pagerank/pagerank.ts`.
- [x] **Edge closure:** assert that every account named by an edge is in the node
      set, in all five programs. Already true, so asserting it is
      output-preserving.
- [x] Property tests: node set closed under its edges; total after normalisation
      exactly the scale; old-versus-new differential over arbitrary admissible
      graphs and parameter boundaries; explicit overflow and rejection parity.
      The ordering property is **ranking invariance under insertion order after
      reconciliation**, not raw-input permutation: records with equal timestamps
      deliberately use fold position as consensus order.
- [x] **A parameter-aware, full-guest cost model.** Not "linear in attestations":
      reconciliation is `O(E log E)`, the output tree is `O(V log V)`, and lane 2
      does per-envelope signature work. Name the terms per program, include
      parameters and witness shape, measure the whole guest, and hold the
      estimate to a **one-sided** guarantee.
- [x] **Two-stage admission.** The seam already exists: `handlers::build_input`
      reconstructs the checkpoint and computes the native journal at
      `run.rs:1204`, *before* `Record::Intent` at line 1222, which the code
      itself marks as where money goes at risk, while `estimated_cost_cents`
      reads `state` and ignores everything `built` learned.
      - **Stage 1, cheap and pure:** authenticated raw counts, program,
        parameters, and conservative algebraic *bounds* (`live_edges <=
        attest_records`, `nodes <= 2 * attest_records + seeds`), using
        `maxIterations`. Assert the bounds hold in a test.
      - **Stage 2, on prepared input:** extend `handlers::Built` with a
        `WorkProfile` and apply the tight estimate immediately before the intent.
      - Record **both** `maxIterations` and `iterations_run`; the two diverging
        is the drift signal.
- [x] **Publish a versioned operator capability profile**, host-enforced: raw
      records, live edges, unique nodes, out-degree, witness bytes, lane-2
      anchors and signature checks, iterations. Boundary and one-over-bound
      tests, visible attributable refusal reasons, and documentation stating that
      **another prover may accept the same checkpoint**. It belongs to the
      operator, not the instance. The guest asserts **no cost-only ceiling**: a
      size cap in a pinned verification key would make a graph that outgrows one
      operator's economics invalid for every prover.
- [x] Differential fuzzing between the Rust and the TypeScript kernels (D6).
- [x] Publish the measured cycle table in `research/operations/trust-graph/runbook.md`.

**Preserve exactly, or the rewrite is not identical:** the stopping condition is
measured only over accounts a trusted path reaches; unreachable accounts take
their teleport value and are skipped before the delta is taken.

**Exit:** all seven reference vectors byte-identical; `guest == native` on every
program; the old-versus-new differential green over the generated corpus; and the
admission estimate demonstrated by a published adversarial benchmark matrix never
to fall below measured cycles inside the envelope.

---

### M2 — Close the gate

One release. Its parts cancel each other if separated.

- [x] Starting share to 100% in all seven reference vectors,
      `params.contributions.json`, `contracts/script/examples/CreateInstance.s.sol:58`
      and `contracts/script/DeployEasOffchainE2E.s.sol:82`.
- [x] The leftover starting balance goes only to accounts a trusted path reaches.
      About five lines, mirrored in TypeScript.
- [x] **Seed universe, a live defect.** `build_graph` builds nodes from live edge
      endpoints only, while `initialize_scores` divides the trusted share by the
      count of *configured* seeds. A seed with no edges never receives its slice
      and the slice is never redistributed: measured at starting share 100%, one
      absent seed of two grants only **50% of the scale**, two absent of three
      grant **33%**. This gets worse once the gate closes and the whole endowment
      sits on the seeds. Every configured seed becomes a ranked zero-edge node,
      exactly once, in canonical order.
- [x] Fold the founder boost into the row denominator, making it provably inert
      (verified bit-identical at 1x, 2x, 4x, 10x), then remove it from the
      parameter tuple per D1.
- [x] **Add a schema/domain version word to the params-hash preimage.**
      `encode::params_hash` has none today; "params-schema v2" lives only in a
      source comment.
- [x] With growth now impossible, delete `_validateGrowth`,
      `RankGrowthUnbounded` and `MAX_TRUST_MULTIPLIER_FP`, and replace the
      `mul_div` overflow panic's justification with an invariant the guest
      asserts directly: total standing never exceeds the scale, every iteration.
- [x] **`MIN_TOLERANCE_FP = 1e6`** (D8), shipped with its evidence
      table and its margin labelled empirical.
- [x] **Templates default to three to five founding accounts.** Measured under
      M2 in a community of 40: one founder holds 33.64%, the largest of three
      holds 10.75%, and the largest of five holds **6.24%**. Document the floor
      honestly rather than mechanising it away, and note that a founder the
      community wants gone is removable through governance.
- [x] Governance quorum per D5.
- [x] Correct `docs/concepts/algorithm.md`, which lists the boost as one of three
      trust mechanisms. It dilutes the founder, leaves every downstream ratio
      unchanged, and breaks convergence.

**Exit:** the **metamorphic gate property** holds: adding, removing, or rewiring
any component with no directed path from a seed changes no reachable account's
score or payout, and every account in that component scores zero. Plus: the
default and golden profiles settle on their stopping condition; no parameters the
validator accepts can panic the guest; the seven vectors, the schema version, and
the new vkeys regenerate in one commit.

**Breaks, per program:** guest and vkey; parameter ABI and hash schema; Solidity
factory and controller redeployment; browser and indexer parameter handling. Not
a `setZkVerifier` operation.

---

### M3 — The two remaining defects *(value gate, not testnet)*

Independent of each other and of everything above.

#### M3a — Signer liveness

The Safe's signers are chosen purely by score, and a score cannot know its holder
stopped acting, so re-running the signer sync **re-installs the dead rather than
replacing them.** Three dead signers out of five locks the Safe permanently. No
scoring change reaches this; the module needs a per-account activity input of its
own.

- [x] Name the **authenticated** fact that proves activity, who can supply it,
      and who can censor it. An unauthenticated or censorable liveness signal is
      a new route to removing a legitimate signer, which is worse than the
      deadlock it fixes.
- [x] Freshness rule, and behaviour when the signal is absent. **Absent must mean
      "no change", never "assume dead".**
- [x] Opens with a design pass. The candidates all have weaknesses: an on-chain
      transaction proves possession but not participation; a signature on a
      recent Safe transaction proves participation but only for signers already
      included; a periodic heartbeat proves neither and creates an availability
      requirement.

**Exit:** re-running the signer sync replaces the inactive rather than
re-installing them, and no single party can manufacture the absence of a liveness
signal for a signer they want removed.

#### M3b — Distance-decay decision support

- [x] Publish the trade-off next to the setting in the creation flow, so the
      choice between "trust travels far" and "closed loops pay less" is made with
      the numbers in view. Measured: decay 0.6 gives a 1.21x gain from a
      reciprocal fake account and reaches 5 hops; 0.8 gives 1.68x and 7 hops;
      1.0 gives 6.17x and no distance limit. **Moves ahead of M3a if Sepolia
      exposes network creation** (D7).

---

## Release gates

### Testnet gate (Sepolia)

**M0 + M1 + M2**, deployed as one bundle. M1 is reviewed separately and never
launched on its own. Beyond this program, Sepolia additionally needs the
deployment-path work in [research/operations/sepolia.md](../../research/operations/sepolia.md): a chain
profile separate from deployment stage, a sanitized `deployments/sepolia.json`
release manifest, and the **SP1 6.3.1 compatibility check**. If that toolchain
has no supported verifier route, the bump rebuilds every ELF and regenerates
every key and vector, so it should ride with M2.

### Value gate (real money on the line)

**M3a.** A Safe that re-installs the dead is not acceptable where funds move.

---

## Release compatibility matrix

| | Scores change | Params ABI / hash | Guest / vkey | Solidity redeploy | Browser / indexer |
|---|---|---|---|---|---|
| **M0** | no | no | no | timelock script only | no |
| **M1** | **no** | no | yes | no | kernel rewrite, same outputs |
| **M2** | **yes** | **yes** (field removed + version word) | yes | **factory + controller** | parameter forms, codecs, indexer |
| **M3a** | no (signer set only) | selection params | signer guest | module | signer views |
| **M3b** | no | no | no | no | creation flow |

**Rotation gate**, for every row that changes a vkey: deterministic build,
recorded ELF hash, vkey, parameter-schema version, params hash, golden digest;
atomic or paused verifier/params transition; in-flight proof drain; shadow
computation; canary; rollback path.

---

## Capacity and operations

"Carry a real network" needs a measured profile, not one 200-account point. The
cells divide by who can produce them, and M1 only carries the first group:

| Measurable in-loop | Needs a real prover | Needs a deployed stack |
|---|---|---|
| executor cycles; conservative estimate; iterations and convergence; input shape; native kernel timing; browser preview time and memory | Groth16 wall time; peak memory; cost on a named hardware or service class | end-to-end checkpoint-to-accepted-root latency |
| M1 exit | **operator ledger, Jake** | Sepolia launch |

**Operator telemetry**, from M1: estimate-to-actual cycle ratio, iterations and
convergence, input shape, proof latency and cost, refusal reason, budget
remaining, snapshot age. **"The graph became too large" must be a visible,
attributable state, never a silent stalled snapshot.**

Bitcoin OTC scale (5,881 accounts) is a research dataset, not a target. Pick the
snapshot cadence first, since that is what members experience as "how long until
my vouch counts", and derive the affordable graph size from it.

---

## Operator actions ledger (Jake)

1. **The SP1 6.3.1 verifier-route check** against Succinct's supported-version
   data. Not answerable from the repo, and it decides whether a toolchain bump
   rides along with M2.
2. **Real-prover measurements.** Groth16 wall time, peak memory and cost on a
   named hardware or service class. These need infrastructure no agent in this
   loop has, so M1's exit deliberately does not depend on them.
3. **Resolved:** D5 is fixed at 15% from the production scenario table. At least
   three independent founders is the operating precondition; a one-founder
   network is visibly founder-controlled and should not hold shared funds.
4. **Snapshot cadence for the first real network.** The number members actually
   experience, and the one the affordable graph size should be derived from.
5. **Nothing is pushed.** The program closes in a local commit; publishing it
   remains an explicit operator action.

---

## Out of scope (filed, not forgotten)

- **Complaints and negative attestations.**
  [trustgraphs#104](https://github.com/AInima-Collective/trustgraphs/issues/104). The
  graph cannot say "this person defrauded me", and withdrawing a vouch is
  byte-identical to never having made one. Fully designed and measured against
  real data; blocked on a product decision about the recovery path. Includes the
  withheld-share accounting, which is the only reason this program ever needed
  scores that do not sum to the whole, and vouch age, which matters more once
  complaints exist.
- **One scoring core.** `pagerank-core` and `weighted-prior-core` are two
  implementations of graph ranking with different arithmetic. Unifying them is a
  code-quality win, not a correctness one, and it costs a golden churn and a key
  rotation across five programs. Do it when there is a reason, not on principle.
- **An earned founder prior.** Making a founder's balance conditional on being
  vouched for was designed and measured, and the only rule that resists a founder
  certifying itself needs at least two founders and still does not resist two
  founders cooperating. Before M2, recommending three to five founders took a
  repudiated founder from 33.60% to 7.40% for a one-line template change;
  production M2 measures the largest of five at 6.24%, and governance can remove
  a founder the community wants gone. The measurement artifact is
  `research/scoring-sim/founder_prior.py` if this is ever revisited.
- **Closed loops.** A fabricated account is somewhere your outflow lands that you
  still control, and a vouch back makes it a loop. The gain is flat in headcount,
  so no defence that counts identities touches it. Distance decay bounds it and
  nothing else does. The most interesting open research question in the system,
  and it wants a cycle-aware approach rather than an identity-aware one.
- **A max-flow capacity metric.** Measured and rejected: at 150 honest members it
  starves 122 of them, and which 122 depends on path-exploration order.
- **Voucher liability.** Four approaches tried, all defeated by normalisation.
- The Sepolia deployment path itself, the Optimism retirement, and the
  contributions/hypercerts/signer-sync programs, all of which
  `research/operations/sepolia.md` keeps off the launch-critical path.

---

## Program log

- 2026-08-22 — **Opened.** Scoring engine reviewed against the production Rust
  and the real SP1 executor. Quadratic rank loop measured at 2.67 billion guest
  cycles for 200 accounts; the operator's linear cost model measured 54x low at
  the same point; a push-based rewrite verified bit-identical on the shipped
  reference vector and ten further configurations. Admission-gate and boost
  findings from the 2026-08-21 review re-confirmed against production semantics.
  4.0 GB of untracked build output removed from `research/`.

- 2026-08-22 — **Cross-agent review**, nine
  threads, all closed. Three defects surfaced only because a claim was checked
  rather than accepted: real limit cycles at the shipped damping, the
  absent-seed endowment loss, and `decay_pow` still being quadratic when hoisted
  per node. Two positions of mine were corrected and are worth remembering: the
  guest never becomes linear in attestations, and a finite experiment is not a
  universal claim.

- 2026-08-22 — **Scoped down, on Jake's call.** The first draft had six
  milestones and four blocking decisions. Two things came out.

  **The single-core rewrite, and with it the whole "where does lost mass go"
  question.** That question was self-inflicted: it only arises if the core
  conserves mass exactly, which I proposed by copying how `weighted-prior-core`
  works, and which nothing needed. The score is a share, not a quantity; decay
  lowers standing relative to others and the final normalisation handles it. The
  one place the accounting genuinely breaks is complaints, where lowering
  someone's score raises everyone else's including the accuser's, and that now
  travels with [#104](https://github.com/AInima-Collective/trustgraphs/issues/104)
  where it belongs.

  **The earned founder prior.** Measured: recommending three to five founders
  takes a repudiated founder from 33.60% to 7.40%, which is most of the problem
  for a template default. The mechanism would have added a qualification rule, a
  validator constraint, a minimum seed count and a security boundary that does
  not cover two founders cooperating, to move that 7.40% to zero. Rank does not
  improve with more founders, since founders split the endowment equally, but
  rank only matters for signer selection, which needs M3a regardless.

  Four milestones, no blocking decisions. D2, D9, D10 and D11 withdrawn.

- 2026-08-22 — **M0 complete.** The graph-reputation core, its still-enforced
  cross-language golden, and its build docs now live together under
  `research/graph-reputation/`; the weighted-prior helper moved to
  `research/weighted-priors/core` and is a dev-only prover dependency. The old
  floating-point `pagerank` crate is gone, with its deterministic migration
  fixture frozen in `pagerank-core` instead. All orphan `PLAN.md` citations now
  point to `research/ZK_ARCHITECTURE.md`. Timelocks assign proposer and canceller
  independently from construction, remain self-administered, and production
  deployment refuses missing or overlapping cancellers. Verification:
  `cargo check --workspace` emits only the allowed `proc-macro-error2` notice;
  `cargo test --workspace` is green; both detached research crates and the
  relocated TypeScript golden are green; `forge test` is 54 suites / 738 tests /
  0 failures. That full run also exposed and corrected one stale pre-existing
  accumulator test whose `NoNewInputs` expectation contradicted the current
  two-lane checkpoint contract. Verification-created `research/**/target`
  output (506 MB) was cleaned; `research/` is 2.6 MB.

- 2026-08-23 — **M1 complete.** The Rust and browser kernels now use the
  output-preserving push formulation and frontier-carried decay, backed by the
  frozen pull oracle, property tests, and cross-language differential fuzzing.
  The operator applies a conservative shape bound before preparation and a
  versioned `WorkProfile` immediately before intent; every supported capability
  has a named refusal reason. The published adversarial SP1 matrix covers every
  guest and the trust-graph envelope through 400 nodes: measured cycles remain
  below the estimate in every row, with 1.48x to 6.59x headroom.

- 2026-08-23 — **M2 complete.** All seven programs use the versioned parameter
  schema without `trustMultiplierFp`, 100% starting share, the configured seed
  universe, and reachability-gated residual allocation. Total standing is
  asserted at or below the fixed-point scale on every iteration; accepted
  tolerance cannot panic the guest. The production governance scenario fixed D5
  at 15%: the largest of three founders is 10.75%, the largest of five is 6.24%,
  and the disconnected fabricated bloc is 0%. The seven new ELF hashes, vkeys,
  parameter hashes, and golden digests are recorded in `research/VKEY_NOTES.md`.

- 2026-08-23 — **M3 complete.** Signer activity is an authenticated, complete
  hash chain of direct governance votes, checked against the live on-chain
  accumulator and Safe pre-state. Fresh activity can rotate inactive signers;
  absent, stale, incomplete, or insufficient activity preserves the exact owner
  set and threshold. The creation flow now puts the measured distance-decay
  reach and reciprocal-loop trade-off next to the setting.

- 2026-08-23 — **Program closed.** Fresh SP1 6.3.1 deterministic builds and
  `guest == native` checks passed for all seven programs. The complete Rust,
  frontend, indexer, non-audit Solidity, standalone-operator, and local E2E
  suites are green; the three release-only operator gates also pass when run
  sequentially. Remaining ledger items require a real prover, a supported
  deployed verifier route, or a first-network operating choice and are therefore
  launch work rather than unfinished scoring-engine work. Nothing was pushed.
