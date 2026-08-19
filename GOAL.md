# GOAL — Network creation, done properly

> **Status (2026-08-19): spec written, build not started.** Every claim below was verified against
> `main` (a45e9b3) during the 2026-08-19 diagnosis session; file:line anchors are from that commit.

Make creating a trustgraph network — of any program, with any supported feature — something a
stranger can do from the app without wedging the platform, without reading the codebase, and
without asking an operator for a privileged transaction.

Today that promise fails five ways: creating a network **crash-loops the indexer** and rolls back
the new network's own row; the creation wizard leaks its two sibling workspaces onto every step;
the weighted-prior workspace speaks in wire-format jargon and asks for identifiers that appear
nowhere in the UI; the weighted and compose factories are **not deployed anywhere** (their create
buttons are dead on every deployment); and contributions — the platform's flagship funding
feature — has **no factory at all** and cannot be self-served even by a sophisticated user,
because the registry role that registration requires is held only by factories.

---

## Decision record (Jake, 2026-08-19)

- **D1 — Full entry fork.** The wizard restructure is done properly: an explicit chooser before
  step 0, not a minimal `step === 0` gate on the two cards.
- **D2 — Governed wrappers.** Weighted and compose instances get governed-wrapper factories, the
  same Safe-from-genesis shape as `GovernedTrustgraphsFactory`.
- **D3 — ContributionsFactory is armed.** The script-only contributions deployment becomes a
  factory path with indexer and frontend support.
- **D4 — Weighted (and compose) factories go live.** Deploy scripts, pipeline wiring, and config
  keys, so the existing workspaces actually create instances.

---

## Outcome

When this goal is complete:

1. Creating any instance through the app **never kills or wedges the indexer**. The block that
   carries a creation indexes fully; the network page loads immediately after the transaction
   confirms. The whole update-without-insert hazard class is gone from `indexer/src`, not just the
   one crash site.
2. `/create` opens on a three-path chooser (standard network / weighted starting shares / compose
   proved distributions). Each path explains itself in one plain sentence. The step wizard shows
   only its own steps; the weighted path is also discoverable in-flow from the starting-accounts
   step.
3. The weighted-prior workspace passes the plain-reader test end to end. Nobody is asked to paste
   a bytes32 they have no way to find: instance ids are chosen from pickers backed by the indexer,
   and a created weighted instance has a persistent surface (directory + copyable id), not a
   one-shot toast.
4. On a fresh dev stack, `pnpm deploy:contracts` stands up the weighted and compose factories with
   their verifiers and registrar grants, and both workspaces create real instances that the
   indexer discovers and the frontend renders. The prod runbook documents the same for a real
   chain.
5. A creator can choose governance for any program: `GovernedWeightedTrustgraphsFactory` and
   `GovernedTrustComposeFactory` install the Safe + gov module + guard + recovery authority stack
   in one transaction, with the same sealed-authority guarantees and tests as the existing
   governed factory. The main wizard *says* it installs governance and shows the profile it
   installs.
6. A contributions round is created from the parent network's page in one transaction through
   `ContributionsFactory` — schemas, resolver, mirror, snapshot, distributor, controller,
   registration — indexed by discovery events instead of build-time JSON, and rendered without any
   entry in a checked-in config file.
7. Every feature that is structurally immutable at creation (distributor, governance, signer-sync)
   is a visible creation-time choice; every knob that is rotatable later is documented as such and
   not forced into the wizard.

---

## Normative baseline and pins

- Base factory design + security review: [`research/INSTANCE_FACTORY.md`](research/INSTANCE_FACTORY.md)
  (§ future work names contributions as "factory-able, but a separate design pass" at :386-389 —
  this goal is that pass).
- Weighted prior: [`research/WEIGHTED_PRIOR_DECISION.md`](research/WEIGHTED_PRIOR_DECISION.md)
  (accepted ADR; its :15-17 one-liner is the model for all rewritten copy),
  [`docs/build/weighted-prior/architecture.md`](docs/build/weighted-prior/architecture.md),
  [`docs/build/weighted-prior/runbook.md`](docs/build/weighted-prior/runbook.md).
