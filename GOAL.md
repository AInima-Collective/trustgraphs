# GOAL — Close the Pre-Mainnet Audit

> **STATUS (2026-08-13): LAUNCH GATE MET for the trust-graph path.** All launch-blocking and
> recommended milestones are landed with regression tests, on `audit-fixes-2026-08-13`:
>
> - **A1 · M-3** — signer journal binds `instanceDomain` (signer vkey rotates) — `3e7b98c`
> - **A2 · H-5 + A3 · M-12** — anchored-count head-replay fix (registry ingress sig +
>   count-ranked rule Φ) + CAR bounds-checks (trust-graph vkey rotates once) — `682a595`
> - **B1–B5 · H-3, M-6, M-9, M-10, M-11** — operator hot-wallet hardening — `6655834`
> - **C1–C4 · M-4, M-5, M-8, M-7** — governance delay + delegatecall allowlist, abstain
>   out of quorum, exec() honored, fee-hike timelock + funder guards — `446baf0`
> - **D1 · H-4** — ceiling documented (production.md) + 80% operator alert — `ddd63f4`
> - **F1** — CI secret-scan gate — `ddd63f4`; **F2** — oracle staleness default (this commit)
> - **E1** (hypercerts content-addressing) was already banked in `ce9a9d8`.
>
> Suites: forge 488 → **503** green; Rust workspace 33 suites green; operator 21 green;
> golden vectors regenerated for both rotated programs; TS golden PASS.
>
> **Still open, by design:** **E2** (hypercerts suppression/DA — needs Jake's design decision;
> hypercerts must not ship with value until it lands), **D2** (price/stake ingress — required
> only before an open-to-adversary set), **F3** (low/info backlog, non-blocking). Deploy-time:
> each program's vkey rotation runbook is written into its runbook; rotations happen at the
> mainnet deploy, one per program.

Take Trustgraphs from "audited, cheap cluster fixed" to **safe to run the
first Ethereum-mainnet experiments with real value**, and clear the path
for hypercerts to follow later.

> Land every launch-blocking finding from the 2026-08-13 pre-mainnet audit,
> with a regression test per fix and a single planned vkey rotation per
> program, so the trust-graph score/governance/reward path and signer-sync
> can hold value on chain 1 — and content-address the hypercerts badge
> definitions so that program is one design decision away from shipping too.

This file is the execution spec. The finding-level source of truth is
[`research/premainnet-audit-2026-08-13-outstanding.md`](research/premainnet-audit-2026-08-13-outstanding.md)
(ranked outstanding issues) and the fixes already banked in commit
`a6f89c5` (M-1, M-2, H-1, H-2). Every ID below (`M-3`, `H-3`, `C-1`, …)
resolves to that report.

---

## Ground rules

1. **One vkey rotation per program, batched.** A guest change rotates that
   program's `SP1_PROGRAM_VKEY`. Group all guest edits for a program into a
   single rotation with regenerated golden vectors — never dribble them.
   The three programs (`trust-graph`, `signer-sync`, `hypercerts`) rotate
   independently; only touch the ones whose guest actually changed.
2. **Parity discipline is non-negotiable.** Every byte encoding lives in
   one core crate and is proven byte-identical across native Rust, the SP1
   guest, the Solidity golden test, and the frontend TS port before it is
   used. An encoding or journal change without regenerated vectors in the
   same commit is a failure. New journal words must be reproduced
   byte-for-byte in guest + host encoder + Solidity + TS.
3. **A regression test ships with every fix.** No finding is "closed"
   without a test that fails on the old code and passes on the new. The
   suite was 483 → 488 after `a6f89c5`; it only goes up.
4. **Fail closed, degrade per node.** Guest-side fixes (C-1, H-5, M-12)
   trip a deterministic skip or reject-input, never a panic or a silent
   include. A malformed or non-content-addressed input is skipped and
   recorded, it does not abort the epoch.
5. **No new CVL/FV surface here.** Fuzz + unit + golden + e2e per fix. FV
   stays where it is; these are targeted hardening changes, not a redesign.

---

## Decision gate — RESOLVED (2026-08-13): lane 2 IS enabled

Lane 2 (off-chain attestations via `AnchorRegistry` / envelope-0) is
enabled in the first mainnet experiments. Consequences, now baked into the
plan below:

- **`H-5` (head-replay) and `M-12` (CAR panic) are LAUNCH-BLOCKING** and
  ride the trust-graph vkey rotation in Milestone A (A2, A3).
- The lane-2 mediums in the outstanding report — head-age / anchor-order
  handling — must be reviewed alongside A2.

No open scope questions remain.

---

## Milestones

Sequenced by lead time and blast radius. A and B are the launch gate; C–D
land before real value moves; E clears hypercerts; F is opportunistic.

