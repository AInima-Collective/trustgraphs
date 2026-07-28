# GOAL — The proof scheduler (nobody runs the runbook, communities pay for their own roots)

Build the missing operator and its economics:

> **A daemon watches the chain and keeps proven scores fresh without a
> human in the loop: it freezes checkpoints on the contract-fixed
> cadence, proves them, and lands them. Curated instances are proven on
> us. Everyone else either self-proves — permissionless, documented,
> free forever — or tops up an on-chain tank, and the same loop pays
> whoever produces the root, with the fee provably unstealable from the
> mempool.**

This file is the execution spec. The design is normative:
[`research/PROOF_SCHEDULER.md`](research/PROOF_SCHEDULER.md) (problem
§0, inventory §1, operator §2, backend + costs §3, economics §4,
failure semantics §5, decisions §7–§10), sitting on
[`research/INSTANCE_FACTORY.md`](research/INSTANCE_FACTORY.md) §5 and
constrained by [`research/UPGRADE_GOVERNANCE.md`](research/UPGRADE_GOVERNANCE.md)
§5.5/§5.6. The factory GOAL closed leaving one sentence unfinished —
"proven scores land on the epoch cadence" was true only because a human
ran `taskfile/instances.sh`. This build makes it true by itself.

**Target for this GOAL: on a mainnet-forked anvil, the daemon runs
unattended across multiple epochs over three programs — trust-graph,
contributions, and signer-sync — landing real Groth16 proofs verified
by the canonical SP1 gateway, with one instance subsidized, one drawing
a funded vault, and the bounty demonstrably unstealable.** Deploying
the hosted operator to mainnet (custody, PROVE funding, on-call) is a
later GOAL.

**Scope fence (Jake 2026-07-27):** no hypercerts / lane-2 handler in
this program. The corrected lane-2 sequencing is recorded in the
appendix so the analysis isn't lost, and the domain-separation fix in
M0 covers hypercerts anyway because it is structural rather than
per-program.

---

## Ground rules

1. **The design doc is normative.** Deviations get an entry in
   `docs/DEVIATIONS.md` (what, why, which § it touches). Two are
   pre-approved: `PROOF_SCHEDULER.md` §4.3's commit-reveal is
   **superseded** by recipient-in-journal, and §4.2's free-floor-for-all
   is **superseded** by curated subsidy (both recorded in that doc's
   §9/§10).
2. **Parity discipline, again.** Journal v3 (M0) touches
   `packages/pagerank-core::{lib,encode}`, all three cores that build a
   `Journal`, every guest bin, `MerkleSnapshot.submitProof`, all three
   golden vector files, the Solidity golden tests, the frontend TS port
   (`frontend/lib/pagerank`), **and every ABI consumer** — the indexer's
   `submitProof`/`MerkleProofSubmitted` handling and the frontend's
   generated ABIs land in the same PR. No intermediate state where the
   contract and its consumers disagree.
3. **Avoid preventable spend; budget for the rest.** Preventable spend
   (a params mismatch, a known-pending rotation, an unfinalized
   checkpoint, an empty vault, an oversized instance) is a hold or skip
   with an alert, before the request. Unpreventable spend is real —
   a creator-admin can rotate config one block after any preflight — so
   the operator carries **per-instance and global loss budgets** and
   halts the instance when one is exceeded. Two structural changes in
   M0 shrink the unpreventable set: `paramsHash` is pinned per
   checkpoint, and checkpoints can only be minted by their snapshot.
4. **Guest-vs-native byte assert is a submit precondition.** The
   operator computes the journal natively (`pagerank_core::compute`)
   and asserts the proof's `publicValues == encode::journal_encoded(native.journal)`
   before it broadcasts. Free, and it is the same assertion `execute`
   already makes (`zk/prover/src/common.rs`).
5. **The decision logic lives where CI can test it.** Everything that
   can be *wrong* (when to trigger, which checkpoint to prove, when to
   hold, when to claim) goes in a crate the root workspace tests
   (`.github/workflows/rust.yml` runs `cargo test --workspace`); only
   the thin sp1-sdk adapter lives in the detached `zk/` workspace.
6. **Stateless by default, and honest about the gap.** The contracts
   are the scheduler's database. Local state is an append-only request
   journal whose only job is "don't pay twice after a crash". Because a
   request id cannot be journaled before the request that mints it,
   the ambiguous window is an explicit state (`RequestOutcomeUnknown`)
   that is resolved by lookup or left for a human, never auto-retried.
