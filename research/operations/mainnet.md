# Trustgraphs on Ethereum mainnet: deployment plan

> Internal deployment plan, drafted 2026-09-10 from a survey of the checkout at `6130e70a`.
> Not product documentation. Sections marked **Decision** need an answer before that step runs.
> When the deployment is live this page becomes the deployment record, the way
> [`sepolia.md`](./sepolia.md) did for the testnet.

## 1. End state

| Surface            | Testnet (Sepolia, 11155111)                | Mainnet (1)                                   |
| ------------------ | ------------------------------------------ | --------------------------------------------- |
| Frontend           | `testnet.trustgraphs.xyz` on Vercel        | `trustgraphs.xyz` on Vercel                   |
| Indexer + operator | Railway project `trustgraphs-sepolia`      | Railway project `trustgraphs-mainnet`         |
| Public API         | `api.testnet.trustgraphs.xyz` (indexer)    | `api.trustgraphs.xyz` (indexer)               |
| Contracts          | `deployments/sepolia.json` (live, v0.1.1)  | `deployments/mainnet.json` (new)              |
| Programs           | everything the release carries             | trust-graph, weighted, composition, contributions, signer-sync; governance and subnetworks |
| Not on mainnet     |                                            | hypercerts, Nostr workspace, strict off-chain EAS lane, imported-EAS factories, sponsored relay |

Both deployments come from the same release artifacts. Mainnet deploys the guest set already
proven on Sepolia (release `v0.1.1` guests, identical vkeys in `v0.1.2`), so no guest changes and
no new verification keys are involved. What changes is a small amount of deployment tooling that
today spells "sepolia" where it should read the selected target.

## 2. What exists today

**Sepolia is complete and live.** Contracts from block 11,670,854 (commit `6d3e272e`), one showcase
network, Railway project `reasonable-purpose` in Jake's personal workspace (Postgres in us-west2,
indexer in us-west2, operator plus its journal volume in us-east4), the indexer at
`indexer-production-97a3.up.railway.app` and `/ready` returning 200. The Vercel frontend serving
Sepolia is what `trustgraphs.xyz` resolves to now. `testnet.trustgraphs.xyz` has no DNS record.
DNS for the zone is at GoDaddy, with A/CNAME records pointing at Vercel.

**Mainnet is fenced off deliberately, in four places, each small:**

| Fence | Where | What it does |
| --- | --- | --- |
| Deploy env factory | `contracts/deploy/env.ts:292-295` | throws "no authorized deploy plan yet" for the mainnet target |
| Operator manifest binding | `zk/operator/src/config.rs:780-783` | refuses any release manifest not bound to chain 11155111 |
| Indexer target allowlist | `packages/indexer/scripts/deployment-profile.mjs:189-191`, `ponder.config.ts:129-131` | `DEPLOY_TARGET must be local or sepolia` |
| Railway preflight | `scripts/railway-preflight.mjs` | asserted ~30 Sepolia literals in `.railway/railway.ts` (now asserts the per-target rows) |

Everything around those fences already knows about mainnet: the typed profile
(`contracts/deploy/profiles.ts:24-32`), the manifest schema and validator (`chain: mainnet`,
`chainId: 1`), the frontend target table and config generator (`RPC_URL_1_0/1`,
`deployments/mainnet.json`, `config/networks.mainnet.json`, tested end to end in
`packages/frontend/lib/application-config.test.ts`), the Solidity epoch-floor guard
(`block.chainid == 1` can never take the testnet opt-in), and the operator's chain-id cross-check.

**External dependencies on mainnet, verified on-chain 2026-09-10** (each has code; the schema
registry was read back from `EAS.getSchemaRegistry()` rather than typed by hand, because the
commonly quoted address is wrong):

