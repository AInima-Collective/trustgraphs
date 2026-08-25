# GOAL: the app on Sepolia, and a network you create in a browser

> Five contracts are live on a public chain and nothing points at them yet. This program
> closes that gap from the other end: an indexer that follows Sepolia, a frontend that says
> plainly which chain you are on, and a create page that works, so the first network on
> Sepolia is one somebody made in a browser rather than one we minted with a script. The
> same path a visitor takes is the path we take first.

**Status:** opened 2026-08-25, on `main` at `13eb98d`. Not started.

**Baseline, measured today on live Sepolia:** the five contracts are deployed and all
nineteen post-deploy invariants pass. `InstanceRegistry.instanceCount()` is 0.
`TrustgraphsFactory.VAULT()` is the deployed vault, `EPOCH_FLOOR()` is 7,200 blocks, about a
day at Sepolia's cadence. Base fee sampled at 1.02 gwei. The deployer holds 0.457 ETH and the
submitter key holds 0.200 ETH at nonce 0.

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
M6. Nothing here touches it. M5 of this program consumes its `v0.0.4` release.

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
6. **No testnet indicator and no wrong-network prompt.** Neither exists anywhere in the
   frontend. A visitor on mainnet gets a failed transaction and no explanation.
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

### The operator cannot pin to Pinata

`PinTarget` is `{name, api, gateway}` with no authentication field
(`zk/operator/src/config.rs:127`), and publication posts to `{api}/api/v0/add`
(`zk/operator/src/handlers.rs:726`), which is the kubo RPC shape. Pinata does not expose that
API. Score blob publication therefore needs one of: a kubo the operator runs, an
authenticating proxy in front of Pinata, or an optional `token` field on `PinTarget`. This is
a decision, not a defect, and it is D3 below.

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
- **D3 — Where score blobs get pinned.** See above. A self-hosted kubo gives the operator two
  independent targets when paired with Pinata's read gateway and satisfies `min_success = 2`.
  Pinata alone requires the new token field and still leaves `min_success` at 1, which is one
  service away from an unavailable score.
- **D4 — When `.env` gets restructured.** M0 moves Sepolia values into a gitignored
  `.env.sepolia` overlay and returns `.env` to local defaults. That file is read by a live
  stack on the operator's Mac, so the swap is scheduled by the operator, not by the program.

---

## Delivery plan

### M0 — Two targets, one checkout

The cheapest milestone and the one that unblocks the rest, because right now the indexer can
only be run against one chain at a time and switching means editing a file two machines share.

- [ ] A shared env loader that reads `.env`, then overlays `.env.<target>` when
      `DEPLOY_TARGET` names a public chain. Used by the three entry points that load dotenv
      today: `contracts/deploy/utils.ts:36`, `packages/indexer/scripts/launch-indexer.mjs`,
      and `packages/indexer/ponder.config.ts`.
- [ ] Move the Sepolia values out of `.env` into `.env.sepolia`. `.env.*` is already
      gitignored, so nothing changes tracking status. `.env` keeps local defaults and
      anything genuinely shared.
- [ ] A guard so the local demo tasks refuse to run when the resolved target is not local.
      The shared checkout makes this a real hazard, not a theoretical one.
- [ ] Tests for both resolutions, and for the overlay not leaking Sepolia secrets into a
      local run.

**Exit:** `pnpm indexer:dev` is local and `DEPLOY_TARGET=sepolia pnpm indexer:start` is
testnet, with no file editing between them, and each refuses the other's chain.

### M1 — The indexer follows Sepolia

No new contracts, nothing at stake, and it answers the one question that cannot be answered
by reading: whether the RPC actually serves logs and historical calls from block 11,565,413.

- [ ] Generate `config.sepolia.json` from the finalized manifest and confirm its contents
      against the live addresses.
- [ ] Set `IPFS_GATEWAY` (finding 4) and bring the indexer to head against the live factory
      on the `trustgraph_sepolia_v1` writer schema.
- [ ] Confirm `GET /instances` returns `[]` without error and that the factory source is
      live rather than silently disabled.
- [ ] Record the backfill wall time and the getLogs volume, so the provider tier is chosen
      on a number.

**Exit:** the indexer sits at head with zero errors, and `/instances` answers.

### M2 — Governed creation reaches Sepolia

Additive. Nothing already deployed is redeployed, re-wired or re-granted.

- [ ] Extend `deployments/schema.json`, which is strict, with slots for the signer verifier,
      the governed factory, the Safe singleton and proxy factory, and a `programs.signer`
      entry beside `programs.trustGraph`. Update `release-manifest.ts` and its validator in
      the same change.
- [ ] Parameterize `DeployGovernedTrustgraphsFactory.s.sol:35-36` to accept a Safe singleton
      and proxy factory, keeping the self-deploying behaviour for local only. On a public
      chain, `new GnosisSafe()` makes every DAO Safe the wizard mints invisible to
      app.safe.global and the Safe Transaction Service, because those index known singletons.
- [ ] Add the signer ZK verifier step to `SepoliaEnv`, gated on a nonzero
      `SP1_SIGNER_PROGRAM_VKEY`. `DeployZkVerifier`'s zero-vkey fallback silently pins the
      root vkey, which for a signer verifier is a verifier that can never verify its own
      program. Fail closed.
