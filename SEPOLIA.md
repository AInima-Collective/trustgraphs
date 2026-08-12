# Trustgraphs on Ethereum Sepolia

Status: deployment research and implementation plan, 2026-08-07.

## Outcome

Trustgraphs is not ready to deploy to Sepolia by changing environment variables alone.
The repository currently has two coupled modes:

- development means local chain 31337 and the modern factory/registry stack;
- production currently means Optimism chain 10 and a legacy direct-per-network deployment path.
  Both are slated for retirement: Ethereum mainnet is the go-forward production chain.

Ethereum Sepolia should be added as an explicit chain target and should use the modern
factory/registry architecture. It must use canonical Sepolia EAS, a real SP1 verifier
gateway, a release-derived program vkey, and a production indexer/operator. The mock
gateway, zero vkeys, default Anvil key, placeholder endpoints, and old Optimism deployment
path are not acceptable on a public testnet.

This document assumes “Sepolia” means Ethereum Sepolia, chain ID **11155111**, rather than
OP Sepolia.

## Recommended first release

The first public testnet release should include:

1. Canonical Sepolia EAS and Schema Registry as external dependencies.
2. Trustgraphs SchemaRegistrar.
3. SP1JournalVerifier for the trust-graph root program.
4. InstanceRegistry.
5. ProvingVault, using Sepolia test USDC and an ETH/USD feed, if the UI will offer prepaid proving.
6. MerkleSnapshotDeployer, MerkleFundDistributorDeployer, and TrustgraphsFactory.
7. One project-controlled seeded instance created through the factory.
8. A production Ponder writer/API, a continuously running operator, IPFS persistence, and the web app.

Keep Contributions, Hypercerts, Zodiac Safe, MerkleGov, and signer-sync outside the
launch-critical path. They can follow once the core vouch → index → prove → root → score flow
is stable. If ProvingVault is omitted, the frontend must remove or disable its prepay option.

“Live” means more than having contracts on a block explorer. A launch is complete only when
a user can connect on Sepolia, discover an instance, vouch and revoke, see both changes
indexed, and see a genuine SP1 proof update the on-chain root and indexed scores.

## Confirmed public dependencies

| Dependency                    | Sepolia value                              | Launch treatment                                                  |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Chain ID                      | 11155111                                   | Assert before every broadcast, indexer start, and frontend build. |
| Explorer                      | https://sepolia.etherscan.io               | Use for links and source verification.                            |
| EAS                           | 0xC2679fBD37d54388Ce493F1DB75320D236e1815e | Use the canonical deployment; do not deploy a private EAS.        |
| EAS Schema Registry           | 0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0 | Use the canonical deployment.                                     |
| Circle test USDC              | 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 | Optional vault asset; it has no real-world value.                 |
| SP1 Groth16 gateway candidate | 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B | Verify code and exact SP1-version support before deployment.      |

Sources:

