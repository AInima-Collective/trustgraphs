# Deploy to a public chain

A public Trustgraphs deployment combines contracts whose program identity must remain stable with
indexing, proving, and publication services that must remain available. Treat it as a
security-sensitive release, not a copy of the local demo.

## Supported deployment profiles

The target is the only switch. `DEPLOY_TARGET` selects a row in `contracts/deploy/profiles.ts`
(chain identity) and `contracts/deploy/public-chains.ts` (which optional families the generation
ships and which policy defaults hold); `deployments/<target>.json` is that chain's public record,
`config/networks.<target>.json` its seed catalog, `deployments/operator.<target>.toml` its proving
policy, and the ignored `.env.<target>` its secrets. Adding a chain is one row in each table plus
those files; nothing else in the tooling names a chain.

| Target    | Profile                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sepolia` | Ethereum Sepolia (11155111). Modern registry; verifiers for trust-graph, signer-sync, weighted-prior, trust-compose, and contributions; base and governed factories for trust-graph, imported EAS, weighted, and composition; a contributions factory; canonical Safe integration; signer-sync module deployer; proving vault. |
| `mainnet` | Ethereum mainnet (1). The same plan without the imported-EAS factory pair (a recorded generation-1 decision; it can be added later with `--continue-existing`). The admin is a Safe. `deployments/mainnet.json` is `planned` until the first broadcast finalizes it.                                                     |

Both chains end every plan with two role handoffs (`contracts/script/HandoffAccessControl.s.sol`):
the proving vault's admin and fee-setter roles, and the subnetwork registry's admin role, move
from the deployer to `INSTANCE_REGISTRY_ADMIN` in one broadcast each, and the script asserts from
chain state that the deployer holds neither. The only grants left for the admin are the factories'
`REGISTRAR_ROLE` on the instance registry; the deploy writes them as a Safe Transaction Builder
batch to `.docker/admin-grants.<target>.json` and prints the equivalent `cast` commands.

## Before deployment

- Pin the source commit, Foundry dependencies, Rust toolchain, and SP1 version.
- Build the exact guest artifacts and record their digests and verification keys.
- Run the Solidity, Rust, frontend, indexer, golden-vector, and end-to-end suites relevant to the
  chosen profile.
- Produce a proof with the intended backend and verify it through the target chain's SP1 gateway.
- Review every admin, registrar, Safe, timelock, vault, and operator role the profile actually
  deploys.
- Confirm durable RPC, indexer, witness, and output-publication capacity.

Never deploy a verifier with a key derived from a different guest build.

## Deploy the contracts

Choose a target explicitly. The Sepolia deployment is additive: run its read-only release
preflight, continue from the tracked live manifest, then assert the on-chain end state:

```bash
pnpm deploy:sepolia:preflight
pnpm deploy:sepolia:continue
pnpm deploy:sepolia:postcheck
```

The first mainnet deployment is a fresh broadcast against the planned manifest, from a clean
checkout of the release tag with that release's `guest-manifest.json` beside it:

```bash
pnpm deploy:mainnet:preflight
pnpm deploy:contracts --stage production --chain mainnet --dry-run
pnpm deploy:mainnet:contracts
pnpm deploy:mainnet:postcheck
pnpm verify:contracts --chain mainnet
```

The mainnet preflight is the Sepolia one with the chain swapped: it checks the release identity,
refuses scratch receipts before a fresh deploy, requires `ALLOW_MAINNET_EPOCH_FLOOR=true` for a
floor under a day of blocks (the testnet opt-in is ignored on chain 1 and vice versa), confirms
code at every canonical external, and reads the SP1 gateway route. After the admin Safe executes
the grant batch, rerun the postcheck: it asserts the role graph, including both handoffs.

The deployment code validates profile-specific environment variables before sending transactions.
Inspect every simulated call and receipt. Preserve contract addresses, deployment blocks, source
commit, guest digests, verification keys, and transaction hashes in the target's deployment
manifest.

After deployment, verify the complete role graph from chain state. Transfer any temporary
bootstrap roles required by that profile and confirm the deployer retains no unintended authority.

## Operate the services

Public service requirements include:

- finalized and failover RPC endpoints;
- durable Postgres storage and a correct registry or deployment start block for the indexer;
- sufficient independent output-file publication targets for the operator's configured policy;
- a prover with persistent journal and manifest storage, budgets, finality checks, and alerts; and
- monitoring for stale checkpoints, held proofs, publication failures, root mismatches, source
  availability, and low proving-vault balances where a vault is deployed.

Test restoration of the database, operator journal, weighted manifests if that program is present,
and published output files before relying on the deployment.

### Sepolia service package

Railway is the selected host for the first public testnet. Its project definition and deployment
runbook are in [Run the services on Railway](./railway.md). The Compose package below
remains the portable reference implementation and local recovery-drill path.

`docker-compose.prod.yml` is the production package, not a developer convenience stack. The
writer and serving API run from `packages/indexer/Dockerfile`; neither installs dependencies into
or bind-mounts the checkout. Postgres and the operator state use explicitly named volumes. Only
the small tracked `deployments/` directory is mounted read-only so the operator can consume the
finalized manifest and policy.

Set the variables required by the Compose file, then run:

```bash
docker compose -f docker-compose.prod.yml build ponder ponder-server
docker compose -f docker-compose.prod.yml up -d
```

`OPERATOR_IMAGE` must be the release workflow's complete
`ghcr.io/.../trustgraphs-operator@sha256:...` reference. On startup, the operator refuses unless
its embedded trust-graph and signer ELF digests and vkeys match the tracked release manifest. The
Sepolia release image, `v0.1.2`, built from commit `6a9e2d7` by
[release run 34422090643](https://github.com/AInima-Collective/trustgraphs/actions/runs/34422090643)
is:

```text
ghcr.io/ainima-collective/trustgraphs-operator@sha256:d37fad30f3007a1f0f515ffec1f8a1542248296d71b796705146f086e94f22e6
```

That run reproduced the guest ELFs twice, published a linux/amd64 + linux/arm64 OCI index,
attested it, pulled it anonymously, and re-derived the embedded vkeys. The writer schema must be a
new versioned name for each indexer release; the views schema stays stable. The
primary Sepolia RPC and `PONDER_RPC_URLS_11155111` must name different providers so a single
provider outage does not stop ingestion. The frontend host must receive `PONDER_URL`,
`IPFS_GATEWAY_PUBLIC`, `RPC_URL_1` for ENS reads, and both `RPC_URL_11155111_0` and
`RPC_URL_11155111_1`; the two browser RPC upstreams must also be independent. Public frontend
config generation rejects missing, placeholder, non-HTTP, or duplicate endpoints.
Set `FEATURED_NETWORK_ID` on the frontend host to the catalog instance id, configured slug, or
Merkle snapshot address of the network the homepage should feature. Prefer the immutable instance
id for Sepolia; changing it takes effect on the next deployment.

The v0.1.0 frontend uses Next.js 16 on Node.js 22. Its `dev` and `build` scripts deliberately pass
`--webpack`: the browser-compatible EAS workspace client remains CommonJS because the pinned EAS
SDK's native-ESM entry is not usable by the Node services and tests, while Next.js 16 Turbopack
rejects that mixed module boundary. Keep the explicit bundler flag on the deployment host and do
not replace it with a bare `next build` until the EAS client has a tested ESM package boundary.

Build the candidate from a frozen install, start that exact production output, and run the wallet
and Sepolia browser smokes against its preview URL before promotion. The framework upgrade changes
neither public environment variables nor persistent data. To roll back, redeploy the last reviewed
Next.js 15 commit from a fresh install and build; discard cached `.next` and `node_modules` outputs
rather than sharing framework artifacts across the two major versions.

The repository uses the native TypeScript 7 compiler in every workspace. `@typescript/native`
aliases `typescript@7.0.2` and supplies `tsc`; the package named `typescript` temporarily aliases
`@typescript/typescript6@6.0.2` so Next.js and `typescript-eslint` can use the legacy JavaScript
compiler API. That compatibility package exposes `tsc6`, not `tsc`, and therefore cannot silently
replace the native compiler. This follows Microsoft's supported
[side-by-side migration layout](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
Keep both pins identical in all five manifests until those tools support the TypeScript 7 API,
then remove the bridge from all workspaces in one change.

Run `pnpm typecheck:all` to verify the manifest pins, the resolved compiler version, and every
workspace. CI runs the same command after a frozen install. Package tsconfigs retain their
pre-existing `skipLibCheck` settings for third-party Web3 declaration graphs, while Trustgraphs
source remains under `strict` typechecking. The root peer-dependency rule explicitly accepts the
6.0.2 bridge for transitive packages whose metadata still caps TypeScript below 6; the frozen
install, generators, tests, and production build validate that compatibility boundary. Standalone
frontend test builds explicitly select Node globals, ES2022/DOM libraries, and NodeNext resolution
because TypeScript 7 no longer auto-loads ambient `@types` packages and requires `--ignoreConfig`
for file-list compilation beside a tsconfig.

After the frontend is deployed, exercise its clean-browser, read-only launch surface before using
a funded wallet:

```bash
FRONTEND_URL=https://testnet.example.org \
  pnpm --filter trustgraphs-frontend smoke:public