7. **A stolen bounty must be structurally impossible.** The proving fee
   follows the *journal's* recipient; only gas reimbursement follows
   `msg.sender`, and reimbursement is **capped and conservative, never
   claimed to be exact** — `gasleft()` deltas cannot see intrinsic cost,
   and `block.basefee` deliberately excludes the priority fee so a
   self-inflated tip is not reimbursable. The invariant under test is
   `reimbursement <= demonstrable caller cost`.
8. **Money moves by pull, never push.** Payouts are credits the
   recipient withdraws. A recipient that rejects ETH must never be able
   to revert a successfully verified root.
9. **Money contracts get the security treatment.** `ProvingVault` is
   the first contract here that holds user funds behind a
   permissionless payout path. Full Foundry battery + `solidity-auditor`
   + `/security-review` before the last milestone exits.
10. **No new FV surface** — fuzz, unit, golden, e2e per milestone.
11. **Frontend copy passes the plain-reader test** (and no em-dashes in
    user-facing strings). "Scores refresh about once a month" and
    "about 3 weeks of roots left at this rate", never `epochLength`,
    never `maxPerRoot`, never a § reference in the DOM.
12. **Sensible defaults over stalls.** Anything not locked in Decisions
    gets a recorded default and a config key, not a blocker.

---

## Interface freeze (IF) — merges first, everything hangs off it

One PR freezing four interfaces, in `packages/pagerank-core`,
`src/contracts/`, and a new `docs/OPERATOR.md`:

