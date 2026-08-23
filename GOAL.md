# GOAL: close the audit before the door closes

> Nothing is deployed to a public chain yet, so every fix in this program is free
> today and a migration tomorrow. Every verification key is still "none yet", so
> the guest changes that would normally be the expensive part of a remediation
> are, right now, the cheap part. The testnet deploy is the door closing. This
> program is the list of things that have to be true before it does.

**Status:** opened 2026-08-23, the day the pre-testnet audit closed. Code surface
verified at `55cb254`. Baseline: `forge test` 738 passed / 0 failed across 54
suites at audit start (plus 172 audit PoC tests, of which 5 fail deliberately and
are dispositioned in M0). `cargo test --workspace` 343 tests green.

**Theme:** parallelism is the point. The audit produced 19 confirmed findings
across 6 HIGH, 8 MEDIUM and 5 LOW, and a dependency pass over all of them found
that **almost none of them are ordered**. Thirteen lanes can run at once. Exactly
one lane is internally serialized, and one pair has to merge. Everything else is
independent, and the plan is built to keep it that way.

**Evidence record:**
[research/audits/2026-08-23-pre-testnet.md](research/audits/2026-08-23-pre-testnet.md) —
the audit: mechanism, consequence and smallest fix per finding, plus the nine
claims raised and rejected. The proof-of-concept tests behind it are committed at
`90765d6` under `contracts/test/audit-poc/`, one executable regression per
finding.

Convention: this file is deleted when the program closes and archived to
`research/plans/`, as `research/plans/scoring-engine.md` was.

---

## Why this program exists, and why now

1. **The number the last audit's risk acceptance rested on is wrong by 58x.**
   `InputCapacity.MAX_TOTAL_INPUTS` is 200,000; the operator refuses at ~3,467.
   The 80%-of-200,000 alert fires 46x after the cliff, so the monitoring that
   made "accept H-4" defensible cannot fire. That decision has to be re-taken
   with the real number, and it is the one finding that changes what the system
   can do at all.

2. **The newest code is where the HIGH findings landed, and it is the least
   tested.** 25 of 54 in-scope contracts have no dedicated test file, and they
   cluster in `factory/`, `composition/` and `params/` — the network-creation
   program that shipped after the last audit. `forge coverage` has never produced
   a number for this protocol; it hits Yul stack-too-deep both ways.

3. **Two instance-creation paths can be griefed by a stranger for a rounding
   error of the victim's cost.** A governed creation can be blocked at 60.9:1 gas
   asymmetry, and a script-deployed resolver can be made permanently unprovable
   for 24,034 gas. Both are permissionless, repeatable, and land on the flagship
   flow.

4. **Rotating verification keys is free exactly once more.** Every vkey is
   documented as "none yet" (`docs/verify/addresses-and-vkeys.md:29-36`). The
   guest fixes in M2 rotate seven programs. Doing that after a public deploy
   means rebuilding every ELF, regenerating every key and vector, and migrating
   live instances.

---

## Decisions

**D1 — trust-compose does not ride the first testnet deploy.** The audit's main
structural result is that compose instances have a constant `leafCount`, no
anchor registry, and an `acc()` that moves every block, and those three facts
together defeat two guards that hold correctly on every other program. H-6, M-3,
M-6 and L-4 are all compose-path. Compose ships when its lanes land and it has
test coverage, not before. *Ruled here; reversible only with evidence.*

**D2 — one guest batch, one rotation, seven programs.** M-1b (binding the anchor
head signature to a domain) changes a preimage the guest verifies at
`crates/envelopes/src/eas_offchain.rs:117-122`, reached from both `main.rs` and
`signer.rs`, so it rotates trust-graph, signer-sync, hypercerts, contributions,
nostr-workspace, atproto-conformance and trustgraph-program-v2. H-5b (the
contributions wrapping subtraction) rotates contributions alone. **They ride
together or the rotation happens twice.** *Ruled here.*

**D3 — H-2 ships fail-closed-only.** The audit's fix has two halves: fail closed
before `bindSchema`, and an immutable schema admin. The second half edits
`TrustgraphsFactory.sol:357/458`, `WeightedTrustgraphsFactory.sol:148/196` and
`DeployNetwork.s.sol:147/172` — the same lines H-3 needs. The factories already
bind atomically, so fail-closed alone closes the finding, and the collision
disappears. *Ruled here to protect lane independence.*

