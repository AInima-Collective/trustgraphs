# GOAL — Close the Open-Source Readiness Backlog

> **Status (2026-08-14): 14 issues closed, 18 remain.**
>
> Closed after auditing `main` through `860b257` and rerunning the focused regressions:
>
> - **#11** — bounded hook gas, dense hook storage, zero-address rejection, and
>   refund-safe reimbursement (`a6f89c5`, `c7ee5ec`)
> - **#12** — admitted anchor relayers, immutable combined-count ingress capacity, shared
>   vault/operator limits, and auditable replacement-snapshot recovery (`f5d826a`)
> - **#13** — snapshot-scoped claims and quote/settlement parity (`2d46090`)
> - **#14** — constitutional authority floor and handoff, fail-closed accumulator history,
>   total pagination, and fixed epoch phase (`aa8e2b5`)
> - **#15** — persistent deterministic-submit abandonment and fresh-checkpoint recovery
>   (`362e547`; empty-root/hook precursor in `a6f89c5`)
> - **#16** — durable multi-target publication, restart-safe retry, and deterministic historical
>   repair (`131ecfd`)
> - **#20** — atomic module-only Safe graduation, sealed owner execution, delayed member/recovery
>   routes, and live authority disclosure (`820b6f3`)
> - **#21** — optional atomic signer-sync installation, zero-config discovery/operation, indexed
>   receipts and settings controls, plus isolated signer finality/loss budgets (`56326fd`)
> - **#22** — atomic governed prepayment and payable initial policy (`f1ef43f`)
> - **#28** — versioned canonical Contributions tuples, registry discovery, hard commitment checks,
>   and sidecar-free public reproduction (`3de8943`)
> - **#29** — a nonzero epoch schedule is mandatory for direct deployments (`cf9808c`)
> - **#34** — weighted-prior V1 semantics, exact normalization/commitment/availability model,
>   2,048-entry benchmark cap, cross-language fixture, and ordered implementation split
>   (`8bf7588`; children #52–#55)
> - **#35** — allowlisted ERC-8004 identity/history indexing, hardened asynchronous registration
>   metadata, qualified bulk APIs, agent identity UI/lens, and byte-identical score/proof behavior
>   (`f6529a1`, PR #57; follow-ups #58–#62)
> - **#36** — accepted normalized final-distribution composition, exact source-aware Hamilton
>   arithmetic, bounded/fail-closed provenance policy, reproducible goldens and simulations, plus a
>   separate advisory graph-reputation design (`860b257`, PR #69; children #63–#68)
>
> Remaining launch-risk issue: **#27**.
> Remaining research/product epics: **#37–#38**.
> Weighted-prior implementation chain: **#52 → #53 → #54 → #55**.
> ERC-8004 reputation chain: **#58 → #59**; #60 and #61 are parallel gates; all feed blocked #62.
> Trust-composition chain: **#63 → #64 → #65 → #66** (with #61 also gating #65); graph lineage
> **#67 → #68** remains parallel and advisory.

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

| Lane                              | Issues                           | Purpose                                                          | Dependencies                                |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| A · operator availability         | #16 closed                       | Repair score-blob availability                                   | `131ecfd`                                   |
| B · snapshot/vault hardening      | #12 and #14 closed               | Bound hostile input growth and finish snapshot invariants        | `f5d826a`, `aa8e2b5`                        |
| C · self-serve economics          | #22 closed                       | Make app prepayment activate a payable proving policy            | `f1ef43f`                                   |
| D · authority and production      | #20 closed → #27                 | Creator bypass removed; deploy and smoke-test production         | `820b6f3`; #12/#14/#22 prerequisites closed |
| E · program self-service          | #21 and #28 closed               | Factory signer-sync and reproducible Contributions params        | `56326fd`, `3de8943`                        |
| F · decision closure              | #34 and #36 closed; #37          | Close bounded research questions with evidence and child issues  | independent research tracks                 |
| G · agent product                 | #35 closed; #38                  | ERC-8004 enrichment and delegated action/voting                  | shared agent UX only; avoid coupling proofs |
| H · weighted-prior implementation | #52 → #53 → #54 → #55            | Core/guest, commitment lifecycle, operator/indexer, then UX      | ordered by #34 ADR                          |
| I · ERC-8004 reputation           | #58 → #59; #60 and #61 → #62     | Raw evidence, experiment, completeness/program gates, then proof | #62 blocked on #58–#61                      |
| J · trust composition             | #63 → #64 → #65 → #66; #67 → #68 | Proven blend stack plus separate advisory graph reputation       | #65 also depends on shared #61              |

The remaining D, F, and G lanes can proceed independently; H and J are ordered internally, while I
shares program-aware ingestion issue #61 with J. None blocks the core public repository release.

---

## Milestone 1 — Availability and paid proving

**Complete.** These four issues removed the most immediate availability, payment, and snapshot
invariant risks.

### M1.1 · #15 — abandon deterministic submission failures and advance

**Closed in `362e547`** (with the empty-root/hook precursor in `a6f89c5`). The journal now records
terminal abandonment across restarts; estimate, simulation, and receipt reverts share one
configurable counter; transient failures and reorgs do not consume it; and the planner waits for
input movement before triggering/proving a fresh checkpoint.

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

**Closed in `131ecfd`.** The operator now journals publication attempts and successes against the
exact CID and durability-policy hash, retries failed work across restarts with bounded alerting,
and refuses submission until the configured minimum of independent Kubo-compatible targets has
stored and served the canonical bytes. `operator republish` reconstructs historical checkpoint
inputs and parameters, verifies the resulting root, digest, CID, recipient, and total against the
landed state, then repairs every configured target without requiring prover or submitter secrets.

The end-to-end operator test deliberately lands an unreadable CID, repairs it through a fresh local
Kubo target, and passes the repaired bytes through the indexer's production Merkle-row derivation.
It also verifies restart idempotence and subsequent-checkpoint progress. The focused Rust, frontend,
and indexer suites pass; production and operator documentation now cover independent backup targets,
minimum-success policy, retention, recovery, and the distinction between content identity and an
availability guarantee.

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

**Closed in `f1ef43f`.** Governed creation now takes explicit initial paid cadence and 8-decimal
USD cap terms, rejects every funded/disabled or unfunded/enabled mismatch, requires a priced
initial band, and bounds the initial cadence and cap before deploying anything. The bootstrap Safe
installs that policy after the deposit binds the vault account and before the wrapper removes itself
as owner, so the one transaction is atomic.

The wizard passes zero/zero for an unpaid network and, for prepayment, shows the effective cadence,
combined fee/gas cap, current band-1 fee, conservative refresh estimate, and withdrawal notice
before signing. Its exact USD parsing and estimate math have a focused regression. The governed
factory regression exercises a real Safe and vault, verifies the installed policy, triggers the
first checkpoint, and proves its quote is eligible rather than `PolicyDisabled`. All 97 factory
tests, the full frontend test suite, the generated-ABI production build, focused lint, and Solidity
build pass.

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

**Closed in `aa8e2b5`.** The constitutional role now has a nonzero holder invariant and explicit
two-step handoff whose successor inherits snapshot and vault emergency authority. Accumulator
replacement is permitted only while both sides are pristine; dense checkpoint ids and monotonic
freeze blocks are enforced independently, and the documented post-checkpoint recovery path is a
replacement snapshot plus directory/vault migration. Both history views now return empty or
clamped pages for every boundary and overflow-sized request. A changed nonzero epoch length anchors
a fixed phase, while late permissionless triggers consume the current scheduled boundary without
misstating the checkpoint's actual freeze block. The 532-test Forge suite, frontend suite, generated
ABI checks, and size build pass; `MerkleSnapshot` retains 12,022 bytes of EIP-170 runtime margin.

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

**Closed in `f5d826a`.** `AnchorRegistry` now separates identity registration from finite proving
capacity: only governance-admitted `ANCHORER_ROLE` relayers may append, every node count must
increase, and address heads retain their owner signature. A one-shot reciprocal snapshot binding
lets each append authenticate the current lane-1 count and reject, before mutation, when the next
combined input would exceed an immutable deployment cap no higher than the shared 200,000
vault/operator boundary. The operator reads the lower instance cap for 80% alerts, and the settings
page shows its live headroom.

[`research/ANCHOR_INGRESS.md`](research/ANCHOR_INGRESS.md) records the accepted censorship/liveness
tradeoff, mainnet attacker cost, the fact that mutable lane-1 ingress still needs its own gate or
price, and the replacement-snapshot/directory/vault migration ceremony that composes with #14.
Outsider Sybil registration, band inflation, admitted legitimate growth, exact exhaustion, live
lane-1 consumption, binding, replay, and post-checkpoint rotation regressions pass. The complete
541-test Forge suite, 86 operator-core tests, 32 operator tests, Hypercert/input-exporter tests,
frontend tests/lint/production build, contract-size build, and the full root/signer/two-lane/
Hypercert Anvil E2E pass. Accepted risk: admitted relayers control inclusion, and a compromised
relayer can spend the configured finite capacity; multiple operators, role monitoring, revocation,
and early migration are required.

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

**Closed in `820b6f3`.** Factory creation now enables exactly two delay-enforcing Safe modules,
installs the owner-execution guard, swaps the bootstrap owner, and irreversibly seals the guard in
one outer transaction. A valid creator signature cannot change snapshot settings, move Safe funds,
remove the guard, enable a bypass module, delegatecall, or MultiSend. Member governance retains its
1-block voting delay, 50,400-block vote, and 7,200-block execution delay; the initial recovery
proposer can only queue an exact action for an immutable 14-day public delay, which the proposer or
member-governed Safe may cancel and anyone may execute after maturity.

[`GOVERNED_SAFE_AUTHORITY`](./research/GOVERNED_SAFE_AUTHORITY.md) records the guard, direct
timelock, and staged-bootstrap comparison plus emergency/liveness rules and the accepted recovery
risk. The create review refuses an older configured factory without this authority profile and
shows owners, threshold, graduation, and both delays before signature. Network settings verify the
live guard storage slot/sealed state, exact two-module set, Safe bindings, owners, threshold,
proposer, and delays before displaying “Graduated.” The focused 13-test factory battery covers
direct execution, value withdrawal, settings, Safe self-calls, guard removal, module addition,
delegatecall, batching, module delay/cancellation, and the 14-day minimum. All 547 Forge regressions,
the Rust workspace, frontend tests/lint/build, indexer tests, secret scan,
sizes, and the root/signer/two-lane/Hypercerts rehearsal pass.

Accepted risk: the recovery proposer may queue arbitrary Safe calls or delegatecalls after 14 days;
that disclosed constitutional route is necessary before the first score root and remains observable
and cancellable. Production deployment must confirm the 57,601-block member veto path normally fits
inside that window or increase the compiled recovery delay.

Prior state: the governed factory created a Safe and a working Merkle governance module, but
finished as a 1-of-1 creator-owned Safe. That signer could bypass graph voting and execution delay.

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
parts of #12 and #14; #22's creation-time paid policy closed in `f1ef43f`.

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

**Closed in `3de8943`.** New Contributions deployments register a typed parameter controller that
emits every complete canonical tuple and binds it to the instance ID, snapshot, EAS, and registry.
Rotations atomically update the controller, snapshot, and registry commitments while preserving
version history. The scanner, operator, indexer, and verifier tooling reconstruct from that public
history and fail closed on any event/getter/controller/snapshot/registry mismatch; the prover now
rejects a known mismatch before constructing an input. The Anvil acceptance test removes the local
draft, gives the reproducer only RPC/registry/start-block inputs, rebuilds the checkpoint, submits a
nonzero accepted root, and independently reproduces that exact root from chain history.

- Introduce a Contributions deployer/factory or immutable parameter publisher that emits the full
  canonical parameter tuple and binds it to the snapshot/instance ID.
- Teach `instance_scan`, the operator, indexer, and verifier tooling to reconstruct the tuple from
  chain history and require its hash to match `snapshot.paramsHash()`.
- Change a known parameter mismatch from a warning to a pre-proving hard error.
- Add a third-party reproduction test starting from only RPC URL, registry address, and start block;
  it must rebuild inputs and reproduce the accepted root without a local params file.

**Close when:** a fresh machine can reproduce a Contributions result from public data alone.

### M3.2 · #21 — make signer-sync an optional governed-factory module

**Closed in `56326fd`.** Governed creation optionally installs a dedicated signer verifier/vkey and
selection tuple, enables the module before sealing the Safe, and publishes a complete descriptor.
Ponder/API and settings now expose live module state, receipts, staleness, failures, and a delayed
member-governed pause/resume action. The operator derives signer work from the creation receipt,
waits for landed score checkpoints, reconstructs historical pinned params, submits the complete
owner receipt without IPFS/vault handling, and uses mutually isolated finality/loss-budget policy.
The real-Safe integration creates once, discovers both modules, applies a signer proof and replaces
the owner set; invalid program identities and unsafe selection policies roll the whole creation
back. Verification: 553 Forge tests, 34 adapter tests, 88 operator-core tests, 25 indexer tests,
frontend parity/lint/production build, Ponder codegen, and EIP-170 size checks.

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

**Closed in `8bf7588` (PR #56).** The accepted ADR fixes persistent personalized-prior semantics,
prior-supported node/dangling behavior, exact decimal/Hamilton normalization, canonical CSV/JSON and
`TGWP` bytes, compact calldata validation with chain-history recovery, timelocked rotation,
governance/version/migration boundaries, and a constitutional 2,048-entry cap. Rust, TypeScript,
and Solidity share a byte fixture; measured max-shape cost is 445,972,213 SP1 cycles and the compact
2,048-entry EVM path is bounded at 3,694,644 gas under the documented method. Implementation is
split in dependency order across #52–#55.

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

**Closed in `860b257` (PR #69).** The accepted V1 decision selects a normalized blend of complete,
atomically captured source distributions with exact two-stage source-aware Hamilton apportionment,
manual nonzero weights, fail-closed availability/freshness, and explicit governance-admitted
provenance limits. The checked-in BigInt reference and goldens pin commitments, attribution,
rounding, invalid/stale inputs, and post-trigger immutability. The simulator covers all 36 positive
A/B/C 10%-grid policies, disagreement and leave-one-out sensitivity, compromised-source bounds,
clone amplification, meta-referral cartels, and a conservative 8-source / 8,192-entry native cap.
Graph reputation remains a separate scoped, curated-admission, advisory policy. Proven composition
is split across #63–#66 (sharing #61), and lineage/vouch experimentation across #67–#68.

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

**Closed in `f6529a1` (PR #57).** The Optimism Identity Registry is allowlisted with pinned ABI,
proxy implementation/version/owner provenance and monitored control-plane history. Ponder now
reconstructs qualified owner, verified-wallet, URI, and event histories in canonical position order;
a separate DNS/IP-pinned sidecar validates and sanitizes bounded HTTPS/IPFS/data registration
documents without blocking chain ingestion. Bulk APIs decorate accounts and whole networks without
N+1 reads, while the account page, member table, graph/inspector, induced agent-wallet lens, and
durable agent route keep identity evidence distinct from existing scores. The two-agent Solidity
fixture, 33 indexer tests, frontend production build and byte-identical PageRank/Hypercerts/
Contributions vectors, Forge fixture/full-suite evidence, Rust workspace, Compose, and schema checks
pass. Follow-up reputation work is dependency-ordered in #58–#62.

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

- #20 is closed (#12 and #14 are complete prerequisites).
- #16's configured publication durability policy is live.
- #27's deployment ceremony and end-to-end smoke test pass.

### Honest closure target

- **Near term:** #37 — the remaining independently closable research decision.
- **Production track:** #27 — deploy and exercise the now-guarded creation path.
- **Feature track:** #38 — delegated actions after the #35 identity slice.
- **Weighted-prior track:** #52 → #53 → #54 → #55 — implement the accepted #34 ADR in reviewable
  trust-boundary order.
- **ERC-8004 reputation track:** #58 → #59, with #60/#61 as parallel design/platform gates; #62
  remains blocked until all four close compatibly.
- **Trust-composition track:** #63 → #64 → #65 → #66 for the proven blend; #67 → #68 for separate
  advisory graph reputation. #65 also waits for shared program-aware ingestion issue #61.

The target is all 18 remaining issues, but the metric is accepted behavior with evidence—not an
empty issue list.