- **Journal v3 — 12 words.** Append to `pagerank_core::Journal`
  (`lib.rs:149`, currently 10 fields) and to `encode::journal_encoded`
  (`encode.rs:54`):
  - `recipient: Address` — the bounty payee, a pass-through commitment
    each program's `GuestInput` supplies and the guest commits verbatim.
  - `instance_domain: B256` — `keccak256(abi.encode(snapshot, chainId))`.
    **`submitProof` rebuilds this from `address(this)` and
    `block.chainid`**, so the submitter cannot lie about it and no
    program's params codec has to remember to include it. This is the
    universal version of the `INSTANCE_FACTORY.md` §6.1 fix; it closes
    the hole that hypercerts still has (its `Params` carries no
    instance-unique field at all, so two identically-configured
    hypercerts instances accept each other's proofs today). Trust-graph's
    params-v2 `accumulator`/`chainId` fields become belt-and-braces;
    leave them, they are golden-locked and harmless.
- **`submitProof` gains `address recipient`**, folded into the digest
  rebuild (`MerkleSnapshot.sol:217-230`) alongside the derived
  `instanceDomain`, and added to `MerkleProofSubmitted`.
- **Checkpoint-pinned params.** `trigger()` records
  `checkpointParamsHash[id] = paramsHash`; `submitProof` builds the
  digest from the **pinned** value and reverts `UnpinnedCheckpoint` if
  it is unset. Rotations then take effect at the next boundary
  automatically, which is what `UPGRADE_GOVERNANCE.md` §5.6 asks
  operators to arrange by hand today, and an in-flight proof survives a
  params rotation. **The verifier is deliberately NOT pinned:** a
  verifier rotation is the emergency response to an SP1 soundness bug
  (§5.5's design load), and pinning it would let proofs under a
  known-broken verifier keep landing.
- **`ProvingVault` API, in full** — deposits, `submitAndClaim`, credit
  withdrawal, per-instance policy, quote/eligibility views, events. It
  is frozen here rather than at M3 so the indexer and frontend can build
  against it in parallel.
- **Operator config schema** (`docs/OPERATOR.md`): `{rpc, registry,
  curated set, per-program manifests, cadence policy, gas policy,
  finality policy, prover backend, claim policy, loss budgets, alert
  webhook}`.

*Exit:* doc + type changes + regenerated vectors under test. Nothing
else merges before this.

---

## Milestones

Each milestone merges with tests green and the zk-parity job passing.
**Lanes marked ∥ are independent after their stated prerequisite.**

### M0 — Journal v3, checkpoint pinning, and the accumulator binding *(prereq: IF)*

Three contract-level changes plus the parity dance:

1. **Journal v3** threaded through the three cores' `compute`
   (`contributions-core/src/compute.rs:286`,
   `hypercerts-core/src/compute.rs:292`), all guest bins, `submitProof`
   and its unit tests, `input-exporter` (`--recipient`, default zero),
   `contributions fetch`, `taskfile/instances.sh`, the frontend TS port
   + `golden.test.ts`, and the indexer's ABI consumers. All three golden
   vector files regenerated; every vkey re-derived (`task zk:vkey`) and
   `docs/PROGRAMS.md` updated. The signer program keeps its own
   `SignerJournal` shape and stays outside the vault, but its vkey
   rotates by contagion, as the params-v2 table records.
2. **Checkpoint-pinned `paramsHash`** in `MerkleSnapshot`, per the IF.
3. **Bind each accumulator to its snapshot.** `AttestationAccumulator.checkpoint()`
   is permissionless today (`AttestationAccumulator.sol:42-52`) with no
   snapshot binding, so anyone can freeze a lane-1 instance's inputs at
   a block of their choosing, bypassing the `epochLength` gate and
   contradicting the invariant asserted at `MerkleSnapshot.sol:44-46`.
   `TrustAccumulatorMirror.sol:99-102` already has the right pattern
   (`msg.sender != snapshot ⇒ revert`). Add the same one-time binding to
   `AttestationAccumulator`, set by the factory after the snapshot
   exists (the resolver must be deployed first, so it is a bind-once
   setter, not a constructor arg — the same shape as the contributions
   `bindSnapshot` cycle). This is also what makes `UnpinnedCheckpoint`
   safe rather than a denial-of-service surface.

Why the rotation is now rather than later, for the DEVIATIONS entry:
mainnet has nothing deployed, so it costs zero ceremony today and is
contagious across N live instances tomorrow — the same argument that
moved domain separation into the factory build.

*Exit:* four-leg parity green (Rust / guest / Solidity / TS);
**recipient binding** — a proof for recipient A reverts under recipient
B; **domain separation** — two instances identical in every param
(including a hypercerts-shaped pair with no instance-unique params at
all) reject each other's proofs; **rotation survivability** — a
`setParamsHash` between trigger and submit does not invalidate the
in-flight checkpoint, and does bind the next one; **boundary integrity**
— a direct `accumulator.checkpoint()` from a stranger reverts; the
frozen v1 Optimism instance documented as untouched; DEVIATIONS entries
for the journal bump and the accumulator binding.

### M1 — `packages/operator-core`: catalog + decision engine *(prereq: M0; ∥ with M3)*

A new root-workspace crate, no sp1-sdk, no keys, no sends:

- **`catalog`** — lift the reconstruction logic out of
  `packages/input-exporter/src/bin/instance_scan.rs` (registry →
  `InstanceRegistered` tx → factory `InstanceCreated` → full params →
  self-check `params_hash(event.params) == snapshot.paramsHash()`) into
  a reusable `scan()` behind a `ChainReader` trait. **Two changes from
  the binary's behaviour:** a failure is per-instance
  (`SkipParamsMismatch`), never a global abort — one garbage registry
  row must not stop every healthy instance — and instances the chain
  cannot describe are read from a **program manifest** instead (below).
- **Manifests for what the chain doesn't carry.** "Zero per-instance
  config" is true only for factory-minted trust-graph instances.
  Contributions is not in `InstanceRegistry` at all
  (`DeployContributionsInstance.s.sol` writes `deployment_summary.json`),
  hypercerts registers an opaque `paramsHash` with no params-bearing
  event, and `SignerSyncZkModule` is not discoverable from the registry
  in any form. So: factory trust-graph instances stay zero-config; every
  other instance gets a small explicit manifest entry (program, params
  path, submit target, dependencies). Say so plainly in the docs rather
  than implying the chain describes everything.
- **`decide`** — the pure heart: `plan(InstanceState, Policy) -> Action`,
  with `Action` ∈ `{Idle(reason), Trigger, AwaitFinality, Prove(cp),
  Submit(cp), HoldRotationPending, HoldBasefee, HoldPaused,
  HoldLossBudget, SkipUnsupported, SkipParamsMismatch}`. Coalescing
  lives here (only the newest unproven checkpoint is ever proved,
  because `submitProof` is monotonic), as does the epoch arithmetic
  judged against `head + 1`. **Readiness is program-specific**, not a
  generic leafCount comparison: `EmptyLaneAccumulator.leafCount()` is
  `pure returns (0)` forever, and a contributions instance can move
  while its mirrored lane-1 is quiet. Compare the checkpoint
  commitments the program actually consumes.
- **`finality`** — track `(blockNumber, blockHash)` for the trigger and
  anchor transactions a proof depends on; `AwaitFinality` until
  confirmed, so a reorg cannot erase a checkpoint we already paid to
  prove.
- **`guard`** — mandatory re-read of `(paramsHash, zkVerifier)` before
  spend and before submit, plus a best-effort pending-op probe when an
  instance's admin is a `TimelockController` (factory instances are
  creator-admin'd and have none, so the probe is optional, not assumed).
  With M0's pinning, a params rotation no longer invalidates in-flight
  work; the guard's remaining job is verifier rotations and pauses.
- **`journal`** — append-only JSONL keyed `(chainId, instanceId,
  checkpointId)`. An **intent record with a client-side idempotency
  nonce is fsynced before the request**; the network request id is
  appended after. On restart, intent-without-id resolves by querying the
  backend for that nonce, and if the backend cannot answer, the record
  becomes `RequestOutcomeUnknown` — surfaced to a human, never
  auto-retried.

*Exit:* `cargo test -p operator-core` covers every `Action` branch
against a fake chain — quiet instance, epoch not elapsed, coalesce over
three unproven checkpoints, params mismatch skips one instance and
leaves the rest running, verifier rotation pending, basefee spike,
unfinalized checkpoint, loss budget exceeded, crash-restart replay in
all three journal states. **Spike (do this first, it is the one
unverified external dependency):** confirm what sp1-sdk 6.3.1 offers for
request idempotency and status lookup by requester; the answer decides
whether `RequestOutcomeUnknown` is rare or common, and it is written
into `docs/OPERATOR.md` either way.

### M2 — `zk/operator`: the daemon, three handlers *(prereq: M1)*

- **Prover library seam.** `zk/prover` gains `src/lib.rs` and
  value-returning entry points (`execute(input) -> Journal`,
  `prove(input, groth16) -> (publicValues, seal)`) that the existing CLI
  wraps. This deletes the stdout-scraping seam `taskfile/instances.sh`
  relies on (it parses `outputRoot:` with `awk`).
- **The daemon** (`zk/operator`, detached workspace beside `zk/prover`
  so the sp1-sdk graph stays unmixed with the root workspace's alloy
  graph): interval tick, per-instance state machine driving
  `operator-core`'s `Action`, one in-flight proof per instance, global
  concurrency cap. Startup checks: vkey vs the deployed
  `SP1JournalVerifier` per program, chain id, key balances. Two keys per
  the sp1-blobstream template: `NETWORK_PRIVATE_KEY` (PROVE balance) and
  a separate submitter key.
- **Handlers**: trust-graph (zero-config, factory-minted),
  contributions (manifest), signer (manifest; woken by
  `MerkleRootUpdated` on its trust instance, submitting to
  `SignerSyncZkModule.submitSignerProof` — the same trigger topology the
  old WAVS `safe-signer-sync` had).
- **Submit path**: `eth_call` simulation first, basefee gate (a root
  that lands six hours late still files at its input-freeze block),
  nonce management with replacement, `StaleCheckpoint` revert treated as
  **success** (someone landed a newer root), pause-shaped revert treated
  as hold + alert.
- **Ops**: structured JSON logs, `status.json` heartbeat, alert webhook,
  `--once` mode (the code path e2e and CI drive), and a fourth service
  in `docker-compose.prod.yml` beside `ponder`.

*Exit:* `operator --once` proves and lands every ready instance across
all three programs on the dev stack, reproducing
`taskfile/instances.sh`'s result for trust-graph; that script is retired
to a documented fallback. Kill the daemon mid-proof and restart: it
re-attaches rather than paying again. A `trigger()` spam run costs the
spammer gas and the operator nothing (coalescing measured, not
asserted).

### M3 — `ProvingVault` *(prereq: M0's ABI; ∥ with M1–M2)*

One contract, instance-keyed, ETH + USDC:

- **`submitAndClaim` is the payout seam.** The vault forwards to
  `snapshot.submitProof(...)`, confirms `lastAppliedCheckpoint ==
  checkpointId`, marks the checkpoint claimed, and credits. A
  `MerkleSnapshot` hook cannot be the seam:
  `IMerkleSnapshotHook.onMerkleUpdate` sees only a `MerkleState` — no
  checkpoint, submitter, or recipient. Recorded so it isn't
  re-litigated.
- **Accounts bind to a snapshot at first deposit**, not per call.
  Resolving through `InstanceRegistry` on every claim would let the
  registry's `OPERATOR_ROLE` redirect a funded community's balance to a
  malicious snapshot. Migration is an explicit, community-authorized
  action.
- **The split that kills front-running:** `provingFee → args.recipient`
  (proven in the journal), `gasReimbursement → msg.sender` (whoever
  paid). Copying a pending tx pays the original prover their fee and
  refunds the copier only their gas. **Under partial funding the fee is
  paid first**, or a copier could consume the remaining balance as gas
  and leave the prover with nothing.
- **Paid eligibility is on-chain**, because operator policy cannot bind
  a stranger: a per-instance `minPaidIntervalBlocks` (the cadence the
  community is actually paying for) plus `maxPerRootUsd`. This replaces
  the design doc's period/count pair — it expresses the same guard more
  directly, and it is the only place a paid-cadence limit *can* live,
  since `EPOCH_FLOOR` binds only at creation (see Decisions).
- **Cost-indexed bounty**: gas from a conservative capped formula with
  strict calldata bounds, priced at `block.basefee`; proving fee from
  `feePerRootUsd[program][band]` where the band function is
  **per-program** and defaults to *unsupported ⇒ zero fee*, so an
  unknown or oversized program can never claim the cheapest band. The
  operator's `cycle_limit` and the vault's top band must name the same
  boundary; that agreement is a test.
- **Fail open on correctness, closed on money**: a stale or invalid
  price feed pays zero proving fee and still lands the root. USDC is
  valued at $1 in v1 (deliberate; `maxPerRoot` bounds the exposure).
- **Authority is `CONSTITUTIONAL_ROLE`**, not `OPERATIONAL_ROLE`.
  Operational is the short-lane params role; extending it to fund
  custody widens it into something it was not designed to be. For
  creator-admin'd instances these are the same address today and diverge
  correctly at graduation.
- **Withdrawal notice** (7 days, request-then-wait). Instant withdrawal
  would let a community rug a prover mid-proof, which is exactly the
  reliability the hosted service sells. Top-ups stay instant. Anyone may
  top up any instance. FEE_SETTER = us (§8.2).

*Exit:* Foundry battery green — pay-once per checkpoint, bind-at-deposit
resists a hostile registry update, **front-run simulation** (copy a
pending `submitAndClaim` from another sender; the fee still credits the
original recipient), **rejecting-recipient simulation** (a recipient
that reverts on receive does not block the root), partial funding pays
fee before gas, `reimbursement <= demonstrable caller cost` as a fuzz
property, `minPaidInterval` and `maxPerRoot` enforcement, stale-feed
path lands and pays no fee, withdrawal notice cannot be short-circuited,
reentrancy, unknown program gets zero fee. Plus `solidity-auditor` and
`/security-review` with findings triaged.

### M4 — Wiring: prepay, claim policy, and the surfaces people see *(prereq: M2 + M3)*

- **Factory**: `createInstance` becomes payable and forwards
  `msg.value` into the vault for the new `instanceId` ("deploy your
  network endowed with a year of roots"). The factory still holds no
  instance roles.
- **Operator claim policy**: curated instances are proven on us via
  plain `submitProof` and never draw a vault; every other instance is
  proven only when its vault covers the quote, via `submitAndClaim`.
  Balance, eligibility, and feed freshness are checked *before* proving,
  so a prover never discovers mid-flight that it will not be paid. Vault
  empty ⇒ stop and say so honestly rather than silently subsidizing.
- **Indexer**: deposits / claims / credits / balance / last-root-age
  tables, and `MerkleProofSubmitted`'s recipient.
- **Frontend**: "Refresh now" reads `lastTriggerBlock + epochLength` and
  shows a countdown instead of letting the tx bounce `EpochNotElapsed`;
  a staleness line ("scores as of 3 days ago"); the vault panel
  (balance, burn rate, "about 3 weeks left", top-up in ETH or USDC);
  the wizard gains an optional prepay step.

*Exit:* on the dev stack a community tops up from the UI, sets a faster
paid cadence, watches the operator produce and claim roots and the
balance fall; a curated instance is proven with no vault; an unfunded,
uncurated instance renders honestly as stale with a clear path to fix
it. All copy reviewed against ground rule 11.

### M5 — Fork e2e + hardening *(prereq: M0–M4)*

Fork mainnet; stand up registry, factory, vault; run the daemon
unattended across multiple epochs with **one real Groth16 leg per
handler**: a curated trust-graph instance, a vault-funded trust-graph
instance, a contributions round, and a signer-sync rotation, all
verified by the canonical SP1 gateway in forked state. Adversarial pass:
front-run the funded instance's claim from a second sender; rotate
`paramsHash` between trigger and submit and confirm the in-flight proof
still lands (M0's pinning) while the next checkpoint binds the new
value; freeze-shaped revert handling; `kill -9` mid-flight in each
journal state; trigger-spam; a stranger's direct
`accumulator.checkpoint()` rejected. Docs: `docs/OPERATOR.md` (run,
configure, alert, recover, self-host), `docs/trust-graph/RUNBOOK.md`
updated so the manual loop is the documented fallback,
`docs/PRODUCTION.md` gains the operator + vault sections, `PROGRAMS.md`
vkeys refreshed.

*Exit:* a fresh session reproduces the scenario from the docs alone;
the multi-epoch run shows zero manual interventions; audit findings
triaged to issues with fixes or accepted-risk notes.

---

## Parallelization map

```
IF ── M0 (journal v3 + pinning + binding) ──┬── M1 (operator-core) ── M2 (daemon) ──┬── M4 (wiring) ──┐
                                            └── M3 (ProvingVault) ∥ ─────────────────┘                 └── M5 (fork e2e)
```

M3 needs only M0's ABI, so the vault and the daemon build in parallel.
M4 is the join. The inter-lane contract is the IF's frozen interfaces.

---

## Decisions (locked)

| Decision | Resolution |
|---|---|
| Scope | Daemon + vault + journal v3, **no hypercerts / lane-2 handler** (Jake 2026-07-27) |
| Free tier | **Curated subsidy only** (Jake 2026-07-27). The hosted operator proves a curated set; everyone else self-proves or funds a vault. This closes the unbounded-liability hole a permissionless factory otherwise creates (an attacker pays ~1 attestation of gas per epoch to make us pay a ~600k-gas submit: ~4-5x leverage). The promise is "every **eligible** instance", and the docs must say that, not "every instance" |
| `EPOCH_FLOOR` | **Bounds creation only, not ongoing cost.** The admin receives `CONSTITUTIONAL_ROLE` in the creating tx (`TrustGraphFactory.sol:317-319`) and `setEpochLength` is constitutional, so any creator can lower their own epoch afterwards. Three intervals are therefore distinct: the factory's creation floor (anti-spam), the operator's subsidy cadence (policy), and the vault's `minPaidIntervalBlocks` (on-chain, the only enforceable one). `INSTANCE_FACTORY.md` §2.2 and `PROOF_SCHEDULER.md` §4.2 both claim the floor bounds hosted cost; both are corrected |
| Bounty theft | **Recipient-in-journal**; commit-reveal superseded and never built |
| Fee vs gas | Fee follows the journal recipient, gas follows `msg.sender`, fee paid first under partial funding, reimbursement **capped and conservative rather than exact** |
| Payout mechanics | **Pull credits**, never push |
| Domain separation | **Journal-level `instanceDomain`**, derived by `submitProof` from `address(this)` + `block.chainid`. Universal, so no program's params codec can forget it. Fixes the live hypercerts hole |
| Params rotation | **Pinned per checkpoint** at `trigger()`; unpinned checkpoints revert. **Verifier deliberately not pinned** — a verifier rotation is the SP1-soundness emergency path and must invalidate in-flight proofs |
| Checkpoint minting | **Bound to the snapshot** (`TrustAccumulatorMirror`'s existing pattern). Today `AttestationAccumulator.checkpoint()` is open to anyone, which breaks the never-prover-chosen-boundary invariant |
| Per-instance config | Zero for factory trust-graph; **explicit manifest** for contributions, signer, and any non-factory instance. Stated plainly rather than implied away |
| Vault authority | `CONSTITUTIONAL_ROLE`, and accounts **bind to a snapshot at first deposit** so a registry update cannot redirect funds |
| Catalog failures | **Per-instance skip**, never a global abort |
| Finality | Proofs wait for confirmed trigger/checkpoint transactions; block hashes tracked, `AwaitFinality` in the decision model |
| Crash idempotency | Intent + nonce fsynced before the request, id appended after, `RequestOutcomeUnknown` for the ambiguous window — never auto-retried |
| Deploy target | **Local anvil + mainnet fork.** Mainnet custody/funding/on-call is a later GOAL |
| Vault tokens | ETH + USDC, claim draws ETH first, USDC valued at $1 in v1 |
| Operator role | **Requester, not prover**, on the Succinct auction network |
| SLA | Best effort + redundancy; no on-chain proving obligation |
| Home chain | Ethereum mainnet ⇒ submit gas dominates ⇒ basefee gate |
| Trigger-as-a-service | Not built (§4.4) |

Still open, deliberately not blocking: hosted-operator custody (KMS vs
local keys) and PROVE float management; how a community *gets* curated
(app-side flag, not a registry field); a paid-priority
`requestProof{value}` lane; moving FEE_SETTER behind the operational
timelock; Lane D freeze; lane-2 / hypercerts proving; multi-chain.

---

## Appendix — lane 2, recorded for when it comes back

Out of scope here, but the sequencing was worked out and the version in
`PROOF_SCHEDULER.md` §2.3/§5 is self-contradictory (it says anchor →
trigger → fetch, and also that only already-captured heads may be
anchored). The correct order is **fetch and verify → durably pin →
anchor the captured heads → await finality → trigger → build from the
pinned bundle → prove**. Anchoring first and failing the fetch makes the
epoch unprovable. Two further traps: `EmptyLaneAccumulator.leafCount()`
is always zero, so lane-2 readiness must compare anchor commitments, not
leaf counts; and the vault's leafCount-derived size band misprices a
lane-2-only program for the same reason, which is why the band function
is per-program with an unsupported default.

---

## Execution notes — model allocation

**Main session:** journal v3, checkpoint pinning, and the accumulator
binding (M0 — a wrong encoding poisons four legs, and the two contract
changes touch the invariant surface); the vault's payout arithmetic,
authority model, and front-run argument (M3); milestone acceptance;
DEVIATIONS calls.

**Subagent lanes:** M1's test battery against the fake chain and the
sp1-sdk idempotency spike; M2's handler plumbing and ops surface; M3's
Foundry battery; M4's indexer tables and frontend panels; docs. Frame
adversarial prompts as property refutation ("refute: some call sequence
pays a bounty twice for one checkpoint", "refute: a registry update can
redirect a funded instance's balance"), not exploit development.

---

## Bug capture

Every counterexample → minimal committed repro → GitHub issue (design §,
trace, affected surface) → failing test stays expected-fail until the
fix flips it. Findings that contradict `PROOF_SCHEDULER.md` are
DEVIATIONS events. **Two issues get filed before this build starts,
because they are live in shipped code rather than plan defects:** the
hypercerts params schema carries no instance-unique field (cross-instance
proof reuse), and `AttestationAccumulator.checkpoint()` is permissionless
(prover-chosen epoch boundaries). M0 fixes both.

---

## Done when

1. **All milestones exited** with stated criteria; the zk-parity job
   (Rust / guest / Solidity / TS) green on journal v3.
2. **Nobody runs the runbook:** across a multi-epoch fork run, every
   root on all three programs was produced by the daemon with zero
   manual steps, and the manual loop survives only as documented
   fallback.
3. **Quiet is free, spam is bounded:** an instance with no new edges
   costs nothing; a `trigger()` spam run costs the spammer gas and the
   operator nothing; a stranger cannot mint a checkpoint at all.
4. **Preventable spend is prevented, unpreventable spend is budgeted:**
   every hold and skip branch is exercised, the loss budget halts an
   instance rather than bleeding, and a params rotation mid-flight no
   longer wastes a proof at all.
5. **The bounty cannot be stolen:** the front-run simulation credits the
   original prover their fee at unit (M3) and fork (M5) level, and the
   copier receives only capped gas.
6. **A community can pay for its own scores:** top up from the UI, get a
   faster paid cadence, watch an honest burn rate, stop paying by
   letting it run out — with `minPaidInterval` and `maxPerRoot` meaning
   a stranger can never drain the tank faster than the community chose.
7. **Self-proving still works:** a single-instance operator run with a
   community's own keys produces and lands the same root, documented in
   `docs/OPERATOR.md`. The hosted service sells convenience, not access,
   and the curated subsidy is described as what it is.
