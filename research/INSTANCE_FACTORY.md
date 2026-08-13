# INSTANCE_FACTORY — permissionless community instances via a TrustgraphsFactory

Status: **BUILD DECIDED 2026-07-24** — the execution spec is
`GOAL.md` (retired; see git history); all §8 questions are answered in place below.
Tracked as [issue #6](https://github.com/JakeHartnell/trustgraphs/issues/6). **The repo cleanup
program this was sequenced after closed 2026-07-24** (all six milestones landed; see
`research/DEVIATIONS.md` for the log), so every precondition now holds: Localism-specific
code is gone, generated artifacts live under `.trustgraph/`, and there is no live
production network to migrate (the legacy v1 Optimism instance is frozen on journal v1
and never migrates — `docs/concepts/networks-and-programs.md` is the canonical statement).

## 0. Product shape (decided up front)

A community that thinks trustgraphs is cool opens the app, fills in a
create-a-network wizard (name, description, membership criteria copy,
trusted seeds, a few tuning knobs, optional add-ons), signs **one
transaction**, and gets a working instance: members can vouch
immediately, and proven scores start landing on the normal epoch
cadence. No repo checkout, no Foundry, no config PR, no indexer or
frontend redeploy.

Scoping decisions already made:

| Question | Decision |
|---|---|
| What's in the box | **Configurable bundle**: core graph always (resolver/accumulator + schema + `MerkleSnapshot`); optional add-ons chosen at creation (fund distributor first; gov stack and contributions rounds later) |
| Who runs proving + indexing | **Hosted by us initially** — one shared prover loop + one shared Ponder covers all factory instances; self-hosting stays possible because everything is permissionless |
| Access | **Fully permissionless** factory; the app curates what it *features*, not what can *exist* |
| Chains | **One chain first**; the design must not paint us out of multi-chain |

## 1. What an instance actually is today

From the deploy scripts (`script/DeployNetwork.s.sol:75-188`) and the
platform doc (`research/MULTI_PROGRAM_PLATFORM.md` §4):

**Shared singletons (once per chain), reused by every instance:**

- EAS + SchemaRegistry (native predeploys on Base/OP; `script/DeployEAS.s.sol:52-74`)
- `SchemaRegistrar` (thin wrapper over `SchemaRegistry.register`)
- SP1 verifier gateway (canonical Succinct deployment; never ours)
- `SP1JournalVerifier` — **one per (chain, program vkey)**, shared by all
  instances of that program (`src/contracts/merkle/SP1JournalVerifier.sol:10-11`,
  `docs/concepts/networks-and-programs.md:85-89`: "a new instance costs only a deployment, no verifier")
- `InstanceRegistry` — one per chain (`src/contracts/registry/InstanceRegistry.sol:8`).
  **Built but dormant**: zero references in `deploy/`, `indexer/`, `frontend/` today.

**Per-instance contracts (trust-graph program):**

1. `EASIndexerResolver` (is-a `AttestationAccumulator`) — no roles, permissionless folds
2. The vouching **schema UID** — instance-specific because the UID binds the
   resolver address (`getUID(schema, resolver, revocable)`)
3. `MerkleSnapshot` — ctor takes `(verifier, paramsHash, accumulator,
   constitutionalAdmin, operationalAdmin)` (`MerkleSnapshot.sol:91-110`)
4. `TrustgraphsParamsController` — stores and publishes every complete parameter
   version, owns the snapshot's operational role, and is itself owned by the
   community's EOA, Safe, or operational timelock
5. Optional: `MerkleFundDistributor`, Safe + `MerkleGovModule` +
   `SignerSyncZkModule`, two `TimelockController`s

**The ZK layer is already factory-shaped.** The guest ELF/vkey carry
zero instance data; every instance-specific value (params incl. seeds,
schema UID, accumulator checkpoint) enters as a private witness hashed
into `paramsHash` or as storage the contract binds at submit time
(`packages/pagerank-core/src/encode.rs:79-112`, `MerkleSnapshot.sol:205-243`).
`submitProof` and `trigger` are permissionless. Retargeting the prover
at a new instance is **config-only**: RPC + addresses + checkpoint id +
that instance's params (`packages/input-exporter/src/main.rs:36-84`).
"Same vkey, a thousand instances" is the intended design and is
essentially already true.

## 2. The factory contract

### 2.1 `createInstance` — one tx, minimal core

```solidity
struct CreateArgs {
    string  name;            // short label; instanceId = keccak256(creator, name, salt)
    string  metadataURI;     // IPFS: about, criteria, CTA, imagery — presentation only
    PageRankParams params;   // the full params struct, calldata — NOT a bare hash
    address admin;           // constitutional + operational admin (defaults to creator)
    bool    withDistributor; // optional add-on
    address distributorToken;// 0 = ETH-style default; else ERC20
}
```

Sequence inside one call (all steps the Foundry scripts do today, but
on-chain — the scripts already prove each step is EVM-expressible):

1. `resolver = new EASIndexerResolver(EAS)` — no post-wiring needed
2. `schemaUid = SCHEMA_REGISTRAR.register(VOUCH_SCHEMA, resolver, true)` —
   must precede the hash, exactly as `DeployNetwork.s.sol:109-124` orders it
3. `paramsHash = ParamsCodec.hash(withSchemaUid(args.params, schemaUid))` —
   the codec is already a Solidity twin of `pagerank-core::params_hash`,
   already invoked on-chain by the deploy script; the factory just moves the
   params source from a JSON file (`vm.readFile`) to calldata
4. Deploy the snapshot with factory-held roles only for the duration of this
   transaction, then deploy `TrustgraphsParamsController` with the complete
   version-1 tuple and community admin as owner
5. Grant the controller the snapshot's sole operational role; grant the admin
   the constitutional role; verify and renounce both transient factory roles
6. Optional `new MerkleFundDistributor(admin, snapshot, admin, fee, false)`
7. `INSTANCE_REGISTRY.registerWithParamsAuthority(instanceId, Instance({program:
   "trust-graph", snapshot, verifier: SHARED_VERIFIER,
   registryOrAccumulator: resolver, paramsHash}), controller)`
8. `emit InstanceCreated(instanceId, creator, name, metadataURI,
   resolver, schemaUid, snapshot, distributor, params /* FULL struct */)`
9. Emit `ParamsControllerCreated`, then publish the complete version-1
   `ParamsUpdated` event. This ordering lets a streaming indexer discover the
   dynamic child before its first version log.

Gas shape: 3–4 CREATEs + one external schema registration + one registry
write. Entirely reasonable for a single UI-driven tx on an L2. No
circular wiring exists in the trust-graph path (the contributions-style
`bindSnapshot` cycle only appears in later program bundles).

**The load-bearing trick is step 7: emit the full params struct.**
Today params live in `params.json` files and `paramsHash` is opaque
on-chain — `research/UPGRADE_GOVERNANCE.md` §7 already flags "params
illegible on-chain" as a gap. If the factory event carries the whole
struct, then:

- the hosted **prover** reconstructs any instance's input from chain
  alone (registry → addresses, event → params, self-check: hash the
  event params, compare to `snapshot.paramsHash()`) — zero manual
  config per community, which is the difference between "hosted infra
  scales to N instances" and "every creation is an ops ticket";
- the **indexer/frontend** can display seeds, damping, epoch length
  honestly instead of a hash;
- third parties can verify what a community's graph actually computes.

This is the factory-sized version of `UPGRADE_GOVERNANCE.md`'s proposed
`setParams(struct)` fix, and it should share the same codec path.

### 2.2 What the factory constrains (permissionless ≠ unvalidated)

The factory should enforce cheap sanity bounds at creation, because a
raw `bytes32 paramsHash` accepts anything (`UPGRADE_GOVERNANCE.md:91-93`):

- params bounds: damping ∈ (0,1), trustShare ≤ 1, non-empty seed set,
  `precisionScale` = the platform constant, iteration/tolerance in the
  proven-safe envelope
- `epochLength` floor (e.g. ≥ 1 day): blocks trigger-spam instances.
  **Correction 2026-07-27:** it does *not* bound hosted-proving cost.
  The admin holds `CONSTITUTIONAL_ROLE` from the creating transaction
  and `setEpochLength` is constitutional, so a creator can lower their
  own epoch immediately afterwards (`TrustgraphsFactory.sol:317-319`).
  The floor binds creation, nothing after it; ongoing cost is bounded by
  operator policy (curated subsidy) and the vault's on-chain paid
  cadence — `research/PROOF_SCHEDULER.md` §4.2 banner and §10.1.
- name uniqueness per creator via the `instanceId` derivation; global
  vanity-name squatting is a curation problem, not a registry problem

Everything else stays permissionless. Spam instances are inert: they
cost their creator gas, our prover simply doesn't prove them (see §5),
and the app doesn't feature them.

### 2.3 Roles: simple mode first

Default: `admin` (the creator, or a Safe they name) holds
`CONSTITUTIONAL_ROLE` on the snapshot, owns the typed parameter controller,
and owns the distributor. The controller is the snapshot's sole
`OPERATIONAL_ROLE` holder. That separation removes any parallel raw-hash
capability while preserving a simple creator-admin mode. The controller uses
two-step ownership, so graduating it to a Safe or operational timelock is an
explicit, reviewable handoff.

"Graduation" (timelocks, Safe governance, gov module + `addHook`) is a
later, separate flow. Note the ordering constraint the scripts encode:
`addHook` needs `CONSTITUTIONAL_ROLE` (`DeployZodiacSafes.s.sol:130-137`),
so graduation must run before any role renounce — a `graduate()` helper
on the factory (or a playbook doc) should own that sequence. The
factory itself must **never retain any role** on the instances it
creates; it holds only the registry's append-only `REGISTRAR_ROLE`.

### 2.4 Registry fit

`InstanceRegistry` is almost exactly the directory the factory needs;
two deltas:

1. **Grant the factory only `REGISTRAR_ROLE`.** The append-only registrar may
   add rows but cannot use the global `update` path to repoint an existing
   network. Each row also names a least-privilege `paramsAuthority`; only that
   controller may update that row's `paramsHash`, and it cannot change the
   program, snapshot, verifier, or accumulator.
2. **`instanceId` derivation** must be collision-free under permissionless
   creation: `keccak256(abi.encode(creator, name, salt))`, not a bare
   label hash (first-come label squatting would let a stranger block
   "gitcoin" forever with the current `keccak256(label)` convention).

The registry record stays presentation-free; `metadataURI` + name live
in the factory event / indexer tables. Curation ("featured on
trustgraph.xyz") is an app-side flag, never a registry field —
the registry is neutral infrastructure.

## 3. Discovery: registry-driven indexer + frontend

Today the entire catalog is static build-time JSON:
`config/networks.*.json` → `.docker/deployment_summary.json` → static
import in `indexer/ponder.config.ts:6` → symlinked `networks.json` in
`frontend/lib/config.ts:2`, with `generateStaticParams()` pre-rendering
network pages (`app/network/[id]/page.tsx:20-28`). A new instance
currently requires editing JSON, restarting Ponder, and rebuilding the
frontend — the exact thing the factory must eliminate.

The good news (deliberate earlier choices paying off): **the tables are
already instance-keyed.** Offchain tables key by
`merkleSnapshotContract` (`indexer/offchain.schema.ts:28,50,115,147`),
attestations carry `resolver` (`indexer/src/eas.ts:20`), distributions
key by distributor address. Handlers barely change.

Migration:

1. **Ponder `factory()` sources.** Ponder natively derives child
   addresses from a factory event argument. `InstanceRegistered` already
   emits `snapshot` and `registryOrAccumulator`
   (`InstanceRegistry.sol:40-47`); the richer `InstanceCreated` factory
   event also carries `distributor`. One `factory()` source per child
   type, children auto-indexed from their creation block — this also
   deletes the `PONDER_START_BLOCK` guesswork per instance. EAS needs no
   factory source at all: attestations hit the singleton EAS contract and
   are already attributed by resolver address.
2. **An `instance` table** written from `InstanceCreated`: id, creator,
   name, metadataURI, addresses, full params, created block. This table
   *replaces* `networks.json` as the catalog. A `/instances` API route
   serves it.
3. **Frontend runtime catalog.** `lib/config.ts` reads `/instances`
   (or the registry directly) instead of the static import;
   `app/network/[id]` flips to `dynamicParams = true` so a
   minutes-old instance resolves without rebuild. There is no live
   production network to migrate (`networks.production.json` was deleted in the cleanup;
   the legacy v1 Optimism instance is frozen and out of catalog scope); the only backfill is
   registering local dev-seed networks so there is one catalog, not two —
   and even that can simply be recreated through the factory instead.
4. **SchemaManager** builds its schema list from the catalog rows
   (each instance contributes its vouch schema UID + resolver), which it
   structurally already supports — the list is just no longer import-time
   static (`frontend/lib/schemas.ts:20-22`).

Known single-instance stragglers to sweep during the migration: the
positional template-index coupling in `deploy/env.ts:157-215`, the
`anchor` table's deferred `instanceId` dimension
(`indexer/ponder.schema.ts:60`), and the distributor `startBlock: 'latest'`
workaround (`ponder.config.ts:150-160` — factory children index from
creation block, which fixes it properly). The bespoke `/localism-fund`
route is already gone by this point (cleanup M2 removes it, replacing it
with a generic optional `applicationUrl` on the network config entry);
the factory's `metadataURI` blob is that field's long-term home — the
wizard's Identity screen should carry it forward.

## 4. The create wizard (UI)

Screens, all passing the plain-reader rule:

1. **Identity** — name, about, membership criteria, image → pinned to
   IPFS as the `metadataURI` blob. (Correction 2026-07-24: the frontend
   has **no pin path today** — score-blob pinning lives in
   `deploy/env.ts:uploadToIpfs()` and the runbook's `ipfs add` step;
   the frontend's `app/api/ipfs/[cid]` route is a read-only gateway
   proxy. The wizard needs a new pin route built on the `pinApi`
   pattern.)
2. **Trusted seeds** — "pick a few accounts everyone in your community
   already trusts; scores flow outward from them." Paste addresses /
   pick from connected wallet's graph. This is the one screen with real
   cognitive load; `research/GRAPH_SEEDING.md` (weighted teleport prior)
   is the future upgrade, but v1 ships binary seeds exactly as the live
   networks use.
3. **Tuning** — hidden behind "advanced": damping, trust multiplier,
   trust share, epoch length. Defaults = the battle-tested live-network
   params; the wizard shows consequences in plain language ("scores
   update about once a week").
4. **Add-ons** — "add a shared fund your community can distribute by
   trust score" → distributor + token picker.
5. **Review & sign** — one tx; success screen deep-links to the new
   `network/[id]` page, which is live as soon as the indexer has the
   event (seconds, not a redeploy).

## 5. Hosted proving at N instances

The prover loop generalizes cleanly because everything it needs is now
on-chain (§2.1): enumerate registry → for each instance past its epoch
boundary → `trigger()` → export input (`input-exporter` already takes
addresses as args and self-checks the fold against the checkpoint) →
prove → `submitProof`. One operational note from the cleanup: prover/exporter outputs
now default to `.trustgraph/<program>/` (one fixed directory per *program*, settable via
`--out-dir`/`--out`); a hosted loop proving N instances of the same program must pass
per-instance out-dirs (e.g. `.trustgraph/trust-graph/<instanceId>/`) or successive
instances overwrite each other's `input.json`/`proof.bin`. Per-instance cost is real,
though: one SP1 proof per instance per epoch.

Sustainable posture given "hosted by us initially":

- **Tier 0 (free, automatic):** every factory instance gets proven at
  some floor cadence (the factory's `epochLength` floor is what makes
  this affordable), while total instance count is small.
- **Tier 1 (featured/partner):** faster cadence, our cost.
- **Escape valve (always):** proving and submission are permissionless —
  any community can run `zk/prover` against their own instance whenever
  they like, per the existing runbook. This is the decentralization
  story: we are a convenience, not a dependency.
- Later, if volume demands it: a per-epoch proving bounty funded at
  creation (skippable — communities that skip it self-prove). Not v1.

## 6. Security notes

1. **Cross-instance proof replay is currently prevented by value
   uniqueness, not domain separation.** The journal commits checkpoint
   *values* `(acc, leafCount, anchorAcc, anchorCount)` and `paramsHash`,
   but no accumulator address, snapshot address, instance id, or
   chainid (`MerkleSnapshot.sol:205-243`, `encode.rs:49-67`). Two
   factory clones with identical seeds/params and identical (e.g. empty
   genesis) edge sets accept each other's proofs. Today this is
   **benign**: the guest is deterministic, so identical inputs would
   produce the identical root anyway — the replayed proof lands the
   truth. It becomes a live hazard only combined with future changes
   (multi-chain mirrors, journal reinterpretation, versioned root
   streams). Recommendation: fold the accumulator address + chainid into
   `paramsHash` (a params-schema change, *not* a journal/vkey-shape
   change) at the next planned vkey rotation — cheap insurance, batches
   with work `UPGRADE_GOVERNANCE.md` Lane C already schedules. Do not
   block the factory on it.
   **DONE 2026-07-24, in the factory build itself** rather than after it
   (`GOAL.md` M0; `research/DEVIATIONS.md` #7): `Params` is now 17 fields,
   ending `accumulator: address, chainId: uint64`. Rotating before the
   first mainnet instance costs zero ceremony; rotating after the factory
   ships would be contagious across N live instances. Journal v2
   untouched. Operator-facing statement:
   [`docs/build/create-a-network.md`](../docs/build/create-a-network.md) §1.1.

   **CORRECTION to the paragraph above (measured during the build).** The
   claim "two factory clones with identical seeds/params and identical
   edge sets accept each other's proofs" is **false on a single chain**.
   EAS derives `schemaUid = keccak256(abi.encodePacked(schema, resolver,
   revocable))`, so the resolver address is already inside `schemaUid` —
   and `schemaUid` has been a `paramsHash` field since v1. Every factory
   instance has its own resolver, so it already had its own hash. The
   same-chain hazard was covered by accident, not by design.
   What was genuinely unprotected, and is what the two fields buy:
   (a) **a cross-chain mirror** — same deployer + same nonce sequence
   yields the *same* resolver address on another chain (measured:
   identical EAS/SchemaRegistry addresses on chain 1 and chain 31337),
   hence the same schemaUid and a byte-identical v1 `paramsHash`, with no
   chain component anywhere in the 15 fields; (b) **a re-pointed
   accumulator** via the constitutional `setAccumulator`, after which
   `schemaUid` names a resolver that is no longer the input source;
   (c) **two snapshots sharing one accumulator** (the contributions
   `TrustAccumulatorMirror` shape). The change stands — but the reason is
   (a)-(c), not the same-chain clone story this section told.
2. **Post-creation scoring rotation is typed and versioned.** New factory
   instances give the raw snapshot operational role only to
   `TrustgraphsParamsController`. Its `updateParams(fullTuple, evidenceURI)`
   reuses the creation validator, locks instance identity, updates controller,
   snapshot, and directory atomically, and publishes append-only history.
   The generic raw `setParamsHash(bytes32)` remains only as a legacy/other-
   program escape hatch; bypass changes are diagnosed and are not a product
   workflow.
3. **No pause on `submitProof`** anywhere (only the distributor
   pauses). An SP1 soundness bug hits every instance at once, and a
   factory multiplies "every instance." This strengthens the case for
   `UPGRADE_GOVERNANCE.md` Lane D (freeze-only guardian) landing before
   large-scale factory adoption.
4. **Spam/abuse surface:** instances are self-funded gas; the registry
   grows unboundedly but is append-only enumeration (indexer paginates);
   impersonation ("Official Optimism trustgraph") is handled at the
   curation/featured layer plus name-in-instanceId provenance
   (creator address is part of the id and shown in the UI).
5. **Factory holds no instance roles ever** (§2.3) — a compromised
   factory can register garbage directory entries but cannot touch any
   existing instance's verifier, params, or funds. `update()` on the
   registry stays timelock-only so a factory bug can't rewrite history.

## 7. Phasing

- **Phase A — contracts.** `TrustgraphsFactory` + `ParamsCodec` calldata
  path + registry/controller wiring (`DeployInstanceRegistry` into `deploy/env.ts`,
  factory granted `REGISTRAR_ROLE`). No live-network backfill needed —
  there is no production deployment; dev-seed networks are recreated
  through the factory. Foundry suite: creation invariants (factory role-free
  post-create, paramsHash parity vs `pagerank-core` golden vectors,
  bounds rejection, id collision).
- **Phase B — discovery.** Ponder `factory()` sources + `instance`
  table + `/instances` route; frontend runtime catalog + dynamic
  `[id]` routing; retire `networks.json` as source of truth (it can
  remain a dev-seed convenience).
- **Phase C — the wizard** + metadata pinning + prover-loop
  enumeration over the registry.
- Later: `graduate()` governance flow, per-epoch proving bounties,
  additional program bundles (contributions has the mirror/bindSnapshot
  cycle and a cross-instance trust-accumulator dependency — factory-able,
  but a separate design pass), multi-chain.

## 8. Open questions (Jake)

1. **Home chain** — ANSWERED 2026-07-24 (Jake): **Ethereum mainnet**.
   (EAS + the Succinct gateway are both live there. Cost consequences —
   creation tx and per-root submit gas are mainnet-priced, and the
   public mempool forces an anti-theft mitigation on permissionless
   bounty claims — are worked in `research/PROOF_SCHEDULER.md`
   §3.2/§4.3, resolved as recipient-in-journal in its §9.1.)
2. **Creator-as-admin default** (§2.3) — ANSWERED 2026-07-24 (Jake):
   **yes, creator holds both snapshot roles in v1**; graduation is a
   later, separate flow.
3. **Params defaults** — ANSWERED 2026-07-24 (Jake): **current
   live-network params blessed as wizard defaults**; tuning knobs go
   behind "advanced".
4. **Vouch schema string** — ANSWERED 2026-07-24 (Jake): **canonical**
   (`"string comment,uint256 confidence"`) for all factory instances;
   no creator-customizable fields in v1.
5. **Free-tier proving commitment** — ANSWERED 2026-07-24 (Jake):
   **monthly** floor cadence, funded hosted; `epochLength` floor ≈ 30
   days of blocks. Full economics in `research/PROOF_SCHEDULER.md`.
6. **Domain-separation timing** — DECIDED 2026-07-24 (delegated to
   Claude, "most future proof"): **now, as part of the factory build
   itself** (`GOAL.md` M0), not deferred to a later rotation. Mainnet
   (the home chain) has nothing deployed, so rotating before the first
   mainnet instance costs zero ceremony; after the factory ships,
   rotation is contagious across N live instances. The factory is also
   exactly what creates the identical-clone hazard, and `chainId` in
   the hash is the multi-chain prerequisite §0 demands. Journal v2
   stays untouched.