```

The smoke reads the chain from the deployed site's generated config, so the same command runs
against the mainnet site with its `FRONTEND_URL`.

This checks the standard, weighted, and composition creation entries backed by the tracked
factories. It does not submit a transaction; the clean-wallet creation remains a separate release
check.

On a preview deployment where transport 0 is deliberately pointed at an unreachable endpoint,
the same smoke command can prove the browser actually continues through transport 1:

```bash
FRONTEND_URL=https://preview.testnet.example.org \
EXPECT_RPC_FAILOVER=true \
  pnpm --filter trustgraphs-frontend smoke:public
```

The assertion requires a 5xx response from `id=0` followed by a 200 response from `id=1`; do not
use it during an ordinary healthy smoke run.

Use the database host's backup and restore facilities. Verify a backup by restoring it into an
isolated database, then record the backup identifier, checksum, restored database, table count,
and time in the deployment log.

For the restart drill, record the writer's sync block, the operator journal checksum, and the
latest backup checksum; stop both application services, recreate them from their exact image
references, and confirm the sync block advances and the journal checksum is unchanged before new
work is requested. The named volumes must remain attached throughout.

## Verify the release

Exercise only features the selected profile deployed:

1. Create or identify a small supported instance through that profile's actual factory or
   configuration path.
2. Submit representative inputs and freeze a checkpoint.
3. Produce, publish, and submit a proof with the release guest.
4. Confirm the indexer independently derives the accepted root and provenance.
5. Fetch one output entry and Merkle proof through the public API and verify it against the chain.
6. Exercise a protected settings change through the deployed authority model.
7. If an optional component exposes a pause, verifier rotation, or recovery path, test that exact
   control rather than assuming a network-wide emergency pause exists.

Publish the final addresses, deployment blocks, verification keys, and guest digests. See
[Addresses and verification keys](../verify/addresses-and-vkeys.md) and [Run a
prover](./run-a-prover.md).