- Contributions: [`research/CONTRIBUTION_FUNDING.md`](research/CONTRIBUTION_FUNDING.md) (design of
  record), [`docs/build/contributions/interfaces.md`](docs/build/contributions/interfaces.md)
  (**frozen**: schema strings, 21-slot params layout, journal mapping),
  [`research/audits/2026-07-M6.md`](research/audits/2026-07-M6.md) (M6-1: mirror bind rules).
- Copy voice: [`docs/learn/how-scoring-works.md`](docs/learn/how-scoring-works.md) (the liquid
  metaphor) and the main wizard's "starting accounts" vocabulary. House rules: plain sentence
  first, jargon defined in place, no internal spec numbering in the DOM, no em-dashes in site
  copy.
- Program integration checklist: [`docs/build/add-a-program.md`](docs/build/add-a-program.md).
- Interface changes are recorded in [`research/DEVIATIONS.md`](research/DEVIATIONS.md) before
  dependent code merges.
- Existing SP1 vkeys stay byte-identical. Nothing in this goal changes a guest, a params codec, or
  a golden vector (see clarification 9 for the one place this was a live question).

---

## Implementation clarifications

These close gaps found during diagnosis. They are part of the goal, not optional polish.

### 1. The creation crash is an ordering bug, and the fix is the ensure pattern

`MerkleGovModule`'s constructor emits `MerkleSnapshotContractUpdated`
(`src/contracts/merkle/MerkleGovModule.sol:222` → `:724`) long before the wrapper emits
`GovernedInstanceCreated` (`src/contracts/factory/GovernedTrustgraphsFactory.sol:197` vs `:255`).
Ponder's `factory()` child matching is block-granular, so the constructor event dispatches
**before** `indexer/src/governed.ts:120-148` — the only code that inserts the `merkle_gov_module`
row for factory children. The bare `.update()` at `indexer/src/gov.ts:436` throws
`RecordNotFoundError` (non-retryable), the **whole block's DB transaction rolls back** (including
the `InstanceCreated` row), `ponder start` exits, and every restart replays the block and dies
again. This is a permanent wedge, not a blip.

The repo already contains the correct fix, applied after a previous identical wedge:
`ensureDistributorConfig` at `indexer/src/merkle.ts:842-865`. M0 generalizes it. Because all 12
`merkle_gov_module` columns are notNull with no defaults (`indexer/ponder.schema.ts:1354-1377`),
the ensure must read the module's state via `context.client` (end-of-block state — the module is
fully constructed) rather than upsert from event args.

For **new** contracts we additionally fix this at the source: discovery events are emitted before
any child event a handler subscribes to (the `publishInitialVersion()` precedent,
`src/contracts/factory/TrustgraphsFactory.sol:417-420`). Existing contracts are healed
indexer-side only; both defenses ship.

### 2. `MerkleRootUpdated` is the second wedge, hiding behind the first

The gov module is installed as a snapshot hook (`GovernedTrustgraphsFactory.sol:230`) and re-emits
`MerkleRootUpdated` (`MerkleGovModule.sol:536`), handled by another bare update at `gov.ts:453`.
Any governed network whose row was lost — or any start-block configuration that skips the creation
block — wedges again on its **first proof submission**. M0's sweep covers every site, not the one
in the crash log: `gov.ts:215,400,412,424,436,453,469,481`, `vault.ts:133,191,210,218,225`,
`signer-sync.ts:95`, `erc8004.ts:112,285,345`, `erc8004-reputation.ts:160`,
`graph-lineage.ts:54,148,185`, `eas.ts:61`, plus the explicit-throw variants
(`graph-lineage.ts:71-75`, `score-program-binding.ts:155-159`, `composition.ts:472-473`,
`erc8004-reputation.ts:155-158,284-289,321-326`). Sites that are safe today only because of event
ordering (`params.ts:218`, `weighted-prior.ts:197`, `composition.ts:268`) get a comment saying so,
so nobody "fixes" them into fragility.

### 3. TGWP is a file format, not a user concept

