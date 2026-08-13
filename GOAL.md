# GOAL — Close the Open-Source Readiness Backlog

> **Status (2026-08-13): 3 issues closed, 14 remain.**
>
> Closed after auditing `main` at `c7ee5ec` and rerunning the focused regressions:
>
> - **#11** — bounded hook gas, dense hook storage, zero-address rejection, and
>   refund-safe reimbursement (`a6f89c5`, `c7ee5ec`)
> - **#13** — snapshot-scoped claims and quote/settlement parity (`2d46090`)
> - **#29** — a nonzero epoch schedule is mandatory for direct deployments (`cf9808c`)
>
> Remaining launch-risk issues: **#12, #14, #15, #16, #20, #22, #27**.
> Remaining reproducibility and self-service issues: **#21, #28**.
> Remaining research/product epics: **#34–#38**.

Prepare Trustgraphs for public development by closing every issue whose acceptance criteria can be
met with code, tests, documentation, or a recorded design decision, while keeping deployment-only
and research work honest about their external gates.

This file replaces the completed pre-mainnet audit goal. The source of truth for scope is each GitHub
issue. If this plan and an issue disagree, update the issue first or follow the issue.

---

## Closure rules

An issue closes only when all of the following hold:

1. The complete issue is resolved, including its latest status comment. Fixing the original repro
   is not enough when follow-up reliability work is explicitly in scope.
2. Every code fix has a regression that fails before the fix and passes after it. Cross-language
   encodings retain Rust/guest/Solidity/TypeScript parity and regenerated golden vectors.
3. User-facing or operator-facing behavior is documented, including recovery and failure modes.
4. The focused suite and every materially affected package suite pass. Contract, guest, or schema
   changes also run the full relevant workspace suite.
5. The closing comment names the commit or PR, summarizes the evidence, and records accepted risks.
6. Research issues close only with a checked-in decision record, the required evidence/fixtures,
   and independently reviewable implementation issues with ordered dependencies and acceptance
   criteria.

Do not close an issue because it is old, partially fixed, documented as a risk, or inconveniently
broad. Split it only when the original issue's author agrees that the new children preserve its full
scope.

---

## Parallel execution map

Run one branch/PR per numbered issue unless two issues share an inseparable invariant. These lanes
can proceed concurrently:

| Lane | Issues | Purpose | Dependencies |
| --- | --- | --- | --- |
| A · operator availability | #15, #16 | Self-heal failed submissions and repair score-blob availability | none |
| B · snapshot/vault hardening | #12, #14 | Bound hostile input growth and finish snapshot invariants | coordinate accumulator migration semantics |
| C · self-serve economics | #22 | Make app prepayment activate a payable proving policy | fee schedule deployed |
| D · authority and production | #20 → #27 | Remove creator bypass, then deploy and smoke-test production | #20 before #27; #12/#14/#22 before value |
| E · program self-service | #21, #28 | Factory signer-sync and reproducible Contributions params | none; separate PRs |
| F · decision closure | #37; #34 and #36 | Close bounded research questions with evidence and child issues | independent research tracks |
| G · agent product | #35, #38 | ERC-8004 enrichment and delegated action/voting | shared agent UX only; avoid coupling proofs |

The recommended merge order is A/C first, B next, D/E after their designs settle, and F/G in
parallel without blocking the core public repository release.

---

## Milestone 1 — Availability and paid proving

Four comparatively bounded issues. Completing this milestone should remove the most operational
risk per review cycle.

### M1.1 · #15 — abandon deterministic submission failures and advance

The three-strike circuit breaker in `zk/operator/src/run.rs` prevents wallet drain but deliberately
holds for a human. It does not satisfy the issue's self-healing requirement, and simulation failures
do not become strikes.

- Add a persistent terminal `Abandoned` (or equivalently explicit) journal state keyed by
  `(chain, instance, checkpoint)`.
- Classify deterministic simulation reverts and reverted receipts consistently. Transient provider,
  reorg, fee, and availability failures must remain retryable.
- After the configured threshold, exclude the abandoned checkpoint from in-flight selection and
  allow the planner to trigger/prove a newer checkpoint. Never reinterpret an invalid proof as a
  valid root.
- Emit an alert carrying the checkpoint, failure class, attempts, and recovery action.
- Regression: a Ready checkpoint that deterministically fails N times produces `Trigger` for a new
  checkpoint, survives restart, and does not resume submitting the abandoned proof.