### Milestone A — Guest / vkey batch (LAUNCH-BLOCKING, longest lead)

The only changes that touch proven statements and force a redeploy. Do
first because the rotation runbook is the critical path.

- **A1 · M-3 — Signer-sync instance/chain binding.** Add
  `keccak256(abi.encode(address(this), block.chainid))` as a journal word
  in `SignerSyncZkModule.submitSignerProof`, reproduced byte-for-byte in
  the signer guest and `signer_journal_encoded`. Rotate the **signer-sync**
  vkey.
  - Files: `src/contracts/zodiac/SignerSyncZkModule.sol:230-236`,
    `packages/pagerank-core/src/encode.rs:145-153`, `zk/program/src/signer.rs`,
    signer golden vectors + frontend TS port.
  - Done when: two same-params signer modules at mirrored addresses / cross
    chain reject each other's owner-rotation proof (new test); signer golden
    vectors regenerated and green across guest/host/Solidity/TS; vkey
    rotation step written into the deploy runbook.
- **A2 · H-5 — Head-signature replay** *(blocking — lane 2 is on)*.
  Bind a strictly increasing per-node nonce/epoch into the signed head;
  reject any anchored head whose signed count is below the max already
  anchored for that node (or track latest-accepted-head per node in
  `AnchorRegistry`). Rotate the **trust-graph** vkey (envelope change).
  - Files: `packages/envelopes/src/eas_offchain.rs:117-124,186-209`,
    `packages/pagerank-core/src/lane2.rs:73-118`, `AnchorRegistry.sol:91-97`.
  - Done when: re-anchoring a stale pre-revocation head is rejected in-guest
    (revoked edges stay dead) with a regression test; golden vectors green.
- **A3 · M-12 — CAR parse panic** *(blocking — lane 2 is on)*. Bounds-
  check every LEB128 length before slicing in `Car::parse`; fail closed
  (skip the repo) instead of panicking. Rides A2's rotation.
  - Files: `packages/envelopes/src/carset.rs:44,69,77-79`.
  - Done when: a fuzz/unit case with a truncated CAR skips the node and the
    epoch still proves.

> **Batching:** A1 rotates signer-sync only. A2+A3 rotate trust-graph only.
> C-1 (Milestone E) rotates hypercerts only. Sequence the deploy runbook so
> each program is redeployed once.

### Milestone B — Operator hardening (LAUNCH-BLOCKING core + recommended)

Pure `zk/operator` Rust, no vkey. Protects the operator hot wallet the
moment it runs on mainnet.

- **B1 · H-3 — Gas circuit breaker (blocking).** `eth_estimateGas` and
  refuse above a cap; pass the intended `gas` into the pre-send simulation
  so an under-gassed revert is caught before broadcast; count
  `gas_used × price` into the `LossBudget` spend window; add a
  3-strikes-per-`WorkKey` human hold. Files: `run.rs:588-596`, `tx.rs:41-74`,
  `chain.rs:172-178`.
  - Done when: a persistently reverting submit trips the breaker instead of
    draining the wallet (test against a revert-forced submit); on-chain gas
    appears in the loss budget.
- **B2 · M-6 — Inverted `minPayoutUsd` guard.** Fix the `.min(1)` so an
  underpayment is rejected, not accepted. `run.rs:569-570`.
- **B3 · M-9 — Reorg detection + confirmations.** Compare anchor hash to
  the prior head (not itself); wire the unused `guard`/`Dependencies`; only
  journal `Settled{Landed}` after N confirmations so a reorged-out submit
  self-heals. `run.rs:344-359,593-597`.
- **B4 · M-10 — Daemon panic on short `eth_call`.** Treat a short/empty
  `0x` return as a transient provider error, not a process-killing panic.
  `chain.rs:520-531`.
- **B5 · M-11 — Stuck-tx replacement.** Honor the `replacement_after_s`
  knob: replace a tx stranded under the basefee gate instead of wedging the
  nonce. `tx.rs:79-104`.

### Milestone C — Governance + distributor contracts (recommended)

Solidity only, no vkey, fully testable now.

- **C1 · M-4 — Execution timelock + DelegateCall guard.** Add an execution
  delay (Zodiac Delay / `TimelockController`) and forbid `DelegateCall`
  unless the target is allowlisted. `MerkleGovModule:257-271`.
- **C2 · M-5 — Abstain excluded from quorum.** Exclude abstain from the
  quorum sum (or require a minimum absolute "for"). `:315-318`.
- **C3 · M-8 — Honor `exec()` return.** Stop discarding the `exec()` bool;
  a failed action must not mark the proposal executed-forever. `:263-268`.
- **C4 · M-7 — Distributor fee front-run.** Add funder-supplied
  `maxFeeAmount` / `expectedFeeRecipient` and/or a delay on fee changes so
  the owner cannot `setFeePercentage(100%)` in front of `distribute()`.
  `MerkleFundDistributor:342,358,375-389`.
  - Done when: each has a regression test proving the exploit is closed.

