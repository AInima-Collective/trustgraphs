# Proof Scheduling & Proving Economics

**Status:** **BUILD DECIDED 2026-07-27** — the execution spec is `GOAL.md` (retired; see git history), covering
all four phases of §6. Every question this doc raised is answered in §7, §8, and §9; §9 also
records the three architecture decisions taken at build time, one of which **supersedes §4.3's
commit-reveal recommendation**.
**Depends on:** `research/INSTANCE_FACTORY.md` (instance enumeration, params-in-calldata),
`research/UPGRADE_GOVERNANCE.md` (rotation + Lane D constraints on provers),
`research/ZK_ARCHITECTURE.md` (journal, checkpoint model).

---

## 0. Problem

WAVS used to be the thing that noticed work and did it: components were triggered by
on-chain events (`MerklerTrigger`, indexer events) or block intervals, and the operator
quorum produced the root. The ZK migration deliberately kept the *on-chain* half of that
machinery and deleted the *off-chain* half:

- `MerkleSnapshot.trigger()` is permissionless, epoch-gated by the contract-fixed
  `epochLength`, freezes both lanes, and emits `SnapshotTriggered` /
  `InputsCheckpointed(id, acc, leafCount, blockNumber)` — the docstring literally says
  "provers watch InputsCheckpointed" (`contracts/src/merkle/MerkleSnapshot.sol:174`).
- `submitProof` is permissionless and monotonic (`StaleCheckpoint`), and files state at
  the input-freeze block, so delayed/racy/redundant proving is already safe on-chain.

Nobody watches. Every root produced so far was a human running the RUNBOOK. This doc
proposes the missing piece — **the operator** — and the **economics** that let factory
communities shoulder proving costs instead of us.

Two goals from the top:

1. **Epoch cadence by default, manual refresh as a first-class path.** Both already route
   through the same function: a "refresh scores" button is just a `trigger()` call, and
   the epoch gate makes it spam-bounded by construction.
2. **Communities pay for hosted proving; self-proving stays free and permissionless.**

---

## 1. What already exists (load-bearing inventory)

| Piece | State | Role in the scheduler |
|---|---|---|
| `trigger()` + `epochLength`/`lastTriggerBlock` | built | contract-fixed cadence + permissionless manual request, one seam |
| `InputsCheckpointed` / `SnapshotTriggered` events | built | the operator's wakeup signal |
| `submitProof` monotonicity + input-freeze-block filing | built | makes multiple/racing operators safe; intermediate checkpoints skippable |
| `AttestationAccumulator.checkpoint()` `NoNewInputs` guard | built | quiet instances cost nothing — a checkpoint needs ≥1 new edge |
| `crates/input-exporter` (+ `contributions fetch`, `witness fetch`) | built | self-checking input assembly from RPC alone |
| `zk/prover` CLI (`prove --groth16`, `SP1_PROVER=network`) | built | proving backend already speaks to the Succinct network |
| `InstanceRegistry` | built, dormant | enumeration source for a multi-instance loop |
| `InstanceCreated` full-params event (factory §2.1) | designed | makes the hosted loop config-free per instance |
| Operator daemon | **missing** | this doc |
| Payment/bounty layer | **missing** | this doc |

Old-WAVS spec, for reference (recovered from git history, `config/components.json` @
`31ddd2b^`): root producer triggered on `MerklerTrigger(uint64)` + indexer events; pruner
on a 2000-block interval; signer-sync triggered on `MerkleRootUpdated`. The operator
below is the same trigger topology, minus the operator quorum, plus payment.

---

## 2. The operator (`zk/operator`)

One long-running Rust daemon — working name **`trustgraph-operator`** — following the
standard SP1 light-client "operator" shape (sp1-helios / sp1-blobstream, whose operator
sources we verified): an interval tick with a stateless, idempotent `run_once` per
instance, **two separate keys** (`NETWORK_PRIVATE_KEY` for the PROVE balance, a
destination-chain key for submit gas — optionally both KMS-held), a startup vkey check
against the deployed verifier, short-sleep retry on error, and alerting. Rust because
`input-exporter` and `zk/prover` are Rust: the daemon links them as library crates
(shelling out to the CLIs is an acceptable v1 seam; the byte-paths stay untouched either
way). Deployed as a fourth service in `docker-compose.prod.yml` next to
`ponder`/`ponder-server`.

### 2.1 Control loop

Per tick (~1 min) and per registered instance:

