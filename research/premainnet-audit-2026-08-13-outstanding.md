# Trustgraphs — Pre-Mainnet Audit: Outstanding Issues

> **REMEDIATION STATUS (2026-08-13, `audit-fixes-2026-08-13` branch):** every launch-blocking
> and strongly-recommended finding below is FIXED with a regression test. M-3 → `3e7b98c`
> (signer vkey rotation). H-5 + M-12 → `682a595` (trust-graph vkey rotation; `AnchorRegistry`
> gains count-bound, owner-co-signed ingress). H-3, M-6, M-9, M-10, M-11 → `6655834`.
> M-4, M-5, M-7, M-8 → `446baf0`. H-4 → documented + 80% operator alert (D1) in `ddd63f4`
> (D2 — ingress pricing — still required before an open-to-adversary set). C-1's tractable
> half (content-addressing, E1) was banked in `ce9a9d8`; the suppression/DA half (E2) awaits a
> design decision and gates hypercerts-with-value. Of the Low/Info backlog, the CI secret-scan
> gate (H-2 follow-through) and ORCL-1 (staleness default) are done; the rest is tracked in
> `GOAL.md` Milestone F3. Suite: 488 → 503 forge tests green.

**Date:** 2026-08-13
**Scope of this report:** what remains after the fix commit `a6f89c5`, ranked by whether it blocks the initial Ethereum-mainnet experiments.
**Launch scope (confirmed with Jake):** the trust-graph score/governance/reward path **and** signer-sync (Safe owner rotation) go to mainnet. Hypercerts does **not** — its Critical is deferred. Whether **lane 2** (off-chain attestations via `AnchorRegistry` / envelope-0) is enabled in the first experiments is an **open question** that changes the status of two findings (flagged inline).

Method recap: 11 parallel domain reviewers over the contracts + ZK stack (guests, prover, operator, core crates), every finding re-verified against code by the lead. Baseline before and after fixes: full forge suite green (483 → **488** with the new regression tests).

---

## Already fixed in `a6f89c5` (for reference)

| ID | Title | Fix |
|----|-------|-----|
| M-1 | Quorum read live, not snapshotted | `quorumFraction` snapshotted per proposal; `state()` uses it |
| M-2 | Reverting/`totalValue==0` hook bricks `submitProof` | try/catch + 500k stipend + `HookFailed`; gov hook tolerates zero |
| H-1 | Fee-on-transfer distributor insolvency | book measured balance delta; fee on received; skip zero-fee transfer (also closes ERC20-5) |
| H-2 | Committed non-anvil private key | fallback swapped to anvil key #0 |

---

## LAUNCH-BLOCKING — fix before mainnet-with-value

