# Deploy to a public chain

A public Trustgraphs deployment combines contracts whose program identity must remain stable with
indexing, proving, and publication services that must remain available. Treat it as a
security-sensitive release, not a copy of the local demo.

## Supported deployment profiles

The repository currently exposes two production-stage targets with different contract sets:

| Target | Current profile |
| --- | --- |
| `sepolia` | Modern registry, `trust-graph` and signer verifiers, base and governed factories, canonical Safe integration, signer-sync module deployer, and proving vault. Weighted prior, composition, and contributions remain disabled. |
| `optimism` | Legacy configuration-driven deployment of named standard networks, signer verifier, Safes, and timelocks. It is not the modern self-service factory profile. |

The `mainnet` target is intentionally disabled because the repository has no authorized Ethereum
mainnet deployment profile. Do not infer feature support on one target from code deployed by the
other.

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

Choose an implemented target explicitly. For example:

```bash
DEPLOY_STAGE=production DEPLOY_TARGET=sepolia pnpm deploy:contracts
```

or, for the legacy Optimism profile:

```bash
DEPLOY_STAGE=production DEPLOY_TARGET=optimism pnpm deploy:contracts
```

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
runbook are in [Run the Sepolia services on Railway](./railway.md). The Compose package below
remains the portable reference implementation and local recovery-drill path.

`docker-compose.prod.yml` is the production package, not a developer convenience stack. The
writer, serving API, and monitor run from `packages/indexer/Dockerfile`; none installs dependencies
into or bind-mounts the checkout. Postgres and the operator state use explicitly named volumes.
Only the small tracked `deployments/` directory is mounted read-only so the operator can consume
the finalized manifest and policy.

Set the variables required by `ops/production-preflight.sh`, then run:

```bash
ops/production-preflight.sh
docker compose -f docker-compose.prod.yml build ponder ponder-server monitor
docker compose -f docker-compose.prod.yml up -d
```

`OPERATOR_IMAGE` must be the release workflow's complete
`ghcr.io/.../trustgraphs-operator@sha256:...` reference. The preflight rejects a tag. On startup,
the operator also refuses unless its embedded trust-graph and signer ELF digests and vkeys match
the tracked release manifest. The Sepolia candidate built from commit `22bbf4a` by
[release run 32892667547](https://github.com/AInima-Collective/trustgraphs/actions/runs/32892667547)
is:

```text
ghcr.io/ainima-collective/trustgraphs-operator@sha256:876aa9e9569e2de4366404a96b24ae4222e75763cbc692820bd9cdbfd15e0a40
```

That run reproduced the guest ELFs twice, published a linux/amd64 + linux/arm64 OCI index,
attested it, pulled it anonymously, and re-derived the embedded vkeys. The writer schema must be a
new versioned name for each indexer release; the views schema stays stable. The
primary Sepolia RPC and `PONDER_RPC_URLS_11155111` must name different providers so a single
provider outage does not stop ingestion. The frontend host must receive `PONDER_URL`,
`IPFS_GATEWAY_PUBLIC`, and both `RPC_URL_11155111_0` and `RPC_URL_11155111_1`; the two browser RPC
upstreams must also be independent. The preflight requires these frontend values even though the
frontend itself may be deployed by a separate hosting platform.

After the frontend is deployed, exercise its clean-browser, read-only launch surface before using
a funded wallet:

```bash
SEPOLIA_FRONTEND_URL=https://testnet.example.org \
  pnpm --filter trustgraphs-frontend smoke:sepolia
```

This checks the persistent testnet warning, offers the standard governed path, and refuses to
expose weighted or composition creation when their factories are absent. It does not submit a
transaction; M4 still requires the clean-wallet creation itself.

On a preview deployment where transport 0 is deliberately pointed at an unreachable endpoint,
the same smoke command can prove the browser actually continues through transport 1:

```bash
SEPOLIA_FRONTEND_URL=https://preview.testnet.example.org \
SEPOLIA_EXPECT_RPC_FAILOVER=true \
  pnpm --filter trustgraphs-frontend smoke:sepolia
```

The assertion requires a 5xx response from `id=0` followed by a 200 response from `id=1`; do not
use it during an ordinary healthy smoke run.

Back up Postgres from the consistent server-side snapshot emitted by `pg_dump`:

```bash
BACKUP_DIR=/durable/backups ops/postgres-backup.sh
```

The scripts default to the Compose database. For managed Postgres, provide the live connection URL
and PostgreSQL client tools of the same major version as the server:

```bash
DATABASE_URL="$DATABASE_URL" BACKUP_DIR=/durable/backups ops/postgres-backup.sh
```

Every dump receives a SHA-256 sidecar. A backup is not accepted until it has been restored into an
isolated database and found to contain application tables:

```bash
RESTORE_DATABASE=ponder_restore_20260825 \
  ops/postgres-restore-drill.sh /durable/backups/ponder-20260825T000000Z.dump
```

For managed Postgres, `RESTORE_DATABASE_URL` must point at that exact throwaway database. The
script connects and checks `current_database()` before restoring anything:

```bash
DATABASE_URL="$DATABASE_URL" \
RESTORE_DATABASE=ponder_restore_20260825 \
RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" \
  ops/postgres-restore-drill.sh /durable/backups/ponder-20260825T000000Z.dump
```

The restore script refuses production database names and refuses to replace an existing drill
database unless `REPLACE_RESTORE_DATABASE=1` is explicit. Record the dump path, checksum, restored
database, table count, and time in the deployment log.

The monitor checks the indexer and operator `/ready` routes, operator heartbeat age, root age,
publication holds, per-instance vault balances/unpaid roots, and Ponder lag against the live
Sepolia head. Defaults are in the compose file and every threshold has a `MONITOR_*` override. It
sends a webhook only when a finding becomes active and logs recovery when it clears.

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