```
1. READ      snapshot.{epochLength, lastTriggerBlock, lastAppliedCheckpoint, paramsHash}
             accumulator.{leafCount, checkpointCount}   (all via RPC; Ponder optional)
2. TRIGGER   if cadence elapsed AND leafCount > last checkpointed leafCount:
                 send trigger()            # else skip — quiet instance, zero cost
3. OBSERVE   any InputsCheckpointed with id > lastAppliedCheckpoint
             (ours or anyone's — a manual trigger() looks identical)
4. COALESCE  prove ONLY the newest unproven checkpoint
             (monotonic submitProof means intermediates can be skipped forever)
5. ASSEMBLE  per-program input (§2.3); self-check the re-fold vs the checkpoint acc
6. GUARD     check the operational/constitutional timelocks' pending-op queues:
             a queued paramsHash/zkVerifier rotation ⇒ hold this instance, alert
             (UPGRADE_GOVERNANCE §5.6 — a rotation invalidates in-flight proofs)
7. PROVE     SP1_PROVER=network, Groth16; journal the request id to disk first
8. PIN       blob.json → IPFS (CID must equal the guest's in-journal CID)
9. SUBMIT    submitProof(...); on StaleCheckpoint revert: drop job (someone landed a
             newer root — that's success, not failure); deterministic execution reverts share a
             persistent per-checkpoint counter across estimate/simulation/mined receipts. At the
             configured threshold, abandon only that immutable checkpoint and advance after new
             inputs; provider/fee/timeout/reorg failures remain retryable.
```

Design properties worth stating explicitly:

- **Stateless by default.** Everything in steps 1–4 re-derives from chain; the contracts
  are the scheduler's database. The only local state is a small journal of in-flight
  Succinct request ids keyed `(chain, instance, checkpointId)` so a crash-restart doesn't
  pay for the same proof twice.
- **The operator's cadence is the operator's choice.** `trigger()` being permissionless
  means anyone can mint checkpoints (bounded by `epochLength` and `NoNewInputs`), but
  minting a checkpoint does not compel anyone to prove it. Coalescing (step 4) makes
  trigger-spam cost the spammer gas and cost the operator nothing beyond its own chosen
  cadence. This is the grief-resistance story for hosted proving, together with the
  factory's `epochLength` floor (INSTANCE_FACTORY §2.2).
- **Many operators compose.** Monotonic submitProof + input-freeze-block filing means N
  operators (ours, a community's, a bounty hunter's) can run the same loop concurrently;
  the worst case is wasted proving spend, never wrong state. Duplicate-spend avoidance
  between *cooperating* operators is an off-chain concern (the bounty layer in §4 makes
  it an economic one).
- **Fail closed on config drift.** The operator proves only with a params preimage whose
  `ParamsCodec.hash` equals the on-chain `paramsHash` (factory instances: recovered from
  the `InstanceCreated` event; legacy instances: from config). Mismatch ⇒ halt instance,
  alert, never guess.

### 2.2 Instance enumeration

- **v1 (now, pre-factory):** the operator reads the same static catalog the indexer uses
  (`config/networks.*.json` / `deployment_summary.json`). This unblocks the daemon for
  the existing trust-graph + signer + contributions + hypercerts deployments immediately.
- **v2 (factory):** enumerate `InstanceRegistry` + subscribe to `InstanceCreated`; params
  come from the event (the params-in-calldata trick is precisely what makes this loop
  config-free — INSTANCE_FACTORY §2.1). New instance ⇒ picked up on the next tick, no
  ops ticket.

### 2.3 Per-program handlers

The loop is generic; input assembly and the submit target are per-program:

| Program | Wakeup | Input assembly | Submit | Fully automatable? |
|---|---|---|---|---|
| trust-graph | epoch tick / `InputsCheckpointed` | `input-exporter` (RPC only) | `submitProof` | yes |
| signer-sync | `MerkleRootUpdated` on the trust instance (same topology as old WAVS) | `input-exporter --signer` | `SignerSyncZkModule.submitSignerProof` | yes |
| contributions | epoch tick / `InputsCheckpointed` | `contributions fetch` (RPC, two checkpoints incl. `TrustAccumulatorMirror`) | `submitProof` | yes |
| hypercerts / atproto | epoch tick, **plus an anchor pre-step** | `witness fetch` (PDS CARs + PLC) → `buildinput` | `submitProof` | yes, with the anchor loop below |

**The atproto anchor pre-step is part of scheduling.** Lane-2 instances need
`AnchorRegistry.anchor(...)` called with fresh head digests *before* `trigger()` freezes
the lane; the witness bundle must then be fetched for exactly those anchored heads. So
for these instances the per-epoch sequence is `anchor heads → trigger → witness fetch →
buildinput → prove → submit`, all owned by the same per-instance state machine. The
operator should also **pin the witness bundle to IPFS** alongside the score blob: for
lane-1 programs anyone can rebuild inputs from RPC, but for lane-2 the escape valve
("you can always prove it yourself") is only real if the witness data for past epochs is
publicly retrievable.