- [ ] Add the governed factory step after it.
- [ ] Extend `scripts/sepolia-preflight.sh` to gate the signer vkey against the release
      manifest exactly as it gates the root vkey. This is the immutable that cost us a
      verifier and a factory on 2026-08-25, and the signer verifier is the same shape of
      mistake waiting to happen a second time.
- [ ] Point `generate-config.ts:81` at the manifest slot and fail closed on a `planned`
      manifest.
- [ ] Confirm the weighted, compose and contributions entry points stay hidden. The
      generator already falls back to empty for all three, so this is a browser
      verification, not a change. Prove it, because the create page will have real visitors.
- [ ] Update `release-manifest.test.ts`'s "Sepolia plan is trust-graph only" case, which
      pins the five-step shape.
- [ ] Extend `scripts/sepolia-postdeploy-check.sh` with the new invariants: the governed
      factory's `FACTORY`, `SAFE_SINGLETON` and `SAFE_FACTORY` match the manifest, and its
      `SIGNER_SYNC_PROGRAM_VKEY` matches the released signer vkey.

**Exit:** a fork rehearsal mints a network through the wizard's exact code path and the
resulting Safe is a canonical-singleton proxy. Then broadcast, then the post-deploy check.

### M3 — A frontend fit for a public testnet

- [ ] Generate the Sepolia config in the build path (finding 1) and fail closed on
      placeholder or missing URLs (finding 2).
- [ ] Add `IPFS_GATEWAY_PUBLIC` as the browser-facing read gateway, replacing the hardcoded
      value at `generate-config.ts:100`.
- [ ] A persistent, unmissable indicator: Ethereum Sepolia, testnet assets have no value.
- [ ] A wrong-network prompt with an add-and-switch action. `createNetworkAddParams` in
      `lib/wagmi.ts` already builds the parameters; nothing calls it.
- [ ] Harden the RPC proxy (finding 7): allow only the configured public chain ids, allow
      only the read methods the application uses, never relay raw transactions. Wallets
      submit writes through their own provider.
- [ ] Harden the pin route (finding 8): per-IP and per-wallet rate limits, origin
      authorization, quota alerts.
- [ ] Add Sepolia's block time to `lib/blocks.ts` explicitly rather than relying on the
      default.
- [ ] Confirm WalletConnect origins for the deployed domain, and test or disable Porto on
      Sepolia.
- [ ] Hide vault prepayment when `Factory.VAULT` is zero. It is not zero on Sepolia, so this
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
- [ ] Write the created instance into `deployments/sepolia.json`'s `instances[]` and into
      `config/networks.sepolia.json`, which is the outage fallback for the runtime catalog.
- [ ] Confirm the network page renders with description and criteria resolved through the
      public gateway, from a browser that has never seen our pin service.

**Exit:** a network on Sepolia that nobody minted with a script.

### M5 — The first real root, and the score read back

- [ ] Settle D3 and configure the operator's pin targets accordingly.
- [ ] Operator profile for Sepolia: release manifest pointing at the tracked file, RPC kept
      private, the separate submitter key, finalized confirmation policy, Succinct network
      backend, persistent journal path, alert webhook.
- [ ] Apply the budget the predecessor program decided: global 15 USD per day, per instance
      2, signer 1 and 5, curated instances set to the created network only, paid enabled
      against the deployed vault, and `cadence.subsidy_min_blocks` lowered from 216,000 to
      7,200 for this deployment. The default is a deliberate monthly cadence for subsidizing
      someone else's network, and it is wrong for the network everyone will judge us by.
- [ ] Alert at 80% of the global cap, so a runaway is heard before it halts.
- [ ] Vouch, revoke, prove one real root through the live gateway, and read the resulting
      score back in the browser.

**Exit:** a score on a public chain, proven by a real Groth16 proof, rendered from indexed
state.

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

**Root gate (blocks M5):** the creation gate, plus D3 settled and a pin target that two
independent readers can serve.

**Announce gate:** M5 green, the operator running continuously with alerts, and the testnet
label visible on every page.

---

## Operator ledger

Inputs this program cannot produce.

| Input | Variable | State |
| --- | --- | --- |
| Pinata bearer token (the **JWT**, not the API key or secret) | `IPFS_PIN_API_KEY` | in hand |
| Pinata uploads endpoint | `IPFS_PIN_API` | `https://uploads.pinata.cloud/v3/files`, already the default off-local |
| Read gateway, server side | `IPFS_GATEWAY` | needed for M1, must end in `/ipfs/` |
| Read gateway, browser facing | `IPFS_GATEWAY_PUBLIC` | needed for M3, variable does not exist yet |
| Public domain and its WalletConnect origins | | needed for M3 |
| Ponder public API URL | `PONDER_URL` | needed for M3, and finding 2 makes its absence loud |
| Hosting for indexer and operator | | needed for M1 and M5, and see finding 9 |
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
- **`esbuild` in this sandbox resolves darwin binaries** from the shared store, so
  `packages/frontend` scripts under `tsx` fail here. `node --import tsx` works from the
  repository root but not from the frontend package.
- **The tracked manifest is also the deploy's output file.** A real deploy writes straight
  over `deployments/sepolia.json`, which is why its test accepts both `planned` and
  `deployed`.
- **`DEFAULT_ADMIN_ROLE` is `bytes32(0)`,** not the keccak of its name. Every role check
  written by hand has to know that.
- **A dedicated gateway domain in the browser bundle is public information.** If that matters,
  point `IPFS_GATEWAY_PUBLIC` at a shared public gateway: uploads go up with
  `network=public`, so the CIDs resolve either way.