| Dependency | Mainnet address | Source |
| --- | --- | --- |
| EAS | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` | `@ethereum-attestation-service/eas-contracts` deployments/mainnet |
| EAS SchemaRegistry | `0xA7b39296258348C78294F95B872b282326A97BDF` | same, confirmed by `EAS.getSchemaRegistry()` |
| SP1 Groth16 gateway | `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` | same CREATE2 address as Sepolia; route for selector `0x4388a21c` to be checked by preflight |
| Chainlink ETH/USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | live answer read 2026-09-10 |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | Circle |
| Safe 1.3.0 singleton | `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` | same as Sepolia |
| Safe 1.3.0 proxy factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | same as Sepolia |

The ETH/USD feed on mainnet has a one-hour heartbeat, so `FEED_MAX_STALENESS` can return to the
script default of 5400 s (Sepolia needed 7200 because its feed is irregular).

**Audit trail.** Every launch-blocking and strongly-recommended item from the 2026-08-13
pre-mainnet audit is fixed with regression tests. The 2026-09-05 v0.1.0 review's R1 to R12 are
remediated in `v0.1.0` and later. What the review left as *decisions*, not defects, is carried in
section 9 below; the deployment does not silently close them.

## 3. Design principle: the target is the only switch

The repository already has the right shape for many deployments and one code base:

- `DEPLOY_TARGET` selects a `CHAIN_PROFILES[target]` entry;
- `deployments/<target>.json` is the single public record of that chain (addresses, blocks, vkeys);
- `config/networks.<target>.json` is that chain's seed catalog;
- `.env.<target>` is that chain's ignored secret overlay;
- `deployments/operator.<target>.toml` is that chain's proving policy.

Sepolia was the first public target, so several consumers hard-coded the word instead of reading
the profile. The mainnet work is mostly replacing those literals with the profile, so that a third
chain later is one profile row, one manifest, one operator TOML, and one Railway target entry.
Nothing below adds a mainnet-specific code path; every change is "read the target".

## 4. Workstreams

### 4.1 Contract deployment tooling

| Change | Files |
| --- | --- |
| Turn `SepoliaEnv` into a `PublicChainEnv` parameterised by the profile: manifest path from `profile.releaseManifestFile`, networks file `config/networks.<target>.json`, trigger/submit chain `evm:<chainId>`, delay-floor messages naming the chain. `MainnetEnv` is that class with the mainnet profile; the throw goes away. | `contracts/deploy/env.ts` |
| Add `releaseManifestFile: 'deployments/mainnet.json'` to the mainnet profile. | `contracts/deploy/profiles.ts` |
| Replace `'sepolia'` literals with `env.profile.target`: core-contract continuation checks, the `--continue-existing` / `--new-generation` guards, `expectedChain` on every manifest load, generation paths `deployments/generations/<name>/<target>.json`. | `contracts/deploy/deploy-contracts.ts`, `generation.ts`, `release-manifest.ts` |
| Seed manifest: `status: planned`, `chain: mainnet`, the externals above, Safe singleton and proxy factory, the seven program identities from the release guest manifest, `instances: []`. | `deployments/mainnet.json` |
| Generalise the two shell gates to take the target (`scripts/public-chain-preflight.sh <target>`, `scripts/public-chain-postdeploy-check.sh <target>`); keep `deploy:sepolia:*` as aliases and add `deploy:mainnet:preflight`, `deploy:mainnet:contracts`, `deploy:mainnet:postcheck`. The mainnet preflight has no `ALLOW_TESTNET_EPOCH_FLOOR` escape. | `scripts/`, `package.json` |
| `get-rpc` gains a mainnet branch. | `taskfile/env.yml` |
| Role handoffs as plan steps, not printed instructions. A reusable `HandoffAccessControl` Forge script moves the vault's admin and fee-setter roles and the subnetwork registry's admin role from the deployer to the admin in one broadcast each and asserts the end state from chain. The deployer must keep the subnetwork registry's admin role until step 15 because the governed weighted and compose wrappers grant themselves `REGISTRAR_ROLE` there with the deployer's key, so the handoffs are the last two steps. The remaining registrar grants are written as a Safe Transaction Builder batch (`.docker/admin-grants.<target>.json`). The postdeploy script asserts both handoffs. | `contracts/script/HandoffAccessControl.s.sol`, `contracts/deploy/env.ts`, postdeploy script |
| Fix `verify-contracts.ts` to read `run-<timestamp>.json` as well as `run-latest.json` (the four `DeployZkVerifier` invocations overwrite each other), then verify the Sepolia contracts on Etherscan as the rehearsal. Mainnet contracts get verified the same day they land. | `contracts/deploy/verify-contracts.ts`, `foundry.toml` |
| `.env.example` gains a mainnet reference block mirroring the Sepolia one. | `.env.example` |
| Tests: profile resolution for mainnet, generation paths per target, manifest binding per target. | `contracts/deploy/*.test.ts` |

**Deploy plan for mainnet, first generation.** Sepolia's ordered plan minus the imported-EAS
family (steps 6 and 9), per D3: 14 steps. Fresh deploy against
the `planned` manifest, no generation flag; the manifest goes `planned` to `deployed` in one
reviewed PR. `GRANT_REGISTRAR=false` on every factory, as on Sepolia: the registry admin makes the
four `REGISTRAR_ROLE` grants afterwards.

### 4.2 Indexer

| Change | Files |
| --- | --- |
| Replace the two-target allowlist with a profile table (local, sepolia, mainnet) and `loadFinalizedSepoliaManifest` with `loadFinalizedManifest(target)`. | `packages/indexer/scripts/deployment-profile.mjs` |
| `IS_SEPOLIA` becomes `IS_PUBLIC` plus `TARGET`; `CORE_CHAIN`, `CHAIN_ID`, the `chains` block, `EAS_START_BLOCK` and the manifest load (`expectedChain: target`) all derive from the profile. | `packages/indexer/ponder.config.ts` |
| `rpcUrlFor(chainId)` becomes generic (`PONDER_RPC_URL_<chainId>`). | `packages/indexer/src/api/graph-lineages.ts` |
| Link `networks.json` at startup from `DEPLOY_TARGET` instead of a build-time symlink to the Sepolia file, so one image serves both projects. | `packages/indexer/Dockerfile`, `scripts/launch-indexer.mjs` |
| Tests updated for the third target. | `scripts/*.test.mjs`, `src/api/*.source.test.ts` |

Mainnet indexer settings: writer schema `trustgraph_mainnet_v1`, views schema `trust-graph`,
`PONDER_START_BLOCK_1` and `PONDER_EAS_START_BLOCK_1` both at the first deployment block (the
canonical EAS crawl from genesis on mainnet would be about 23 million blocks in 10-block windows;
bounding it is mandatory, as the 2026-09-10 Sepolia quota exhaustion showed), a metered primary
plus two independent public fallbacks (`ethereum-rpc.publicnode.com`,
`mainnet.gateway.tenderly.co`), `FRONTEND_URL=https://trustgraphs.xyz`.

### 4.3 Operator

| Change | Files |
| --- | --- |
| Bind the release manifest to the configured `chain_id` and chain name instead of the Sepolia literal. While there, verify the weighted, composition and contributions guest identities against the manifest at startup as well (today only trust-graph and signer are checked). | `zk/operator/src/config.rs`, `run.rs` |
| Mainnet policy file. | `deployments/operator.mainnet.toml` |
| The Railway operator Dockerfile takes `ARG DEPLOY_TARGET` and copies `operator.${DEPLOY_TARGET}.toml` and `${DEPLOY_TARGET}.json`; Railway supplies build args from service variables. | `.railway/operator.Dockerfile` |

`operator.mainnet.toml` follows the deltas the Sepolia file already annotates for mainnet:
`[finality] confirmations = 64` and `[signer_sync] confirmations = 64`, `[budget]` at a real
`eth_usd` with `per_instance_usd_per_day` and `global_usd_per_day` sized to the epoch (proposed 5 and
20 to start; the 600k-gas submit at 1 gwei is about $1.50, at 10 gwei about $15),
`[gas] max_basefee_gwei` around 30 so proofs wait out fee spikes, `cadence.subsidy_min_blocks`
as the real cadence control now that the floor is 1 (proposed 300 blocks, about one hour, versus
Sepolia's 50; a quiet graph costs nothing either way), `curated.single_release_instance = true` so the daemon fails closed until the
showcase network is recorded, an `ops.alert_webhook`, and `[ipfs] min_success = 2` if a second
independent publication target is adopted (section 5).

Because `config.rs` changes, mainnet runs a new operator image. Guest sources do not change, so
the release workflow's reproducibility gate should show the `v0.1.1` program table unchanged;
the preflight asserts this.

### 4.4 Railway

One authoring file that switches on the linked project, so a plan can never apply the wrong
topology to the wrong project:

```
.railway/railway.ts          defineRailway: look up ctx.projectName in targets, else throw
.railway/lib/project.ts      trustgraphsProject(ctx, target): Postgres, indexer, operator, volume
.railway/targets.ts          trustgraphs-sepolia and trustgraphs-mainnet parameter rows
```

Per-target parameters: `DEPLOY_TARGET`, chain id, region, writer schema, start blocks, RPC fallback
list, `FRONTEND_URL`, git branch, operator memory, and the shared-variable names
(`RPC_URL_<chainId>_0`, `IPFS_GATEWAY`, `IPFS_PIN_API_KEY`, `SUBMITTER_PRIVATE_KEY`,
`NETWORK_PRIVATE_KEY`). `scripts/railway-preflight.mjs` asserts the target rows instead of
literals. The Sepolia row reproduces the live topology exactly, including the us-east4 operator
placement, and the first `railway config plan` against the Sepolia project must report no changes
before anything is applied to mainnet.

The Sepolia project was renamed to `trustgraphs-sepolia` in the dashboard (non-destructive, done
2026-09-10). The mainnet project is created empty, linked, its shared variables sealed, then
`railway config apply`.

Mainnet-specific choices:

- **Git source.** The Sepolia services follow `main`. Mainnet services should follow a long-lived
  `mainnet` branch that is fast-forwarded on purpose, so "what runs on mainnet" is a git ref and a
  merge to `main` cannot rebuild the mainnet indexer. Auto-deploy still gets switched off after the
  first deploy, as on Sepolia.
- **Region.** Everything in one region (us-west2). The Sepolia split is a historical accident the
  IaC comments already describe.
- **Domains.** Custom domains on the indexer services (`api.trustgraphs.xyz`,
  `api.testnet.trustgraphs.xyz`) so the frontends' `PONDER_URL` stops depending on a generated
  Railway hostname.
- **Workspace and spend.** Railway usage limits are workspace-wide. A testnet overrun tripping a
  hard limit would also stop the mainnet operator. Section 5 asks where mainnet should live.
- **Postgres** stays a rebuildable store (chain plus IPFS gateway are the sources of truth). The
  operator journal volume is the one thing that must never be recreated.

### 4.5 Frontend and Vercel

Two Vercel projects from the same repository and the same root directory, differing only in
environment variables. `DEPLOY_TARGET` is the whole switch; with `VERCEL=1` the generator reads
process env and needs no `.env.<target>` file.

| Variable | testnet project | mainnet project |
| --- | --- | --- |
| `DEPLOY_STAGE` / `DEPLOY_TARGET` | `production` / `sepolia` | `production` / `mainnet` |
| `RPC_URL_11155111_0`, `RPC_URL_11155111_1` | two independent Sepolia upstreams | not set |
| `RPC_URL_1` | mainnet upstream, ENS reads only | not needed (app chain is the ENS chain) |
| `RPC_URL_1_0`, `RPC_URL_1_1` | not set | two independent mainnet upstreams |
| `PONDER_URL` | `https://api.testnet.trustgraphs.xyz` | `https://api.trustgraphs.xyz` |
| `IPFS_GATEWAY_PUBLIC` | gateway ending in `/ipfs/` | same or separate |
| `FRONTEND_URL` | `https://testnet.trustgraphs.xyz` | `https://trustgraphs.xyz` |
| `IPFS_PIN_API_KEY`, quotas | Pinata token | Pinata token (separate key) |
| `FEATURED_NETWORK_ID` | Sepolia showcase instance id | mainnet showcase instance id, set after creation |
| `NEXT_PUBLIC_EAS_RELAY_ENABLED` | as today | unset (off) |
| `NEXT_PUBLIC_EAS_OFFCHAIN_*` | as today | unset (creation of the strict lane stays hidden) |

Code changes, all small:

- The canonical origin is hard-coded as `https://trustgraphs.xyz` in `app/layout.tsx` (metadataBase,
  OpenGraph), `app/sitemap.ts`, `app/robots.ts`, `lib/wallet-connectors.ts` (WalletConnect
  metadata), and `components/providers.tsx` (Plausible domain, Clarity gate). Make `FRONTEND_URL`
  required for public builds, emit it into the generated config as `siteUrl`, and read it there.
- A `testnet` chip beside the existing `alpha` chip in `components/Nav.tsx` when the target is
  Sepolia; `applicationEnvironmentLabel` already supplies "Sepolia testnet" and "Ethereum mainnet".
  The alpha notice ("not audited by an outside firm, do not use with large amounts of money")
  stays on both deployments; it is still true.
- `lib/blocks.ts` gains `mainnet: 12`; `packages/frontend/.gitignore` gains `config.mainnet.json`;
  `config/networks.mainnet.json` is committed as `[]`.
- `smoke:sepolia` becomes `smoke:public` reading the chain from the generated config
  (`/api/rpc/<chainId>`) with `FRONTEND_URL` as its input, so the same smoke runs against both sites.
- Docs nav labels and `docs/build/production.md` become "Deploy to a public chain" with a mainnet
  section; `docs/build/railway.md` describes the two projects; `docs/verify/addresses-and-vkeys.md`
  gets a mainnet table.

Nothing in the nav links to Nostr or hypercerts; both are data-driven (indexer catalog and the
seed file) and disappear on their own when the mainnet catalog has no such programs. The strict
off-chain lane's creation toggle is already rendered as "coming soon" and disabled. The sponsored
relay and the relay/gateway lists are env flags left unset on mainnet.

## 5. Decisions

| # | Decision | Recommendation | Why it matters |
| --- | --- | --- | --- |
| D1 | **Admin custody.** `INSTANCE_REGISTRY_ADMIN` holds registry `DEFAULT_ADMIN_ROLE` and `OPERATOR_ROLE`, receives vault admin and fee-setter, and (new) subnetwork-registry admin. | **Decided 2026-09-10: a Safe multisig owned by the team.** A timelock in front of it can be added later because roles are grantable. Still needed before phase 6: the Safe's address (or its signers and threshold if it is to be created). | Decision 41 in `DEVIATIONS.md` records that Sepolia put the admin key on the operator box and says mainnet must not. The post-deploy grants become Safe transactions; the plan generates the Transaction Builder batch. |
| D2 | **Epoch floor** (`FACTORY_EPOCH_FLOOR`, immutable per factory; mainnet minimum 7200). | **Decided 2026-09-10: 1 block, "as often as the chain allows", the same shape as the Sepolia showcase.** Raised and reaffirmed: the deploy scripts refuse a floor below 7200 on chain 1 with no opt-in (`contracts/script/Common.s.sol:49-59`, tested in `CommonScript.t.sol`), so this is a deliberate relaxation, not a parameter. Implementation: a separate `ALLOW_MAINNET_EPOCH_FLOOR=true` opt-in that only chain 1 honours (a copied testnet overlay cannot carry it over), the same check mirrored in the mainnet preflight, and the test updated. With the floor gone, the operator's `cadence.subsidy_min_blocks` and `[budget]` are the only controls on subsidised proving and the vault's per-instance policy (`ProvingVault.setPolicy`: `minPaidIntervalBlocks` and `maxPerRootUsd`, set by the network that funds its own proving) is the only control on paid proving; the operator TOML must be tuned with that in mind (section 4.3). | A network can always choose a longer epoch; the floor only bounds what a creator may pick. |
| D3 | **Feature families in generation 1.** | **Decided 2026-09-10: ship trust-graph, governed trust-graph (signer-sync and subnetworks are bundled), weighted, composition, contributions, and the proving vault, with signer-sync proving enabled in the operator from day one. Leave out the imported-EAS factories and the sponsored relay.** | The review lists "import completeness" as an unresolved design decision and the imported lane drives the canonical-EAS crawl. It can be added additively later with `--continue-existing`, exactly how Sepolia gained families. |
| D4 | **Hosting accounts.** Mainnet Railway project in the personal workspace or a new AInima team workspace; Vercel team for the two projects. | **Decided 2026-09-10: both Railway projects stay in the personal workspace; the Vercel projects stay where the current one is.** Consequence: set the workspace usage alert and hard limit for the combined spend of both projects, and treat a hard-limit shutdown as a mainnet incident, since it stops the mainnet operator too. | Usage hard limits are workspace-wide. |
| D5 | **Second IPFS publication target** for the operator (`min_success = 2`). | Yes: Pinata plus one independently operated pinning service or a kubo node. | The production guide requires two independent targets before relying on a root; Sepolia runs one by recorded exception. |
| D6 | **Keys.** Deployer (hot, funded, renounces at the end), submitter (gas only, rotatable), Succinct requester (`NETWORK_PRIVATE_KEY`, PROVE credit), and the admin Safe signers. | Four distinct keys; none reused from Sepolia. | The Succinct key lives in the operator container. |

Open questions that are not blocking: whether `OPERATOR_STATUS_URL` should be wired (the operator is
on Railway private networking, so the frontend on Vercel cannot reach it; Sepolia leaves it off and
the route reports `available: false`), and whether Plausible should track the testnet host as a
separate site.

## 6. Sequence

Each phase has a gate. Nothing in a later phase starts until the gate holds.

1. **Decisions** (section 5) recorded in this file.
2. **Repository work** on a branch: sections 4.1 to 4.5, plus docs. Gate: all suites green,
   including the new mainnet plan test that finalizes the seed from synthetic receipts;
   `railway config plan` on the Sepolia project shows no changes; the frontend's mainnet config
   generation test passes (a real build waits for the deployed manifest, since public builds
   refuse a planned one). The real `--dry-run` runs from the release checkout in phase 4, because
   it also asserts the checkout is the release commit.
3. **Fork rehearsal.** Broadcast the full mainnet plan on a mainnet-fork anvil (the existing
   `trust-graph/local-testing.md` path puts Succinct's real gateway in state), run the postdeploy
   check against the fork, record the total gas, create a governed network on the fork, submit a
   real Groth16 proof through the gateway. Gate: fork proof accepted; gas total known.
4. **Release `v0.1.3`.** Tag the merged branch; the release workflow rebuilds guests (program
   table must equal `v0.1.1`), publishes the operator image and `guest-manifest.json`.
   `DEPLOYMENT_COMMIT` is that SHA. Gate: guest table unchanged, image verified by the workflow.
5. **Testnet move.** Create the second Vercel project (or repoint the existing one), add
   `testnet.trustgraphs.xyz` and `api.testnet.trustgraphs.xyz` records at GoDaddy, set the Sepolia
   `FRONTEND_URL`, pin origins and Plausible to the testnet host, redeploy the Sepolia indexer with
   the new `FRONTEND_URL`. Gate: `smoke:public` passes on `testnet.trustgraphs.xyz`;
   `trustgraphs.xyz` is free to move.
6. **Mainnet contracts.** Fund the deployer (preflight requires three times the gas budget at the
   current base fee), `deploy:mainnet:preflight`, broadcast from a clean checkout of the tag,
   then the admin Safe executes: four `REGISTRAR_ROLE` grants, vault admin and fee-setter
   acceptance, subnetwork-registry admin acceptance; the deployer renounces; `deploy:mainnet:postcheck`
   asserts the role graph; Etherscan verification; PR that flips `deployments/mainnet.json` to
   `deployed`. Gate: postcheck clean, contracts verified, manifest merged to `main` and `mainnet`.
7. **Mainnet services.** Create and link the Railway project, seal shared variables, `config apply`,
   custom domain on the indexer, wait for `/ready`. Create the showcase network from a mainnet
   Vercel preview deployment using the admin Safe as the network's governance owner, record the
   instance in the manifest, restart the operator, watch the first checkpoint, proof, submission
   and published score blob, and verify the root on-chain. Gate: first real root accepted;
   restart drill from `docs/build/railway.md` section 7 passes.
8. **Cutover.** Point `trustgraphs.xyz` at the mainnet Vercel project, set `FEATURED_NETWORK_ID`,
   `smoke:public` against production, one-week soak with daily log and budget review.

## 6a. Phase 2 status (2026-09-10)

Implemented on branch `feat/mainnet-profile`, uncommitted at the time of writing:

| Workstream | Verification |
| --- | --- |
| Contract deploy tooling (`PublicChainEnv`, target-aware generations and continuations, handoff steps, Safe grant batch, mainnet preflight and postcheck, `verify:contracts` receipt fix) | `pnpm test:deploy` 43/43; root typecheck clean |
| Solidity (`ALLOW_MAINNET_EPOCH_FLOOR`, `HandoffAccessControl`) | `forge test` 1057 passed, 0 failed, 3 skipped; `forge fmt --check` clean |
| Indexer (profile table, startup networks link, EAS start block defaults to the first deployment block) | 154/154 tests; typecheck clean; lint failures are pre-existing in untouched files |
| Frontend (`FRONTEND_URL` as the canonical origin, testnet chip, `smoke:public`) | `test:release` 30/30, full frontend suite green; typecheck clean |
| Operator (manifest bound to the configured chain, every embedded guest pinned, `operator.mainnet.toml`, `DEPLOY_TARGET` build arg) | all seven release guests rebuilt locally in the pinned SP1 image with digests identical to the v0.1.1 table; `cargo test` 116 passed, 0 failed; `cargo clippy -D warnings` clean; `cargo fmt` clean |
| Railway (project-name switch, `targets.ts`, shared builder) | `pnpm railway:check` passes; `railway config plan` against the live Sepolia project: already up to date |

The Railway dashboard rename to `trustgraphs-sepolia` was done on 2026-09-10 and the alias
removed. Still outside the branch: the second Vercel project, DNS records, and every secret.

## 7. Cost sketch

| Item | Estimate |
| --- | --- |
| Contract deployment, about 40 to 50 M gas | 0.02 to 0.05 ETH at 0.5 to 1 gwei; 0.25 ETH at 5 gwei. Base fee on 2026-09-10 was about 0.06 gwei. Hold 0.5 ETH on the deployer. |
| Showcase network creation (governed, seven-plus contracts) | on the order of 10 M gas |
| Each root update | about 0.6 M gas plus Succinct proving (cents to low dollars for a small graph) |
| Railway mainnet project (Postgres, indexer 1 GB, operator 2 GB) | roughly $20 to $40 per month at the reviewed ceilings |
| Metered mainnet RPC | one paid plan for the indexer primary and the two frontend upstreams |

## 8. Ownership of secrets after launch

| Secret | Lives in | Never in |
| --- | --- | --- |
| Deployer key | operator laptop for the broadcast session, then retired | Railway, Vercel, git |
| Admin Safe signer keys | the signers' wallets | any server |
| `SUBMITTER_PRIVATE_KEY`, `NETWORK_PRIVATE_KEY`, `IPFS_PIN_API_KEY`, `RPC_URL_1_0` | Railway shared variables, sealed | git, `deployments/` |
| Frontend RPC upstreams, Pinata key | Vercel project env | `NEXT_PUBLIC_*` |

## 9. Carried findings

These are recorded design decisions from the 2026-09-05 review that a deployment does not close;
the launch scope keeps them small rather than pretending they are resolved.

- Native attestation ingress is permissionless and append-only; the host profile is calibrated to
  1,800 raw inputs with an 80% alert. The showcase network is small and curated. Any funded
  network open to adversarial ingress still needs priced or staked ingress first.
- Signer-sync ships inside the governed factory. The activity-liveness model is bounded by the
  remediation (immutable activity checkpoints, 7200-block submission age) but remains a known
  design edge; the operator's `[signer_sync]` block can be disabled without redeploying.
- Registry authority over child funds was narrowed (parent authority pinned at installation);
  the registry admin remains a trust assumption, which is why D1 puts it in a multisig.
- Imported-EAS completeness and strict off-chain availability are out of scope for generation 1.