### 2.4 Manual refresh, concretely

- **Scheduled instances (`epochLength > 0`):** "Refresh now" in the frontend = a wallet
  `trigger()` tx. It succeeds any time after the boundary, so a community that wants
  scores *right now* rather than whenever the hosted tick next comes around pulls the
  epoch forward themselves; the operator sees the checkpoint and proves it like any
  other. Mid-epoch it reverts `EpochNotElapsed` — the UI should read
  `lastTriggerBlock + epochLength` and disable the button with a countdown instead of
  letting the tx bounce. Epoch boundaries stay never-prover-chosen (the lane-2
  withholding-security invariant, OFFCHAIN §4.1); manual refresh moves *when within the
  allowed window* a checkpoint happens, never what a checkpoint may contain.
- **Unscheduled instances (`epochLength == 0`):** `trigger()` works any time there are
  new edges. Hosted proving for these must be vault-funded (§4) — an uncapped free tier
  on an ungated trigger is an invitation to make us buy proofs.
- **Paid priority (later):** a `requestProof{value}` deposit on the vault that flags a
  checkpoint for immediate proving ahead of the batch tick. Not v1; the free path above
  already covers the "someone wants fresh scores" story.

---

## 3. Proving backend + costs

*(Succinct facts below verified 2026-07-24 against docs.succinct.xyz, the sp1-sdk source
on `dev`, and the sp1-helios/sp1-blobstream operator sources; market prices marked ~.)*

### 3.1 The Succinct Prover Network today

- **Two networks, three strategies.** Mainnet auction network (`rpc.mainnet.succinct.xyz`,
  strategy `Auction`: reverse auction, lowest bid wins, prover stake slashed on missed
  deadline) and a reserved/hosted network (`rpc.production.succinct.xyz` — our current
  env points here — strategy `Hosted`, or `Reserved` under a contractual SLA). Needs
  sp1-sdk ≥ 6.1; we're pinned to toolchain 6.3.1, so no upgrade cliff.
- **Payment is PROVE, prepaid.** Requests draw from a PROVE (ERC-20) balance deposited
  into the SuccinctVApp escrow, tied to the requesting `NETWORK_PRIVATE_KEY` (secp256k1;
  AWS KMS supported). No USDC, no fiat credits on the auction network. Balances can be
  transferred between network accounts, so funding a community's own requester account
  is possible, but there is no third-party-payment primitive — whoever signs, pays.
- **No public rate card.** Fee = dynamic per-mode base fee (Groth16/PLONK/compressed) +
  clearing-price-per-PGU × PGUs (PGU ≈ cycles adjusted for precompiles). The SDK's
  default price cap is market+20%. For sizing, the closest published cross-market anchor
  is Boundless's worked example at **~$0.80–2.00 per Gcycle**; Succinct auction clears
  are believed lower. Succinct's Reserved tier has real SLAs ("proof in under 30 s"
  class) at contact-sales pricing.
- **Latency.** For programs under ~2M PGU, fixed overhead dominates; the Groth16 wrap
  adds ~6 s; auction adds ~10–30 s. Our per-epoch proofs land in roughly the ~1-minute
  class end-to-end — cadence will never be latency-bound.
- **The production requester recipe exists.** sp1-blobstream's operator is the template:
  `Auction` + `skip_simulation(true)` + explicit `cycle_limit`/`gas_limit` +
  `min_auction_period(10)` + 30-min proof timeout, 10 s error backoff, vkey check at
  startup, and — important — **two separate keys**: `NETWORK_PRIVATE_KEY` (PROVE
  balance) and the destination-chain submitter key (gas), optionally both in KMS.

### 3.2 What our proofs cost

- Guest cycles today: trust-graph ≈ 1.8M, signer ≈ 1.85M, hypercerts pilot ≈ 4M. At the
  ~$1–2/Gcycle anchor that is **fractions of a cent of marginal proving per root** — the
  real per-proof cost is the base fee + auction overhead, i.e. **cents, not dollars**,
  until graphs get much bigger. Growth is roughly linear in edges/records.
- The exception: the atproto feasibility memo's ~100k-signature graphs at 23–45B cycles
  ≈ **$20–90/proof** at the same anchor — a genuinely different cost class. Price this
  before promising cadence to large atproto communities; it is the one place "per-root
  bounty" must scale with instance size.
- `submitProof` ≈ 0.6M gas (state+journal ≈ 346k, Groth16 verify ≈ 270–330k). With
  **Ethereum mainnet decided as home chain** (2026-07-24), that is low single-digit
  dollars per root at 1–2 gwei — **gas, not proving, is the dominant per-root cost**,
  and the vault's gas-reimbursement leg matters more than its proving-fee leg. Monthly
  cadence keeps even a large instance count affordable; the operator should also
  basefee-gate submissions (wait out gas spikes — a root that lands six hours late is
  still filed at its input-freeze block).
