# Deploy to a public chain

A public Trustgraphs deployment combines contracts whose program identity must remain stable with
indexing, proving, and publication services that must remain available. Treat it as a
security-sensitive release, not a copy of the local demo.

## Supported deployment profiles

The repository currently exposes two production-stage targets with different contract sets:

| Target | Current profile |
| --- | --- |
| `sepolia` | Modern registry, standard `trust-graph` verifier and base factory, plus an optional proving vault. It does not deploy the governed wrapper, weighted prior, composition, contributions, or signer sync. |
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
