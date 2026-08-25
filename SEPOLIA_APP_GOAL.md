# GOAL: the app on Sepolia, and a network you create in a browser

> Five contracts are live on a public chain and nothing points at them yet. This program
> closes that gap from the other end: an indexer that follows Sepolia, a frontend that says
> plainly which chain you are on, and a create page that works, so the first network on
> Sepolia is one somebody made in a browser rather than one we minted with a script. The
> same path a visitor takes is the path we take first.

**Status:** opened 2026-08-25, on `main` at `13eb98d`. In progress: M0 and M2 are complete, and the
M1 live indexer is complete, but its finalized frontend artifact still needs the public URL. M3,
M5, and M6 have their repository implementation but still need the public-host/browser/live
service evidence described below. M4 has not started because the first network must remain a
browser transaction.

**Execution record, 2026-08-25:** the additive continuation deployed signer verifier
`0xF99e2c06018f2Aa8078859854ecb1fC3C7368b63`, governed factory
`0xFd0ee86105bF67C5c74653b8268c74120C485b6b`, and signer-sync deployer
`0x71CaAe36fF68b329422283bD14Eb88c1D90952c9`. The fork rehearsal used the wizard's exact governed
creation path and produced a canonical Safe 1.3.0 proxy; the live post-deploy audit passes 27/27
with all original addresses unchanged. The `trustgraph_sepolia_v2` indexer historical phase took
21.6 seconds and is in realtime mode; at the latest audit it served `/ready`, `/health`,
`/instances`, and `/metrics`, with zero instances. Its current process had issued 554
`eth_getLogs` calls and recovered from 38 log and 14 block RPC failures, which is direct evidence
that production needs the independent failover required by M6. A Pinata compatibility upload
returned and served the exact expected raw CID
`bafkreihn2e6333b6fme3vpdb7udr5bhwynraq4w4bpu3rhpjhtif3mebyi`.
An optimized Sepolia Next build against the live manifest also passed with local smoke endpoints;
a clean Playwright browser saw the persistent testnet banner and the standard governed creation
path, with weighted, composition, and contributions entry points absent. The development config
links were restored after that probe; the generated Sepolia artifact was deliberately not retained
with localhost URLs. A later outage drill forced the primary RPC to an unreachable loopback port:
the production indexer preflight still reached chain 11,155,111 through its fallback, while a clean
browser observed proxy transport 0 return 502 and Wagmi continue through transport 1 at 200. A
PostgreSQL 17.10 custom-format backup then passed its SHA-256 check and restored 451 application
tables across 9 schemas; source and restored counts matched, and the exact temporary drill database
was removed afterward. Release run
[`32892667547`](https://github.com/AInima-Collective/trustgraphs/actions/runs/32892667547), at
commit `22bbf4a`, then reproduced the guests twice and published the attested linux/amd64 +
linux/arm64 operator index as
`ghcr.io/ainima-collective/trustgraphs-operator@sha256:876aa9e9569e2de4366404a96b24ae4222e75763cbc692820bd9cdbfd15e0a40`.
The workflow's anonymous pull and embedded-vkey derivation passed, an independent anonymous registry
read returned that same index digest and both platforms, and the production compose preflight
accepted the complete digest reference. The persistent-volume restart drill remains outstanding.

**Baseline, measured today on live Sepolia:** the five contracts are deployed and all
nineteen post-deploy invariants pass. `InstanceRegistry.instanceCount()` is 0.
`TrustgraphsFactory.VAULT()` is the deployed vault, `EPOCH_FLOOR()` is 7,200 blocks, about a
day at Sepolia's cadence. Base fee sampled at 1.02 gwei. The deployer holds 0.457 ETH and the
submitter key holds 0.200 ETH at nonce 0.

**Test baseline:** `pnpm test:deploy` 7/7, the indexer's profile and chain-identity suites
5/5, and the frontend suite green in full once `ESBUILD_BINARY_PATH` is set (see the
landmines). The working tree is clean and six commits are unpushed.

**Readiness checks run before opening, so no milestone starts on an assumption:**

- **The RPC serves the deployment block.** `eth_getBalance` and an event-time `eth_call` both
  answer at block 11,565,413, and `eth_getLogs` spans the full deployed range. This was M1's
  one genuine unknown and it is answered: no archive provider is needed. The backfill is 307
  blocks, so it will be over in seconds.
- **Findings 2 and 3 are confirmed by running the generator, not by reading it.** A Sepolia
  config generated from the finalized manifest carries the five live addresses correctly,
  and ships `"ponder": "https://ponder.example.com/ponder"` and
  `"GovernedTrustgraphsFactory": ""` without complaint.
- **`config.production.json` is tracked but `config.development.json` is not.** The Sepolia
  config is a release artifact for a public chain, so it should follow the tracked sibling.

**Predecessor:** [SEPOLIA_GOAL.md](SEPOLIA_GOAL.md), whose broadcast happened on 2026-08-25.
This program takes over that program's M1, M3, M6 and M7 and rewrites them against what is
actually in the tree, which turned out to be considerably more than that document assumed.
Its M4, M5 and M8 are done: the custody handoff is complete, preflight and the post-deploy
check are both committed commands, and the fork rehearsal predicted the real broadcast's gas
digit for digit. Its M2 is not done and is now mostly moot: `DeployProvingVault.s.sol:53-59`
still only checks that the feed and USDC are nonzero, but the vault is already deployed and
its wiring was verified after the fact, so those assertions matter for mainnet rather than
here. Its M0 inputs are in hand except the ones listed in the operator ledger below.

**Sibling:** [GOAL.md](GOAL.md) is the operator packaging program and is still open at its
M6. Nothing here touches it. M5 of this program consumes its release, which as of today is
**`v0.0.5`**, published 2026-08-25. Pin it **by image digest** rather than by tag, and verify
the guest identities embedded in it against both vkeys in the manifest before the first real
root. A mutable tag is not a pin, and the release that matters here is the one whose guests
match what the verifiers were built against.

---

## What is already true

Much more Sepolia support exists than the runbook suggests. Every row below was read in the
tree today, not inferred:

| Area | State |
| --- | --- |
| `contracts/deploy/profiles.ts` | Sepolia profile with chain id, RPC variable, explorer and `releaseManifestFile` |
| `packages/indexer/ponder.config.ts` | Sepolia chain block, start block from the manifest, `CORE_CHAIN` threaded through every contract source |
| Factory discovery in production | Already keyed on the deployment artifact, not the stage: `FACTORY_DISCOVERY = TRUSTGRAPHS_FACTORY !== undefined` |
| `launch-indexer.mjs`, `deployment-profile.mjs` | Resolve Sepolia, demand `PONDER_DATABASE_SCHEMA` in production, refuse a `planned` manifest, preflight chain id, head, historical state and bytecode |
| `packages/frontend/scripts/generate-config.ts` | Reads the release manifest and writes `config.sepolia.json` |
| `scripts/link-deployment-config.mjs` | Links `config.sepolia.json` and `config/networks.sepolia.json` |
| `packages/frontend/lib/wagmi.ts` | Sepolia chain behind the `/api/rpc/11155111` proxy |
| `.env` | Already carries `PONDER_RPC_URL_11155111`, `PONDER_DATABASE_SCHEMA=trustgraph_sepolia_v1`, `PONDER_VIEWS_SCHEMA`, and both released vkeys |
| `config/networks.sepolia.json` | Exists as `[]`, the outage fallback for the runtime catalog |
| `packages/frontend/lib/blocks.ts` | No Sepolia entry, but falls through to `?? 12`, which is correct |

Two database rows, `dev-31337` and `prod-11155111`, already coexist in one Postgres with
separate schemas. Local development and testnet development do not contend for storage.

### The create wizard, and why it is hidden

The wizard writes only through `GovernedTrustgraphsFactory`
(`app/create/steps/ReviewStep.tsx:111`), and `isFactoryAvailable()`
(`app/create/model.ts:29`) requires both the base factory and the governed one. We deployed
the base factory alone, and `generate-config.ts:81` hardcodes the governed address empty for
Sepolia, so the page hides itself twice over.

The governed factory is a wrapper, not a replacement, and this is what makes the whole
program cheap:

- `TrustgraphsFactory.createInstance` is permissionless (`contracts/src/factory/TrustgraphsFactory.sol:315`,
  no role modifier), so the wrapper needs no grant and no redeploy of anything live.
- The signer verification key it pins is already released and already in `.env`:
  `0x00d1b981df6bee1682be2b212151d2ac74c30108215d8e949a84a604ae4baadb`, matching
  `guest-manifest.json`. No new operator input.
- `SAFE_PROXY_DEPLOYMENT_CODE_HASH` and `SAFE_PROXY_RUNTIME_CODE_HASH` are derived from
  whatever proxy factory the constructor is handed
  (`contracts/src/factory/GovernedTrustgraphsFactory.sol:160`), so passing the canonical Safe
  pair is safe by construction rather than by luck.

The canonical Safe deployments were re-verified live on Sepolia today: 1.3.0 singleton
`0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` (22,958 bytes of code), 1.3.0 proxy factory
`0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` (3,774 bytes), and the 1.4.1 pair also present.

---

## What is missing

Ten findings, each measured. Numbered for reference from the milestones, not as an ordering.

1. **`config.sepolia.json` has never been generated,** and `prebuild`
   (`packages/frontend/package.json:7`) runs `config:link` without `config:generate`, so a
   Sepolia build has nothing to link and fails at the link step.
2. **The config generator ships a placeholder API URL.** `generate-config.ts:99` falls back
   to `https://ponder.example.com/ponder` when `PONDER_URL` is unset. That is a build that
   looks healthy and has a dead data plane. It must fail closed on a public target.
3. **The governed factory address is hardcoded empty** for Sepolia at
   `generate-config.ts:81`.
4. **`IPFS_GATEWAY` is unset,** and `packages/indexer/src/merkle.ts:454` throws without it.
   This blocks reading a score back after a root lands, which is the whole point of the
   first proof.
5. **The pin route has no target on a public chain.** `app/api/ipfs/route.ts:37` defaults to
   Pinata off-local and needs a bearer token. Without it the wizard cannot save a network's
   description, so creation fails at the last step before the transaction.
6. **No testnet indicator, and the wrong-network handling is worse than absent.** There is no
   "testnet assets have no value" copy anywhere in the frontend. The wrong-network path, by
   contrast, is already built and then some: the create page renders an explicit switch card
   (`app/create/component.tsx:309`), and `WalletConnectionProvider` has a full add-and-switch
   fallback that calls `wallet_addEthereumChain` when the switch fails
   (`components/WalletConnectionProvider.tsx:85`). The problem is that it fires from a
   `useEffect` the moment a connected wallet is seen on the wrong chain
   (`WalletConnectionProvider.tsx:101`). An unrequested wallet popup on page load is
   acceptable on a dev stack and reads as hostile on a public domain.
7. **The RPC proxy forwards any method to any configured chain.**
   `app/api/rpc/[chainId]/route.ts` caps body size and batch size and nothing else, so
   `eth_sendRawTransaction` relays through our provider credentials today.
8. **The pin route is an unauthenticated public write path** with size caps only, and no
   rate limit, origin check or quota alert.
9. **`docker-compose.prod.yml` runs `pnpm install --frozen-lockfile` against the bind-mounted
   repo.** In this shared checkout that overwrites the Mac's darwin natives with linux ones.
   It must never be pointed at this working tree.
10. **`.env` is a single global switch, and it currently reads `production` / `sepolia`.**
    `launch-indexer.mjs` and `ponder.config.ts` both load it, so local indexer development in
    this checkout is switched off right now. The frontend is unaffected, because
    `generate-config.ts` never loads dotenv, which is surprising enough to be worth writing
    down.
11. **The deploy runner has no additive path, and this blocks M2.** It loops every entry in
    `env.deployContracts` and skips only when a `skip` predicate says so
    (`contracts/deploy/deploy-contracts.ts:93`). In the Sepolia plan exactly one entry has
    one, and it reads an environment variable rather than chain state
    (`contracts/deploy/env.ts:1326`). Appending two steps therefore redeploys the live five.
    `generateReleaseManifest` makes it worse: it rebuilds the record from `.docker/*_deploy.json`
    plus local broadcast files (`contracts/deploy/env.ts:1462`), and preflight requires
    `.docker` be cleared, so a continuation run would overwrite a correct manifest with an
    empty one.
12. **The manifest to deployment-summary converter drops every governed record.**
    `releaseManifestToDeploymentSummary` emits `eas`, `factory`, `provingVault` and
    `networks` and nothing else (`contracts/deploy/release-manifest.ts:451`), while the
    indexer reads `governedFactory.governed_factory` and
    `governedFactory.signer_sync_deployer` to populate its governed-wrapper and signer-sync
    sources (`packages/indexer/ponder.config.ts:243`). On Sepolia both are undefined, so
    those sources are disabled. **A wizard-created network would index its instance row and
    none of its Safe or governance events, and `/instances` would still look correct.**

### The operator cannot pin to Pinata, and it is not a missing token field

`PinTarget` is `{name, api, gateway}` with no authentication field
(`zk/operator/src/config.rs:127`), and `pin_target` (`zk/operator/src/handlers.rs:723`) does
four things, of which only the first is about credentials: it posts a hand-rolled multipart
body to `{api}/api/v0/add`, parses `{"Hash": …}`, asserts the returned content id equals the
one the guest committed in circuit, then fetches the bytes back through the reader's gateway
and compares them.

Pinata breaks the first two outright: it is `uploads.pinata.cloud/v3/files` with a bearer
token, answering `{data: {cid}}`. The third is the one to measure rather than assume. The
guest commits `cid_v1_raw(sha256(blob))`, a CIDv1 raw-codec single block
(`crates/zk-core/src/cid.rs:45`), and Pinata takes a `cid_version` field defaulting to v1,
where CIDv1 auto-enables raw leaves. That should match. **One upload with the real token,
compared against `cid_v1_raw` of the same bytes, decides whether the adapter is small or
needs a CAR builder**, since a single-block CAR pins exactly the block it is handed and the
content id cannot drift.

Both assertions exist for good reasons the comments state plainly: publishing bytes the root
does not commit to is worse than publishing nothing, and "the API accepted it" and "a reader
can fetch these exact bytes" are different claims. Any new backend has to satisfy both.

### A latent ceiling on blob size

`cid_v1_raw` is only the content id a kubo produces when the blob fits one 256 KiB chunk, and
nothing bounds the blob. `canonical_blob` costs about 53 bytes per scored account, so above
roughly 5,000 accounts a kubo returns a dag-pb root instead, the equality assertion fails,
and the daemon refuses to publish. That is fail-closed, which is the right direction, but it
is undocumented and the error message blames the wrong thing. Worth a bounded check and a
comment whichever backends we end up with.

---

## Decisions

Open, for the operator, at the top of this program.

- **D1 — Governed creation, or a script?** Deploying the signer verifier and the governed
  factory costs two additive transactions and makes the first Sepolia network one a person
  creates in a browser, Safe-governed from birth, on the exact path a visitor takes. Creating
  it with a script instead is faster and leaves the create page dark on a public deployment.
  The recommendation is the governed factory, and the rest of this document assumes it. There
  is also a forcing argument: the factories reject EOA distributor owners at both creation and
  attachment, so a seeded network **with a fund** can only come from the governed factory
  anyway. Only a fundless network can use the base factory directly.
- **D2 — Which Safe version.** The vendored dependency is `@gnosis.pm/safe-contracts` at
  1.3.0 and the contract types are the 1.3.0 `GnosisSafe` and `GnosisSafeProxyFactory`, so
  the 1.3.0 pair is the exact match and the recommendation. The 1.4.1 pair is also live on
  Sepolia if there is a reason to prefer it, but it would mean a dependency bump, not a
  configuration change.
- **D3 — Where score blobs get pinned. DECIDED: Pinata now, kubo forever, Filecoin later.**
  Pinata is the quickest thing to stand up for a public testnet. **Kubo support stays**,
  because running the whole stack locally with no account at any service is a property worth
  protecting, and it is also the second independent target that makes `min_success = 2`
  honest rather than nominal. Filecoin Onchain Cloud is deferred to
  [issue #107](https://github.com/AInima-Collective/trustgraphs/issues/107), which covers
  both a Filecoin publication backend and a program that proves a graph from a dataset
  addressed by a content id. The shape that serves all three is to give a publication target
  a *kind*: kubo today, direct upload for Pinata, and the IPFS Pinning Service API spec,
  which is one backend covering Filecoin Pin and everything else implementing it.

  **A publication target is a writer, not a reader.** Every target is written through
  `{api}/api/v0/add` and then read back through its own gateway, and the validator counts
  configured targets, not gateways (`zk/operator/src/config.rs:1076`). So pairing a kubo API
  with a hosted read gateway is one target, not two, and `min_success = 2` needs two distinct
  writable services. Until the Pinata backend exists, Sepolia runs either two kubos or a
  single target with `min_success = 1`, and the second option must be a recorded choice
  rather than a default nobody noticed.
- **D4 — When `.env` gets restructured.** M0 moves Sepolia values into a gitignored
  `.env.sepolia` overlay and returns `.env` to local defaults. That file is read by a live
  stack on the operator's Mac, so the swap is scheduled by the operator, not by the program.

---

## Delivery plan

### M0 — Two targets, one checkout

The cheapest milestone and the one that unblocks the rest, because right now the indexer can
only be run against one chain at a time and switching means editing a file two machines share.

- [x] A shared env loader that reads `.env`, then overlays `.env.<target>` when
      `DEPLOY_TARGET` names a public chain. Used by the three entry points that load dotenv
      today: `contracts/deploy/utils.ts:36`, `packages/indexer/scripts/launch-indexer.mjs`,
      and `packages/indexer/ponder.config.ts`.
- [x] Move the Sepolia values out of `.env` into `.env.sepolia`. `.env.*` is already
      gitignored, so nothing changes tracking status. `.env` keeps local defaults and
      anything genuinely shared.
- [x] A guard so the local demo tasks refuse to run when the resolved target is not local.
      The shared checkout makes this a real hazard, not a theoretical one.
- [x] Tests for both resolutions, and for the overlay not leaking Sepolia secrets into a
      local run.

**Exit:** `pnpm indexer:dev` is local and `DEPLOY_TARGET=sepolia pnpm indexer:start` is
testnet, with no file editing between them, and each refuses the other's chain.

### M1 — The indexer follows Sepolia

No new contracts, nothing at stake, and it answers the one question that cannot be answered
by reading: whether the RPC actually serves logs and historical calls from block 11,565,413.

- [ ] Generate `config.sepolia.json` from the finalized manifest and confirm its contents
      against the live addresses.
- [x] Set `IPFS_GATEWAY` (finding 4) and bring the indexer to head against the live factory
      on the `trustgraph_sepolia_v1` writer schema.
- [x] Confirm `GET /instances` returns `[]` without error and that the factory source is
      live rather than silently disabled.
- [x] Record the backfill wall time and the getLogs volume, so the provider tier is chosen
      on a number.

**Exit:** the indexer sits at head with zero errors, and `/instances` answers.

### M2 — Governed creation reaches Sepolia

Additive. Nothing already deployed is redeployed, re-wired or re-granted.

- [x] **A continuation command, before anything else** (finding 11). It verifies the five
      live addresses against chain state, deploys only the two new contracts, merges their
      records into the existing manifest rather than rebuilding it from `.docker`, and
      asserts the original five addresses are byte-identical afterwards. Without this, M2
      redeploys the chain we just paid for.
- [x] Extend `deployments/schema.json`, which is strict, with slots for the signer verifier,
      the governed factory, the Safe singleton and proxy factory, and a `programs.signer`
      entry beside `programs.trustGraph`. Update `release-manifest.ts` and its validator in
      the same change.
- [x] **Extend `releaseManifestToDeploymentSummary` to emit the governed records**
      (finding 12), so the indexer's governed-wrapper and signer-sync sources are populated
      on a public chain. This is the difference between indexing a governed network and
      indexing its instance row alone.
- [x] Parameterize `DeployGovernedTrustgraphsFactory.s.sol:35-36` to accept a Safe singleton
      and proxy factory, keeping the self-deploying behaviour for local only. On a public
      chain, `new GnosisSafe()` makes every DAO Safe the wizard mints invisible to
      app.safe.global and the Safe Transaction Service, because those index known singletons.
- [x] Add the signer ZK verifier step to `SepoliaEnv`, gated on a nonzero
      `SP1_SIGNER_PROGRAM_VKEY`. `DeployZkVerifier`'s zero-vkey fallback silently pins the
      root vkey, which for a signer verifier is a verifier that can never verify its own
      program. Fail closed.
- [x] Add the governed factory step after it.
- [x] Extend `scripts/sepolia-preflight.sh` to gate the signer vkey against the release
      manifest exactly as it gates the root vkey. This is the immutable that cost us a
      verifier and a factory on 2026-08-25, and the signer verifier is the same shape of
      mistake waiting to happen a second time.
- [x] Point `generate-config.ts:81` at the manifest slot and fail closed on a `planned`
      manifest.
- [x] Confirm the weighted, compose and contributions entry points stay hidden. The
      generator already falls back to empty for all three, so this is a browser
      verification, not a change. Prove it, because the create page will have real visitors.
- [x] Update `release-manifest.test.ts`'s "Sepolia plan is trust-graph only" case, which
      pins the five-step shape.
- [x] Extend `scripts/sepolia-postdeploy-check.sh` with the new invariants: the governed
      factory's `FACTORY`, `SAFE_SINGLETON` and `SAFE_FACTORY` match the manifest, and its
      `SIGNER_SYNC_PROGRAM_VKEY` matches the released signer vkey.

**Exit:** a fork rehearsal mints a network through the wizard's exact code path and the
resulting Safe is a canonical-singleton proxy. Then broadcast, then the post-deploy check.

### M3 — A frontend fit for a public testnet

- [x] Generate the Sepolia config in the build path (finding 1) and fail closed on
      placeholder or missing URLs (finding 2).
- [x] Add `IPFS_GATEWAY_PUBLIC` as the browser-facing read gateway, replacing the hardcoded
      value at `generate-config.ts:100`.
- [x] A persistent, unmissable indicator: Ethereum Sepolia, testnet assets have no value.
      This is the genuinely missing half of finding 6.
- [x] Replace the automatic chain switch (`WalletConnectionProvider.tsx:101`) with an
      explicit prompt. The add-and-switch flow underneath it is already correct and should be
      kept; what changes is that a person asks for it rather than a `useEffect` firing a
      wallet popup at them on page load.
- [x] Harden the RPC proxy (finding 7): allow only the configured public chain ids, allow
      only the read methods the application uses, never relay raw transactions. Wallets
      submit writes through their own provider.
- [x] Harden the pin route (finding 8): per-IP and global quotas, origin authorization,
      quota alerts. **Not per-wallet.** `app/create/pin.ts:11` posts unauthenticated JSON
      with no wallet identity attached, and origin checking is not authentication, so a
      per-wallet limit would need a signed challenge and a session. That is a larger design
      and it is out of scope here; say what the route actually enforces rather than implying
      an identity it does not have.
- [x] Add Sepolia's block time to `lib/blocks.ts` explicitly rather than relying on the
      default.
- [ ] Confirm WalletConnect origins for the deployed domain, and test or disable Porto on
      Sepolia.
- [x] Hide vault prepayment when `Factory.VAULT` is zero. It is not zero on Sepolia, so this
      is a correctness item for future deployments rather than a launch blocker.

**Exit:** a production build against the finalized manifest, served on the public domain,
with no placeholder URLs anywhere in the bundle.

### M4 — The first network, created in a browser

- [ ] Connect a clean wallet, land on the create page, and confirm it is offered rather than
      hidden.
- [ ] Create the network. Description pins to IPFS, the transaction goes through the
      governed factory, and the Safe that comes back is a canonical proxy.
- [ ] Confirm the new instance appears in `GET /instances` without an indexer restart. This
      is the claim factory discovery makes and it has never been tested on a public chain.
- [ ] **Confirm the Safe, the governance module and the governed-authority records appear
      too**, without a restart. `/instances` answering is not sufficient evidence: finding 12
      is a failure mode where the instance row is correct and every governed source is
      silently disabled, so an exit that only checks `/instances` would pass on a half-indexed
      network.
- [ ] Write the created instance into `deployments/sepolia.json`'s `instances[]` and into
      `config/networks.sepolia.json`, which is the outage fallback for the runtime catalog.
- [ ] Confirm the network page renders with description and criteria resolved through the
      public gateway, from a browser that has never seen our pin service.

**Exit:** a network on Sepolia that nobody minted with a script.

### M5 — The first real root, and the score read back

- [x] Measure Pinata's returned content id against `cid_v1_raw` of the same bytes, before
      writing any adapter.
- [x] Give a publication target a kind, add the direct-upload backend for Pinata, and leave
      the kubo backend exactly as it is. Keep both invariants at the call site.
- [x] Add the bounded blob-size check, so the 256 KiB ceiling fails with an error that names
      the real cause.
- [x] Operator profile for Sepolia: release manifest pointing at the tracked file, RPC kept
      private, the separate submitter key, finalized confirmation policy, Succinct network
      backend, persistent journal path, alert webhook.
- [x] Apply the budget the predecessor program decided: global 15 USD per day, per instance
      2, signer 1 and 5, curated instances set to the created network only, paid enabled
      against the deployed vault, and `cadence.subsidy_min_blocks` lowered from 216,000 to
      7,200 for this deployment. The default is a deliberate monthly cadence for subsidizing
      someone else's network, and it is wrong for the network everyone will judge us by.
- [x] Alert at 80% of the global cap, so a runaway is heard before it halts.
- [ ] Vouch, revoke, prove one real root through the live gateway, and read the resulting
      score back in the browser.

**Exit:** a score on a public chain, proven by a real Groth16 proof, rendered from indexed
state.

### M6 — Something that survives being left alone

Finding 9 says the existing compose path must never be pointed at this checkout, and then no
milestone replaces it. Without this, M1 can exit with an indexer running out of a developer's
working tree and M5 can exit on a one-off operator run, and neither is a service. The
requirements are already written down in
[docs/build/production.md](docs/build/production.md); this milestone is where they get met
rather than cited.

- [x] An indexer build that does not install into a bind-mounted checkout: an image, or an
      explicit hosting build path with its own dependency install.
- [x] Durable Postgres with a backup and a restore that has actually been run, not just
      configured.
- [x] RPC failover, since one provider outage currently stops both the indexer and every
      browser read through the proxy.
- [ ] The operator image pinned **by digest**, with a persistent volume for its journal, and
      a restart-and-recover drill.
- [x] Monitoring with thresholds: `/ready` and `/status`, stale checkpoints, publication
      failures, vault balance, and indexer lag.

**Exit:** kill both services, bring them back, and lose nothing. Then leave them alone for a
week and have the alerts, not a person, be what notices anything.

---

## What this program does not do

The weighted, compose and contributions programs stay hidden on Sepolia. Their factories are
not deployed, their config keys fall back to empty, and their entry points explain
themselves as unavailable rather than failing. Confirming that is an M2 item; changing it is
not in scope.

---

## Gates

**Creation gate (blocks M4):** M0 through M3 complete, with the M2 fork rehearsal green end
to end and the post-deploy check passing against the real broadcast.

**Root gate (blocks M5):** the creation gate, plus two writable publication targets, or a
recorded decision to run at `min_success = 1` and why.

**Announce gate:** M5 and M6 both green. The operator and indexer survive a restart drill,
the alerts are the thing that notices, and the testnet label is visible on every page.

---

## Operator ledger

Inputs this program cannot produce.

| Input | Variable | State |
| --- | --- | --- |
| Pinata bearer token (the **JWT**, not the API key or secret) | `IPFS_PIN_API_KEY` | in hand |
| Pinata uploads endpoint | `IPFS_PIN_API` | `https://uploads.pinata.cloud/v3/files`, already the default off-local |
| Read gateway, server side | `IPFS_GATEWAY` | in the ignored overlay; live indexer and exact-byte Pinata readback passed |
| Read gateway, browser facing | `IPFS_GATEWAY_PUBLIC` | implemented and in the ignored overlay; still needs the final host build |
| Public domain and its WalletConnect origins | | `https://trustgraphs.xyz` selected; host and WalletConnect origin configuration still needed for M3 |
| Ponder public API URL | `PONDER_URL` | still needed; the existing public site's old Ponder upstream is unavailable |
| Browser RPC primary and failover | `RPC_URL_11155111_0`, `RPC_URL_11155111_1` | PublicNode and Tenderly selected and live-validated for chain id, head, historical code, calls, balances, blocks, and estimates; both are recorded in the ignored overlay and still need copying into the public host |
| Hosting for indexer and operator | | still needed for M5/M6; local writer is not the public service |
| Operator image for this source | `OPERATOR_IMAGE` | published, attested, anonymously pulled, and recorded as `ghcr.io/ainima-collective/trustgraphs-operator@sha256:876aa9e9569e2de4366404a96b24ae4222e75763cbc692820bd9cdbfd15e0a40`; host deployment and restart drill remain |
| Docker-capable drill host | | image publication and the direct Postgres restore are complete; still needed for the service restart drill and week soak |
| Funded Succinct prover account | `NETWORK_PRIVATE_KEY` | present in `.env` |

Pinata's API key and secret are for the legacy `api.pinata.cloud/pinning/*` endpoints, which
nothing in this repo calls. Keep them out of `.env` so nobody assumes they are wired.

---

## Landmines

- **`.env` steers three separate systems and currently says Sepolia.** The deploy CLI, the
  indexer launcher and `ponder.config.ts` all load it. The frontend does not, which is the
  surprising half. M0 exists to end this.
- **Never pin a locally built vkey.** It cost a verifier and a factory on 2026-08-25 because
  both are immutable. The signer verifier in M2 is the same shape of mistake, one milestone
  away.
- **Never run `pnpm install` in this checkout,** and never point `docker-compose.prod.yml` at
  it. The Mac's darwin natives and this sandbox's linux ones cannot both be installed, and
  the compose file installs into the bind mount.
- **Never run local demo tasks while the operator's stack is live.** Shared checkout, one
  `.docker` directory, one set of generated artifacts.
- **`esbuild` in this sandbox resolves darwin binaries** from the shared store, so anything
  that transforms TypeScript through `tsx` fails with "You installed esbuild for another
  platform." That is the frontend config generator and four source tests, among others. **The
  fix is `ESBUILD_BINARY_PATH` pointing at a linux-arm64 esbuild of the matching version**,
  which esbuild honours directly. Do not repair this by installing anything: `node_modules`
  is shared with a macOS checkout and only one platform's binaries can live there.
- **The tracked manifest is also the deploy's output file.** A real deploy writes straight
  over `deployments/sepolia.json`, which is why its test accepts both `planned` and
  `deployed`.
- **`DEFAULT_ADMIN_ROLE` is `bytes32(0)`,** not the keccak of its name. Every role check
  written by hand has to know that.
- **A dedicated gateway domain in the browser bundle is public information.** If that matters,
  point `IPFS_GATEWAY_PUBLIC` at a shared public gateway: uploads go up with
  `network=public`, so the CIDs resolve either way.