**Close when:** both the historical empty-root case and a different deterministic revert recover
without a human, while transient failures and reorgs retain their safe retry behavior.

### M1.2 · #16 — repair and harden blob publication

Pin-before-submit and CID/readability checks are already on `main`; failed pinning still has no
repair path, and one Kubo node is not durable storage.

- Add `operator republish --instance <id> --checkpoint <id>` (or an equivalent explicit command).
  Reconstruct the canonical blob from checkpointed chain inputs, prove its digest/CID matches the
  landed state, and reuse the existing pin/readability checks.
- Support multiple pin targets or a pinning-service adapter with a configured minimum-success
  policy. Do not submit a root unless the configured publication policy is met.
- Persist failed publication work so a restart can retry it; make repeated failure visible without
  flooding alerts.
- Add an integration test that starts with an unreadable landed CID, republishes, and verifies the
  indexer can ingest the repaired blob.
- Document backup targets, retention expectations, republish procedure, and the fact that
  content-addressing proves bytes but not availability.

**Close when:** an operator can repair an old failed pin deterministically and production config no
longer relies on one storage target.

### M1.3 · #22 — a prepayment must create a payable policy

The wizard and factory can deposit ETH, but a new vault account still has `maxPerRootUsd == 0`, so
quotes return `PolicyDisabled` forever until an administrator uses an out-of-band script.

- Add explicit initial `minPaidIntervalBlocks` and `maxPerRootUsd` inputs to governed creation, with
  safe bounds and clear units. Zero means unpaid/curated and must not be presented as prepayment.
- During bootstrap, have the new Safe call `ProvingVault.setPolicy` before bootstrap authority is
  handed off. A nonzero prepayment with a zero policy must revert or be blocked by the UI.
- Show the effective cadence, cap, fee band, estimated number of refreshes, and withdrawal limits
  before signing. Keep the global fee schedule as a visible deployment prerequisite.
- Regression: a prepaid app-created instance has a nonzero policy and its first valid checkpoint
  quote is not `PolicyDisabled`; an unpaid instance remains valid.

**Close when:** the one-transaction app path produces a funded, payable instance and the UI never
accepts money into a disabled policy by accident.

### M1.4 · #14 — finish the four MerkleSnapshot hardening findings

Treat the four findings as separate commits in one issue PR if that makes review easier:

1. **Constitutional recovery.** Prevent the last constitutional holder from being revoked or
   renouncing. Prefer a two-step transfer/recovery design with explicit events over an untracked
   holder counter. Test single-holder and multi-holder transitions plus vault authority recovery.
2. **Accumulator rotation.** Define a generation-aware migration boundary so a new accumulator
   cannot reuse checkpoint IDs, overwrite checkpoint metadata, or file a state at a lower block.
   If safe migration is deferred, fail closed by forbidding rotation after the first checkpoint and
   document the redeploy/migrate path.
3. **Pagination.** Return an empty array when `offset >= length`; avoid `offset + limit` overflow.
   Test exact-end, past-end, zero-limit, and `type(uint256).max` for both views.
4. **Fixed epoch phase.** Anchor epochs to a fixed origin/epoch number rather than sliding
   `lastTriggerBlock` from the caller's chosen block. Permissionless callers may trigger a due epoch
   but may not move every future boundary. Update the contract comments and runbook.

**Close when:** all four findings have explicit invariants and regressions, and accumulator recovery
semantics do not conflict with the input-ceiling recovery chosen for #12.

---

## Milestone 2 — Hostile-input and authority boundaries

These are the security design gates for production deployment. Do not rush them for issue count.

### M2.1 · #12 — make anchor ingress economically or administratively bounded

Today an untrusted node can grow `anchorCount`, move a funded instance into a more expensive band,
and eventually push it past the operator's 200,000-input ceiling. Saturating `bandOf` alone is not a
fix because it would pay for work the operator still refuses to prove.

- Choose and document one v1 admission rule: priced/staked anchor writes, governance-admitted
  writers, or a constitutionally bounded per-epoch/per-node allowance with Sybil-resistant identity.
- Enforce the bound at ingress, before `anchorCount` changes. The vault and operator must derive
  priceability from the same authenticated size.
- Provide a constitutional recovery/reseed path that preserves an auditable link to prior history
  and composes with #14's accumulator-generation rules.
- Test band inflation, exhaustion, many attacker-controlled nodes, legitimate updates, limit
  boundaries, and recovery. Include an attacker-cost analysis for the production chain.