**D4 — 200,000 stays the protocol ceiling, and the operator's cycle limit does
not move.** The instinct is to make the declared number true by raising the
operator budget until 200,000 fits. That is the wrong direction, because the
ceiling is not a capacity knob, it is the denial-of-service threshold.

Re-read the audit's own arithmetic: 78,191 gas per leaf times 3,467 leaves is
the 271M gas figure. It was never the cost of filling 200,000; it is the cost of
reaching the *real* ceiling. An attacker makes an instance unprovable today for
about 0.0027 ETH. Raise the operator's limit so one proof covers 200,000 and the
attacker pays roughly 58x more, still only ~0.16 ETH, while the operator becomes
willing to attempt a ~330B-cycle proof nobody has ever measured, on inputs the
attacker chose. That moves the defender's worst case far more than the
attacker's cost. **A higher ceiling is a larger commitment to absorb whatever
gets pushed at you.**

So: keep `MAX_TOTAL_INPUTS = 200_000` as the protocol ceiling, which is what
this repo's own principle already asks for ("the protocol stays permissive;
operator policy fails loudly"). Two ceilings differing is correct. Four ceilings
where nobody can name which one binds is the defect. *Ruled here.*

**Open, and now the real question:** ingress admission. The ceiling was never the
defense; pricing or staking who may add inputs is. That is the prior audit's D2,
still open, and lane F does not close it (see Operator ledger).

---

## Delivery plan

**M0 must land first, and it is small.** Everything in M1 is parallel with
everything else in M1. M2 is one lane that is internally serialized. M3 is
independent of all code lanes and can start on day one.

### M0 — Make the tree safe to work in parallel

Two landmines will make thirteen concurrent lanes fight each other, and one CI
gap hides a whole program's parity check.

- [x] `crates/pagerank-core/tests/audit_poc_encoding.rs` wrote a **tracked** file
      (`contracts/test/audit-poc/audit-vectors.json`) on every
      `cargo test -p pagerank-core`, which `task zk:parity` runs. Every lane would
      have dirtied the tree. The write is now opt-in behind `AUDIT_WRITE_VECTORS`.
- [ ] Document the stale-ELF trap in `taskfile/zk.yml:36-38`: `sp1_build` does not
      watch `crates/` path dependencies, so editing a core crate silently reuses a
      stale ELF unless `task zk:build` is run. Every lane touching `crates/` needs
      to know this; M2 depends on it being true.
- [ ] Add `nostr-workspace` to the `zk-parity` matrix
      (`.github/workflows/zk-parity.yml:76-83`). It is the only program not gated,
      and it is where two of the four "missing" golden vectors actually live.
- [ ] Disposition the 5 deliberately-failing PoCs so `forge test` is green on
      `main`: four are harness artifacts (one caused by solc hoisting
      `block.number` across `vm.roll`), one is a preserved refutation. Mark them
      `skip`, or move them under a non-default path, and record why in the file.

**Exit:** `forge test` green on `main`; `cargo test -p pagerank-core` leaves the
tree clean; `task zk:parity` covers all seven programs; the stale-ELF trap is
written down where a lane will hit it.

---

### M1 — Eleven lanes, all at once

Each lane owns its files outright. No two lanes in this milestone edit the same
file, with the one merged exception noted in Lane B. Any lane can land alone.

| Lane | Findings | Owns | vkey |
|---|---|---|---|
| **A** Ingress fail-closed | H-2, L-3 | `eas/resolvers/EASIndexerResolver.sol` | no |
| **B** Distributor | H-3, M-8 | `merkle/MerkleFundDistributor.sol` | no |
| **C** Governed factories | H-4, M-2 | the 3 `Governed*Factory.sol` | no |
| **D** Base-factory ownership | H-3 (owner half) | the 4 base factories | no |
| **E** Proving vault | H-6, L-1 | `vault/ProvingVault.sol` | no |
| **F** Capacity ceiling | H-1 | `operator-core`, `limits/InputCapacity.sol` | no |
| **G** Contributions envelope | H-5a | `ContributionsParamsController.sol` | no |
| **H** Weighted versions | M-5 | `WeightedPriorParamsController.sol` | no |
| **I** Compose pool rule | M-6 | `params/TrustComposeValidator.sol` | no |
| **J** Governance & modules | M-7, M-4 | `zodiac/` | no |
| **K** Composition adapter | M-3 | `composition/CompositionSourceAdapter*.sol` | no |
| **L** Anchor registry, Solidity half | M-1a | `registry/AnchorRegistry.sol` | no |
| **N** Low & docs | L-2, L-5, docs drift | `GraphLineageRegistry`, `TEST.sol`, `docs/` | no |