TGWP is the 4-byte magic of the manifest blob (`packages/weighted-prior-core/src/manifest.rs:123`,
`frontend/lib/weighted-prior/core.ts:196-242`, `WeightedPriorValidator.sol:18`). Rewritten copy
never leads with it. "Resolve names outside consensus" means: ENS names are resolved in the
browser at a finalized mainnet block, recorded only in the provenance receipt, and re-checked
before simulate and before sign (`import.ts:448`, `workspace.tsx:374-389`); copy says that in
those words. The vocabulary is the wizard's: **starting accounts, with different sizes**. The
exact-bytes machinery stays fully visible in the verify/export section — it moves down the page,
it does not disappear.

### 4. Instance ids come from pickers, with copyable fallbacks

Both id inputs in the weighted workspace are bytes32 factory instance ids used purely as indexer
lookup keys. The binary id already has surfaces (network URL, Settings → Advanced → Instance ID,
`SuccessStep`); the weighted id has **none** — it appears once in a non-persisted toast
(`weighted/workspace.tsx:523`) and cannot be recomputed because the creation salt is random per
page load (`workspace.tsx:100-104`). The fix is structural: a binary-instance picker backed by
`useNetworks()` (`contexts/CatalogContext.tsx:91-107`, mounted app-wide) and a weighted-instance
picker backed by `GET /weighted-priors` (already fetched by the composition workspace's candidate
grid, `lib/composition/api.ts:124-137`). Free-text stays as an escape hatch with helper text
naming where ids live. The composition workspace's rotate-mode input gets the same treatment.

### 5. One summary key per factory, agreed by both consumers

The indexer reads `deploymentSummary.compositionFactory.composition_factory`
(`indexer/ponder.config.ts:75,195`); the frontend generator reads
`deployment.trustComposeFactory.trust_compose_factory`
(`frontend/scripts/generate-config.ts:80`). Whichever key a deploy step writes, one consumer
silently stays empty. M3 picks **`trustComposeFactory.trust_compose_factory`** (matches the
contract name and the frontend) and retargets the indexer. Weighted already agrees on
`weightedFactory.weighted_factory` in both consumers — keep it.

### 6. Governed wrappers are three concrete contracts sharing singletons

`CreateArgs` diverges too much for a generic wrapper (weighted adds `bytes manifest`; compose adds
`bytes policyManifest` + `address[] sourceAdapters`). What **is** shared:
`GovernedAuthorityDeployer` and `SignerSyncModuleDeployer` (`InstanceDeployers.sol:87-168`, both
program-agnostic — share the deployed *instances* so the indexer's `signerSyncModuleDeployer`
source needs no change), the registry path (wrappers call through their base factory, which keeps
the only `REGISTRAR_ROLE` grant — no new grants), and a **new `MerkleGovModuleDeployer`**.
`MerkleGovModule` is currently `new`'d inline (`GovernedTrustgraphsFactory.sol:197`) and its
initcode is the wrapper-size budget's biggest line item; the deployer solves EIP-170 for three
wrappers at once *and* hosts the ordering fix: silent construction, then a post-discovery
initializer that emits `MerkleSnapshotContractUpdated` after the wrapper's discovery event.
`MerkleGovModule` is confirmed program-agnostic — the leaf encoding is identical across
trust-graph, weighted, and compose cores (`packages/zk-core/src/merkle.rs:10-16`, consumed by all
three `compute.rs`), and the hook only needs `CONSTITUTIONAL_ROLE`, which all three factories give
to `admin` = the Safe. All three wrappers emit the **same** `GovernedInstanceCreated(instanceId,
creator, safe, merkleGovModule, snapshot)` signature so `governed.ts` registers one handler N
times. The existing `GovernedTrustgraphsFactory` is redeployed on the shared deployer (dev-only;
no production deployment exists to migrate).

### 7. The vault prices programs; the wrappers must ask it, not assume