- `trigger()` is a cheap tx (checkpoint write + events).
- Self-hosting: a single RTX 4090-class box (24 GB VRAM, 32–64 GB RAM) proves this class
  end-to-end; marginal cost per proof is negligible but a 24/7 cloud box is ~$220–500/mo
  — the network wins below roughly hundreds of proofs/day, and self-hosting stays a real
  option for motivated communities, which keeps hosted pricing honest.
- **Treasury note:** communities will pay the vault in ETH/USDC; Succinct bills in
  PROVE (~$0.19, floating). The hosted operator carries a small PROVE float and FX
  exposure. Keep the vault denominated in what communities hold; treat PROVE as an
  operational input we restock, not a token we make customers touch.

---

## 4. Economics: who pays

### 4.1 The cost object

One root = one proof + one submit + (amortized) trigger + pinning + ops. Per instance per
epoch, order-of-magnitude **single-digit dollars** today, dominated by the proof (with a
fixed Groth16-wrap floor, so cost is *per root*, only weakly per size at our scale). Two
structural facts shape everything else:

1. **Quiet instances are free.** No new edges ⇒ no checkpoint ⇒ no proof. Cost scales
   with active communities only.
2. **Proving is permissionless.** Any pricing we set is disciplined by "fork the loop and
   run it yourself" — the hosted service sells convenience and reliability, not access.

### 4.2 Three funding layers (recommendation)

**Layer 0 — free floor (hosted, our cost).** Every factory instance gets automatic
proving at a **monthly** floor cadence (decided 2026-07-24; this answers
INSTANCE_FACTORY §8.5 and sets the factory `epochLength` floor at ~30 days of blocks).
This is CAC: a community's first contact with trustgraphs must not be a bill. Bounded and
predictable: `N_active × cost per root / month`. The floor never draws the vault —
everything above it does; that keeps "free tier" an honest sentence.

> **SUPERSEDED 2026-07-27 (Jake): curated subsidy, not a universal floor.** Two errors
> above. (a) `N_active` is *not* bounded: the factory is permissionless, so an attacker
> mints instances and keeps each one barely active for ~1 attestation of gas per epoch,
> making us pay a ~600k-gas submit — roughly 4-5x gas leverage, indefinitely. (b) The
> factory `epochLength` floor does not bound per-instance cost either: the admin holds
> `CONSTITUTIONAL_ROLE` from the creating transaction and `setEpochLength` is
> constitutional, so any creator can lower their own epoch immediately after creation
> (`TrustgraphsFactory.sol:317-319`). The floor binds creation, nothing after it.
> The replacement: the hosted operator proves a **curated set**; everyone else
> self-proves (free, permissionless, unchanged) or funds a vault. Three intervals are
> now distinct — the factory's creation floor (anti-spam), the operator's subsidy
> cadence (policy), and the vault's `minPaidIntervalBlocks` (the only one enforceable
> on-chain). See §10.1.

**Layer 1 — the proving vault (communities pay for more).** A per-instance prepaid gas-tank
— the Gelato 1Balance / Chainlink Automation "upkeep balance" pattern, which is the
proven UX for exactly this problem:

- `ProvingVault` (one contract, instance-keyed balances; **ETH and USDC both accepted**,
  tracked as two balances per instance). Anyone can top up any instance — communities,
  their DAOs, a patron.
- The vault pays out **per landed root**: when `submitProof` for instance I lands
  checkpoint C, the prover can claim `bounty(I, C)`. Faster-than-monthly cadence,
  unscheduled instances, and paid-priority refreshes all draw from the same balance.