- [ ] **A — H-2.** `_requireBoundSchema` fails **open** while `boundSchema == 0`, so
      an attacker attests a foreign edge before binding, the honest `bindSchema`
      then succeeds silently, and the poisoned leaf makes the instance permanently
      unprovable for 24,034 gas. Revert all attestations until bound, exactly as
      `ContributionResolver` already does. Per D3, do **not** add the schema-admin
      gate here. Also L-3: `expirationTime` is accepted and never enforced by
      either side, while the frontend renders an "Expired" banner for a status the
      proven score ignores — enforce it or stop displaying it.
- [ ] **B — H-3 + M-8, merged.** These edit the same functions and cannot be split.
      `_distribute` pins `merkleState.root` against the funder's `expectedRoot` but
      copies `totalValue` into `totalMerkleValue` unchecked, and `claim` divides by
      it; a snapshot mirroring the honest root with a shrunken `totalValue` hands
      one leaf 100% of a third party's round. Pin the denominator in the
      funder-guarded overload. Add the per-round spend cap, which also bounds the
      blast radius to one round and stops the over-paid round becoming permanently
      unsweepable through checked underflow. Then M-8: `sweep` is `whenNotPaused`
      too, so a pause across a deadline converts contributor entitlements into a
      funder refund with no exit.
- [ ] **C — H-4 + M-2.** Same three files, different functions, so one lane.
      H-4: `_createBootstrapSafe` derives the CREATE2 nonce from mempool-visible
      calldata with a constant initializer and has no adopt branch, so a squatter
      spends 215,129 gas to destroy 13,097,357 of the victim's. Precompute the
      address; adopt it when it is a Safe on the expected singleton with owners
      exactly `[address(this)]`, threshold 1, no guard or modules; otherwise bump a
      bounded counter. A `try/catch` retry does not work, the gas is already gone.
      M-2: make the signer verifier and vkey immutable on the wrappers, as
      `TrustComposeFactory` already does. Costs 12 call-site updates across 12
      files, 9 of them PoCs.
- [ ] **D — H-3, owner half.** Disjoint from C: the governed wrappers delegate, so
      this is the four *base* factories. Every one deploys the distributor with
      `owner = admin`, documented as "0 means msg.sender", a creator EOA
      (`TrustgraphsFactory.sol:458` and siblings), and `DeployNetwork.s.sol:173`
      leaves the deployer EOA. The prior audit's "renounced to timelocks" is true
      of `MerkleSnapshot` and false here. Decide the intended holder and wire it.
- [ ] **E — H-6 + L-1.** `claim` passes `snapshot.getLatestState().root` into a
      statement key whose counts come from `checkpointId`. Key the statement on the
      checkpoint's own `acc`, and have `claim` read the checkpoint's own root via
      `getAcceptedCheckpoint`. Make `_settle` `_skip` rather than revert, so a
      payment refusal can never discard a verified root. **Hazard:** this flips 9
      PoCs at assert time with no compiler error pointing at them; they land in the
      same commit. L-1: assert the stablecoin's decimals as the constructor already
      does for the feed.
- [ ] **F — H-1.** Per D4 this lane makes the system stop lying about its own
      edge; it does not raise the edge. Four ceilings exist and only the last one
      binds: `MAX_TOTAL_INPUTS = 200_000` (protocol), `CapabilityProfile::default()`
      capping `max_unique_nodes` at 10,000 which is ~5,000 leaves and is documented
      nowhere, `max_raw_records` at 50,000, and `OPERATOR_CYCLE_LIMIT = 8e9` which
      refuses at **3,467**. Publish all four and which binds first.
      Make `cycle_limit` and `CapabilityProfile` configurable — neither is today —
      so a better-resourced prover can raise them; policy is cheap to change and a
      pinned vkey is not. Delete `ProvingVault`'s claim that the operator derives
      its limit from `MAX_PRICED_INPUTS`, which `work.rs:202` contradicts outright.
      Move the alert onto the operator's **own** limit so it fires before the cliff
      instead of 46x after it. Set the shipped default from the measured envelope
      in `docs/build/trust-graph/runbook.md:443` rather than from either number
      standing today: 8e9 was picked to look round and 3,467 is where it lands by
      accident, and neither was chosen.
      **Constraint:** `MAX_TOTAL_INPUTS` is pinned cross-language by hand-written
      asserts on both sides (`ProvingVault.t.sol:733` and
      `operator-core/policy.rs:104`), so the Solidity and Rust edits are one commit.
      No vkey: `operator-core/src/work.rs:202` says these ceilings are asserted by
      no guest and pinned in no vkey, and the constant appears in neither the
      17-word `params_hash` nor the 12-word journal.