`ProvingVault.bandOf` (`src/contracts/vault/ProvingVault.sol:461-490`) has **no
`trust-graph-weighted` case** — it returns 0 (unpriced), so a governed-weighted prepay path is
dead on arrival. And `GovernedTrustgraphsFactory.sol:156` hardcodes fee band `1`, which is wrong
for trust-compose (flat band 3). M4 extends `bandOf` with `trust-graph-weighted` (sized bands,
like trust-graph) and makes the wrappers derive the guardrail band from the vault instead of a
literal. Recorded in DEVIATIONS; the vault is redeployed on dev by the normal pipeline.

### 8. Signer-sync plumbing ships in the wrappers; enabling it stays blocked

`SignerSyncZkModule` is mechanically generic (any `MerkleSnapshot` + any `IAttestationAccumulator`)
but the only signer guest proves the **trust-graph** selection pipeline
(`zk/program/src/signer.rs`). The new wrappers accept the `SignerSyncConfig` struct — the deployer
already fails closed on a vkey mismatch (`InstanceDeployers.sol:142-145`) — but the frontend does
not offer it for weighted/compose, and docs say why. Per-program signer guests are out of scope.

### 9. Contributions params keep journal-level domain separation

The 21-slot contributions params layout has no `chainId`/`accumulator` fields; replay separation
lives in the journal's `instanceDomain = keccak256(abi.encode(snapshot, chainId))` rebuilt by
`submitProof`. Adding v2-style fields would regenerate `test/golden/contributions.json` and rotate
the contributions vkey. **Ruling: keep journal-level separation** — it is sound (the domain binds
snapshot and chain), and this goal does not rotate vkeys. Recorded in DEVIATIONS with the
reasoning, so the door stays visibly open for a future codec bump.

### 10. ContributionsFactory shape

Mirrors `TrustgraphsFactory` discipline throughout:

- **instanceId** becomes `keccak256(abi.encode(creator, name, salt))` — the script's
  snapshot-address-mixing derivation (`DeployContributionsInstance.s.sol:159`) is not
  pre-computable and breaks the wizard pattern.
- **Parent linkage is a first-class argument**: `CreateArgs.parentInstanceId`; the factory reads
  the registry, asserts `program == keccak256("trust-graph")`, uses the record's accumulator as
  the mirror's `trustAccumulator`, and emits `parentInstanceId` in the creation event. The
  frontend's address-equality matching (`lib/network-nav.ts:39-49`) and the operator's
  `parent_instance_id: None` (`packages/operator-core/src/catalog.rs:616`) both graduate to the
  explicit link.
- **Schema squatting ×3**: the adopt-existing-UID pattern (`TrustgraphsFactory.sol:309-337`)
  applied to all three schema registrations, with `SchemaAdopted(instanceId, schemaIndex, uid)`.
- **Mirror is CREATE'd inline by the factory** (1,959 B initcode) because
  `TrustAccumulatorMirror.binder = msg.sender` is not a constructor arg; resolver is also inline
  (its `schemaAdmin` **is** a constructor arg, but inline keeps the bind/setSchemas dance in one
  frame). Snapshot + distributor reuse the existing deployers; a new
  `ContributionsParamsControllerDeployer` mirrors the trust-graph one. Budget ≈ 16-18 KB runtime
  under `via_ir` — fits, with a fallback of externalizing the validator library.
- **Distributor follows the factory convention** (fee 0, feeRecipient = admin), not the script's
  3%-to-deployer.
- **Verifier is a shared immutable** cross-checked in the constructor via `programVKey()`
  (the `TrustComposeFactory.sol:100-107` pattern), replacing the script's per-instance verifier
  deploy. `TestUSDC` and the params-file round-trip disappear entirely — the daemon already
  serializes params from chain (`zk/operator/src/handlers.rs:815-830`).
- **A `ContributionsParamsValidator` must be written from scratch** (none exists, unlike the other
  three programs): trust-graph's bounds re-derived for the 21-field tuple plus round-specific
  bounds (window ordering, carveout ≤ 10_000 bps, multiplier ≤ scale, pool sanity).
- **The reconstruction contract is preserved**: `registerWithParamsAuthority` +
  `publishInitialVersion()` exactly as today, so `operator-core`'s five-way agreement check
  (`catalog.rs:546-636`) keeps working with zero changes. The factory event is purely additive.
