# How a Trust Graph Upgrades Itself

**Status:** research report, no implementation decision yet.
**Question:** what is the right pattern for changing the algorithm, its parameters, the guest program
(vkey), the seed prior, and the contracts — without a trusted operator, and without letting the
system's own output capture its evolution?
**Inputs:** repo audit of the current upgrade surface; survey of upgrade governance in production ZK
systems (rollups, SP1 integrations, L2BEAT stages); survey of what goes wrong when scoring/reputation
algorithms change (credit scoring, search, Digg, US News, Passport, OpenRank, Colony). Sources at the
end; first-principles reasoning marked **[FP]**.

---

## 1. TL;DR — the proposed pattern

TrustGraph already has the right backbone: **no proxies, immutable verifiers, versioning by
redeploy-and-repoint, two timelocked authority tiers**. The report proposes hardening that backbone
into a complete pattern, "**versioned root streams, four lanes, exit as veto**":

1. **A version is an immutable identity.** `(program, vkey, paramsSchema, journal shape)` is frozen
   at an address forever (already true: `SP1JournalVerifier` is fully immutable). Meaning never
   changes under an unchanged address. "Upgrade" = publish a new stream + consumers repoint.
2. **Four lanes, by blast radius:**
   - **Lane A — bounded params** (seed/prior rotation, damping tweaks *inside pre-committed
     bounds*): operational timelock, in place, rate-limited, bounds checked on-chain.
   - **Lane B — unbounded params** (anything outside the bounds): escalates to the constitutional
     lane. Bounds are the constitution's answer to parameter drift.
   - **Lane C — algorithm / guest / encoding** (new vkey): constitutional timelock, new verifier
     deploy + repoint, batched across sibling programs, gated on **shadow-run evidence** and a
     **reproducible-build artifact** so anyone can check vkey ↔ source before the window closes.
   - **Lane D — emergency**: a **negative-authority-only** freeze (pause root acceptance / freeze a
     route). Can never install anything. Scoped to provable soundness bugs, with a sunset. Recovery
     always goes back through Lane C — freezing removes the urgency, so the install ceremony never
     needs to be rushed.
3. **Shadow runs before votes.** A candidate `(vkey, params)` must run as a published, ZK-proven
   challenger stream for K epochs before it is even votable. The permissionless prover makes this
   nearly free: the upgrade debate happens over an attested per-account diff, not rhetoric.
4. **Non-reflexive approval.** The score distribution alone can never ratify its own successor.
   Score-weighted governance may *propose*; activation must survive an exit window long enough for
   consumers to repoint or freeze (exit-as-veto, Lido-Dual-Governance-lite), and settled epochs are
   never re-scored.
5. **Anti-front-running cutoff.** The first epoch under a new rule discounts or excludes attestations
   created after the proposal was published, so pre-positioning cannot buy standing under the new
   rule.

Sections 2–4 justify this; §5 details the pattern; §6 lists the invariants; §7 is the concrete gap
list against the current code; §8 the open questions.

---

## 2. Current upgrade surface (repo audit)

The design already splits authority into two tiers (`MerkleSnapshot.sol:21-27`,
`research/ZK_ARCHITECTURE.md:235-246`): the **constitutional** knob is *what counts as correct*
(vkey / verifier / accumulator / epoch length), the **operational** knob is *with which parameters*
(`paramsHash` only). Role wiring makes CONSTITUTIONAL the admin of OPERATIONAL so an operational
compromise cannot escalate (`MerkleSnapshot.sol:106-109`).

| Knob | Where | Mutability | Authority | Delay |
|---|---|---|---|---|
| vkey + gateway | `SP1JournalVerifier.sol:19-30` | **immutable** | change = deploy new verifier + `setZkVerifier` (`MerkleSnapshot.sol:117-121`) | constitutional timelock, **14d** (`DeployTimelocks.s.sol:34`) |
| paramsHash (17 fields incl. `seedSetRoot`, damping, weights, schemaUid, lane-2 domains, and the v2 domain separators `accumulator`/`chainId`) | `encode.rs:79-112`, `ParamsCodec.sol:40-60` | single storage slot | `setParamsHash` → OPERATIONAL (`MerkleSnapshot.sol:134-137`) | operational timelock, **2d** |
| journal (10 fields, v2) | `encode.rs:49-67` + digest rebuild in `submitProof` (`MerkleSnapshot.sol:227-240`) | **frozen, no version byte** | versioning by fresh deployment; live v1 instance frozen forever | n/a |
| accumulator / anchor registry / epoch length / hooks | `MerkleSnapshot` setters | storage pointers | constitutional | 14d |
| trusted seeds | committed as `seedSetRoot` inside paramsHash; full set is a guest witness | rotate via new `params.json` → `setParamsHash` | operational | 2d |
| gov module knobs | `MerkleGovModule.sol:415-437` | quorum, delays, snapshot pointer | `onlyOwner` | owner = timelock |
| distributor | `MerkleFundDistributor.sol:246-291` | fees, allowlist, pause | custom owner (2-step) | — |