- [EAS SDK deployment addresses](https://docs.attest.org/docs/developer-tools/eas-sdk)
- [Circle testnet USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Succinct SP1 verifier contracts](https://docs.succinct.xyz/docs/sp1/verification/contract-addresses)
- [Safe supported networks](https://docs.safe.global/advanced/smart-account-supported-networks?expand=11155111&service=Transaction+Service)
- [Ethereum Sepolia configuration](https://github.com/eth-clients/sepolia)

The ETH/USD feed address is deliberately not frozen in this plan. Select it from
[Chainlink’s current Ethereum data-feed directory](https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum)
immediately before deployment, then verify on chain that it has code, reports 8 decimals,
returns a positive answer, and has a sufficiently recent updatedAt value.

### Blocking SP1 compatibility check

The repository pins SP1 SDK/tooling version **6.3.1**. Succinct’s current verifier-contract
page names V5.x.y and V6.1.0 as officially supported versions. That does not prove 6.3.1 is
incompatible, but it makes compatibility an unresolved launch gate.

Before deploying SP1JournalVerifier:

1. Derive the vkey from the exact release checkout and pinned toolchain.
2. Confirm with Succinct’s supported-version data that the chosen gateway has the verifier
   route required by that proof.
3. Generate a genuine Groth16 proof and successfully verify it through the gateway on Sepolia.

If 6.3.1 has no supported route, upgrade or pin the repository to a supported SP1 release,
rebuild every relevant ELF, regenerate vkeys and golden vectors, and rerun the complete
parity/test suite. Never substitute MockSP1Gateway on Sepolia.

## Configuration model

Do not redefine the legacy Optimism production code path as Sepolia. Separate operational
strictness from chain identity:

- deployment stage: development or production behavior;
- chain target: local, sepolia, or mainnet;
- chain profile: chain ID, RPC variable, explorer, external addresses, start block, and
  generated artifact names.

A minimally disruptive implementation can add a SepoliaEnv, but a reusable PublicEnv driven
by a typed chain profile is preferable. Both Sepolia and the future Ethereum mainnet
deployment should then share the same modern deployment path.

Use chain-scoped, sanitized manifests such as **deployments/sepolia.json** as the interface
between deployment, indexer, operator, and frontend. Do not use
**.docker/deployment_summary.json** as a release artifact: it is machine-local, ignored by
Git, and currently includes rpc_url, which may contain a provider credential.

A release manifest should contain at least:

```json
{
  "version": 1,
  "chain": "sepolia",
  "chainId": 11155111,
  "deploymentCommit": "git commit",
  "firstDeploymentBlock": 0,
  "external": {
    "eas": "0x...",
    "schemaRegistry": "0x...",
    "sp1Gateway": "0x...",
    "ethUsdFeed": "0x...",
    "usdc": "0x..."
  },
  "contracts": {
    "schemaRegistrar": { "address": "0x...", "block": 0, "txHash": "0x..." },
    "rootVerifier": { "address": "0x...", "block": 0, "txHash": "0x..." },
    "instanceRegistry": { "address": "0x...", "block": 0, "txHash": "0x..." },
    "provingVault": { "address": "0x...", "block": 0, "txHash": "0x..." },
    "trustgraphsFactory": { "address": "0x...", "block": 0, "txHash": "0x..." }
  },
  "programs": {
    "trustgraphs": {
      "sp1Version": "resolved version",
      "elfSha256": "0x...",
      "vkey": "0x..."
    }
  },
  "instances": []
}
```

RPC URLs, private keys, database URLs, IPFS credentials, prover credentials, and webhook
secrets belong only in secret storage.

## Scripts and deployment orchestration

### Required changes

| File or area                                    | Change                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **deploy/types.ts**                             | Add a typed Sepolia/chain target rather than treating every non-development run as Optimism.                                                                  |
| **deploy/env.ts**                               | Add chain ID 11155111, Sepolia RPC/config paths, the modern factory plan, canonical external dependencies, and strict production validation.                  |
| **deploy/deploy-contracts.ts**                  | Accept the new target and emit the sanitized chain-scoped manifest.                                                                                           |
| **taskfile/env.yml**, **taskfile/services.yml** | Recognize the new target instead of accepting only DEV and PROD.                                                                                              |
| **script/Common.s.sol**                         | Fail closed on a public chain if FUNDED_KEY is absent; never fall back to the known Anvil key. Assert the expected chain ID and print the deployer/balance.   |
| **script/DeployEAS.s.sol**                      | Accept explicit EAS and Schema Registry addresses. Reuse canonical Sepolia contracts and deploy only SchemaRegistrar. Keep private EAS deployment local-only. |
| **script/DeployProvingVault.s.sol**             | Validate feed code/decimals/freshness and USDC code/decimals before deploying. Make testnet economics explicit.                                               |
| **script/CreateDevInstances.s.sol**             | Refactor to a release-capable create-instances script with deterministic salts, explicit admin, metadata URI, and distribution choice.                        |
| new handoff/invariant scripts                   | Transfer registry/vault/instance roles, verify every immutable and role, and stop if post-deploy state differs from the manifest.                             |

The current skip/resume logic trusts the presence of local artifacts. For public deployment it
must also verify chain ID, bytecode at every recorded address, immutable constructor values,
and deployment commit. A file from chain 31337 or chain 10 must never cause a Sepolia step to
be skipped.

### Deployment behavior

Use the modern development sequence as the architectural reference, but replace its mock and
developer defaults:

1. Validate chain ID, deployer, balance, release commit, external contract code, vkeys, and
   oracle/token behavior.
2. Reuse canonical EAS and Schema Registry; deploy SchemaRegistrar.
3. Deploy SP1JournalVerifier with the real gateway and release-derived root-program vkey.
4. Deploy InstanceRegistry.
5. Deploy ProvingVault if paid/prepaid proving is in scope.
6. Deploy MerkleSnapshotDeployer and MerkleFundDistributorDeployer.
7. Deploy TrustgraphsFactory and grant only its required registrar capability.
8. Create the seeded instance through TrustgraphsFactory.
9. Configure vault policies and top-ups, if enabled.
10. Transfer operational and administrative roles, then remove deployer privileges that are
    not part of the documented custody model.
11. Verify source and publish the finalized manifest.

Do not use **DeployNetwork.s.sol** as the primary path. It can deploy a direct instance, but it
bypasses the registry/factory event stream that powers runtime discovery and the create wizard.

### Parameters to decide before deployment

- Project Safe or other admin addresses; do not leave long-lived control on the deployer EOA.
- Seeded instance admin, name, metadata CID, algorithm parameters, quorum, min participants,
  max vouches, and distribution behavior.
- Factory EPOCH_FLOOR. The public-chain script requires at least 7,200 blocks; at roughly
  12 seconds per block that is about one day. Use this testnet-friendly floor deliberately.
- Vault fee bands, max gas, oracle staleness, curated/free proving policy, and initial test-USDC
  liquidity.
- Whether permissionless instances must prepay or self-prove. Do not promise free proving for
  every public instance without an explicit budget and abuse policy.

### Roles and optional Safe stack

InstanceRegistry initially gives the deployer administrator/operator privileges, while
ProvingVault gives it administrator and fee-setter privileges. The existing scripts do not
complete those handoffs. Add an idempotent handoff script, verify the recipient roles, and
renounce/revoke the deployer only after verification.

The existing **DeployZodiacSafes.s.sol** should not be used unchanged on Sepolia. It deploys
its own old Safe singleton/factory, starts with one deployer owner, leaves module ownership
with the deployer, and unconditionally transfers 2 ETH to the Safe. If governance proofs are
included later:

- use the canonical Sepolia Safe deployment or explicitly justify a private deployment;
- parameterize owners, threshold, module owners, and funding;
- require a real signer-program vkey and nonzero selection-parameters hash;
- complete ownership transfers; and
- prove and execute a signer-sync smoke test.

## Contracts

No core Solidity business-logic change is inherently required for chain 11155111.
Trustgraphs commits block.chainid into its parameters, and the configured Cancun EVM target is
available on Sepolia. The work is deployment integration, validation, and custody.

### Pre-deploy contract checks

- Canonical EAS and Schema Registry both have code and match the ABI used by the pinned EAS
  package. Run a Sepolia fork integration test for schema registration, attest, revoke, and
  resolver callbacks.
- SP1 gateway has code and supports the exact proof selector emitted by the pinned prover.
- Root-program vkey is nonzero and comes from the release ELF.
- ETH/USD feed has 8 decimals and a live, sane round.
- Test USDC has 6 decimals.
- All project admin addresses are nonzero and documented.

### Post-deploy invariants

An automated script should assert:

- connected chain ID is 11155111;
- verifier gateway and program vkey equal the release manifest;
- registry administrator/operator/registrar roles match the custody plan;
- factory EAS, Schema Registry, verifier, registry, vault, deployers, and EPOCH_FLOOR match;
- the seeded InstanceCreated event and registry row agree;
- the instance schema UID, resolver, accumulator, snapshot, chain ID, and parameters hash agree;
- the accumulator is bound to the intended schema and snapshot;
- the distributor owner and vault policy are correct;
- the vault registry, feed, USDC, fee bands, and balances are correct;
- no unintended deployer privileges remain; and
- every manifest address has bytecode.

SP1JournalVerifier’s vkey is immutable, and TrustgraphsFactory’s verifier reference is immutable.
A new program vkey therefore requires a new verifier and a new factory for future instances.
Existing snapshots can rotate their verifier only through their constitutional governance path.
This should be treated as a release migration, not an in-place configuration edit.

## Indexer

### Required changes

**indexer/ponder.config.ts** currently maps production to Optimism, development to local, uses
Optimism-specific start blocks, and disables factory discovery in production. Change it to:

- define Sepolia with chain ID 11155111;
- read **PONDER_RPC_URL_11155111** and optional Sepolia websocket configuration;
- take a single release start block from the Sepolia manifest or
  **PONDER_START_BLOCK_11155111**;
- enable factory discovery whenever a factory address exists, regardless of deployment stage;
- use InstanceCreated as the source for dynamically created child contracts; and
- keep legacy Optimism constants only inside the Optimism profile.

**indexer/scripts/launch-indexer.mjs** should derive its expected chain ID, RPC variable, and
start block from the same chain profile. Preserve its valuable preflight checks:

- RPC chain ID is exact;
- head is at or after the configured start block;
- the provider can serve historical state at that block;
- configured contracts have code; and
- persisted database identity matches the target chain.

Add tests for a correct Sepolia profile, wrong-chain RPC, missing bytecode, start block after
head, and factory discovery in production mode.

### Production operation

- Run Ponder writer and serve processes against Postgres.
- Use distinct schemas, for example **trustgraph_sepolia_v1** for the release writer and
  **trustgraph_sepolia** for stable/public views. Never share the Optimism production schema.
- Start at or before the earliest trustgraphs deployment event. A fresh deployment does not
  need an archive provider back to genesis, but the provider must reliably serve logs and
  historical calls from that start block.
- Use a paid, rate-limited provider with enough getLogs capacity. Keep the RPC URL server-side.
- Put the public API behind HTTPS, health checks, request limits, monitoring, and backups.
- Verify that GET /instances includes the seeded instance and that a newly factory-created
  instance appears without an indexer restart.

The indexer resolves EAS state and retrieves score blobs from IPFS. The operator must pin and
verify a score blob before submitting its root; otherwise a valid on-chain event can still
leave the indexed score view unavailable.

## Frontend

### Required changes

| File or area                                 | Change                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **frontend/scripts/generate-config.ts**      | Support sepolia, consume the release manifest, require real Ponder/IPFS URLs, and fail on missing or placeholder addresses.                                         |
| **frontend/lib/wagmi.ts**                    | Import the Viem Sepolia chain, configure chain ID 11155111, use the private RPC proxy, and support the Sepolia websocket variable. Keep mainnet only for ENS reads. |
| **frontend/lib/blocks.ts**                   | Add Sepolia’s approximately 12-second block time.                                                                                                                   |
| **frontend/package.json** and build pipeline | Generate or select the Sepolia config before build; today prebuild assumes an existing production config.                                                           |
| **frontend/config.sepolia.json**             | Generate from the finalized manifest rather than editing addresses by hand.                                                                                         |
| **config/networks.sepolia.json**             | Include the curated seeded instance as an outage fallback, while keeping the runtime catalog authoritative.                                                         |
| frontend environment example                 | Document public Ponder/IPFS endpoints, WalletConnect configuration, and server-only Sepolia RPC secrets.                                                            |

The current **frontend/config.production.json** is an Optimism file with a placeholder Ponder
URL and must not be reused.

### Public endpoint hardening

**frontend/app/api/rpc/[chainId]/route.ts** currently forwards arbitrary JSON-RPC methods to
any configured chain variable. Before exposing a paid provider:

- allow only the configured public chain IDs;
- allow only the read methods the application needs;
- cap body and batch size;
- apply timeout, rate limiting, and abuse monitoring; and
- never relay raw transactions or expose provider credentials.

Wallets should submit writes through their own provider.

**frontend/app/api/ipfs/route.ts** is an unauthenticated Pinata write endpoint. Add per-IP and
per-wallet rate limits, origin/CSRF or signed-wallet authorization, quota alerts, and existing
size limits. Validate CIDs and add response limits/timeouts on the read proxy.

### User experience and browser acceptance

- Show a persistent “Ethereum Sepolia: testnet assets have no value” indicator.
- Give a clear wrong-network prompt and an add/switch-to-Sepolia action.
- Link to Sepolia Etherscan and appropriate ETH/test-USDC acquisition guidance.
- Test WalletConnect allowed origins for the deployed domain.
- Test Porto on Sepolia or disable it if the connector does not support the chain.
- Hide vault prepayment when Factory.VAULT is zero.
- Ensure all browser-visible Ponder and IPFS URLs are HTTPS.

The end-to-end browser test must cover connect, switch chain, discover the seeded instance,
create an instance, vouch, revoke, observe indexer updates, trigger a real root update, and
read the resulting scores. Funding/distribution belongs in the test only if it is included in
the release scope.

## Operator and supporting infrastructure

The contracts, indexer, and frontend are not a functioning trustgraphs deployment without an operator;
roots otherwise become stale.

Configure **zk/operator** with:

- chain ID 11155111 and a private Sepolia RPC;
- InstanceRegistry address and its exact deployment block;
- separate funded network and submitter keys;
- finalized confirmation policy;
- release program vkey and real prover backend/credentials;
- curated versus paid proving policy;
- IPFS API and public gateway;
- persistent journal and status paths; and
- alert webhook.

The score JSON must be uploaded, pinned, and retrievable through the production gateway before
the corresponding root transaction is sent. Back up the append-only operator journal and test
restart recovery. Put the status adapter behind an explicit allowlist rather than exposing
arbitrary upstream URLs.

Other required services are:

- managed or backed-up Postgres;
- reliable Sepolia HTTP RPC, with websocket as an optional latency optimization;
- IPFS pinning/gateway service;
- SP1 prover network account or appropriately sized proving host;
- HTTPS hosting and DNS for Ponder and frontend;
- error tracking, uptime checks, root-freshness alerts, RPC/IPFS quota alerts; and
- separate deployer, operator, and submitter secrets in a secret manager.

## Deployment runbook

### 1. Freeze and test the release

Work from a clean commit and record the Rust, Foundry, Node/pnpm, and SP1 versions.

```bash
task setup
task test
task zk:parity PROGRAM=trust-graph
task zk:build
task zk:vkey PROGRAM=trust-graph
```

Run indexer and frontend tests/type checks as part of the same release CI. Build the guest
before deriving the final vkey, then hash and archive the exact ELF. Do not rebuild it between
deployment and proof generation.

### 2. Run public-chain preflight

- RPC reports 11155111 and supports historical access from the planned deployment block.
- Deployer is the intended address, is not the Anvil default, and has enough Sepolia ETH.
- EAS, Schema Registry, SP1 gateway, oracle, and USDC checks pass.
- Program vkey is nonzero and exact.
- Governance recipients and factory/instance/vault parameters are approved.
- A no-broadcast Foundry simulation succeeds against the same RPC.
- Expected gas cost and account balances are recorded.

### 3. Deploy and verify

Record the head block immediately before the first project transaction. Execute the ordered
deployment above, writing each transaction hash and receipt block to a provisional manifest.
Run invariant and role-handoff scripts. Verify contracts on Sepolia Etherscan using the exact
compiler 0.8.27, optimizer, via-IR, and Cancun settings in **foundry.toml**. Publish the
sanitized manifest only after every invariant passes.

### 4. Start and validate the indexer

Start a fresh Sepolia writer schema at the recorded first block, let it reach head, then expose
the serve process. Confirm the seeded instance, schema registration, and a test vouch/revoke
through the public API. Create another factory instance and confirm automatic discovery.

### 5. Start and validate the operator

Create a small but nontrivial vouch graph. Run one complete real path:

1. observe eligibility;
2. build the graph input;
3. generate a genuine Groth16 proof;
4. upload and verify the score blob;
5. submit through the Sepolia SP1 gateway;
6. observe the new Merkle root;
7. confirm the indexer imports the scores; and
8. verify a score/Merkle proof in the UI.

Only then switch the operator to continuous mode and enable alerts.

### 6. Build and publish the frontend

Generate the Sepolia config from the finalized manifest, set the public Ponder/IPFS URLs and
server-side RPC secrets, build in production mode, and deploy. Run the browser acceptance
flow on the public domain and on a clean wallet before announcing the testnet.

## Rollback and redeployment

Most of this stack is immutable rather than upgradeable. A bad deployment should not be
“fixed” by overwriting the old manifest.

1. Stop the affected operator and frontend writes.
2. Preserve the old manifest, addresses, database schema, and operator journal.
3. Deploy corrected contracts under a new release manifest and new writer schema.
4. Backfill and validate the new indexer.
5. Atomically point the frontend at the new config.
6. Keep the prior read path available until the new release is proven healthy.

Changing the root-program vkey requires a new SP1JournalVerifier. Because the factory pins its
verifier, it also requires a new factory for future instances. This migration constraint is a
reason to resolve the SP1 version gate before any public factory is deployed.

## Launch checklist

### Release and contracts

- [ ] Ethereum Sepolia is an explicit chain profile; no local/Optimism branch is being reused accidentally.
- [ ] Release commit, toolchains, ELF hash, vkey, and manifest are recorded.
- [ ] Canonical EAS/Schema Registry are used.
- [ ] Exact SP1 gateway compatibility is proven with a real Sepolia proof.
- [ ] No mock gateway, zero vkey, default Anvil key, or placeholder address is present.
- [ ] Factory-created seeded instance passes all post-deploy invariants.
- [ ] Source is verified on Sepolia Etherscan.
- [ ] Registry, vault, and instance roles match the documented custody model.

### Indexer and operator

- [ ] Wrong-chain RPC and missing-code preflights fail closed.
- [ ] Sepolia has isolated writer/public database schemas and a recorded start block.
- [ ] Factory discovery works in production and discovers a new instance without restart.
- [ ] Public API is synced, HTTPS-only, monitored, and rate-limited.
- [ ] Operator uses separate funded keys, persistent journal storage, and alerts.
- [ ] A real proof updates the root and its pinned score blob is indexed.

### Frontend and security

- [ ] Generated config says sepolia/11155111 and contains no placeholder endpoint.
- [ ] Connect, add/switch chain, vouch, revoke, create, index, root, and score flows pass.
- [ ] A prominent testnet/no-value label is visible.
- [ ] RPC proxy is chain/method restricted and rate-limited.
- [ ] IPFS writes are abuse-protected and CIDs are validated.
- [ ] Provider, database, IPFS, prover, and signing secrets are absent from browser bundles and Git.
- [ ] WalletConnect origins and every public HTTPS endpoint are production-configured.

## Suggested implementation order

1. Introduce the shared chain profile and sanitized manifest.
2. Make EAS, public-chain keys, external dependencies, and role handoffs safe.
3. Add the modern Sepolia deploy plan and invariant checks.
4. Generalize Ponder and enable production factory discovery.
5. Add Sepolia frontend configuration and harden public API proxies.
6. Resolve SP1 compatibility and complete a fork/test proof rehearsal.
7. Deploy contracts, then indexer, operator, and frontend in that order.

The shortest safe path is therefore a focused chain-configuration and release-hardening change,
not a new set of trustgraphs contracts.