- **Round creation is gated on the parent's authority**: the factory requires
  `MerkleSnapshot(parentSnapshot).hasRole(CONSTITUTIONAL_ROLE, msg.sender)`. Anyone can create a
  trust network; only a network's authority can hang a contributions round on it (for governed
  networks that means a proposal, which is exactly right). This kills the spam/ambush problem —
  rounds render on the parent's tab, so permissionless creation would let strangers decorate
  other people's networks. *(Flagged for Jake: the permissive alternative is permissionless
  creation + frontend filtering; the gate is one `hasRole` staticcall and is the recommendation.)*
- **Contracts allow N rounds per parent; the UI shows all, newest active first.** The
  one-active-round framing stays as presentation (`contributions/page.tsx:52-55`), not a contract
  invariant.

### 11. The wizard fork lives at `/create`, before the first side effect

Step 0's Continue pins metadata to IPFS (`app/create/component.tsx:118-146`), so the chooser must
precede `IdentityStep`, not live inside it. `/create` keeps its URL (bookmarks, and
`lib/composition/workspace.source.test.ts:45` asserts `href="/create/composition"` stays in
`component.tsx`). `STEPS`' hardcoded indices (`component.tsx:99-116,141,156`;
`ReviewStep.tsx:490-506`) become data-driven in the same change. Contributions is **not** a
creation-time checkbox — it needs a live parent, so its home is the network page (M7), with an
informational note in the wizard's Extras step mirroring the existing fund note
(`AddOnsStep.tsx:296-303`).

---

## Non-negotiable invariants

1. **A valid chain never wedges the indexer.** Any event the config subscribes to either updates
   an existing row, materializes it via an ensure, or logs-and-skips with a warning. No bare
   `.update()` on a row a factory child might not have; no silent catch.
2. **Discovery before children** in every new contract: the event that teaches the indexer a child
   exists is emitted before any child event a handler consumes.
3. **Copy passes the plain-reader test**: plain sentence first, jargon defined in place, no wire
   formats in the lede, no em-dashes in site copy. Exact-bytes affordances remain available —
   honesty is not the casualty of clarity.
4. **No free-text identifier without a picker or a documented place to find it.**
5. **Existing vkeys, golden vectors, and frozen interfaces stay byte-identical.** DEVIATIONS.md
   records anything that touches an interface doc.
6. **Wrapper factories retain no authority**: after creation the Safe (or EOA admin) holds
   everything; factory and deployers are inert (mirror the `test_FactoryAndDeployersAreInertAfterCreation`
   discipline). Every new factory/wrapper has an explicit EIP-170 headroom test.
7. **`operator-core`'s catalog reconstruction keeps working unchanged** for contributions
   (registry row + typed controller is the creation record; events are additive).
8. **Source tests are contracts.** `workspace.source.test.ts` pins (aria ids, literal button
   labels, the composition href) are honored or consciously updated in the same commit as the UI
   change, never broken incidentally.

---

## Scope

**In**: indexer resilience class-fix; `/create` fork + wizard restructure; weighted workspace
copy + pickers + persistent weighted surface; deploy scripts and config wiring for weighted +
compose factories (dev pipeline + prod runbook); `GovernedWeightedTrustgraphsFactory` +
`GovernedTrustComposeFactory` + shared `MerkleGovModuleDeployer` + vault band extension;
distributor/prepay exposure on the weighted + compose creation paths; `attachDistributor` on the
base factories with indexer + Features-tab support; `ContributionsFactory` + validator + indexer
discovery + frontend decoupling + "start a contribution round" flow; docs.

**Out**: per-program signer guests; governance parameter configurability at creation (the profile
stays factory-asserted; rotatable post-creation by the Safe); an ungoverned path in the main
wizard (the base factory remains callable directly); hypercerts/nostr factories; contributions
params codec v2; production deployment execution (runbook only — no prod exists to migrate);
multi-chain deploy-artifact scoping (SEPOLIA.md's manifest proposal — separate effort, noted where
it bites).

---

## Execution map

