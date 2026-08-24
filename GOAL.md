# GOAL: put Trustgraphs on Ethereum Sepolia

> The audit closed this morning and every verification key is still "none yet", so the
> expensive parts of a public deployment are, right now, still cheap. This program spends
> that window. It ends with a public chain holding contracts we cannot quietly edit, so
> everything that has to be true before the first broadcast is written down here first.

**Status:** opened 2026-08-23, on `main` at `b08db97`. Not started.

**Baseline:** `pnpm test:deploy` 6/6 green. `pnpm deploy:contracts --dry-run` prints a
five-step Sepolia plan. `forge test` was last recorded green at 738 by the audit-closure
program, by exhaustive path sharding: the one-shot process exceeds the runner's memory.

**Predecessor:** [research/plans/pre-testnet-audit-closure.md](research/plans/pre-testnet-audit-closure.md),
whose M3 built the chain-profile and release-manifest machinery this program consumes.
That program's testnet gate is this program's entry condition, and it is met.

---

## What is already true

M3 of the audit closure shipped the deploy-path skeleton, and it works:

- `contracts/deploy/profiles.ts` separates deployment *stage* from chain *target*, with
  Sepolia as an explicit profile (chain 11155111, `PONDER_RPC_URL_11155111`, explorer,
  manifest path).
- `deployments/sepolia.json` is the tracked release manifest, validated by
  `deployments/schema.json`, with a validator that rejects secret-shaped keys.
- `contracts/script/Common.s.sol` refuses the default Anvil key on a public chain and
  asserts the expected chain ID before any broadcast.
- The indexer (`ponder.config.ts`), its launcher preflight, the frontend config generator,
  `lib/wagmi.ts`, and the operator (`zk/operator/src/config.rs:453`, which binds itself to
  chain 11155111 from the manifest) all already have Sepolia branches.

### External dependencies, re-verified on Sepolia 2026-08-23

Every address the manifest pins was checked live from this checkout today:

| Dependency | Address | Result |
| --- | --- | --- |
| EAS | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` | 19,972 bytes of code |
| EAS Schema Registry | `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` | 1,977 bytes of code |
| SP1 Groth16 gateway | `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` | route `0x4388a21c` resolves to `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2`, `VERSION()` is `v6.1.0`, **not frozen** |
| Chainlink ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | 8 decimals, `"ETH / USD"`, live round $2,464.97, 1,095s old when sampled |
| Circle test USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 6 decimals, symbol `USDC` |
| Safe 1.3.0 singleton | `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` | canonical, `VERSION()` is `1.3.0` |
| Safe 1.3.0 proxy factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | canonical, has code |

The SP1 version gate stays resolved: no toolchain bump, no second key rotation. Recheck the
feed and the gateway route immediately before broadcast anyway, per `research/operations/sepolia.md`.

---

## Decisions

Ruled by the operator on 2026-08-23, at the top of this program:

- **D1 — The ProvingVault ships in the first release.** `TrustgraphsFactory.VAULT` is
  `immutable` (`contracts/src/factory/TrustgraphsFactory.sol:185`), so a factory deployed
  without a vault can never offer prepay: adding it later means a second factory and a
  migrated create path. Prepaid proving is rehearsed on testnet, where the asset has no
  value, rather than first attempted on mainnet.
- **D2 — Visitors can create their own networks.** The public testnet exposes the wizard,
  not just a seeded instance. This is the ruling with the largest blast radius, and
  everything in M1 exists because of it.
- **D3 — An EOA holds registry and vault administration.** Reversed from an initial Safe
  ruling on the same day: a Safe costs a setup step and a signing ceremony per administrative
  action, and what it protects here is a deployment we expect to discard before mainnet. The
  deployer remains a transit role and the program is not finished until it has renounced.
  Two consequences are load-bearing. The admin EOA can call `InstanceRegistry.update()` on
  **any** instance, including networks strangers created, so this key rewrites the discovery
  layer for the whole deployment; it cannot touch vault deposits. And a Safe is still
  mandatory in exactly one place: `TrustgraphsFactory.sol:358` rejects an EOA distributor
  owner, so a seeded network **with a fund** must be created through the governed factory,
  which mints its own Safe. Mainnet returns to Safe custody.
- **D4 — Proving runs on the Succinct prover network.** No proving host to keep alive, and
  it matches how the operator runs continuously.
- **D5 — Testnet economics: price the vault for realism, put the real ceiling in the
  operator.** Delegated to me and ruled below. Every fee collected on Sepolia is faucet money
  and therefore worth zero, while every proof spends real prover credit, so the vault is a
  rehearsal and the operator's loss budget is the actual spending limit. Fee bands stay at
  $5/$10/$15 and we seed no liquidity; the free tier is the seeded network alone;
  `budget.global_usd_per_day` drops 250 to **15** and `per_instance` 25 to **2**, capping the
  worst case near $450/month instead of $7,500. Full reasoning and the cost table are in
  [JAKE_HARTNELL_TODO.md](JAKE_HARTNELL_TODO.md#part-25-the-economics-decided).

### What D2 costs, specifically

The wizard calls `createGovernedInstance`, and the Sepolia plan does not deploy anything
that answers it. Three facts, each verified:

1. `SepoliaEnv.deployContracts` (`contracts/deploy/env.ts:1102`) stops at
   `TrustgraphsFactory`. There is no governed factory step, and the dry-run confirms a
   five-step plan.
2. `packages/frontend/scripts/generate-config.ts:81` reads
   `const governedFactoryAddress = isSepolia ? '' : localGovernedFactoryAddress`. Even if
   the contract existed, the generated Sepolia config would not point at it.
3. `DeployGovernedTrustgraphsFactory` requires a **real signer-program verifier**: it reads
   `.docker/zk_verifier_signer_deploy.json` and passes both the verifier and
   `signerProgramVKey` into an immutable constructor
   (`contracts/script/DeployGovernedTrustgraphsFactory.s.sol:24-48`). So D2 also pulls
   `SP1_SIGNER_PROGRAM_VKEY` and a second `DeployZkVerifier` run into the release.

D2 does **not** pull in weighted or compose. Those factories stay undeployed and their
wizard entry points stay hidden, per the audit closure's compose gate and
`research/operations/sepolia.md`. First public release is trust-graph only, governed.

---

## Delivery plan

### M0 — The inputs that cannot be produced in this repo

Nothing else can finish without these, and none of them are code. Tracked in the operator
ledger below; listed here because they gate M8.

- [ ] Release vkeys and ELF digest, derived from the frozen release checkout on a machine
      with the SP1 toolchain: `trust-graph` vkey, `signer` vkey, `SP1_PROGRAM_ELF_SHA256`.
      **This sandbox has no SP1 toolchain at all** (`cargo-prove` and `sp1up` are both
      absent), so this step is operator-side by construction.
- [ ] The admin EOA that receives registry and vault administration (D3), ideally distinct
      from the deployer key.
- [ ] A funded deployer key that has never been published, plus a separate operator
      submitter key.
- [ ] A private Sepolia RPC that serves logs and historical calls from the deployment block.
- [ ] A funded Succinct prover network account.

### M1 — Governed creation becomes part of the release

The largest lane, and the one D2 created.

- [ ] Extend the manifest: `deployments/schema.json` is strict
      (`additionalProperties: false`), so the signer verifier, the governed factory, and the
      Safe singleton/proxy-factory addresses each need a slot, plus a `programs.signer`
      entry beside `programs.trustGraph`. Update `contracts/deploy/release-manifest.ts` and
      its validator in the same change. The operator's parser ignores unknown fields, so it
      does not break, but it should learn to read the new ones.
- [ ] Add the signer ZK verifier step to `SepoliaEnv`, gated on a nonzero
      `SP1_SIGNER_PROGRAM_VKEY`. The existing zero-vkey fallback in `DeployZkVerifier`
      silently pins the root vkey, which for a signer verifier is a verifier that can never
      verify its own program. Fail closed instead.
- [ ] Add the governed factory step to `SepoliaEnv`, after the base factory.
- [ ] **Use the canonical Safe deployment.** `DeployGovernedTrustgraphsFactory.s.sol:35-36`
      calls `new GnosisSafe()` and `new GnosisSafeProxyFactory()`. On a public chain that
      makes every wizard-created DAO Safe invisible to app.safe.global and the Safe
      Transaction Service, because those index known singletons. Parameterize the script to
      accept a singleton and factory address, pass the canonical 1.3.0 pair on Sepolia, and
      keep the self-deploying behaviour for local only.
- [ ] Point `generate-config.ts` at the manifest instead of the empty-string literal, and
      make it fail closed on a `planned` manifest.
- [ ] Confirm the weighted and compose entry points stay hidden. `generate-config.ts:112-133`
      already falls back to an empty address for both, since the manifest carries no such
      key, so this should be a verification in the browser rather than a change. Prove it,
      because D2 puts real visitors on the create page.
- [ ] Update `contracts/deploy/release-manifest.test.ts`'s "Sepolia plan is trust-graph only
      and reuses canonical EAS" case, which currently pins the five-step shape.

**Exit:** a dry-run prints the full governed plan; a fork rehearsal creates a network
through the wizard's exact code path and the resulting Safe is a canonical-singleton proxy.

### M2 — The vault, validated

- [ ] `DeployProvingVault.s.sol:49-55` only checks that the feed and USDC are nonzero.
      Before deploying on a public chain it must assert: both addresses have code; the feed
      reports 8 decimals and a live, positive, in-window round; USDC reports 6 decimals.
      A vault wired to a dead feed prices every proof at zero and looks like a bug for a
      week before anyone notices.
- [ ] Per D5, the fee bands, the oracle band and `FEED_MAX_STALENESS=7200` all stay as they
      are, and we seed no liquidity. The work here is to *document* that in the runbook as a
      deliberate choice rather than an unexamined default, so nobody "fixes" the fee bands to
      zero later on the reasoning that testnet money is fake.

### M3 — The seeded instance, as a release step

- [ ] There is no release-capable creation script: `CreateDevInstances.s.sol` is a dev
      fixture. Write one that takes an explicit admin, name, metadata CID, algorithm
      parameters, quorum, participation floors, and a distributor choice, with a
      deterministic salt.
- [ ] Every minted distributor must be owned by an initialized Safe. The factories reject
      EOAs at both creation and attachment (audit lane D), so under D3's EOA custody a seeded
      network **with a fund** has to come from the governed factory, which mints its own Safe
      in the creating transaction. That also means the seeded network exercises the same code
      path visitors use, which is worth having. A fundless seeded network can use the base
      factory directly.
- [ ] Write the created instance into `deployments/sepolia.json`'s `instances[]` and into
      `config/networks.sepolia.json`, which is currently `[]` and is the outage fallback for
      the runtime catalog.

### M4 — Custody handoff and post-deploy invariants

- [ ] An idempotent handoff script: registry administrator and operator, and vault
      administrator and fee-setter, move to the admin EOA (D3); the script verifies the
      recipient holds each role **before** the deployer renounces anything. If the operator
      elects one key for both deployer and admin, the script must say the handoff was a no-op
      rather than reporting a pass it did not perform.
- [ ] A release verification script asserting the invariant list in
      `research/operations/sepolia.md`: chain ID; verifier gateway and vkey equal the manifest;
      registry roles match the custody plan; the factory's EAS, registrar, verifier,
      registry, vault, deployers and `EPOCH_FLOOR` match; the seeded `InstanceCreated` event
      and the registry row agree; the instance's schema UID, resolver, accumulator, chain ID
      and params hash agree; the accumulator is bound to the intended schema and snapshot;
      distributor ownership and vault policy are correct; no unintended deployer privilege
      remains; every manifest address has bytecode.
- [ ] The existing skip/resume logic trusts local artifacts. Make it verify chain ID and
      on-chain bytecode too, so a file left over from chain 31337 can never cause a Sepolia
      step to be skipped.

**Exit:** the verification script passes against the fork rehearsal, and fails loudly when
a role handoff is deliberately omitted.

### M5 — Preflight, executable rather than prose

- [ ] Turn today's manual checks into one command that fails closed: chain ID is 11155111;
      deployer is not the Anvil key and holds enough ETH; EAS, registrar, gateway, feed,
      USDC and the canonical Safe pair all have code; the gateway still routes `0x4388a21c`
      and the route is not frozen; the feed answers live and in-window; both vkeys are
      nonzero and match the manifest; `DEPLOYMENT_COMMIT` matches the working tree.
- [ ] Record expected gas and balances, so the broadcast has a number to compare against.

### M6 — A frontend fit for a public testnet

- [ ] Generate `config.sepolia.json` in the build path. `prebuild` currently runs
      `config:link` and never `config:generate` (`packages/frontend/package.json:7`), so a
      Sepolia build has nothing to link. `config.production.json` is a stale Optimism file
      and must not be reused.
- [ ] A persistent, unmissable "Ethereum Sepolia, testnet assets have no value" indicator,
      plus a wrong-network prompt with an add/switch action. Neither exists today.
- [ ] Harden `app/api/rpc/[chainId]/route.ts`: it caps body size and batch size but forwards
      **any** JSON-RPC method to **any** chain that happens to have an env var set. Add a
      chain allowlist and a read-method allowlist, and never relay raw transactions.
- [ ] Harden `app/api/ipfs/route.ts`: it is an unauthenticated public write path with size
      caps only. Add per-IP and per-wallet rate limits, origin authorization, and quota
      alerts before it is exposed on a public domain.
- [ ] Confirm WalletConnect origins for the deployed domain, and test or disable Porto on
      Sepolia.

### M7 — Indexer and operator, in production shape

- [ ] Fresh writer schema (`trustgraph_sepolia_v1`) and a separate public views schema.
      Never share the Optimism production schema.
- [ ] Start block from the manifest; confirm factory discovery works in production mode and
      that a newly created instance appears without a restart.
- [ ] Operator TOML for Sepolia: `release_manifest` pointing at the tracked file, RPC kept
      private, separate submitter key, finalized confirmation policy, Succinct network
      backend, IPFS API and public gateway, persistent journal path, alert webhook.
- [ ] Apply D5's budget: `global_usd_per_day = 15`, `per_instance_usd_per_day = 2`, signer
      `1`/`5`, `cents_per_billion_cycles` and `cycle_limit` untouched, `curated.instances` =
      the seeded network only, `paid.enabled = true` against the deployed vault.
- [ ] **Lower `cadence.subsidy_min_blocks` from 216,000 to 7,200 for this deployment.** The
      default is a deliberate "we pay for a curated instance about once a month" (see the
      comment at `crates/operator-core/src/policy.rs:117` and the prover runbook), and it
      applies only to curated instances, which after D5 is exactly the seeded network. A
      monthly cadence is correct when subsidizing someone else's network and wrong for the
      demo everyone will judge the system by. Daily costs about $15/month, which fits the D5
      cap. This is a config override for the Sepolia profile, not a change to the default.
- [ ] Alert at 80% of the global cap, so a runaway is heard before it halts.
- [ ] The score blob must be pinned and retrievable through the production gateway *before*
      its root transaction is sent.
- [ ] Backups for Postgres and the operator journal; test restart recovery.

### M8 — Dress rehearsal on a Sepolia fork

Everything above, executed end to end against `anvil --fork-url` on Sepolia state, before a
single real transaction. The fork carries the real EAS, the real gateway and the real feed,
so it exercises the actual external surface at zero cost.

- [ ] Full ordered deploy, including governed factory and seeded instance.
- [ ] Role handoff, then the verification script.
- [ ] Create a network through the wizard's code path; confirm the Safe is a canonical
      proxy.
- [ ] Vouch, revoke, index, and produce a root, then read the score back in the UI.
- [ ] Record gas totals and the deployer balance delta.

### M9 — Broadcast and validate

Operator-gated, in the order `research/operations/sepolia.md` sets out: freeze and test the release,
preflight, deploy and verify, indexer, operator, frontend, then the browser acceptance run
on the public domain with a clean wallet. Publish the finalized manifest only after every
invariant passes.

---

## Gates

**Fork gate (blocks M9):** M1 through M7 complete, and M8 green end to end.

**Broadcast gate:** the fork gate, plus every M0 input in hand, plus a genuine Groth16 proof
verified through the real Sepolia gateway.

**Announce gate:** the browser acceptance flow passes on the public domain, the operator is
running continuously with alerts, and the testnet label is visible.

---

## Operator ledger

1. **Derive the release keys.** `trust-graph` vkey, `signer` vkey, and the ELF digest, from
   the frozen release checkout. Nothing downstream is real until these are.
2. **Name the admin EOA** that receives registry and vault administration in M4, and say
   whether it is a separate key from the deployer or the same one.
3. **Provision secrets:** deployer key, operator submitter key, private Sepolia RPC,
   Succinct network key, Pinata credentials, Postgres, Etherscan API key for verification.
   None of these belong in the repo or in the manifest.
4. **Economics are ruled (D5), not owed.** What remains for the operator is a veto, plus
   confirming the Succinct account is actually billed for these proofs rather than sitting on
   a testnet allowance, since that changes the expected bill but not the caps.
5. **Name the seeded network:** name, purpose, metadata, parameters, and whether it carries
   a fund at creation. The trusted-seed list is the one that deserves real thought: it is the
   root of authority for the first public graph, and the template still holds Anvil accounts.
6. **Ingress admission is still open** from the last audit, and this program does not close
   it. Lane F made the ceiling honest; it did not stop anyone reaching it for roughly
   0.0027 ETH. A public testnet where anyone can create a network is exactly the setting
   that surfaces it.
7. **Nothing is pushed.** `main` is ahead of `origin/main`, and publishing stays an explicit
   operator action.

---

## Landmines

- **This sandbox's `node_modules` are macOS binaries.** The Linux esbuild natives were
  reinstalled by hand to get `pnpm test:deploy` running, and a `pnpm install` wipes that.
- **The ponder 0.16.2 `getIntervals` patch is still non-durable**, and is carried in the
  shared `node_modules` rather than in a lockfile. It has to survive onto whatever machine
  runs the production indexer, or be replaced by a version bump.
- **`forge test` in one process exceeds the runner's memory.** Shard by path.
- **Em-dashes are invalid in Solidity string literals.** Use ASCII or `unicode""`.
- **A vkey change requires a new verifier and, because the factory pins it, a new factory
  for future instances.** Treat it as a release migration, never a config edit.