**Close when:** an unaffiliated address cannot cheaply change another instance's proving band or
permanently exhaust its accepted input capacity.

### M2.2 · #20 — factory governance must not have a 1-of-1 bypass

The governed factory now creates a Safe and a working Merkle governance module, but it finishes as a
1-of-1 creator-owned Safe. That signer can bypass graph voting and execution delay.

- Write a decision record comparing at least: Safe guard/modifier enforcement, timelock-owned
  authority, and a staged bootstrap/graduation model. State emergency recovery and liveness rules.
- Separate constitutional and operational authority from genesis or make the temporary bootstrap
  state explicit, time-bounded, and impossible to market as decentralized governance.
- Enforce the execution delay for owner-originated and module-originated calls to protected
  settings, upgrade, withdrawal, and arbitrary Safe targets. Test bypasses through direct Safe
  execution, enabled modules, delegatecall, batching, and guard removal.
- Surface the current authority graph, delay, owners, threshold, and graduation state in the create
  review and network settings.

**Close when:** no single creator transaction can immediately change scoring truth, withdraw the
proving tank, or bypass member-approved execution on a graduated network.

### M2.3 · #27 — deploy the production creation path

This is external-state work, not a code-only closure. It follows #20 and the production-relevant
parts of #12, #14, and #22.

- Deploy and verify the registry, vault/oracle configuration, base factory, governed factory,
  deployer helpers, Safe dependencies, verifier, and timelocks/guards on the selected chain.
- Grant the minimum registry roles, initialize fee bands/gas policy, set a production epoch floor,
  and transfer every privileged role through the documented ceremony.
- Run a real smoke test: create from the public app, discover through the production indexer,
  attest, trigger, publish/prove, display the score blob, quote/pay the bounty, vote, and execute
  after the enforced delay.
- Generate `frontend/config.production.json` and indexer config from verified deployment artifacts;
  remove placeholder endpoints. Publish addresses, bytecode hashes, start blocks, role holders, and
  rollback instructions.

**Close when:** the public `Create a network` CTA completes against production and its child instance
is automatically discovered and operational end to end.

---

## Milestone 3 — Reproducible and self-serve programs

### M3.1 · #28 — publish and reconstruct Contributions parameters

- Introduce a Contributions deployer/factory or immutable parameter publisher that emits the full
  canonical parameter tuple and binds it to the snapshot/instance ID.
- Teach `instance_scan`, the operator, indexer, and verifier tooling to reconstruct the tuple from
  chain history and require its hash to match `snapshot.paramsHash()`.
- Change a known parameter mismatch from a warning to a pre-proving hard error.
- Add a third-party reproduction test starting from only RPC URL, registry address, and start block;
  it must rebuild inputs and reproduce the accepted root without a local params file.

**Close when:** a fresh machine can reproduce a Contributions result from public data alone.

### M3.2 · #21 — make signer-sync an optional governed-factory module

The voting half of this issue is complete. Close the remaining signer-sync half without changing
the trust-graph program or its roots.

- Add optional signer-sync creation inputs: verifier/program identity, selection policy, and clearly
  separated signer-sync snapshot/module addresses.
- Deploy, enable, and announce `SignerSyncZkModule` in the governed creation transaction. Index the
  event and expose it through catalog/API rather than hardcoding signer sync disabled.
- Add network settings/status UI, rotation receipts, stale/failure diagnostics, and a deliberate
  enable/disable path.
- Schedule signer-sync work in the operator with separate loss budgets and finality handling.
- Integration test: create once, discover both modules, land a signer proof, and update the Safe
  owner set without a hand-edited config file.

**Close when:** an outside user can enable, observe, and operate signer-sync from the standard
factory/app path.

---

## Milestone 4 — Research issues that can close with decisions

These tracks do not block publishing the repository. They do block any claim that the corresponding
feature is implementation-ready.

### M4.1 · #37 — private Trustgraph decision sprint (first research closure)

This is the smallest research closure. Convert `research/PRIVACY_ARCHITECTURE.md` into an approved
ADR that fixes:

- credential issuer knowledge, private target resolution, member output granularity, comment policy,
  and accepted metadata leakage;
- pilot architecture (TEE-first, MPC-first, or parallel), exact trust/corruption assumptions, and
  rollback/key-release requirements;
- the first private consumer; and
- named owner plus measurable entry/exit gate for every selected spike.