### Milestone D — Accumulator bloat ceiling (H-4)

Permissionless ingress grows `leafCount`/`anchorCount` irreversibly; past
`MAX_PRICED_INPUTS = 200,000` the root is unprovable and unpaid, and the
chained hash cannot be trimmed.

- **D1 (blocking-minimum):** document the ceiling and its attacker cost in
  the launch runbook; add monitoring/alerting on `leafCount`+`anchorCount`
  approaching the band-0 cliff. Sufficient only if the first experiments
  are closed-set / allowlisted.
- **D2 (before open-to-adversary):** price/stake attestation ingress for
  high-value instances (the payable resolver exists); add a low-friction
  constitutional `setAccumulator` re-seed so the ceiling is recoverable
  without losing all vouch history.
- Files: `eas/AttestationAccumulator.sol:93-98`, `EASIndexerResolver.sol:86/107`,
  `AnchorRegistry.sol:91-97`, `ProvingVault.sol:456-463`.

### Milestone E — Hypercerts C-1 (unblock the deferred program)

`strongref_targets` (badge definitions) are prover-supplied and used to
gate `allowedIssuers`, so a prover can add/forge/suppress badge-award edges
and move `output_root`. Two independent halves:

- **E1 · Content-addressing (implementable now, no design decision).**
  Verify in-guest that each `strongref_targets` entry's bytes hash to the
  multihash embedded in its CID key; drop (treat as absent) any entry that
  fails. This kills *forgery* — the prover can no longer invent a permissive
  `allowedIssuers` list for a CID the author signed.
  - Files: `packages/hypercerts-core/src/semantics.rs:216-223`, a CID
    parse+verify helper (base32-lower decode + multihash prefix +
    `zk-core::cid::sha256`), `compute.rs:256`.
  - Rotates the **hypercerts** vkey; regenerate hypercerts golden vectors
    (valid vectors are unaffected — the check only rejects malicious input).
  - Done when: a test feeding `(cid → mismatched bytes)` gets the entry
    dropped and the forged edge does not appear; golden vectors green.
- **E2 · Suppression / data-availability (needs Jake's decision).**
  Content-addressing does not stop a prover *omitting* a real restrictive
  definition (absence = open-vocabulary default). Closing this needs a
  commitment to which CIDs were resolvable — e.g. require badge definitions
  to be anchored so their presence is provable, or commit the resolved-CID
  set into the journal for challenge. **Open design question — do not
  implement E2 until the approach is chosen.**
- Gate: hypercerts does **not** ship to mainnet-with-value until both E1
  and E2 are closed.

### Milestone F — Low/Info backlog + hygiene (opportunistic)

- **F1 · CI secret-scan gate** (the H-2 follow-through) so a bespoke
  private key cannot re-enter the tree — this is the third occurrence, do
  it early even though it is "Info".
- **F2 · Oracle tightening (`ProvingVault`):** feed staleness default 24h →
  mainnet ~1h heartbeat (ORCL-1); check price vs aggregator min/maxAnswer
  (ORCL-2). Cheap and mainnet-relevant.
- **F3 · The rest** of the Low/Info clusters (GOV-4, MATH-5/6/7/8/9,
  ERC20-2/3/4/6, AC-3/4/6, DOS-3, ZKS-3/4, ZKO-8/9, ZKG-3/4/5/6, ORCL-3,
  SIG-3) as time allows — grouped in the outstanding report, none blocking.

---

## Launch gate (the sign-off)

Mainnet-with-value for the trust-graph path is cleared when:

1. Milestone A complete (M-3, H-5, and M-12 all landed — lane 2 is on),
   with all guest programs' golden vectors green and vkeys rotated in the
   deploy runbook.
2. Milestone B complete (operator cannot drain its hot wallet).
3. Milestone C complete (no governance/distributor value-capture path).
4. H-4 at least documented + monitored (D1); D2 done if the set is open.
5. Full forge suite + Rust workspace green; parity vectors regenerated for
   every rotated program.

Hypercerts-with-value additionally requires Milestone E (both halves).

## Sequencing summary

1. **A1** (signer vkey) — longest lead, start immediately.
2. **A2/A3** (trust-graph vkey: H-5 head nonce + M-12 CAR bounds) — lane 2
   is on, so these batch into the same trust-graph rotation.
3. **B1** — protect the hot wallet before the operator touches mainnet.
4. **C1–C4**, then **B2–B5**.
5. **D1** (document + monitor) always; **D2** if open to adversaries.
6. **E1** done (banks the tractable half of the Critical); **E2** after
   Jake picks the DA approach.
7. **F1** early; **F2/F3** opportunistically.