- [ ] **G — H-5a.** `updateParams` validates only the three schema UIDs, and
      `ContributionsParamsValidator.validateFinal` exists with **zero production
      call sites**. Call it. One line. The guest half is M2.
- [ ] **H — M-5.** Add the `latestVersion` high-water mark that
      `TrustComposeParamsController` already has. **Hazard:** the existing invariant
      suite asserts the bug — `WeightedPriorLifecycleInvariant.t.sol:163` requires
      `pending.version == controller.version() + 1` — so the fix and
      `WeightedPriorParamsController.t.sol:204-212` and
      `QuillStateInv_WeightedVersionReuse.t.sol:119` move in one commit.
- [ ] **I — M-6.** Reject an output pool below the source count; the compose guest
      already does (`composition-core/src/compute.rs:197-198`), so this is
      Solidity-only and needs no rotation. Also close the variant the audit missed:
      `sourceCount` is rotatable while `outputPool` is not, so a policy rotation can
      brick a live instance.
- [ ] **J — M-7 + M-4.** M-7: `Passed` is terminal, permanent and permissionlessly
      executable, so a sleeper proposal executes after a full root turnover; add a
      snapshotted execution window and an `Expired` state. **Hazard:** `Proposal` has
      14 fields and 10 tuple destructures in `unit/MerkleGovModule.t.sol`; adding a
      field breaks all 10. M-4: `SignerSyncZkModule.setAccumulator` has no rotation
      lock and never resets `lastAppliedCheckpoint`, unlike `MerkleSnapshot`.
- [ ] **K — M-3.** Pin the registry immutably on the adapter factory, or reject a
      foreign one in `_validatePolicy`. Today every provenance pin is read from a
      registry the caller supplies, and one shared adapter factory serves the
      platform, so `isAdapter` is a global signal over forgeable input.
- [ ] **L — M-1a, Solidity-only.** Split deliberately from M-1b so it needs no
      rotation: add a range check on `count` and a de-registration or admin reset.
      Today `count = type(uint64).max` is terminal, with no reset, no
      de-registration and no re-`register()`, and the count-monotonicity added by
      the last audit is what made a bogus high head permanently outrank honest ones.
- [ ] **N — L-2, L-5, docs.** L-2: `MAX_REFERRAL_SUBJECTS` is documented as bounding
      the active set and implemented over the lifetime set. L-5: `TEST.sol` builds
      `ERC20Permit("MyToken")` against `ERC20("TEST","TEST")`, so every
      wallet-produced permit signature is rejected. Docs: three files tell three
      different chain stories, `docs/learn/limits.md` never mentions composition,
      and `docs/README.md:57` is a live 404.

**Exit:** every lane green independently; `forge test` green with all lanes
merged; no lane needed a file another lane owned; the compose lanes (E, I, K) are
explicitly marked as not shipping to testnet per D1.

---

### M2 — One guest batch, one rotation

The only internally serialized lane in the program, and the only one that rotates
keys. It can start on day one and run alongside all of M1; it just cannot be split.

- [ ] **M-1b — bind the head signature.** `AnchorRegistry`'s payload is
      `keccak256(HEAD_DOMAIN_TAG, head, count)`: no `envelopeKind`, no
      `dataCommitment`, no chain id, no verifying contract. One signature replays
      into a second instance and across a chain-id change, and a victim's blind
      32-byte `personal_sign` is a valid head authorization. Copy the sibling:
      `EasOffchainAnchorRegistry` already uses a full EIP-712 struct bound to
      `verifyingContract`, and is the reference implementation.
      The guest verifies the byte-identical preimage
      (`crates/envelopes/src/eas_offchain.rs:117-122`, consumed at `:211-216`), so
      Rust and Solidity move together. **The anchor leaf itself needs no change** —
      `zk-core/src/anchor.rs:17-33` already binds `envelopeKind` and
      `dataCommitment`, matching `AnchorRegistry.sol:213`.