**Close when:** the ADR is approved in the issue, owners accept the spikes, and the issue's four
discussion outcomes are checked. Implementation remains in the new spike issues.

### M4.2 · #34 — scalable weighted-prior specification

- Lock the mathematical/product meaning, node universe, dangling behavior, normalization and exact
  remainder rule, canonical CSV/JSON bytes, commitment, availability, rotation, governance, and
  version/migration policy.
- Benchmark representative graphs at hundreds, low thousands, and the proposed maximum across guest
  cycles, witness size, calldata/gas, operator memory/time, and browser recomputation.
- Add at least one Rust/TypeScript/Solidity canonical normalization/root fixture.
- Choose a concrete entry cap and architecture from the evidence. Record explicit deferrals for
  every remaining question and open ordered implementation issues.

**Close when:** every exit criterion in #34 is evidenced in the repository or linked children.

### M4.3 · #36 — composition and graph-reputation specification

- Build the reference rational blend and candidate integer apportionments; replay at least three
  representative sources and publish simplex, disagreement, correlation, attribution, and
  leave-one-out results.
- Fix scope/output compatibility, apportionment, source/account/blob limits, freshness, failure
  semantics, capture manifest, provenance trust boundary, nesting rule, and proving-price model.
- Add golden fixtures for overlap, missing accounts, unequal pools, rounding, stale sources, wrong
  blobs, and post-trigger source updates.
- Finalize lineage authority, scoped/expiring vouches, Sybil assumption, caps, and advisory-only
  launch policy. Open dependency-ordered implementation issues for `trust-compose`.

**Close when:** every exit criterion in #36 is met; a detailed candidate report alone is not enough.

---

## Milestone 5 — Agent product epics

### M5.1 · #35 — ERC-8004 identity enrichment

Deliver one vertical slice without feeding external agent data into proven Trustgraph scores:

- pinned official Identity Registry ABI and allowlisted Optimism/local deployments with proxy
  implementation provenance;
- local lifecycle fixture and reorg-safe ordered indexing of identity owner, verified wallet, URI,
  and relation history;
- an asynchronous SSRF-bounded metadata fetcher with byte/time/redirect/content-type limits,
  backreference validation, content hashes, and timestamped endpoint observations;
- bulk account/network APIs and a durable agent identity route; and
- consistent evidence labels in account header, member table, graph, inspector, and verified-wallet
  induced lens.

**Close when:** all nine acceptance boxes in #35 pass and existing roots, vectors, recomputation, and
proof paths remain byte-identical.

### M5.2 · #38 — delegated actions with human override

Ship stages 1–4; split stage 5 into its own research issue:

1. Upkeep-agent runbook for permissionless execute/claim/trigger/prover operations.
2. EIP-712 EAS delegated-attestation signing, review, relay, expiry/replay protection, and gasless
   vouch UX while keeping the human signer as attester.
3. Notification/preemption voting loop with an observable intended-vote receipt.
4. Audited principal-overrides-delegate voting: explicit delegate grant/revoke,
   `castVoteAsDelegate`, proposal-pinned proof, exact tally replacement, events, indexer receipts,
   frontend override, and quorum invariants.

Before implementation, resolve one delegate versus scoped delegates, identical versus discounted
quorum weight, event-only reason format, and notification requirements.

**Close when:** stages 1–4 work end to end with malicious delegate, revocation, replay, double-vote,
override, and tally-conservation tests; graph-level delegation research has its own issue.

---

## Release gates and issue-count target

### Core open-source release

- No known critical/high finding is presented as fixed when it is merely documented.
- Fresh-clone setup, build, focused test commands, contribution guide, security policy, licensing,
  generated artifacts, and secret scan are green.
- Milestone 1 is complete, or any remaining item is explicitly labeled with impact and workaround.
- Production is not implied until #27 closes.

### Production-with-value

- #12, #14, #20, and #22 are closed.
- #16's configured publication durability policy is live.
- #27's deployment ceremony and end-to-end smoke test pass.

### Honest closure target

- **Near term:** #14, #15, #16, #22, #28, and #37 — six independently closable issues.
- **Production track:** #12, #20, and then #27 — three security/deployment issues.
- **Feature track:** #21, #35, #38 — substantial vertical slices.
- **Research track:** #34 and #36 — close through evidence and decisions, not placeholder code.

The target is all 14 remaining issues, but the metric is accepted behavior with evidence—not an
empty issue list.