- **Bounty is cost-indexed, not flat** (decided 2026-07-24):
  `bounty = gasReimbursement + provingFee`. Gas reimbursement is computed from the
  submit tx's observable `gasUsed × basefee` (native, no oracle needed). The proving
  fee comes from an on-chain **fee schedule** — `feePerRoot(program, sizeBand)` in USD
  terms, set by a FEE_SETTER role (us initially, timelocked later) — converted at claim
  time via a Chainlink-class ETH/USD feed. The same feed lets a claim draw ETH first,
  then USDC, so both deposit tokens spend against one USD-denominated price.
  Two guards make cost-indexing rug-proof for communities: a per-instance
  **`maxPerRoot` cap** set by the instance admin (a fee-schedule hike can never drain a
  vault faster than the cap), and a **per-period claim limit** matching the instance's
  cadence target (a burst of roots can't sweep the balance).
- Instance admin sets the cadence target and `maxPerRoot`; UI surfaces balance, burn
  rate, and "scores stale — top up" the way keeper dashboards do.
- The factory's one-tx creation can route `msg.value` straight into the vault: "deploy
  your instance endowed with a year of weekly roots" is a good product sentence.
- **Prior art:** this is the same shape as Boundless's deployed ERC-1271
  "smart-contract requestor" (a contract escrows funds and authorizes at most one paid
  proof per period, with permissionless request builders) — the pattern is proven; on
  Succinct there's no first-party primitive, so the vault is our own contract paying on
  landed `submitProof`, which we'd need anyway to also cover submit gas.

**Layer 2 — self-serve (free forever).** Documented, containerized single-instance mode
of the same operator (`OPERATOR_INSTANCES=0x…`, own `NETWORK_PRIVATE_KEY`, own funded
submitter). The escape valve made runnable; also our own dogfood path.

### 4.3 The bounty front-running problem (live on mainnet from day one)

> **SUPERSEDED 2026-07-27 (Jake).** The three-step ladder below (private orderflow →
> commit-reveal → journal v3) collapses into its last rung: **recipient-in-journal is built now**,
> commit-reveal is never built. See §9.1 for the decision and §9.2 for the payout seam it enables.
> The analysis below stands as the reason the fix is needed at all.

A naive "vault pays `msg.sender` of `submitProof`" is snipeable wherever a public mempool
exists: the proof rides in calldata, so a watcher copies the pending tx and lands it
first, collecting the bounty the real prover paid the network to produce. **Home chain is
Ethereum mainnet (decided 2026-07-24), which has exactly that mempool — so the vault
needs a mitigation in v1, not eventually.**

- **v1, hosted operator:** private orderflow (Flashbots Protect or equivalent) for its
  own submit txs. Zero contract complexity; covers the party doing ~all the claiming
  initially.
- **v1, permissionless claimants: commit-reveal on the vault.** `commitClaim(keccak256(
  journalDigest, claimant, salt))` at least one block before the submit+claim; the
  reveal must match a commitment aged ≥1 block and < some expiry. One extra small tx
  per root (trivial next to 0.6M-gas submits); front-runners see only an opaque hash.
- **The right fix, journal v3:** a prover-chosen `recipient` field inside the journal,
  so the bounty destination is proven and copying calldata pays the original prover
  anyway. Costs a vkey rotation — ship it with the already-planned domain-separation
  rotation (accumulator address + chainid into the params schema, INSTANCE_FACTORY
  §6.1) as one constitutional action, then retire commit-reveal.

Note the blast radius is only the bounty, never correctness: a stolen bounty still lands
a correct root.

### 4.4 What we deliberately do NOT build

- **No proving obligation on-chain.** The vault is a standing offer, not an SLA;
  liveness comes from redundancy (our operator + bounty hunters + self-provers), matching
  the protocol's trust model. An SLA product, if ever, is an off-chain contract on top.
- **No off-chain SaaS billing in v1.** Stripe-for-proofs is the simplest business but the
  wrong first move for a permissionless protocol; the vault *is* the billing system and
  it composes with DAOs, which our customers are. Keep SaaS as a later enterprise skin.
- **No trigger-as-a-service via Chainlink/Gelato in v1.** The daemon must exist anyway
  for proving; outsourcing only the `trigger()` call buys decentralization theater. The
  vault + permissionless loop is the real decentralization story; external keeper
  networks can join it without our help precisely because everything is permissionless.

---

## 5. Failure & rotation semantics (the boring load-bearing part)

- **Succinct request fails / times out:** retry with backoff, cap per checkpoint; a
  checkpoint left unproven is superseded by the next epoch's (coalescing) — the system
  degrades to a slower cadence, never to a wrong root.
- **paramsHash/zkVerifier rotation mid-flight:** the pre-prove pending-ops guard (§2.1
  step 6) makes the operator stop before spending; after activation it resumes with the
  new preimage/vkey. Registry-published `(config, activation epoch)` (UPGRADE_GOVERNANCE
  §5.6) would let it pre-build both sides.
- **Deterministic submit revert:** count estimate, explicit simulation, and mined receipt reverts
  consistently. At the configured threshold, fsync an `Abandoned` journal record, stop submitting
  that immutable proof, and freeze a newer checkpoint after consumed inputs move. Do not count
  provider, fee/nonce, receipt-timeout, availability, or reorg failures; those retry safely.
- **Witness fetch fails (atproto):** the PDS is down or a repo moved — `--keep-going`
  semantics per DID, alert on manifest-empty; the anchor step must only anchor heads the
  witness fetch subsequently captured, else the epoch is unprovable (fail before
  anchoring, not after).
- **Vault empty:** hosted operator drops the instance to the free floor cadence (or stops,
  for unscheduled instances); UI shows staleness honestly. Nothing on-chain breaks —
  consumers keep reading the last proven state, which is the same behavior as "no new
  attestations."

---

## 6. Build plan

*(Phasing as researched. The executable version, with milestones, exit criteria and the §9
architecture, is `GOAL.md`: IF + M0 journal v3, M1 `operator-core`, M2 daemon,
M3 lane 2, M4 vault, M5 wiring, M6 fork e2e. Phases 3 and 4 merged there, because §9.1 moved the
rotation to the front.)*

- **Phase 1 — the daemon (unblocks everything):** `zk/operator` crate, static catalog,
  trust-graph + contributions + signer handlers, Succinct network backend, request
  journal, docker-compose service, alerting. No payment code. This alone retires "a
  human runs the RUNBOOK" and can run against today's deployments.
- **Phase 2 — atproto handler:** anchor loop + witness pinning for hypercerts-class
  instances.
- **Phase 3 — vault:** `ProvingVault` (instance-keyed ETH+USDC balances, cost-indexed
  pay-on-landed-root with fee schedule + ETH/USD feed + `maxPerRoot`/rate caps,
  top-up-for-anyone), factory wiring (`msg.value` → vault at creation), frontend
  balance/staleness surfaces. Mainnet home chain ⇒ commit-reveal claims from day one
  (§4.3); the hosted operator additionally submits via private orderflow.
- **Phase 4 — journal v3 (with the domain-separation rotation):** recipient-in-journal
  bounty claiming; one constitutional rotation covers both.

## 7. Decisions (Jake, 2026-07-24)

1. **Floor cadence: monthly.** Sets the factory `epochLength` floor (~30 days of
   blocks) and the hosted cost ceiling; also answers INSTANCE_FACTORY §8.5.
2. **Vault tokens: ETH and USDC, both.** Dual balances per instance; the ETH/USD feed
   the cost-indexed bounty needs anyway converts between them at claim time.
3. **Bounty sizing: cost-indexed per root** (gas reimbursement from observed
   `gasUsed × basefee` + USD fee schedule per program/size band), guarded by the
   per-instance `maxPerRoot` cap and per-period claim limit.
4. **Hosted operator is a requester, not a prover.** It posts inputs to the SP1 prover
   network (auction strategy); running our own prover hardware is a later option if
   demand shows up, and changes nothing about this design — a self-run prover would
   just be another network participant. Floor-cadence roots never draw the vault;
   above-floor service does.
5. **SLA: best effort + redundancy.** No contractual uptime; liveness comes from our
   operator + bounty hunters + self-provers. Succinct's Reserved tier stays a possible
   enterprise skin later, not a dependency.

## 8. Decisions, round 2 (Jake, 2026-07-24)

1. **Home chain: Ethereum mainnet** (also answers INSTANCE_FACTORY §8.1). Consequences
   folded in above: submit gas dominates per-root cost (§3.2, basefee-gating), and the
   public mempool makes a v1 anti-theft mitigation mandatory rather than a later option
   (§4.3 — which §9.1 then resolved in favour of recipient-in-journal over commit-reveal).
2. **Fee-schedule governance: FEE_SETTER = us for the MVP.** Moving it behind the
   operational timelock is a post-MVP hardening item; the per-instance `maxPerRoot` cap
   is what protects communities in the meantime.
3. **Large atproto graphs are out of MVP scope.** No fee band for the 23–45B-cycle
   class; the operator enforces an explicit `cycle_limit` per request and skips+alerts
   on any instance that exceeds the supported size band instead of silently buying a
   $90 proof. Revisit when a big atproto community actually shows up.

## 9. Decisions, round 3 (Jake, 2026-07-27) — and the architecture they force

Taken while writing `GOAL.md`. The first two change what gets built; the rest are
consequences worked out against the code and recorded here so the build has one design to follow.

### 9.1 Journal v3 now: the bounty recipient is proven, not hidden

**Decision: build recipient-in-journal in this program; never build commit-reveal.**

`Journal` gains an eleventh field, `recipient`, passed through the guest as a pass-through
commitment (nothing computes from it), and `submitProof` takes it as an argument folded into the
digest rebuild. A proof is therefore *non-fungible between claimants*: copying a pending
transaction reproduces the original prover's recipient.

Two reasons this beats §4.3's ladder:

1. **The rotation is free today and contagious tomorrow.** This is the identical argument that
   moved domain separation into the factory build (`INSTANCE_FACTORY.md` §8.6): mainnet has
   nothing deployed, so rotating before the first mainnet instance costs zero ceremony, while
   rotating after N live instances is a coordinated migration. The four-leg parity dance was just
   exercised for params-schema v2; running it again is a known procedure, not a research project.
2. **It is strictly stronger than hiding the claim.** Commit-reveal makes theft *hard to target*;
   a proven recipient makes it *unprofitable by construction*. It also deletes an extra
   transaction per root, the commitment/expiry contract surface, and the hosted operator's
   private-orderflow dependency.

Cost, stated honestly: one vkey rotation across all four programs (contagion — `docs/concepts/networks-and-programs.md`
records the measurement methodology), plus regenerating three golden vector files and the frontend
TS port.

### 9.2 The payout seam: `submitAndClaim`, not a hook, not a passive claim

The vault cannot observe a root that landed through a plain `submitProof` — the submitter is in an
event, not in storage, and `IMerkleSnapshotHook.onMerkleUpdate` receives only a `MerkleState`
(no checkpoint id, no submitter, no recipient), so hooks cannot attribute a payout either.
Therefore the vault *is* the submit path for anyone claiming: `submitAndClaim(instanceId, args)`
forwards to `snapshot.submitProof(...)`, confirms `lastAppliedCheckpoint == checkpointId`, marks
the checkpoint claimed, and pays. The snapshot address is resolved from `InstanceRegistry`, never
from calldata, so a caller cannot point the vault at a fake snapshot that "lands" a root trivially.

**The split that finishes the front-running story:** the **proving fee follows the journal's
`recipient`**, the **gas reimbursement follows `msg.sender`**. A copier is refunded exactly the gas
they actually burned and earns nothing else, while the party who paid the prover network keeps the
fee. Claiming is opt-in: roots landed directly through `submitProof` are still perfectly valid,
they simply pay nobody.

### 9.3 Withdrawal notice (new guard)

Vault withdrawals are request-then-wait (7 days), top-ups instant. Instant withdrawal would let a
community rug a prover mid-proof, which is precisely the reliability the hosted service sells, and
"check the balance, then spend a minute proving" has no atomicity otherwise. Per-instance
authority is `MerkleSnapshot.hasRole(OPERATIONAL_ROLE, …)`, so it tracks graduation with no new
role plumbing.

### 9.4 Where the daemon's logic lives

Split, rather than one crate: **`crates/operator-core`** (root workspace, alloy only, no
sp1-sdk) holds everything that can be *wrong* — instance reconstruction lifted out of
`instance_scan.rs`, the pure `plan(state, policy) -> Action` decision function, the rotation guard,
the crash-safe request journal — so `cargo test --workspace` in CI covers it. **`zk/operator`**
(detached beside `zk/prover`, where the sp1-sdk graph already lives) is a thin adapter that turns
an `Action::Prove` into a network request. `zk/prover` gains a `[lib]` with value-returning
`execute`/`prove` entry points, which also deletes the stdout-scraping seam
`taskfile/instances.sh` currently relies on.

### 9.5 Scope and target

Full §6 (phases 1–4) as one program. Exit target is **local anvil plus a mainnet-forked anvil**
with real Groth16 verified by the canonical SP1 gateway in forked state; deploying the hosted
operator to mainnet (custody, PROVE funding, on-call) is a separate later GOAL.

## 10. Corrections from external design review (2026-07-27)

A second agent reviewed the design and `GOAL.md`. Most findings held; the ones that changed the
design are below, together with the two claims that did not survive checking and the two problems
the check turned up in *shipped* code. Everything here is folded into `GOAL.md`.

### 10.1 Economics: curated subsidy, and where a cadence limit can actually live

`epochLength` is not a cost bound after creation (see the §4.2 banner), so both the "free monthly
root for every instance" promise and the "the floor bounds hosted cost" justification fail
together. Resolved as **curated subsidy** (§4.2 banner). The consequence for the vault: since
operator policy cannot bind a stranger, a funded instance needs **on-chain paid eligibility** or
anyone can route a checkpoint through `submitAndClaim` and draw the community's funds at whatever
rate they like. That is a per-instance `minPaidIntervalBlocks` plus `maxPerRootUsd`, replacing the
§4.2 period/count pair — the same guard, expressed as the cadence the community is paying for.

### 10.2 Journal v3 carries an instance domain too

Recipient-only (§9.1) is not sufficient. `hypercerts_core::compute::Params` contains **no
instance-unique field at all** — no accumulator, no chainId, no registry address, no schema UID —
so two identically-configured hypercerts instances have byte-identical `paramsHash` and, anchoring
the same heads, byte-identical journals. They accept each other's proofs today. Rather than patch
each program's params codec, `submitProof` now derives an `instanceDomain` from `address(this)` and
`block.chainid` and folds it into the digest, with the guest committing it as a pass-through input.
Structural, universal, and it cannot be forgotten by a future program.

### 10.3 Rotation safety: pin params per checkpoint, never the verifier

"Never spend on an unlandable proof" is unachievable by re-reads alone: a creator-admin can rotate
configuration one block after any preflight. Two changes shrink the unpreventable set instead of
pretending it is empty. `trigger()` pins `paramsHash` into the checkpoint and `submitProof` uses
the pinned value (unpinned ⇒ revert), which makes rotations take effect at the next boundary
automatically — what §5.6 currently asks operators to arrange by hand. The **verifier is
deliberately not pinned**: a verifier rotation is the response to an SP1 soundness bug (§5.5's
design load), and pinning it would let proofs under a known-broken verifier keep landing. What
remains unpreventable is carried by per-instance and global **loss budgets**, and the invariant is
restated as "avoid preventable spend".

### 10.4 Checkpoint minting is currently unbound (shipped-code bug)

`AttestationAccumulator.checkpoint()` (`AttestationAccumulator.sol:42-52`) has no access control
and no snapshot binding, so anyone can freeze a lane-1 instance's inputs at a block of their
choosing, bypassing `MerkleSnapshot`'s `epochLength` gate and contradicting the
never-prover-chosen-boundary invariant asserted at `MerkleSnapshot.sol:44-46`.
`TrustAccumulatorMirror.sol:99-102` already implements the correct pattern. Fixed by a bind-once
snapshot setter, which is also what makes §10.3's `UnpinnedCheckpoint` revert safe rather than a
denial-of-service surface.

### 10.5 "Zero per-instance config" was overclaimed

True only for factory-minted trust-graph instances. Contributions is not in `InstanceRegistry` at
all, hypercerts registers an opaque `paramsHash` with no params-bearing event, and
`SignerSyncZkModule` is not discoverable from the registry in any form. Everything outside the
factory path gets an explicit manifest entry, said plainly. Related: catalog failures are now
**per-instance skips** — `instance_scan.rs` aborts the whole run on one mismatch, which is right
for a one-shot human-run tool and wrong for a daemon.

### 10.6 Vault mechanics

Four corrections, all adopted: payouts are **pull credits** (a recipient that rejects ETH must not
be able to revert a verified root); accounts **bind to their snapshot at first deposit** (resolving
through the registry per call would let `OPERATOR_ROLE` redirect a funded balance); under partial
funding the **proven fee is paid before the submitter's gas** (otherwise a copier consumes the
remainder as gas and the prover gets nothing); and gas reimbursement is **capped and conservative,
not exact** — `gasleft()` deltas cannot see intrinsic cost and `block.basefee` excludes the
priority fee, so the testable property is `reimbursement <= demonstrable caller cost`. Vault
authority moves from `OPERATIONAL_ROLE` to `CONSTITUTIONAL_ROLE`: operational is the short-lane
params role and should not become fund custody.