- [ ] **H-5b — the wrapping subtraction.** `contributions-core/src/compute.rs:235`
      wraps `s - beta_fp` in `alloy` U256, flipping the evaluator carve-out from the
      whole pool to three wei with a valid proof and a real payout. The TypeScript
      port does the same subtraction in `bigint` and goes negative, so guest, host
      and display disagree on one `paramsHash`. Fix all three.
- [ ] **Golden vectors.** Add the two genuinely-unpinned fields (non-empty
      `domainSetHash`; a `paramsHash` with `minWeightFp`, `envelope0DomainSeparators`
      and `lane2MaxHeadAge` non-default). The other two the audit listed —
      `envelopeKind != 0` and a multi-entry `skippedDigest` — are **already pinned**
      in `tests/golden/nostr-workspace.json`; they were invisible only because that
      program is missing from the parity matrix, which M0 fixes.
- [ ] Regenerate every affected vector and rotate: `task zk:vectors PROGRAM=<name>`,
      then `task zk:parity` as the gate. Run `task zk:build` first, per M0's
      stale-ELF note.

**Exit:** `task zk:parity` green across all seven programs; one rotation recorded
for trust-graph, signer-sync, hypercerts, contributions, nostr-workspace,
atproto-conformance and trustgraph-program-v2; the audit's cross-language parity
check still passes on the four fields it verified.

---

### M3 — The deploy path that does not exist yet

Independent of every code lane. Can start immediately. This is not an audit
finding; it is the prerequisite the audit kept running into.

- [ ] Add a real chain target. `contracts/deploy/env.ts` knows only `dev` (31337)
      and `prod` (Optimism 10); `grep -rn 11155111 contracts/` returns nothing.
      Separate deployment *stage* from chain *target* and chain *profile*, per
      `docs/build/sepolia.md`.
- [ ] Produce a sanitized `deployments/sepolia.json` release manifest as the
      interface between deploy, indexer, operator and frontend. Do not use
      `.docker/deployment_summary.json`: it is machine-local, git-ignored, and
      carries `rpc_url`, which may hold a provider credential.
- [ ] Remove the Anvil default key from `Common.s.sol:8-9`, which backs all 29
      deploy scripts, and add a chain-id assert before every broadcast.
- [ ] Reconcile the three chain stories in `production.md`, `sepolia.md` and
      `addresses-and-vkeys.md`.

**Exit:** a Sepolia deploy is reproducible from the manifest by someone who did
not write it; no script can broadcast to the wrong chain or with a default key.

---

### M4 — Coverage where the findings actually were

- [ ] Dedicated tests for the ten untested contracts that matter, in the order the
      audit found defects in them: `TrustComposeParamsController` (307 LOC),
      `CompositionSourceAccumulator` (288), `TrustComposeFactory` (263),
      `CompositionSourceAdapter` (232), `InstanceDeployers` (201), both params
      validators, `AttestationAccumulator`, `TrustgraphsParamsController`, and the
      five codecs. 25 of 54 contracts have none today.
- [ ] Static analysis in CI: there is none. Add it, un-comment clippy in
      `rust.yml`, and fix the 6 `forge fmt --check` failures, all in post-audit code.
- [ ] Get a coverage number, or record why it is impossible. `--ir-minimum` hits
      Yul stack-too-deep at `TrustgraphsParamsController.sol:17`, plain at
      `MerkleSnapshot.sol:473`.
- [ ] Move `RoleSeparatedTimelockController` out of
      `contracts/script/DeployTimelocks.s.sol`. It is production governance living
      outside `src` and outside every `src`-scoped tool.

**Exit:** no contract carrying a HIGH or MEDIUM fix lacks a dedicated test file;
CI runs static analysis; the coverage question is answered either way.

---

## Release compatibility matrix

| | Scores change | Params ABI / hash | Guest / vkey | Solidity redeploy | Browser / indexer |
|---|---|---|---|---|---|
| **M0** | no | no | no | no | no |
| **M1** | no | no | no | yes, most instances | ABIs regenerate |
| **M2** | no | yes | **yes, 7 programs** | `AnchorRegistry` | yes, both |
| **M3** | no | no | no | n/a (first deploy) | config only |
| **M4** | no | no | no | no | no |

`packages/frontend/lib/contract-abis.ts` is tracked and wagmi-generated, and
nearly every lane touches it. Regenerate it per lane; never resolve it as a merge
conflict.

---

## Release gates

### Testnet gate (Sepolia)