Other load-bearing facts:

- **Enforcement is by digest match, not in-guest assertion.** `submitProof` rebuilds the journal
  digest from the *current* stored `paramsHash` and hands it to the verifier; a proof under other
  params simply fails (`MerkleSnapshot.sol:227-243`). The pin is global-latest: rotating a knob
  invalidates in-flight proofs instantly. That is the intended cutover semantics, but it means
  rotations should land at checkpoint boundaries (§5.5).
- **Vkey rotation is contagious.** The programs share a key-generic rank core; any guest change (or
  toolchain change — a reinstall shifted vkeys with zero source change, `docs/PROGRAMS.md:30-38`)
  rotates trust-graph, signer, and hypercerts vkeys together. Rotations must be batched
  (`docs/PROGRAMS.md:64-66`).
- **The four-way parity set is the real coupling surface.** pagerank-core / zk-core → guest → host →
  golden JSONs → Solidity golden tests → frontend TS port must move atomically on any encoding
  change. The address-keyed merkle-leaf format (`keccak256(keccak256(abi.encode(account, value)))`)
  is the seam that insulates gov/distributor/frontend proof consumers as long as it is preserved.
- **Timelocks are self-administered, no backdoor** (`DeployTimelocks.s.sol:92-99`), deployer hands
  off with a lockout guard. Proposer today = founding multisig; the plan to hand the operational
  proposer to `MerkleGovModule` "once stable" is noted but **not wired**
  (`ZK_ARCHITECTURE.md:244`).
- **Already-acknowledged, uncured problem:** "governance power derives from scores, which derive
  from paramsHash. A captured majority could entrench itself via the seed set … the timelock + a
  diverse, slowly-rotating seed set are the mitigations, not a cure" (`ZK_ARCHITECTURE.md:246`).
- **Gaps found:** no pause/freeze anywhere except `MerkleFundDistributor`; `setParamsHash` accepts
  any `bytes32` (no bounds, no rate limit, params illegible on-chain); no version/status field in
  `InstanceRegistry` (it is a directory, not a lifecycle registry); `GRAPH_SEEDING.md:189-201`
  leaves open whether seed-prior λ caps belong in the constitution.

---

## 3. What goes wrong when a scoring algorithm changes

The failure modes, ranked by likelihood × severity (full precedent detail in the sources):

| # | Failure mode | Precedent | Why TrustGraph is exposed |
|---|---|---|---|
| 1 | **Metric front-running of announced changes** — farm the edges the new rule will reward, before activation | universal in SEO; X open-sourcing its ranker spawned a weight-farming meta | transparency is *mandatory* here (provers need the algorithm); the entire mitigation budget must come from mechanism design |
| 2 | **Slow incumbent capture via parameter drift** — many small "reasonable" changes compound entrenchment; seeds vote seeds | Vitalik's coin-voting critique; conviction voting's "slow capture" caveat; Google self-preferencing (€2.4B, upheld 2024) | the reflexive loop is explicit: the planned MerkleGovModule-as-proposer closes it |
| 3 | **Overnight repricing shock** — step change reads as a wealth transfer; consumers hard-fork away | Digg v4 (90% user loss), Google Panda (losers never recovered), US News 2023 boycott | roots gate governance weight *and* money |
| 4 | **Governance-power renting** — attestation-buying/delegation markets assemble upgrade-voting weight without standing | Vitalik's "unbundling" attack | reputation-renting is the trust-graph analogue of vote-buying |
| 5 | **"Neutral" encoding change smuggling distributional effects** — tie-breaks, truncation, rounding | in-house precedent: the ainima θ_min fixed-point rounding hole | low scrutiny on "technical" lanes |
| 6 | **Security fix blocked by continuity rules** — a detected sybil ring keeps bleeding influence through blends/delta caps | QF sybil rounds pre-Passport | continuity and response speed are in direct tension; needs a two-track answer |
| 7 | **Objective-metric capture** — the health metric gating upgrades is itself gamed | the standard futarchy critique | put metric definition on the slowest track |
| 8 | **Version fragmentation / forum shopping** — consumers pin whichever stream favors them | OpenRank contexts (feature), Bluesky default-feed dominance (bug) | partially a feature; the *default* pointer is the residual power |
| 9 | **Retroactive resettlement** — new rules re-score settled epochs | no sane precedent allows it (credit scoring never re-underwrites closed loans) | easy to prohibit structurally; catastrophic if allowed |

