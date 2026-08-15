# GOAL — Close the Open-Source Readiness Backlog

> **Status (2026-08-15): 25 issues closed, 17 remain.**
>
> Closed after auditing `main` through `6d03320` and rerunning the focused regressions:
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
> - **#37** — accepted issuer-known/unlinkable private profile, band-only disclosure and leakage
>   oracle, replicated attested-TEE pilot, bounded four-party MPC target, and first private consumer
>   (`5526d6a`, PR #76; children #70–#75)
> - **#38** — dedicated upkeep-agent runbook, human-signed EAS relay, notification-first voting
>   runner, and exact principal-overrides-delegate governance with indexed/UI receipts
>   (`d71ca82`, PR #78; graph-native research split to #77)
> - **#52** — isolated weighted-prior core and SP1 guest, exact Hamilton/dangling-to-prior scoring,
>   TGWP validation, Rust/TypeScript/Solidity production goldens, actual guest rejection/parity
>   gates, sub-billion max benchmark, and byte-identical legacy guests (`6530bf5`, PR #79)
> - **#53** — isolated weighted factory/controller, exact compact-manifest validation and calldata
>   recovery, O(1) commitment history, timelocked prior rotation, checkpoint pinning, max-row gas
>   gates, and stateful atomicity invariants (`f47173d`, PR #80)
> - **#54** — isolated weighted operator routing, exact cache/mirror/calldata recovery, active and
>   pending pinning, historical checkpoint replay, reorg-safe prior indexing, and additive
>   commitment/entry APIs (`281cb68`, PR #81)
> - **#55** — exact CSV/JSON/TGWP import and export, finalized-block ENS receipts and signing
>   freshness, asynchronous day-zero/concentration preview, weighted create/rotation/activation,
>   and explicit new-instance binary prefill (`339adc3`, PR #82)
> - **#58** — pinned ERC-8004 Reputation Registry provenance, canonical raw feedback/revocation/
>   response replay, event-block verified-wallet attribution, bulk APIs, hardened asynchronous
>   descriptors, and a score/proof-isolated raw explorer (`62af08a`, PR #83)
> - **#59** — hashed pinned-policy ERC-8004 experiment, independent exact replay, complete
>   exclusion/coverage/sensitivity evidence, adversarial ring/Sybil/rotation fixtures, isolated UI,
>   and a bounded no-go for production or proof integration (`1608411`, PR #84)
> - **#60** — explicit deployed-history completeness no-go, conditional activation-scoped
>   cooperating-registry boundary, exact cross-language accumulator/checkpoint vectors,
>   adversarial omission/reorg/upgrade/recovery evidence, and a measured 16,384-event milestone cap
>   (`6d03320`, PR #89; children #86–#88)
> - **#61** — registry-authenticated immutable score-program/output-domain bindings, explicit
>   decoder/table/API routing, fail-closed provenance validation, and audited restart/backfill and
>   rolling-deploy paths (`b725c32`, PR #85)
> - **#63** — isolated strict trust-compose core/guest, exact TGCP/TGCM/params/journal commitments,
>   source-aware Hamilton attribution, cross-language production vectors and fail-closed gates,
>   plus measured 8-source / 8,192-entry proving bounds (`344cc08`, PR #90)
>
> Remaining launch-risk issue: **#27**.
> Remaining graph-native agent-delegation research: **#77**.
> Weighted-prior implementation chain: **#52, #53, #54, and #55 closed**.
> ERC-8004 reputation chain: **#58, #59, #60, and #61 closed**; conditional implementation order
> is **#86 → #87 → #88 → #62**, with both #59's policy no-go and upstream adoption preserved.
> Trust-composition chain: **#63 closed → #64 → #65 → #66**; the shared #61 gate is closed; graph lineage
> **#67 → #68** remains parallel and advisory.
> Private-profile chain: **#70 → #71** for the selected TEE pilot, **#70 → #74 → #75** for the first
> consumer; #72 and #73 evaluate the MPC target in parallel.

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

| Lane                              | Issues                                        | Purpose                                                         | Dependencies                                |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| A · operator availability         | #16 closed                                    | Repair score-blob availability                                  | `131ecfd`                                   |
| B · snapshot/vault hardening      | #12 and #14 closed                            | Bound hostile input growth and finish snapshot invariants       | `f5d826a`, `aa8e2b5`                        |
| C · self-serve economics          | #22 closed                                    | Make app prepayment activate a payable proving policy           | `f1ef43f`                                   |
| D · authority and production      | #20 closed → #27                              | Creator bypass removed; deploy and smoke-test production        | `820b6f3`; #12/#14/#22 prerequisites closed |
| E · program self-service          | #21 and #28 closed                            | Factory signer-sync and reproducible Contributions params       | `56326fd`, `3de8943`                        |
| F · decision closure              | #34, #36, and #37 closed                      | Close bounded research questions with evidence and child issues | accepted ADRs and child splits              |
| G · agent product                 | #35 and #38 closed; #77                       | ERC-8004 enrichment, delegated action/voting, graph research    | shared agent UX only; avoid coupling proofs |
| H · weighted-prior implementation | #52, #53, #54, and #55 closed                 | Core/guest, commitment lifecycle, operator/indexer, then UX     | complete in #34 ADR order                   |
| I · ERC-8004 reputation           | #58/#59/#60/#61 closed; #86 → #87 → #88 → #62 | Cooperating input boundary, complete-era policy, then proof     | Upstream adoption; #59 no-go preserved      |
| J · trust composition             | #63 closed → #64 → #65 → #66; #67 → #68       | Proven blend stack plus separate advisory graph reputation      | shared #61 gate closed                      |
| K · private profile               | #70 → #71; #70 → #74 → #75                    | Leakage oracle, TEE pilot, and unlinkable governance consumer   | #72/#73 evaluate the MPC target in parallel |

D remains externally gated; G is now research-only. F is complete. H, J, and K are ordered
internally; the program-aware ingestion gate shared by I and J is closed in #61. None blocks the
core public repository release.

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

**Closed in `5526d6a` (PR #76).** The accepted ADR fixes issuer-known blind enrollment, private
target cards, positive replace/revoke semantics without comments, band-only member disclosure, 100
fixed PageRank iterations without BFS/trust decay, exact padded capacity/leakage policy, and a
non-binding unlinkable score-band governance consumer. The selected pilot is two reproducibly
built attested AWS Nitro scorers with two-root agreement and 2-of-3 key release. The stronger target
is four-party active MPC at `t=1`, but its confirmed independent operator set is honestly recorded
as empty, so it cannot become the pilot yet. The machine-readable policy and public-trace oracle
gate #70–#75, all assigned with explicit dependencies and exit/no-go criteria.

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

### M4.2a · #52 — weighted-prior core, guest, and production goldens

**Closed in `6530bf5` (PR #79).** A separate `weighted-prior-core` and detached
`trust-graph-weighted` SP1 guest implement TGWP V1 validation, persistent personalized-prior
PageRank, dangling-to-prior behavior, and exact mass-conserving Hamilton apportionment without
changing the binary-seed programs. Rust, TypeScript, and Solidity consume the promoted production
golden, including literal equal-remainder/address-tie vectors. Actual guest runners byte-match
empty, sparse, dangling, concentrated, tie, and max-size scenarios and reject every required
manifest/binding failure. The 2,048-entry, degree-16, 40-iteration release fixture measures
923,463,928 cycles under a strict sub-billion gate. Rebuilt trust-graph, signer-sync, Contributions,
and Hypercerts ELF hashes exactly match the branch point, proving their vkeys did not rotate.
Hosted Actions were billing-blocked before runner allocation; the Rust workspace, frontend, 575
Forge tests, prover builds/checks, guest gates, formatting, lint, regeneration, and secret scan ran
locally. Operator recovery and indexer integration are complete in dependency child #54, and the
user-facing workflow is complete in #55.

### M4.2b · #53 — weighted-prior commitment and rotation lifecycle

**Closed in `f47173d` (PR #80).** A separate `trust-graph-weighted` factory, frozen 13-field params
codec, compact TGWP validator, and typed controller create weighted instances without changing any
binary-seed factory or controller. Creation and rotation validate the exact manifest chain,
version, length, count, ordering, uniqueness, positivity, mass, root, and SHA-256 through the
constitutional 2,048-row boundary, while contracts retain only O(1) commitments and versioned
provenance metadata. Owner proposals and cancellations feed a factory-fixed delay; activation is
permissionless, replay/version guarded, and atomically updates controller, snapshot, and registry.
Already-triggered checkpoints keep their pinned hash. Events plus creation/proposal transaction
input reconstruct every exact manifest, with a fail-closed recovery runbook. The real max-row
`proposePrior` path measures 3,579,477 execution gas and 4,048,961 total L1 gas under the ADR method.
A 128,000-call stateful invariant, max-size creation, malformed/fuzz/replay tests, full Forge suite,
weighted Rust/TypeScript parity, lint, and size build pass; the weighted factory retains 12,145
bytes of EIP-170 margin and the existing governed factory retains 2,598. Hosted Actions were again
billing-blocked before runner allocation. Operator/indexer integration is complete in #54; UX
is complete in #55.

### M4.2c · #54 — weighted-prior operator recovery and indexer APIs

**Closed in `281cb68` (PR #81).** The operator discovers the isolated weighted program from the
registry, reconstructs checkpoint-pinned current or historical tuples, and routes only through the
weighted core and guest. Exact TGWP bytes recover in cache, raw-CID mirror, then archival calldata
order; every source is revalidated against chain/version/count/root/SHA commitments. Active and
pending versions are retained under bounded cache policy, degraded mirrors retry and alert, and
unavailable data disables proving. The indexer independently decodes and validates creation and
proposal calldata into reorg-safe instance/version/entry history, keeping chain lifecycle separate
from byte availability, and exposes additive paginated weighted APIs without changing binary
instance responses. Full Rust and Forge suites, the actual operator/SP1 parity gate, Ponder
codegen, 42 indexer tests, focused lint, formatting, and diff checks passed locally. Hosted Actions
were billing-blocked before runner allocation. Weighted UX is complete in #55.

### M4.2d · #55 — weighted-prior import, preview, creation, and redeployment UX

**Closed in `339adc3` (PR #82).** `/create/weighted` accepts bounded human CSV/JSON and emits
byte-tested canonical CSV/JSON, normalized TGWP, root, SHA-256, deterministic provenance, exports,
and exact #53 calldata. Invalid decimals, duplicates after resolution, wrong chain, over-cap and
oversized inputs retain editable state with field errors. ENS names resolve only at a recorded
finalized Ethereum block, never enter consensus bytes, and are re-resolved immediately before
simulation and signing; any change rebuilds all artifacts and clears approval. The asynchronous,
cancellable preview shows normalized/day-zero shares, largest/top-10 concentration, HHI, roots,
bytes and gas. Weighted creation, address-level timelocked rotation review/activation, unavailable
manifest refusal, wrong-chain safeguards, and explicit equal-weight binary prefill all fail closed.
The production #52 frontend golden, canonical/import/ENS tests, 2,048-entry worker benchmark,
headless end-to-end workflow, accessibility/recovery guard, optimized Next build, and 15 weighted
factory/controller tests passed locally. Hosted Actions again failed before runner allocation due
account billing. No factory deployment is implied: absent `weightedFactory`, import/preview/export
remain available and signing stays disabled.

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

### M4.3a · #63 — trust-compose core, SP1 guest, and production vectors

**Closed in `344cc08` (PR #90).** The isolated `composition-core` validates exact canonical source
blobs against CID/SHA-256/Merkle/total commitments, validates compact static `TGCP` policy and
captured-state `TGCM` bytes, and performs checked uint128/two-stage source-aware Hamilton allocation
with widened uint256 products. It emits canonical output bytes/CID/root plus a complete per-source
attribution ledger. The detached SP1 6.3.1 guest and native adapter pin the new program identity,
20-word params tuple, common 12-word journal, capture commitment, and instance binding without
changing any legacy guest artifact.

Independent TypeScript production vectors plus Rust and Solidity codecs/validators reproduce every
research quota, attribution, source update, output commitment, journal digest, and proof. Positive
guest scenarios cover overlap, missing accounts, unequal pools, reorder, exact reproduction,
remainder ties, updates, and representative scale; native and guest rejection gates fail closed on
commitment/source/program/freshness/quota/cap violations. The accepted maximum remains 8 required
sources and 8,192 aggregate/union entries: its 412,097-byte witness executes in 222,311,301 cycles
with 7,328 KiB host peak RSS, and the SP1 mock Groth16 path verifies exact public values. The full
Rust workspace, 610 Forge tests, 11 TypeScript composition tests, frontend suite, and aggregate
parity task passed locally. Hosted Actions were billing-blocked before runner allocation. Atomic
capture/factory wiring continues in #64.

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

**Closed in `d71ca82` (PR #78).** The shipped module supports one revocable vote delegate per
principal, proposal-pinned provisional votes, and exactly one final principal override with stored
power and tally conservation. Events, Ponder history, and governance UI preserve the original
agent, rationale, override, and transaction positions. The notification-first runner waits through
the configured notice interval, votes late with its own key, recovers across restarts, and writes
digest-bearing mode-0600 receipts; the operator runbook covers permissionless upkeep and incident
response. EAS 1.3 typed signatures keep humans as attesters while a chain/contract/schema-bounded,
zero-value, short-deadline relay pays gas. All 568 Forge tests, frontend/indexer suites, production
frontend build, strict runner compile, CI-budget fuzzing, Rust tests, secret scan, code generation,
and size checks pass. Stage 5 is isolated in #77; no deployment was attempted.

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

### M5.3 · #58 — raw ERC-8004 reputation evidence

**Closed in `62af08a` (PR #83).** The official Optimism Reputation Registry proxy, implementation
history, version, owner, identity binding, deployment block, ABI, and bytecode expectations are
pinned and fail closed on drift. Ponder preserves the canonical feedback, revocation, and response
stream with exact event provenance; reviewer attribution uses only verified-wallet history before
the feedback position and explicitly represents unattributed or ambiguous evidence. A stable bulk
API provides exact agent/reviewer/tag/unit/revocation/block filters and keyset pagination without
N+1 reads. Optional descriptors remain asynchronous, bounded, hash-checked observations behind the
#35 metadata boundary. The agent page exposes signed raw values, mutable external descriptors,
responses, revocations, and attribution evidence without creating a global score or changing any
TrustGraph edge, root, proof, or legacy golden. The rotation/revocation/response fixture, 598 Forge
tests, 52 indexer tests, frontend tests/build, code generation, and focused lint/format checks pass;
hosted jobs were billing-blocked before runner allocation.

**Close when:** all raw-event, historical-attribution, bulk-query, metadata-boundary, fixture,
operator-recovery, and no-score-coupling acceptance criteria in #58 pass. Complete.

### M5.4 · #59 — pinned-policy ERC-8004 reputation experiment

**Closed in `1608411` (PR #84).** One exact Optimism registry/cutoff, tag/unit/decimal policy,
qualified-agent reviewer epoch/root, event-time wallet attribution rule, target universe, pair
reconciliation, denominators, bounds, arithmetic, and ordering are canonically serialized and
SHA-256 committed. The exact-BigInt simulator assigns one machine-readable reason to every excluded
record and compares reviewer-weighted direct aggregation with Hamilton-apportioned, fixed-mass
positive-edge propagation. A second implementation independently reproduces serialization,
filtering, reconciliation, arithmetic, propagation, and ordering. The fixture covers repetition,
responses, revocation, wallet rotation, self-feedback, an unadmitted Sybil clone, an admitted
reciprocal ring, policy mismatch, explicit zero, and missing evidence. Only 9 of 28 declared pairs
are observed, while the small #8/#9 ring captures 66.9419% of propagated target mass, so the report
records a bounded no-go for production/proof integration. The dedicated experimental graph/table
remains outside existing scores, vouch edges, roots, and proofs. Eleven experiment tests, strict
research TypeScript, 52 indexer tests, frontend goldens/build/lint, and an HTTP route smoke pass;
hosted jobs were billing-blocked before runner allocation.

**Close when:** every policy, canonicalization, independent-golden, exclusion, coverage,
adversarial-fixture, comparison, recommendation, UI-labeling, and isolation criterion in #59 pass.
Complete.

### M5.5 · #61 — authenticated score-program ingestion and APIs

**Closed in `b725c32` (PR #85).** A single canonical registry now assigns stable program and
semantic output-domain identifiers to address-keyed TrustGraph, weighted TrustGraph,
Contributions recipients and claim UIDs, Hypercerts nodes, composition, and reserved ERC-8004
agent subjects. Ponder folds only the configured governed `InstanceRegistry`, makes the first
snapshot/program/domain/instance identity immutable, follows verifier/params rotations with exact
event provenance, checks the live snapshot verifier before reading IPFS, and rejects unknown,
conflicting, mismatched, or not-yet-enabled declarations. Ingestion, schema rows, APIs, directory,
and frontend page dispatch use that authenticated declaration; key width is validation only and
never selects a decoder. The nullable migration, dry-run-first transactional backfill, idempotent
restart repair, and indexer-first rolling deployment are documented and tested. Fixtures cover a
20-byte address and identical-looking Contributions claim, Hypercerts node, and future agent
bytes32 subjects with isolated table/API routes. All 61 indexer tests, frontend tests and
byte-identical goldens, focused lint, code generation, migration generation, and the production
frontend build pass; hosted jobs were billing-blocked before runner allocation.

**Close when:** every authenticated-source, collision, fail-closed routing, compatibility,
provenance, restart/backfill, rolling-deploy, golden-parity, and operator-documentation acceptance
criterion in #61 passes. Complete.

### M5.6 · #60 — proof-complete external ERC-8004 registry inputs

**Closed in `6d03320` (PR #89).** The accepted ADR records a no-go for a proof-complete claim over
the existing Optimism registry history: event exports, signatures, CIDs, and individual receipt
proofs authenticate supplied items but cannot prove non-omission. The only selected future path is
activation-scoped cooperation from an official or separately named registry domain: reviewed proxy
implementations synchronously append every admitted semantic event to an immutable global sidecar,
import a complete frozen starting wallet state, bind implementation epochs and exact topic/data
bytes, and freeze finalized fixed-count milestones. No pre-activation feedback becomes proven.

The executable miniature freezes 18 TypeScript/Rust/Solidity vectors for the event fold, raw
preimage fold, checkpoint, and event-time wallet attribution. Adversarial tests reject deletion,
insertion, reordering, duplication, truncation, stale forks, missing preimages, unknown upgrades,
and recovery crossing. The measured steady append is 51,674 execution gas; 16,384 records with
256-byte data produce a 9,256,968-byte witness and 192,335,661 isolated SP1 cycles, establishing the
maximum research milestone pending a complete-guest benchmark. The full 601-test Forge suite,
focused 3-test Solidity gas/golden suite, six TypeScript adversarial tests, Rust golden test, prover
library/example checks, formatting, and detached SP1 benchmarks pass; hosted jobs were
billing-blocked before runner allocation. Implementation is independently ordered as #86 → #87 →
#88 → #62, and #59's scoring-policy no-go remains in force.

**Close when:** every boundary, candidate-comparison, threat-model, canonical-encoding,
historical-attribution, fail-closed behavior, cost/exhaustion/recovery, precise-claim, executable
fixture, and independently reviewable child-issue criterion in #60 passes. Complete.

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

- **Decision track:** complete — #34, #36, and #37 have accepted ADRs and owned child splits.
- **Production track:** #27 — deploy and exercise the now-guarded creation path.
- **Feature track:** complete — #35 identity enrichment and #38 delegated actions are closed;
  graph-native delegation research continues separately in #77.
- **Weighted-prior track:** complete — #52, #53, #54, and #55 shipped the accepted #34 ADR in
  reviewable trust-boundary order.
- **ERC-8004 reputation track:** #58, #59, #60, and #61 closed. The current-history path is a
  no-go; conditional activation-era implementation is ordered #86 → #87 → #88 → #62 and remains
  gated by upstream adoption plus a future scoring-policy go.
- **Trust-composition track:** #63 closed; #64 → #65 → #66 for the remaining proven blend; #67 → #68 for separate
  advisory graph reputation. The shared program-aware ingestion gate #61 is closed.
- **Private-profile track:** #70 → #71 for the selected TEE pilot and #70 → #74 → #75 for the first
  consumer; #72 and #73 test the stronger MPC target without blocking the pilot fixture.

The target is all 17 remaining issues, but the metric is accepted behavior with evidence—not an
empty issue list.
