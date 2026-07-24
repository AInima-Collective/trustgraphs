# GOAL — Permissionless instance factory (create a network in one transaction)

Build the instance factory:

> **A community opens the app, fills in a create-a-network wizard (name,
> description, membership criteria, trusted seeds, a few knobs, optional
> fund distributor), signs one transaction, and gets a working
> TrustGraph instance: members vouch immediately, the page is live in
> seconds, and proven scores land on the epoch cadence — no repo
> checkout, no config PR, no indexer or frontend redeploy, no ops
> ticket per community.**

This file is the execution spec. The design is done and normative:
[`research/INSTANCE_FACTORY.md`](research/INSTANCE_FACTORY.md)
(product shape §0, instance anatomy §1, factory contract §2, discovery
§3, wizard §4, hosted proving §5, security §6). All §8 open questions
are now answered — the Decisions table below locks them. This build
realizes the platform claim's other half
([`docs/PROGRAMS.md`](docs/PROGRAMS.md)): "adding an instance costs
only a deployment" becomes "adding an instance costs only a
transaction."

**Target for this GOAL: two communities created through the UI wizard
on local anvil, both proven and rendering scores, driven end-to-end
with zero config edits.** Mainnet (the decided home chain) deployment
is a later GOAL.

---

## Ground rules

1. **The design doc is normative.** Deviations get an entry in
   `docs/DEVIATIONS.md` (what, why, which § it touches). Two are
   already known and pre-approved below: the distributor-ownership
   constructor change and the §4.1 pinning-premise correction.
2. **Parity discipline.** The params schema change (M0) touches
   `packages/pagerank-core::encode`, `ParamsCodec.sol`, and the
   frontend TS port; all legs plus regenerated
   `test/golden/trust-graph.json` land in the same PR or CI fails.
   `TrustGraphGoldenVectors.t.sol:141` (`test_ParamsHashEncoding`) is
   the anchor assertion; the factory's on-chain hash path must satisfy
   it against the same vectors.
3. **The factory holds no instance roles ever** — as a *tested
   invariant*, not a convention: after `createInstance` returns, the
   factory has zero roles on the snapshot, zero ownership on the
   distributor, and holds only `OPERATOR_ROLE` on `InstanceRegistry`.
   Transient in-tx role custody (needed for `setEpochLength`) is fine;
   persisting past the tx is a test failure.
4. **Registry neutrality.** `InstanceRegistry` records stay
   presentation-free; name/metadataURI live only in the factory event
   and indexer tables. "Featured" is an app-side flag, never an
   on-chain field.
5. **Frozen things stay frozen.** Journal v2 (10 words,
   `MerkleSnapshot.sol:227-240`) is untouched — domain separation goes
   into the *params schema*, not the journal shape. `InstanceRegistry`
   needs zero code changes (register is already `OPERATOR_ROLE`-gated
   with caller-supplied ids; the factory enforces the id derivation).
6. **No new FV surface** — fuzz, unit, golden, e2e per milestone, same
   policy as prior builds.