### M-3 — Signer-sync proof journal omits instance/chain binding  *(now blocking: signer-sync is in the launch)*
`SignerSyncZkModule.submitSignerProof` rebuilds its journal from `(acc, leafCount, paramsHash, selectionParamsHash, signerSetRoot, targetThreshold)` with **no** `instanceDomain`/chainId word — unlike `MerkleSnapshot`, which binds `keccak256(address(this), block.chainid)` (issue #9). The module rotates a Safe's owner set (fund control), and its isolation currently rests only on `paramsHash` transitively carrying `accumulator`/`chain_id` params that are `serde(default)=0` and were explicitly demoted to non-load-bearing. Two modules sharing an accumulator+params, or mirrored at the same CREATE2 address cross-chain, allow replay of an owner-rotation proof.
**Fix:** add `keccak256(abi.encode(address(this), block.chainid))` as a journal word, reproduced byte-for-byte in the signer guest and `signer_journal_encoded`.
**Caution — this is not a quick edit:** changing the guest changes the **program vkey**. Requires golden-vector regen, guest+host+Solidity byte-parity, and a redeploy/vkey-rotation step in the launch runbook. Files: `src/contracts/zodiac/SignerSyncZkModule.sol:230-236`, `packages/pagerank-core/src/encode.rs:145-153`, `zk/program/src/signer.rs`, golden vectors + frontend TS port.

### H-3 — Operator submit revert loop is uncapped and outside the loss budget
Hard-coded gas limits (1.5M submit) with no `eth_estimateGas`; the pre-send simulation is an `eth_call` with **no gas field**, so a tx that reverts only because 1.5M is insufficient passes simulation and burns full gas on-chain; a failed submit never journals `Settled`, so the next 60s tick re-plans it. `LossBudget` counts proving cost only — on-chain gas is never budgeted. A persistently reverting submit drains the operator hot wallet with no circuit breaker.
**Fix:** estimate gas and refuse above cap; pass the intended `gas` into the simulation; count `gas_used × price` into the spend window; add a 3-strikes-per-WorkKey human hold.
**Location:** `zk/operator/src/run.rs:588-596`, `tx.rs:41-74`, `chain.rs:172-178`.

### H-5 — Head-signature replay resurrects revoked edges  *(blocking IFF lane 2 is enabled — otherwise defer)*
Envelope-0 head signatures carry no monotonic nonce; rule Φ picks the newest *anchored* head by anchor order, and anchoring is permissionless. Any third party can re-anchor a victim's old (pre-revocation) head with its still-valid signature; the honest prover must then consume it (resurrecting revoked out-edges) or drop the node — rewriting the score root that gates governance and rewards.
**Fix:** bind a strictly increasing per-node nonce/epoch into the signed head and reject any anchored head whose signed count is below the max already anchored for that node (or track the latest accepted head per node in `AnchorRegistry`).
**Location:** `packages/envelopes/src/eas_offchain.rs:117-124,186-209`, `packages/pagerank-core/src/lane2.rs:73-118`, `AnchorRegistry.sol:91-97`.

### H-4 — Permissionless accumulator/anchor bloat → griefing and permanent unprovability
Attestations (and revocations, which also append a leaf) grow `leafCount`+`anchorCount` monotonically and irreversibly; proving cost scales linearly. Above `MAX_PRICED_INPUTS = 200,000`, `ProvingVault.bandOf` returns band 0 (no prover paid) and the code ties that to the zkVM cycle limit — past that point the root is both unprovable and unpaid, and the chained hash cannot be trimmed. Recovery today means a new resolver, losing all vouch history.
**Assessment:** for small, controlled experiments this may be tolerable *with monitoring*, but the permanent-ceiling property is severe. Treat as blocking unless the launch is closed-set / allowlisted, and in all cases **document the ceiling and its attacker cost**.
**Fix:** price/stake attestation ingress for high-value instances (the payable resolver exists); bound the proving window or pin an attester set; provide a low-friction constitutional `setAccumulator` re-seed so the ceiling is recoverable.
**Location:** `eas/AttestationAccumulator.sol:93-98`, `EASIndexerResolver.sol:86/107`, `AnchorRegistry.sol:91-97`, `ProvingVault.sol:456-463`.

---

## STRONGLY RECOMMENDED — not hard blockers, but land before real value moves

**Governance (`MerkleGovModule`):**
- **M-4** — `execute()` has no timelock and proposal actions may `DelegateCall` the Safe, bypassing any Guard. Add an execution delay (Zodiac Delay / TimelockController) and forbid `DelegateCall` unless the target is allowlisted. `:257-271`.
- **M-5** — Abstain votes count toward quorum, enabling minority passage. Exclude abstain from the quorum sum, or require a minimum absolute "for". `:315-318`.
- **M-8** — `execute()` discards the `exec()` return value, so a failed action is silently swallowed and the proposal is marked executed forever (siblings revert on `!ok`). `:263-268`.

**Operator (`zk/operator`):**
- **M-6** — `minPayoutUsd` guard inverted (`.min(1)`), so a vault that slashes policy between quote and submit still gets a valid root for ~0 payment. `run.rs:569-570`.
- **M-9** — Same-depth reorgs undetected (anchor hash compared to itself; `guard`/`Dependencies` machinery unused) **and** `Settled{Landed}` journaled at 0 confirmations, so a reorged-out submit wedges the instance behind manual journal surgery. `run.rs:344-359,593-597`.
- **M-10** — Daemon panics (process death) on short/empty `eth_call` returns; a routine `0x` from a lagging/flaky provider crashes it. `chain.rs:520-531`.
- **M-11** — No stuck-tx replacement despite the `replacement_after_s` knob and docs; a tx stranded under the basefee gate queues everything behind its pending nonce. `tx.rs:79-104`.

**Distributor (`MerkleFundDistributor`):**
- **M-7** — Owner can front-run `distribute()` with `setFeePercentage(100%)` + `setFeeRecipient(self)` to capture a funder's whole round. Add funder-supplied `maxFeeAmount`/`expectedFeeRecipient`, and/or delay fee changes. `:342,358,375-389`.

**Lane 2 (`packages/envelopes`) — only if lane 2 is enabled:**
- **M-12** — `Car::parse` panics on a malformed CAR instead of failing closed, aborting the whole guest. Bounds-check every LEB128 length before slicing. `carset.rs:44,69,77-79`.

---

## DEFERRED (Jake's call)

- **C-1 (Critical, hypercerts only)** — `strongref_targets` is prover-supplied, not content-addressed against its CID, and committed nowhere, so a prover can add/forge/suppress badge-award edges and move the `output_root`. **Must be fixed before hypercerts ships to mainnet with value.** Not in the trust-graph launch path. `packages/hypercerts-core/src/semantics.rs:216-223`, `compute.rs:123-125`.

---

## LOW / INFO backlog (grouped — address opportunistically)

**Governance/distributor:** passed proposals never expire (GOV-4); quorum threshold floors to zero for tiny pools (MATH-5); deadline-0 distributions permanently lock dust + round-to-zero shares (ERC20-4/MATH-6); native-ETH push in fee/sweep blockable by a reverting recipient (DOS-3/ERC20-3/6); owner can `pause()` claim+sweep indefinitely (AC-3); rebasing tokens strand distributions (ERC20-2); single-step module ownership vs two-step secondaries (AC-4).
**ZK/operator:** signer-sync stuck if the proven set contains the Safe's own address (GOV-6); `setAccumulator` doesn't reset the checkpoint high-water mark (ZKS-3); signer paramsHash read live not pinned per checkpoint (ZKS-4); single trusted RPC + plaintext http allowed (ZKO-8); hot keys inherited by read-only subprocesses + runtime `cargo run` in the money path (ZKO-9); CAR content-addressing skipped for non-sha256 blocks (ZKG-3); PLC op sig doesn't enforce low-S (ZKG-4); `from_utf8_lossy` MST-key parity hazard (ZKG-5).
**Oracle (`ProvingVault`):** feed staleness default 24h vs mainnet ~1h heartbeat (ORCL-1); non-strict price bounds not checked vs aggregator min/maxAnswer (ORCL-2); immutable feed address, no fallback (ORCL-3).
**Contracts hygiene:** `OffchainAttestationVerifier.verify` ignores `expirationTime` (SIG-3, example contract); state paginators underflow-revert on out-of-range offset (MATH-9); fee rounds down (MATH-7); `quote()` divides-before-multiplies vs `settle` (MATH-8); mixed nodeId/address leaves share one untagged tree (ZKG-6); `PayableEASIndexerResolver.withdraw` arbitrary recipient (AC-6, non-production).
**Hygiene (from H-2):** add a CI secret-scan gate so a bespoke private key can't re-enter the tree (the July scrub + this finding are the second and third occurrences).

---

## Verified-sound (for the launch sign-off)

The audit did **not** find an unconditional third-party-fund-loss bug in the trust-graph launch path. Positively verified:

- **Root-producer soundness:** journal parity byte-exact and golden-locked across guest/native/Solidity/TS; input completeness binds the frozen accumulator; the monotonic guard blocks rollback; the trust-graph producer binds `instanceDomain` + chainId unconditionally on-chain (issue #9). (ZK-soundness reviewer: 14 properties; ZK-guest reviewer: 9 property groups; witness table 19/20 inputs constrained — the one free input is C-1, hypercerts-only.)
- **Access control:** the `MerkleSnapshot` two-tier timelock split is non-crossing (operational cannot escalate to constitutional — code + test verified); the factory ends every `createInstance` holding no role; `InstanceRegistry` splits append-only REGISTRAR from rewrite OPERATOR; `ProvingVault` gates fund custody on the *bound* snapshot's constitutional role; deploy scripts grant-then-renounce to the timelocks and hand module ownership to the managed Safe.
- **Token/oracle handling:** SafeERC20 throughout; state-before-transfer + pull-ledger vault; oracle decimals assert + staleness/negative/bounds guards; USD conversions round against the payee (fuzz-proven).
- **Operator spend controls (proving):** fsynced `Intent` records, rolling `LossBudget`, no auto-retry on ambiguous outcomes; witness validated against on-chain state and byte-asserted guest==native before any paid proving run. (The gaps are on the **gas/tx** side — H-3, M-6, M-9/10/11 — not the proving side.)

---

## Recommended sequencing

1. **M-3** (signer-sync journal + vkey) — launch-blocking and the longest lead time (guest change → vkey rotation → redeploy).
2. **H-3** (operator gas circuit-breaker) — protects the hot wallet the moment the operator runs on mainnet.
3. **Answer the lane-2 question** — if enabled, **H-5** and **M-12** join the blocking set; if not, defer both.
4. **H-4** — at minimum document the ceiling + attacker cost; add the `setAccumulator` re-seed path if experiments are open to adversaries.
5. Governance/operator/distributor Mediums (M-4…M-11) before any real value moves.
6. C-1 before hypercerts ships; Low/Info backlog opportunistically; add the CI secret-scan gate.