**M0 + M1 lanes A, B, C, D, F, G, H, J, L, N + M2 + M3.** Trust-graph only.

Compose lanes (E, I, K) are explicitly *not* in the gate, per D1. The SP1 6.3.1
verifier-route check is a hard blocker inside M3 and is an operator action: if
that toolchain has no supported route, the bump rebuilds every ELF and
regenerates every key and vector, and it must ride with M2 rather than after it.

### Compose gate

**M1 lanes E, I, K + M4 coverage for `composition/` and `TrustComposeFactory`.**
Compose ships when the code that only it exercises has tests, not before.

### Value gate (real money on the line)

**Lane D resolved to a non-EOA holder, and lane B merged.** A distributor whose
owner is a creator EOA and whose denominator is unpinned should not hold other
people's funds.

---

## Operator actions ledger (Jake)

1. **The SP1 6.3.1 verifier-route check** against Succinct's supported-version
   data. Not answerable from the repo, and it decides whether a toolchain bump
   rides with M2. Carried over from the last program, still open, now blocking.
2. **Ingress admission — the decision H-1 actually surfaces.** Per D4 the ceiling
   is ruled and lane F is scoped, but lane F only makes the edge honest. It does
   not stop an attacker reaching that edge for ~0.0027 ETH. Pricing or staking
   who may add inputs is what closes it, and that is a product decision about who
   a network is open to. The prior audit's "accept with monitoring" needs
   re-taking rather than re-affirming, because the monitoring it relied on fires
   46x late.
   *Related and unmeasured:* nobody has proving wall time, peak memory or cost at
   any scale. The 150-330B cycle figure for 200,000 inputs is the shipped cost
   model run 300x past its largest validated point (V=400, 539M measured cycles).
   Treat it as an order of magnitude. If 200,000 is ever to be a real
   single-proof target, that measurement is the prerequisite, and it likely needs
   chunking or recursion rather than a bigger constant.
3. **Who owns a minted instance's distributor (lane D).** Creator EOA, instance
   Safe, or timelock. This is a product decision about what a network operator is
   trusted with, not a code decision.
4. **Whether the audit PoCs stay in the tree.** They are committed at `90765d6`
   and are per-finding regressions; M0 dispositions the 5 failing ones either way.
5. **Nothing is pushed.** `main` is 3 commits ahead of `origin/main` and
   publishing remains an explicit operator action.

---

## Out of scope (filed, not forgotten)

- **The nine rejected claims.** Recorded in the audit report with the reason each
  failed. Re-raising one needs new evidence, not a re-reading.
- **M-1's soundness half.** The head signature under-binds, but the guest
  re-verifies, so soundness holds and only availability is at risk. M-1a and M-1b
  close the availability half; no soundness work is owed.
- **Compose repetition as a design.** L-4 (`NoNewInputs` unreachable on compose)
  is deliberate per `docs/build/composition/architecture.md`. The bug was that the
  vault was never told, which lane E closes.
- **`PayableEASIndexerResolver`.** Deployed nowhere, no accumulator, accounting
  proven exact. Leave it or delete it; do not audit it again.

---

## Program log

**2026-08-23 — D4 ruled.** "Let's make it 200,000" was raised and resolved
against, on the DoS-economics argument recorded in D4: raising the operator's
cycle limit moves the defender's worst case far more than the attacker's cost.
200,000 stays as the protocol ceiling, the operator limit stays put and becomes
configurable and honest, and the live question moves to ingress admission. The
extrapolated cost of a 200,000-input proof (150-330B cycles) is recorded in the
operator ledger as an order of magnitude, not a measurement.

**2026-08-23 — opened.** Written directly from the pre-testnet audit
(`f8e434e`) and a dependency pass over all 19 confirmed findings. The dependency
pass corrected three assumptions in the audit report itself, and those
corrections are load-bearing for this plan:

- The report treats M-1 as a local Solidity fix. It is the **largest vkey batch
  in the program**: the guest verifies that signature over a byte-identical
  preimage, so binding it rotates seven programs. Split into M-1a and M-1b.
- The report says "add the four golden vectors". Two of the four are **already
  pinned** in `tests/golden/nostr-workspace.json`; they only look missing because
  nostr-workspace is absent from the parity matrix.
- The report says the PoC evidence is untracked. It was committed at `90765d6`
  and is now tracked, which is why M0 has to disposition the 5 failing tests
  rather than leave them.

The report will be amended with these three corrections rather than silently
left wrong.