Two structural lessons from the precedent survey:

- **Score production and score consumption must be decoupled.** FICO is the strongest real-world
  case: versions 2/4/5/8/9/10/10T coexist for decades; the scorer publishes versions, each *lender*
  chooses when to migrate, after validating on its own book; no loan is ever re-underwritten under a
  newer model. This is exactly the versioned-stream + consumer-pinning shape, and it dissolves most
  of "upgrade governance" into per-consumer migration decisions. The negative examples (Passport
  re-weighting every integrator's default scorer silently; US News repricing overnight) are all
  failures of this decoupling.
- **The output must not be the sole electorate.** Every mechanism that lets current winners ratify
  the next rule drifts toward entrenchment. The practical escapes are not fancy: at least one
  approval component that is *not* the score distribution — a consumer/exit veto, a distinct veto
  class, or simply an exit window long enough that leaving is a credible threat (Digg's users had
  one, and used it).

---

## 4. What production systems actually do

Condensed; the point is the pattern each one contributes.

**ZK rollups / L2BEAT stages.** Stage 1 requires that upgrades not controlled by a proper Security
Council (≥8 members, >75% threshold, ≥50% external) give a **≥7-day exit window**; Stage 2 requires
a **≥30-day exit window** and restricts council action to **onchain-provable errors**; the 2025
"walkaway test" requires guarantees to hold even if the council goes inactive. Note the subtlety:
*exit window = upgrade delay minus the time to actually complete an exit.* **Aztec is the model
closest to TrustGraph:** it reached Stage 2 by revoking ownership — rollup and verifier immutable,
upgrades = new opt-in deployments registered in a Registry, governance only moves the pointer.

**SP1 practice.** The canonical `SP1VerifierGateway` routes by a 4-byte selector to versioned
verifiers; the owner can `addRoute` and irreversibly `freezeRoute`. The **Jan 2025 SP1 v3 soundness
disclosure** (recursion under-constraint + Fiat–Shamir flaw, working exploit published) is the
governing incident: Succinct froze the vulnerable routes on the canonical gateways, shipped v4, and
every integrator then rotated its program vkey through its own setter. Two conclusions: (a) **a
zero-delay negative path (freeze) is unavoidable** — a zkVM soundness bug means hostile roots can be
proven *now*; (b) **full vkey immutability without a fast consumer-migration path is unsafe.**
Reproducibility discipline is what makes any of this auditable: pinned toolchain + Docker builds +
an OP-Succinct-style `verify-binaries` script that recomputes the vkey from source for comparison
against the proposal. OP Succinct also contributes the **atomic config bundle**: vkey + params
rotate together as one named object, never independently.

**Parameter vs code lanes.** Aave: protocol params behind a 1-day executor, governance-touching code
behind 7 days; plus the **Risk Steward** fast lane — no vote, but on-chain-enforced caps
(≤ +100% per update, one update per asset per 5 days, increase-only). Compound: 2-day timelock,
pause guardian that can pause but never unpause or move funds. MakerDAO: the GSM delay itself is a
tuned threat-level parameter (0h → 24h → 72h → … → 48h), and the ESM lets *anyone* trigger shutdown
by burning ≥50k MKR — a minority kill-switch usable inside the window against a hostile spell.
ENS: a veto council holding **only the cancel role**, with authority that anyone can expire after
2 years. The generalizable taxonomy: bounded params → steward with on-chain caps; unbounded params
→ vote + short timelock; code → vote + long timelock; emergencies → negative authority only;
nuclear → user-side exit.

**Optimistic / exit-as-veto.** Lido Dual Governance (live 2025): every DAO decision passes a dynamic
timelock; 1% of staked ETH in the veto escrow stretches it 5→45 days, 10% blocks execution until all
objectors have withdrawn — the governed class (stETH holders ≠ LDO voters) can force "you don't get
to change the rules on me before I leave." UMA oSnap: bonded optimistic execution with a challenge
window. Arbitrum: ~37 days end-to-end on constitutional changes explicitly so objectors can complete
L1 withdrawal before activation.

**Scoring systems specifically.** Passport re-weights the default scorer unilaterally (the
anti-pattern: semantic drift under an unchanged identifier); OpenRank lets the *consumer* pick
algorithm + params per job and only guarantees faithful execution; EAS never mutates a schema — new
version = new UID, consumers opt in; Colony changes its reputation formula only via coordinated
network upgrades, and because reputation re-derives from the event log a rule change *can* recompute
history (which TrustGraph must explicitly refuse for settled epochs); Optimism RetroFunding 4 showed
that voting on metric *weights* leaves the real power with whoever defines the *metrics*; Curve's
Mochi incident showed a formula-legal attack ultimately killed by a small discretionary override —
the human backstop question cannot be designed away, only scoped and sunset. And Vitalik's credible
neutrality rules bind directly: open + verifiable (we have that by construction), *simple, few
parameters*, and **don't change it too often** — the veil of ignorance is a resource that frequent
upgrades spend.

---

## 5. The pattern in detail

### 5.1 Version identity: streams, not mutations

A **version** is the immutable tuple `(program, vkey, params schema, journal shape)` plus a
**config** `(paramsHash preimage, activation epoch)`. One version = one immutable
`SP1JournalVerifier` (already true) and, for algorithm changes, a fresh `MerkleSnapshot` instance
side-by-side rather than repointing the live one wherever consumers' pins would otherwise change
meaning under them. `InstanceRegistry` grows from directory into lifecycle registry: each entry
carries a status — `candidate → canonical → deprecated → frozen` — and the "canonical" pointer is
the only thing default-following consumers track. Consumers choose their coupling explicitly:
**pin** (address a specific instance; nothing can change under you) or **follow-canonical** (accept
the registry pointer, protected by the activation delay). This is the Aztec/EAS/FICO shape, and it
kills failure mode #9 structurally and #3 partially (a step change can no longer be imposed on a
pinned consumer).