7. **Frontend copy passes the plain-reader test.** The wizard is the
   most copy-critical surface yet: a community organizer who has never
   read a TrustGraph doc must complete it. No param names, no §
   references in the DOM; consequences in plain language ("scores
   update about once a month").
8. **Sensible defaults over stalls.** Anything not locked in Decisions
   gets a recorded default and a param, not a blocker.

## Interface freeze (IF) — merges first, everything hangs off it

One small PR freezing, in `packages/pagerank-core` +
`docs/trust-graph/FACTORY.md` (new):

- **Params schema v2** — two fields appended to the trust-graph
  `Params` (Rust `encode.rs`, Solidity `ParamsCodec.Params`
  15→17 fields, TS port):
  - `accumulator: address` — the instance's `EASIndexerResolver`
  - `chainId: uint64` — `block.chainid` at creation
  This is the §6.1 domain-separation fix, **decided for now, not for a
  later rotation** (rationale in Decisions). Golden vectors
  regenerated; trust-graph + signer vkeys re-derive (signer reuses the
  trust-graph `paramsHash`, so it rotates with it). Byte-diff-check
  whether hypercerts/contributions ELFs shift (the repo has the
  methodology); if they do, update `docs/PROGRAMS.md` vkeys — there is
  no live instance to migrate anywhere. Their *schemas* do not adopt
  the new fields yet; they are not factory-minted in v1.
- **`CreateArgs`** exactly as design §2.1: `name`, `metadataURI`,
  `params` (full struct, calldata), `admin` (0 ⇒ `msg.sender`),
  `withDistributor`, `distributorToken`, plus `salt`.
- **`instanceId = keccak256(abi.encode(creator, name, salt))`** —
  collision-free under permissionless creation, no label squatting.
- **`InstanceCreated` event** carrying the **full params struct** plus
  `instanceId, creator, name, metadataURI, resolver, schemaUid,
  snapshot, distributor`. This event is the load-bearing interface:
  prover reconstructs instances from it (M5), indexer catalogs from it
  (M2), third parties audit params from it. Freeze it like a journal.
- **Canonical vouch schema string** for all factory instances:
  `"string comment,uint256 confidence"`, revocable, exactly as
  `DeployNetwork.s.sol:109-119` registers today (decided: no
  creator-customizable fields in v1 — keeps `weightFieldIndex`
  uniform).
- **`metadataURI` JSON shape**: `{name, description, criteria, image,
  applicationUrl}` — presentation only, nothing consensus-relevant.

*Exit:* the doc + codec/encode/TS changes + regenerated vectors under
test. Nothing else merges before this.

---

## Milestones

Each milestone merges with tests green and the trust-graph parity job
passing. **Lanes marked ∥ are independent after their stated
prerequisite and should run as parallel subagent lanes.**

**M0 — Domain separation lands end-to-end.** *(prereq: IF; mostly IS
the IF, plus plumbing)*
Thread the two new params fields through `params.json` +
`script/lib/ParamsJson.sol`, `input-exporter` (`--params` path), the
guest, and the existing deploy scripts (`DeployNetwork.s.sol` passes
the resolver address + `block.chainid` into the hash at `:124`).
Re-derive dev-box vkeys (`task zk:vkey`), redeploy pattern unchanged
(new `SP1JournalVerifier` per rotated program).
*Exit:* parity green on all four legs (Rust/guest/Solidity/TS); the
**replay-separation test** passes — two instances with identical
seeds, params, and (empty-genesis) edge sets produce different
`paramsHash`es, and instance A's proof reverts on instance B's
snapshot; `docs/DEVIATIONS.md` entry for the schema change.

**M1 — `TrustGraphFactory` + registry wiring.** *(prereq: M0)*
`src/contracts/factory/TrustGraphFactory.sol`, one `createInstance(CreateArgs)`
doing the dependency DAG in one tx: `new EASIndexerResolver(EAS)` →
`SchemaRegistrar.register(CANONICAL_SCHEMA, resolver, true)` →
`params.accumulator = resolver; params.chainId = block.chainid;
params.schemaUid = uid` → `paramsHash = ParamsCodec.hash(params)` →
`new MerkleSnapshot(SHARED_VERIFIER, paramsHash, resolver, address(this), admin)`
→ `setEpochLength(max(args.epochLength, FLOOR))` →
`grantRole(CONSTITUTIONAL_ROLE, admin)` + `renounceRole(…, this)` →
optional distributor → `INSTANCE_REGISTRY.register(instanceId, …)` →
`emit InstanceCreated(…)`. Notes forced by the code survey:
- `epochLength` is **not** a constructor param
  (`MerkleSnapshot.sol:150`, constitutional-only) — hence the
  transient-role dance above. It must be bulletproof: the grant to
  `admin` precedes the renounce, and the whole thing is one tx.
- `MerkleFundDistributor` ownership is 2-step
  (`MerkleFundDistributor.sol:122-127`), which would leave the factory
  as owner until the creator accepts — **change the constructor to set
  `owner = owner_` directly** (2-step protects live transfers, not
  bootstrap; no live deployment is affected). DEVIATIONS entry.
- Bounds at creation (§2.2): damping ∈ (0,1), trustShare ≤ 1e18,
  non-empty seeds, `precisionScale` == platform constant,
  iterations/tolerance in the proven-safe envelope, `epochLength ≥
  FLOOR` (an immutable, chain-appropriate: ~monthly in blocks on
  mainnet, tiny on anvil).
- No payment path in v1. `createInstance` is non-payable; the
  deploy-and-prepay vault seam belongs to the `PROOF_SCHEDULER` GOAL.
Deploy battery: `DeployInstanceRegistry` + `DeployFactory` steps into
`deploy/env.ts` templates (watch the positional `network_deploy_dev_<i>`
coupling at `env.ts:157-215` — new steps must not shift vouching-entry
indices); factory granted `OPERATOR_ROLE` on the registry; dev-seed
networks **recreated through the factory** so there is one catalog.
*Exit:* Foundry suite green — role-free-post-create invariant (ground
rule 3, enumerated roles + distributor owner), `paramsHash` parity vs
golden vectors through the factory's own hash path, bounds-rejection
battery, id collision + same-name-different-creator, event params
hash-check (`hash(event.params) == snapshot.paramsHash()`), registry
record correctness, both distributor/no-distributor paths;
`pnpm deploy:contracts` stands registry + factory up on anvil and a
`cast send createInstance` produces a working instance.

**M2 — Discovery: registry-driven indexer.** *(prereq: M1; ∥ with M3,
M4, M5)*
Ponder 0.16.2 already supports `factory()` sources — none exist yet.
One factory source per child type (`merkleSnapshot`,
`easIndexerResolver`, `merkleFundDistributor`) keyed off
`InstanceCreated` args; children index from creation block, which
properly deletes the `startBlock: 'latest'` workaround for factory
children (`ponder.config.ts:159-168`) and the `PONDER_START_BLOCK`
guesswork. EAS needs no factory source (handlers already attribute by
`event.log.address` — `indexer/src/eas.ts:19,38`; they are
instance-agnostic today and barely change). Static sources remain only
for non-factory contracts (gov module, safe, contributions instance).
New `instance` table from `InstanceCreated` (id, creator, name,
metadataURI, all addresses, full params as JSON, createdBlock) — this
*replaces* `networks.json` as the trust-graph catalog — plus a
`/instances` API route in `indexer/src/api/`.
Out of scope: the `anchor` table's deferred `instanceId` dimension
(`ponder.schema.ts:60-61`) stays deferred — lane 2 / hypercerts is not
factory-minted in v1.
*Exit:* `cast send createInstance` on a running stack → instance +
attestation rows appear with **no config edit and no Ponder restart**;
existing trust-graph/hypercerts/contributions routes regression-green.

**M3 — Frontend runtime catalog.** *(prereq: M2's `/instances`; ∥ with
M4 build-out, M5)*
`lib/config.ts` trust-graph networks flip from the static
`networks.json` import to the runtime catalog (contributions/
hypercerts entries stay static until those programs are factory-able).
The survey's key finding: `dynamicParams` already defaults true, but
`app/network/[id]/page.tsx:40-59` and every sub-route
(`rate/respond/payout/contribute/_distribute`) resolve ids against the
static `VISIBLE_NETWORKS` arrays — the *lookups* move to the catalog,
not just a routing flag. `SchemaManager` builds its list from catalog
rows (`lib/schemas.ts:19-22` goes dynamic).
*Exit:* a minutes-old factory instance renders at `network/[id]` and
accepts vouches with no rebuild; pre-existing pages unregressed.

**M4 — The create wizard + metadata pinning.** *(prereq: M1 ABI + IF;
UI shells ∥ from IF, wiring needs M3)*
**Correction to design §4.1 (DEVIATIONS entry): the frontend has no
IPFS pin path today** — score-blob pinning lives in `deploy/env.ts:
uploadToIpfs()` and the runbook's `ipfs add` step. Build a pin route
(`app/api/ipfs` POST on the `pinApi` pattern; the read proxy at
`app/api/ipfs/[cid]/route.ts` is the sibling) before the Identity
screen can pin `metadataURI`.
The five screens per §4: Identity (→ pin → `metadataURI`), Trusted
seeds (the one high-cognitive-load screen; binary seeds exactly as
live networks — `GRAPH_SEEDING.md` is a future upgrade), Tuning
(advanced-collapsed; defaults = the blessed live-network params),
Add-ons (distributor + token picker), Review & sign (one tx via the
factory ABI; success deep-links to `network/[id]`).
*Exit:* full creation flow on anvil from a fresh wallet; copy reviewed
against ground rule 7; the created page is live as soon as the indexer
has the event.

**M5 — Multi-instance proving loop.** *(prereq: M1; ∥ with M2–M4)*
The chain-is-the-config claim, proven: a `task` (or small script)
that enumerates `InstanceRegistry`, reconstructs each instance's
params from its `InstanceCreated` event, **self-checks
`ParamsCodec/params_hash(event params) == snapshot.paramsHash()`**,
then per instance past its epoch boundary: `trigger()` →
`input-exporter` → `prove` → pin → `submitProof` — with per-instance
out-dirs (`--out-dir .trustgraph/trust-graph/<instanceId>/`; the
default is per-*program* and successive instances overwrite each
other, `zk/prover/src/common.rs:21-30`).
Scope fence: this is the enumeration seam only. The operator *daemon*,
vault, bounties, and commit-reveal live in the `PROOF_SCHEDULER` GOAL
(its §2 v2 consumes exactly this seam).
*Exit:* two factory instances proven and submitted from chain data +
RPC alone — zero per-instance config files, zero manual params entry.

**M6 — E2E + hardening.** *(prereq: M1–M5)*
The full loop, driven where a user would drive it: wizard-create
network A (no distributor) and network B (with distributor + mock
ERC20), vouch in both through the UI, run the M5 loop, scores render
on both pages; fund + distribute + claim on B. Replay-separation
re-verified on the real stack (submit A's proof to B via cast —
reverts). Adversarial pass: solidity-auditor + `/code-review` over the
factory + touched contracts; spam scenario (garbage-params attempts
all revert on bounds; a created-but-never-proven instance renders
honestly and breaks nothing); registry-enumeration pagination sanity.
Docs: `docs/trust-graph/FACTORY.md` completed as the runbook
(create → discover → prove), `docs/PROGRAMS.md` updated (vkeys +
instance story), `LOCAL_TESTING`-style cold-run doc.
*Exit:* a fresh session reproduces the whole M6 scenario from the doc
alone; audit findings triaged to issues with fixes or accepted-risk
notes.

## Parallelization map

```
IF ── M0 (params v2 + vkeys) ── M1 (factory + deploy) ──┬── M2 (indexer)   ∥ ──┐
                                                        ├── M3 (frontend)  ∥ ──┼── M6 (e2e + hardening)
                                                        ├── M4 (wizard)    ∥ ──┤
                                                        └── M5 (prover loop) ∥ ┘
M4 UI shells can start from IF (ABI + metadata shape frozen); M3 needs M2's route.
```

Subagent guidance: M2/M3/M4/M5 are the four parallel lanes; the frozen
`InstanceCreated` event + golden vectors are the inter-lane contract —
lanes build against the IF artifacts, never against each other's
branches.

## Decisions (locked)

| Decision | Resolution |
|---|---|
| Home chain (§8.1) | **Ethereum mainnet** (Jake 2026-07-24). This GOAL builds + proves on local anvil; mainnet deploy is a later GOAL. Mainnet consequences (submit gas, commit-reveal bounties) are `PROOF_SCHEDULER` scope |
| Admin model (§8.2) | **Creator-as-admin** holds both snapshot roles + distributor ownership (Jake: fine for now). `graduate()` is a later, separate flow; factory never retains roles (ground rule 3) |
| Wizard defaults (§8.3) | **Live-network params blessed** as defaults (Jake). Damping/multiplier/share/epoch behind "advanced" |
| Vouch schema (§8.4) | **Canonical** `"string comment,uint256 confidence"` for all factory instances (Jake). Customization would fork `weightFieldIndex` and multiply test surface |
| Proving floor (§8.5) | **Monthly** hosted floor (Jake, via `PROOF_SCHEDULER`); factory `EPOCH_FLOOR` immutable ≈ 30 days of blocks on mainnet, small on anvil |
| Domain separation (§8.6, delegated) | **Now, in this GOAL (M0)** — `accumulator` + `chainId` appended to the trust-graph params schema. Most future-proof because: (a) mainnet has *nothing deployed*, so rotating before the first mainnet instance costs zero ceremony, while rotating after the factory ships is contagious across N live instances; (b) the factory is precisely what creates the identical-clone replay hazard §6.1 describes; (c) `chainId` in the hash is the multi-chain prerequisite §0 demands. Journal v2 untouched |
| `instanceId` | `keccak256(abi.encode(creator, name, salt))` — squat-proof, same-creator reuse via salt |
| Distributor ownership | Constructor sets `owner = owner_` directly (2-step kept for live transfers). DEVIATIONS entry |
| `epochLength` setting | Transient factory constitutional role in-tx: set → grant admin → renounce; invariant-tested |
| Payments at creation | None in v1; non-payable `createInstance`. Vault prepay seam = `PROOF_SCHEDULER` GOAL |
| Registry changes | **Zero code changes**; factory granted `OPERATOR_ROLE`; `update()` stays timelock-only |

Still open (do not block this GOAL): `graduate()` design, mainnet
deploy runbook (incl. canonical EAS addresses — mainnet has no
predeploy), Lane D freeze + `setParams(struct)` (the
`UPGRADE_GOVERNANCE.md` program; the factory event's full-params emit
deliberately shares the codec path that fix will adopt), contributions/
hypercerts factory bundles, multi-chain.

## Execution notes — model allocation

Same principle as prior builds: **delegate work whose output is
machine-checkable; keep work whose failure mode is silent.**

**Fable (main session):** the params schema v2 change and everything
touching `paramsHash` (M0 — a wrong encoding poisons every lane and
rotates vkeys for nothing); the factory's create sequence + role
choreography (M1 — transient-role bugs are silent until someone is
locked out); the `InstanceCreated` event freeze; milestone acceptance;
DEVIATIONS calls.

**Subagent lanes:** M1 test battery; M2 indexer sources/table/route;
M3 catalog swap; M4 screens + pin route; M5 task script; docs. Frame
adversarial prompts as property refutation ("refute: some CreateArgs
leaves the factory holding a role after the tx"), not exploit
development.

## Bug capture

Every counterexample → minimal committed repro → GitHub issue (design
§, trace, affected surface) → failing test stays expected-fail until
the fix flips it. Findings that contradict `INSTANCE_FACTORY.md` are
DEVIATIONS events; anything weakening §6's security posture reopens
that section.

## Done when

1. **All milestones exited** with stated criteria; trust-graph parity
   job (Rust / guest / Solidity / TS) green in CI on the v2 schema.
2. **One transaction is the whole story:** from a running local stack,
   a fresh wallet completes the wizard and its network is browsable,
   voucheable, and (after the loop runs) score-bearing — zero config
   edits, restarts, or rebuilds anywhere.
3. **Chain is the config:** the M5 loop proves every registry instance
   from on-chain data + RPC alone, self-checked against
   `snapshot.paramsHash()`.
4. **Clones can't cross-feed:** the replay-separation test passes at
   both unit (M0) and real-stack (M6) level.
5. **The factory is provably inert:** the role-free invariant holds
   over the full Foundry suite; a compromised factory can register
   directory garbage but touch no existing instance.
6. **A community organizer can do it:** every wizard screen passes the
   plain-reader rule; creation to first vouch requires reading zero
   internal docs.