Five lanes. Lanes A–E are independent at build time and are intended to run as **parallel
subagents in separate worktrees**; integration order is A → C → (B, D) → E, because A unblocks
verifying everything else on a live dev stack and C gives B and D real addresses to test against.

| lane | milestones | depends on | parallel-safe |
|---|---|---|---|
| A — indexer resilience | M0 | — | yes (indexer/src only) |
| B — creation UX | M1, M2 | live-verify needs C | yes (frontend/app/create only) |
| C — factories live | M3 | — | yes (script/, deploy/, config generators) |
| D — governed wrappers | M4, M5 | integration needs C; M5 verify needs M4 | yes (src/contracts + test, then indexer/frontend) |
| E — contributions | M6, M7 | M7 needs M6; live-verify needs A | yes (new contracts; then indexer/frontend) |
| close-out | M8 | all | — |

Within lanes, milestones also fan out internally (e.g. M0's sweep is a per-file checklist;
M2's copy pass and picker build are separable). Each lane lands as its own reviewed commit series;
no lane blocks another's build phase.

---

## M0 — The indexer survives creation (and everything else)

Fix the crash class, not the crash.

- `ensureMerkleGovModule(context, address)` extracted from `governed.ts:50-148`'s read-back,
  called at the head of every `merkle_gov_module` update in `gov.ts` (all eight sites).
- Sweep every hazard site listed in clarification 2 with the matching remedy: ensure-by-readback
  where the row is reconstructible, log-and-skip where it is genuinely out-of-universe
  (pre-start-block ERC-8004 registries, foreign attestations). Ordering-safe sites get the
  "safe because…" comment.
- `merkleGovModule:setup`'s silent catch (`gov.ts:158-160`) logs a warning naming the stale
  address.
- Regression: a dev-stack e2e that creates a governed instance through
  `GovernedTrustgraphsFactory` and asserts (a) the indexer process stays up, (b)
  `GET /instances/:id` returns 200 with governance populated, (c) a subsequent root submission
  indexes. Plus unit coverage for the ensure path (event arrives with no row → row materialized
  correctly).

**Exit**: the reported repro (wizard-create on dev) passes live; the sweep checklist is complete
with each site's remedy named in the commit message; regression suite green.

## M1 — The creation fork

- `/create` renders a three-path chooser (standard / weighted shares / compose) before any wizard
  state; cards move out of the always-rendered header (`component.tsx:216-248`).
- Step machinery becomes data-driven; step chips, `stepProblem`, `skipPinning`, and `ReviewStep`
  jump targets survive the restructure.
- `SeedsStep` gains the in-flow affordance: a Note-level link "want these accounts to count
  unequally?" → weighted workspace, carrying the already-entered accounts as prefill when
  practical.
- The factory-unavailable early return (`component.tsx:203-204`) gets the same chooser treatment.

**Exit**: chooser on entry; zero sibling-workspace UI inside steps 0–4; source tests green;
`npx tsc --noEmit` green; screenshot pass over all steps in both themes.

## M2 — The weighted workspace speaks human

- Full copy pass per clarification 3: lede, page metadata, mode labels, section headings,
  warnings, and the entry card on `/create` — using the ADR's vocabulary and the wizard's
  "starting accounts" register. Pinned literals honored.
- Binary-instance picker (from `useNetworks()`) and weighted-instance picker (from
  `GET /weighted-priors`) replace bare inputs; free-text fallback keeps helper text naming the
  Settings → Advanced path. Composition rotate-mode input gets the same picker.
- Weighted instances get a persistent surface: listed in the networks directory (or a dedicated
  catalog section) with copyable ids; the creation success state renders the id as `CopyableText`
  and links to the rotation mode.

**Exit**: a reader with no trustgraphs context can narrate what each screen does (plain-reader
pass); no free-text-only id inputs remain; a created weighted instance is findable after a page
reload; source tests updated deliberately where labels changed.

## M3 — Weighted and compose factories live

- `script/DeployWeightedTrustgraphsFactory.s.sol` + `script/DeployTrustComposeFactory.s.sol`:
  deployers, verifier runs (`DeployZkVerifier` labels `weighted` / `composition`, vkeys from
  `trustgraph-prover <program> vkey`), factory constructor args incl. epoch floor + activation
  delays, `REGISTRAR_ROLE` grants mirroring `DeployFactory.s.sol:117-131`, `.docker/*_deploy.json`
  artifacts. Compose additionally deploys `CompositionSourceAdapterFactory` + its two deployers
  and satisfies the ctor `programVKey()` cross-check.
- `deploy/env.ts`: new steps in `DevEnv.deployContracts`; `generateDeploymentSummary()` emits
  `weightedFactory.weighted_factory` and `trustComposeFactory.trust_compose_factory`
  (clarification 5); `ponder.config.ts` retargeted to the compose key.
- Frontend config regenerates with both addresses; indexer restart documented in the taskfile.
- Prod: `docs/build/production.md` + the weighted/composition runbooks gain the actual deploy
  commands (today they only describe pointing config at an address that never existed).

**Exit**: on a cold dev stack, both workspaces create real instances end-to-end; indexer rows
appear (`/weighted-priors`, composition catalog); rotation mode loads a created instance's
history; `README.md`'s program table statuses updated.

## M4 — Governed wrappers

- `MerkleGovModuleDeployer` (silent ctor + post-discovery init emitting
  `MerkleSnapshotContractUpdated`), shared by all three wrappers;
  `GovernedTrustgraphsFactory` rebased onto it (dev redeploy).
- `GovernedWeightedTrustgraphsFactory` + `GovernedTrustComposeFactory`: bootstrap Safe → base
  factory `createInstance` (admin = Safe) → optional vault policy (band from the vault, not a
  literal — clarification 7, incl. the `bandOf` extension for `trust-graph-weighted`) → gov module
  via deployer + defaults assertion → authority deployer → optional signer-sync config
  (plumbed, not offered — clarification 8) → enableModule / addHook / setGuard / swapOwner / seal
  → common `GovernedInstanceCreated` signature.
- Tests mirror the 16-case `GovernedTrustgraphsFactory.t.sol` suite per wrapper, plus inertness
  and EIP-170 headroom for every new contract (including a headroom test for the *existing*
  governed factory, which has none).
- Indexer: new sources + the one shared handler registration; `signerSyncModuleDeployer` source
  unchanged (shared instance).
- Frontend: "create with governance" on both workspaces, with the `authorityProfileValid` check
  ported from `ReviewStep.tsx:152-194` (extended to display the program's own activation delay —
  prior/policy rotation under governance compounds voting + execution + activation delays, and the
  review screen says so in plain words); receipt scanning retargeted (the base factory emits
  `*InstanceCreated`, the Safe is the creator, so `log.address === WEIGHTED_FACTORY_ADDRESS`
  filtering breaks — scan by event topic across the receipt).

**Exit**: governed weighted + governed compose instances created from the app on dev; Safe holds
all authority (asserted by tests and visible in settings); indexer populates governance for both;
forge suite green with the new tests; DEVIATIONS entries for the vault band extension and the gov
module deployer.

## M5 — Creation features, visible and complete

- Weighted + compose creation paths expose `withDistributor` + `distributorToken` (contracts
  already support both — the frontends hardcode `false`) and the vault prepay field where priced.
- The main wizard *states* governance: Extras/Review name the Safe, the voting profile (read live
  from the factory, as `ReviewStep` already does), the recovery delay, and what "your wallet
  becomes the sole Safe owner" means.
- `attachDistributor(instanceId)` on the three base factories: permissionless deploy via the
  existing distributor deployer, owner = current snapshot constitutional holder, emits
  `DistributorAttached(instanceId, distributor, distributorToken)`; indexer handler + a
  Features-tab action replacing the read-only "no fund" card; the wizard's "a fund can only be
  included at creation" copy corrected.
- Extras step gains the informational contributions note pointing at the network-page flow (M7).

**Exit**: gap table from the diagnosis reads "exposed" for every one-tx feature on every factory
lane; attach-a-fund works live on dev on an instance created without one; forge + indexer + UI
tests green.

## M6 — ContributionsFactory (contracts)

Everything in clarification 10, as one reviewed contract change-set:

- `ContributionsFactory` + `ContributionsParamsControllerDeployer` + `ContributionsParamsValidator`
  + `SchemaAdopted`/creation/controller events (the event carries parent id, all child addresses,
  the three schema UIDs, epoch length, and the params tuple).
- `DeployContributionsFactory.s.sol` + dev pipeline step + summary key + registrar grant.
- Test surface: creation happy path against a live parent; parent-gate enforcement (non-authority
  reverts); schema squat ×3 adoption; mirror bind + M6-1 regression; params validator bounds;
  factory/deployer inertness; EIP-170 headroom; `operator-core` catalog reconstruction against a
  factory-created instance (five-way check passes untouched).
- The dev demo round is recreated through the factory (`CreateDevInstances` pattern — no
  static-path backfill), keeping the script as a legacy reference until M7 removes its consumers.

**Exit**: one transaction creates a full contributions instance on dev from a plain EOA holding
the parent's constitutional role; the operator daemon proves it with zero manual config; forge
green; gas measured and recorded (mainnet cost stated honestly in the docs).

## M7 — Contributions in the product

- Indexer: `factory()` sources for resolver / snapshot / distributor children; the
  `CONTRIBUTIONS_INSTANCES` build-time import (`contributions-shared.ts:34-86`) replaced by a DB
  table populated from the creation event; a `/contributions/instances` discovery route; existing
  round/claims/payout APIs keyed off the table.
- Frontend: rounds resolved from the indexer (parent link by `parentInstanceId`, not address
  equality); the "Contribution cycles" settings card gains **Start a contribution round** →
  `/networks/[id]/contributions/new` (round window, pool, carveout; schemas and wiring automatic;
  plain-reader copy); multiple rounds render with newest-active default; static
  `CONTRIBUTIONS_NETWORKS` config retired.
- The `contributions UX` GOAL's submit/claim terminology split is honored in all new copy.

**Exit**: on dev, create a network → start a round from its settings page → attest → prove →
claim, all without touching a config file; no `CONTRIBUTIONS_NETWORKS` references remain;
indexer + frontend + e2e green.

## M8 — Docs and close-out

- `docs/build/create-a-network.md` covers all creation lanes incl. governed wrappers;
  weighted/composition/contributions runbooks updated with real deploy + create flows; FACTORY
  operator doc updated; `docs/concepts/networks-and-programs.md` statuses refreshed.
- DEVIATIONS entries audited against the actual diffs; `TODO.md`'s "Follow up work" section
  cleared of items this goal closed.
- Verification matrix (below) run end-to-end on a cold stack; results recorded in the closing
  commit.

---

## Verification matrix

| check | command / method | milestones |
|---|---|---|
| Solidity suite (incl. new wrapper/factory tests, size + inertness) | `task test` | M4-M6 |
| Rust cores + goldens unchanged | `cargo test -p pagerank-core -p weighted-prior-core -p contributions-core` | all |
| Frontend types + source tests | `npx tsc --noEmit` (filtered per known excludes) + vitest | M1, M2, M4, M5, M7 |
| Indexer survives creation | M0 e2e (create → 200 → root indexed) on cold dev stack | M0, gate for all |
| Cold-stack walkthrough | `task start-all-local` + `pnpm deploy:contracts` → create standard, weighted, compose, governed-weighted, governed-compose, contributions round from the app | M3-M7 |
| Plain-reader copy pass | fresh-eyes read of every new/changed user-facing string | M1, M2, M5, M7 |
| Screenshot sweep, both themes | production build + `shots.mjs` guards (never `next dev`) | M1, M2, M5, M7 |

---

## Done when

1. The M0 regression and the cold-stack walkthrough both pass on a fresh checkout.
2. All five creation lanes work from the app on dev; every created instance is indexed, rendered,
   and findable after a reload.
3. The diagnosis gap table has no "supported by contracts but not exposed" rows left for
   governance, rewards, prepay, or contributions.
4. No user-facing string fails the plain-reader test; no id field lacks a picker or a pointer.
5. Docs describe what exists; TODO.md no longer lists this work; DEVIATIONS records every
   interface touch.