**[FP]** TrustGraph is unusually cheap to migrate: state (attestations) lives outside the contracts
and every root is recomputable from the event log, so side-by-side deployment costs a deploy + a
prover run, not a state migration. The Trail of Bits "migrate, don't proxy" argument applies with
full force; staying proxy-free is a feature to defend, not a limitation.

### 5.2 Lane A/B: parameters, bounded vs unbounded

Replace the raw `setParamsHash(bytes32)` with `setParams(Params calldata)`:

- The contract recomputes the hash via the already-on-chain `ParamsCodec.hash` — params become
  **legible on-chain** (consumers and watchers read actual damping, not an opaque hash).
- A **constitution-level bounds check** runs first: each field must lie inside pre-committed ranges
  (damping ∈ [x,y], trustShare ≤ z, per-source λ ≤ cap with a mandatory positive uniform floor,
  max per-rotation delta per field, ≥ N epochs between rotations). This answers
  `GRAPH_SEEDING.md:189-201` in the affirmative: **the λ caps are constitutional; the values inside
  them are operational.** Bounds live in a contract only the constitutional timelock can replace.
- In-bounds changes ride the operational timelock (Lane A) — seed/prior rotation stays cheap, as the
  two-tier design intends. Out-of-bounds changes are simply not executable operationally; they are a
  constitutional proposal (Lane B), with everything that entails (shadow run, long delay).