### 10.7 Operator: idempotency and finality are protocol states

A Succinct request id cannot be journaled before the request that mints it. The journal now writes
an **intent record with a client-side nonce** before the request and appends the id after; the
ambiguous window resolves by backend lookup or becomes `RequestOutcomeUnknown`, surfaced to a human
and never auto-retried. Separately, proving must **await finality** on the trigger/checkpoint
transactions, with block hashes tracked, so a reorg cannot erase a checkpoint we already paid to
prove.

### 10.8 What did not survive the check

- **"A funded community cannot get faster roots."** False: `EPOCH_FLOOR` binds creation only
  (§4.2 banner). The recommended decoupling is right, for the opposite reason.
- **"Require timelocked configuration for paid proving."** Rejected: it contradicts the decided
  creator-as-admin model and would make the vault unusable for exactly the young communities it
  exists for.
- **"Creation bond" as the anti-spam lever.** Rejected: it reinstates the creation paywall the
  factory deliberately removed. Curated subsidy achieves the same bound with no cost to honest
  creators.

### 10.9 Lane 2, deferred

No hypercerts / lane-2 handler in this program (Jake 2026-07-27). The corrected sequencing —
**fetch and verify → durably pin → anchor captured heads → await finality → trigger → build from
the pinned bundle → prove** — replaces the self-contradictory version in §2.3/§5 (which says anchor
→ trigger → fetch, and also that only already-captured heads may be anchored). Two further traps
for whoever picks it up: `EmptyLaneAccumulator.leafCount()` is always zero, so lane-2 readiness
must compare anchor commitments rather than leaf counts, and the vault's leafCount-derived size
band misprices a lane-2-only program for the same reason — hence per-program band functions with
an *unsupported ⇒ zero fee* default.

Every question this doc raised is decided; what remains is the build (`GOAL.md`).