**[FP]** Bounds are the direct counter to failure mode #2 (drift): no sequence of operational
changes can walk the system outside the constitutionally ratified envelope, and each step is
rate-limited so drift is slow enough to observe and veto. They also shrink the value of front-running
any single Lane-A change (#1): a change small enough to fit the bounds is rarely worth farming.

### 5.3 Lane C: algorithm, guest, encoding (vkey rotations)

The constitutional ceremony, in order:

1. **Proposal artifact**: source diff, the candidate vkey, the pinned-toolchain + Docker build
   recipe, and a `verify-binaries`-style task so anyone can recompute the vkey from source. A
   proposal whose vkey cannot be independently reproduced is not votable. (This is what makes the
   objection window real rather than theatrical.)
2. **Shadow run (champion/challenger)**: the candidate config is registered as `candidate` and
   proven as a **published challenger stream for ≥ K epochs** over live data — the permissionless
   prover means anyone can produce these roots; the indexer/frontend render the per-account diff.
   Objective gates checked on the shadow roots (see §6, soft invariants): sybil-corpus
   non-regression, concentration non-regression, continuity bound. A candidate failing a gate is not
   votable on the standard track.
3. **Approval**: score-weighted governance may propose and approve, but see §5.4 — approval alone
   does not activate.
4. **Exit window**: ≥ the constitutional delay (14d today; raise toward 30d once real value rides on
   the roots, per the Stage-2 norm), measured so a consumer can actually *complete* a repoint or
   freeze within it.
5. **Batched activation** at an epoch boundary, rotating all sibling-program vkeys in one ceremony
   (the shared-core contagion makes dribbling rotations both expensive and confusing).
6. **Anti-front-running cutoff**: the new version's first epoch commits (inside its paramsHash) to
   an input cutoff at the proposal-publication block — attestations created after the proposal are
   excluded or discounted in the first activated scoring. **[FP]** This kills pre-positioning (#1)
   at the cost of delaying legitimate adaptation by one window; the highest-gaming-value surface
   (seed-list adjacency farming) additionally stays on this slowest lane.

**Continuity (optional, decide per §8):** the guest can commit to `(R_old_root, R_new_root, λ_t)`
and blend over N epochs, or clamp per-account delta per epoch. Precedent says step changes are how
legitimacy dies (#3), but blending extends the gaming window and lets a caught sybil ring bleed
slowly instead of dying — which is why the *only* bypass of any continuity rule should be an
**exploit certificate**: a ZK-proven demonstration that a cluster with attestation cost < C achieves
score mass > S under current rules. Proof-of-exploit unlocks the fast track; taste never does.

### 5.4 Non-reflexive approval and exit-as-veto

The plan to hand the operational proposer role to `MerkleGovModule` closes the reflexive loop the
architecture doc already worries about: the roots elect the weights that rotate the params that
produce the roots. Recommendation: **never let score-weighted approval be sufficient on its own.**
Minimum viable version (no new mechanism design): score-weighted governance proposes; activation
must survive the exit window with consumers free to repoint/freeze — exit is the veto, which only
works because §5.1 makes non-migration a real option. Stronger versions, in escalating order of
machinery: a distinct objection class that can *extend* the window (Lido-style veto escrow, e.g.
bonded attestors or consumer contracts stretching 14d → 45d); a two-house check where a
non-score-weighted class (consumer contracts registered in `InstanceRegistry`, or an
attestor-headcount quorum) holds a time-boxed veto (Optimism Citizens'-House-shaped). **[FP]** The
principle from failure modes #2/#4: at least one legitimacy source in every activation path must be
something the current score distribution cannot buy.

### 5.5 Lane D: emergency, negative authority only

The SP1 Jan-2025 incident is the design load: a soundness bug means a hostile root can be proven
*today*, and the 14-day ceremony is too slow to stop it. Add a freeze path with these properties:

- **Powers**: pause `submitProof` on an instance / mark an instance `frozen` in the registry.
  **Nothing else** — never install a vkey, never set params, never bypass a delay, never move funds.
  (Polygon zkEVM's emergency-state scope creep and ZKsync's 3/3 zero-delay upgrade board are the
  cautionary tales; Aave's cancel-only Governance Guardian and ENS's cancel-only council are the
  models.)
- **Scope**: written charter limited to onchain-provable / demonstrable soundness errors (the L2BEAT
  Stage-2 constraint), not liveness, not taste.
- **Sunset**: authority expires automatically after a fixed term (ENS pattern: anyone can call the
  expiry) unless constitutionally renewed.
- **Recovery is boring on purpose**: a frozen system stops bleeding, so the patched version goes
  through the normal Lane C ceremony (possibly with the shadow-run K reduced, never with the
  reproducibility requirement waived). Freeze removes urgency from install — that separation is the
  whole trick, and it is exactly how the SP1 incident actually played out (Succinct froze routes;
  integrators rotated on their own schedules).
- **[FP]** Consider also a Maker-ESM-shaped *permissionless* variant: anyone who burns/bonds above a
  high threshold can force-freeze pending constitutional review — a minority kill-switch that works
  even if the council is captured or asleep. Optional; the council with sunset is the v1.

### 5.6 Mid-stream mechanics

Because `submitProof` checks against global-latest `(zkVerifier, paramsHash)`, any rotation
invalidates in-flight proofs. Keep that semantics (it is the correct fail-closed default), but:
schedule executions at checkpoint boundaries; document in the runbook that provers must not start a
proving run inside a timelock's execution window without checking the pending-operation queue; and
have the registry emit the upcoming `(config, activation epoch)` so provers and indexers can prepare
both sides of the cutover. Settled roots are untouched by construction (`stateBlocks` is
append-only, results file at input-freeze block, `MerkleSnapshot.sol:248-250`).

---

## 6. Invariants any upgrade must preserve

**Hard invariants** (the mechanism must make violation impossible):

1. **Determinism & reproducibility per version.** Every root is fully determined by
   `(instance, vkey, paramsHash, input cutoff)`; anyone can recompute byte-identically; every
   proposed vkey is reproducible from published source + pinned toolchain.
2. **No mutation of meaning at an address.** New algorithm/encoding/journal ⇒ new immutable identity
   (EAS pattern); retired lineages are marked, never rewritten.
3. **Settled-epoch immutability.** No re-scoring, re-settling, or reallocating anything finalized
   under a prior version. Upgrades reprice future flow only. (This also caps the payoff of capture:
   taking the upgrade only buys the future, not history.)
4. **Consumer exit before activation.** A pinned consumer is never switched underneath; the
   canonical-pointer delay exceeds the time to actually complete a repoint/freeze.
5. **Non-reflexive approval component.** No activation path exists in which the current score
   distribution is the only legitimacy source.
6. **Anti-front-running rule.** The first activated epoch of a new version excludes or discounts
   attestations created after the proposal's publication.

**Soft invariants** (objective gates checked on shadow roots; block the standard track, overridable
only on Lane D/exploit-certificate with mandatory post-hoc publication):

7. **Score-continuity bound** — per-account delta per epoch across activation ≤ δ (blend or clamp);
   proof-of-exploit is the only bypass.
8. **Sybil-resistance non-regression** — the candidate must not score the versioned adversarial
   corpus (canonical sybil fixtures; grows monotonically, never shrinks) higher than the incumbent.
9. **Concentration non-regression** — shadow-root HHI/Gini and seed-mass share must not exceed a
   pre-committed bound relative to the incumbent; this is the direct, measurable check on incumbent
   self-dealing.
10. **Two-track tempo** — taste changes ride the slow lane in full; the fast lane exists only for
    exploit certificates and may touch only bounded params, never algorithm, encoding, or seeds.

---

## 7. Gap list: concrete changes to the current repo

Ordered by leverage; none are decided — this is the menu.

1. **Lane D freeze** (biggest uncovered risk today): a pause on `MerkleSnapshot.submitProof` (and
   `SignerSyncZkModule.submitSignerProof`) held by a cancel/freeze-only council with an ENS-style
   sunset. Currently the only pause in the stack is on the fund distributor; a live SP1 soundness
   bug would let hostile roots land for the full 14 days of the rotation ceremony.
2. **`setParams(struct)` with constitutional bounds + rate limit** replacing `setParamsHash(bytes32)`
   (§5.2). Also resolves the `GRAPH_SEEDING.md` open question: λ caps constitutional, values
   operational. Bounds contract swappable only via the constitutional timelock.
3. **`InstanceRegistry` lifecycle**: status field (`candidate/canonical/deprecated/frozen`),
   canonical pointer, and pending-activation announcements (config + activation epoch). Consumers
   document pin-vs-follow. Frontend/indexer learn to render challenger streams and per-account
   diffs — this is most of the shadow-run machinery, and the prover side already exists.
4. **Reproducible-build artifact as protocol requirement**: a `task verify-vkey` (pinned toolchain +
   Docker + recompute-and-compare, OP-Succinct-style) required in every Lane C proposal. The repo
   already documents the toolchain-shifts-vkey hazard; this turns the hazard into a checkable
   artifact.
5. **Do not wire `MerkleGovModule` as sole proposer** without a non-score component in the
   activation path (§5.4). The minimum is formalizing exit-as-veto: registry delay ≥ consumer
   migration time, and consumer freeze rights.
6. **Anti-front-run cutoff support in the guest**: a `proposalCutoffBlock` (or discount factor)
   param, committed in paramsHash, applied in the first activated epoch of a new version.
7. **Delays**: keep 14d/2d pre-value; plan the move toward 30d constitutional (Stage-2 norm) when
   real governance weight and funds ride on the roots. Treat the delay itself as a tuned,
   reviewable parameter (Maker's GSM lesson), changeable only constitutionally.
8. **Shadow-run + rotation runbook**: K epochs, gate predicates (#7–9), boundary-aligned execution,
   sibling-vkey batching, prover guidance for cutover windows. Mostly documentation + indexer work.
9. **Optional / later**: blending or delta-clamp in the guest (decide with #8's gates); a
   permissionless ESM-style force-freeze; a Lido-style veto escrow for window extension.

**[FP]** Note what is *not* on the list: proxies, in-place vkey setters, a general-purpose upgrade
multisig. The existing immutable-verifier + redeploy-and-repoint discipline is the strongest asset
here; every recommendation above adds evidence, bounds, exits, or negative authority — none adds
positive upgrade power.

---

## 8. Open questions (for Jake)

1. **Council**: who sits on the Lane D freeze council, what size/threshold (Stage-1 norm: ≥8,
   >75%, ≥50% external — probably overkill pre-launch; a 3–5 with a 2-year sunset may be the
   pragmatic v1), and is a permissionless burn-to-freeze wanted at all?
2. **Delays**: confirm 14d/2d for now and the trigger for moving to 30d ("value at stake" needs a
   definition — TVL in the distributor? gov module controlling a treasury?).
3. **Continuity**: adopt blending/delta-clamp, or accept step changes with only the shadow-run diff
   as warning? (Simplicity argues for step + long window in v1; the Digg/Panda precedent argues for
   a clamp once money flows.)
4. **Non-score veto class**: exit-as-veto only (no new machinery), or a real second house
   (registered consumers? attestor headcount? bonded objection escrow)?
5. **Params legibility trade-off**: `setParams(struct)` puts the full seed list/prior on-chain per
   rotation (calldata cost, and the seed list becomes trivially enumerable — it already is via the
   witness, but this makes it louder). Acceptable?
6. **Default power**: who governs the *canonical pointer* that frontends/indexers follow? This is
   the residual power that versioning does not dissolve (Bluesky's default-feed lesson) and deserves
   an explicit answer rather than an implicit founding-multisig one.

---

## Sources

**Repo**: `src/contracts/merkle/MerkleSnapshot.sol`, `src/contracts/merkle/SP1JournalVerifier.sol`,
`src/contracts/params/ParamsCodec.sol`, `script/DeployTimelocks.s.sol`,
`packages/pagerank-core/src/encode.rs`, `research/ZK_ARCHITECTURE.md` (Decisions 1–3, trust-surface
table), `research/GRAPH_SEEDING.md` (§seed_prior_root, §open governance question),
`research/MULTI_PROGRAM_PLATFORM.md`, `docs/PROGRAMS.md` (vkey table, toolchain caveat),
`docs/trust-graph/RUNBOOK.md`, `docs/DEVIATIONS.md`.

**ZK / rollup governance**: [L2BEAT stages](https://l2beat.com/stages) ·
[Introducing Stages](https://medium.com/l2beat/introducing-stages-a-framework-to-evaluate-rollups-maturity-d290bb22befe) ·
[SC requirements update](https://medium.com/l2beat/stages-update-security-council-requirements-4c79cea8ef52) ·
[walkaway test](https://forum.l2beat.com/t/stage-1-requirements-update-security-council-walkaway-test/412) ·
[ZKsync governance procedures](https://docs.zknation.io/zksync-governance-procedures/schedule-1-standard-governance-procedures) ·
[Aztec Stage 2](https://thedefiant.io/news/blockchains/aztec-l2beat-stage-2-governance-revokes-rollup-contract-ownership) ·
[Scroll SC transition](https://forum.scroll.io/t/governance-update-security-council-transition-contributor-roles-operational-adjustments/1470) ·
[Polygon zkEVM emergency post-mortem](https://blockworks.co/news/polygon-zkevm-post-mortem)

**SP1**: [SP1VerifierGateway](https://github.com/succinctlabs/sp1-contracts/blob/main/contracts/src/SP1VerifierGateway.sol) ·
[Solidity SDK / freeze](https://docs.succinct.xyz/docs/sp1/verification/solidity-sdk) ·
[reproducible builds](https://docs.succinct.xyz/docs/sp1/writing-programs/compiling) ·
[Jan 2025 security disclosure](https://blog.succinct.xyz/sp1-security-update-1-27-25/) ·
[LambdaClass writeup](https://blog.lambdaclass.com/responsible-disclosure-of-an-exploit-in-succincts-sp1-zkvm-found-in-partnership-with-3mi-labs-and-aligned-which-arises-from-the-interaction-of-two-distinct-security-vulnerabilities/) ·
[OP Succinct verify-binaries](https://github.com/succinctlabs/op-succinct/blob/main/book/advanced/verify-binaries.md) ·
[OP Succinct config bundles](https://github.com/succinctlabs/op-succinct/blob/main/book/validity/contracts/update-parameters.md) ·
[SP1Helios](https://github.com/succinctlabs/sp1-helios/blob/main/contracts/src/SP1Helios.sol) ·
[SP1Blobstream](https://github.com/succinctlabs/sp1-blobstream/blob/main/contracts/src/SP1Blobstream.sol)

**Param/code lanes & vetoes**: [Compound governance](https://docs.compound.finance/v2/governance/) ·
[Aave governance v2](https://github.com/aave/governance-v2/blob/master/README.md) ·
[Aave Risk Steward](https://governance.aave.com/t/bgd-risk-steward-phase-1-capsplusrisksteward/12602) ·
[Maker GSM/flash-loan episode](https://www.coindesk.com/tech/2020/10/30/makerdao-members-voting-on-a-safeguard-against-bprotocol-flash-loan-type-attack) ·
[Maker ESM](https://docs.makerdao.com/smart-contract-modules/emergency-shutdown-module) ·
[ENS security council](https://docs.ens.domains/dao/security-council/) ·
[Optimism OPerating Manual](https://github.com/ethereum-optimism/OPerating-manual/blob/main/manual.md) ·
[Lido Dual Governance](https://blog.lido.fi/dual-governance-101-explainer/) ·
[LIP-28](https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-28.md) ·
[oSnap](https://medium.com/uma-project/announcing-osnap-v2-seamless-dao-governance-with-optimistic-snapshot-execution-38b08a25e035) ·
[Arbitrum governance](https://github.com/ArbitrumFoundation/governance/blob/main/docs/overview.md) ·
[StarkEx escape hatch](https://docs.starkware.co/starkex/perpetual/perpetual-trading-forced-withdrawal-and-forced-trade.html)

**Scoring-algorithm precedents**: [Vitalik — beyond coin voting](https://vitalik.eth.limo/general/2021/08/16/voting3.html) ·
[Vitalik — credible neutrality (mirror)](https://balajis.com/p/credible-neutrality) ·
[Passport weights](https://support.passport.xyz/passport-knowledge-base/stamps/how-is-gitcoin-passports-score-calculated) ·
[OpenRank protocol](https://docs.openrank.com/the-reputation-stack/openrank-protocol) ·
[Colony reputation mining](https://docs.colony.io/develop/dev-learning/reputation-mining/) ·
[SourceCred wind-down](https://discourse.sourcecred.io/t/sourcecred-the-organization-is-winding-down/1383) ·
[EAS schemas](https://docs.attest.org/docs/core--concepts/schemas) ·
[RetroFunding 4 learnings](https://gov.optimism.io/t/retro-funding-4-learnings-and-reflections/9271) ·
[Curve/Mochi Emergency DAO](https://www.coindesk.com/business/2021/11/11/curve-wars-heat-up-emergency-dao-invoked-after-clear-governance-attack) ·
[FICO version coexistence](https://legalclarity.org/fico-8-9-10-and-10t-how-newer-fico-versions-differ/) ·
[FICO 10T mortgage adoption](https://investors.fico.com/news-releases/news-release-details/mortgage-lenders-report-strong-results-early-adoption-fico-score) ·
[Digg v4 case](https://aiinstitute.hbs.edu/platform-digit/submission/the-demise-of-digg-how-an-online-giant-lost-control-of-the-digital-crowd/) ·
[Panda aftermath](https://searchengineland.com/google-panda-two-years-later-losers-still-losing-one-real-recovery-149491) ·
[US News methodology change](https://thedailyrecord.com/2023/01/03/us-news-to-change-ranking-system-after-law-schools-boycott/) ·
[Knight Institute on X's algorithm](https://knightcolumbia.org/blog/twitter-showed-us-its-algorithm-what-does-it-tell-us) ·
[Hanson — futarchy](https://mason.gmu.edu/~rhanson/futarchy.pdf) ·
[SR 11-7 champion/challenger](https://www.magicmirrorsecurity.com/blog/sr-11-7-model-risk-management-guidance-explained) ·
[Trail of Bits — upgrade anti-patterns](https://blog.trailofbits.com/2018/09/05/contract-upgrade-anti-patterns/)

**Verification caveats carried from research**: ZKsync SC size (docs say 9-of-12, onchain discovery
shows 8), Polygon zkEVM 3d-vs-10d timelock conflict, Succinct gateway 2/3 multisig is
L2BEAT-observed rather than Succinct-published, Kleros Governor deployed deposit values unpublished.
The verified production vkey emergency swap is Scroll's (~2026-02-23, `ZkEvmVerifierPostFeynman`).
