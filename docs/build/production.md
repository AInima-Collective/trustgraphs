# Deploy to production

A production trustgraphs deployment combines immutable proving contracts with services that must
remain available over time. Treat the deployment as a security-sensitive release, not a copy of
the local demo.

## Before deployment

- Pin the source commit, Foundry dependencies, Rust toolchain, and SP1 version.
- Run the Solidity, Rust, frontend, indexer, golden-vector, and end-to-end suites.
- Produce a real proof with the intended backend and verify it through the target chain's SP1
  gateway.
- Review every admin, Safe, timelock, guardian, registrar, and operator role.
- Decide which programs and optional modules the release will support.

Do not deploy a verifier with a key derived from a different guest build.

## Deploy the contracts

Set the target chain, canonical external dependencies, program verification keys, and governance
addresses in the deployment environment. The repository deployment pipeline is:

```bash
DEPLOY_STAGE=production DEPLOY_TARGET=<network> pnpm deploy:contracts
```

Inspect every simulated call and deployment receipt. Record the contract addresses, deployment
blocks, source commit, verification keys, and transaction hashes in a chain-specific deployment
manifest.

After deployment, transfer temporary bootstrap roles to their final Safe or timelock and verify
the resulting role graph from the chain. A deployment is not complete while an unintended
deployer key retains authority.

## Operate the services

Production service requirements include:

- finalized and failover RPC endpoints;
- a durable Postgres database for the indexer;
- at least two independent score-file publication targets;
- a prover with persistent journal storage, budgets, finality checks, and alert delivery; and
- monitoring for stale checkpoints, held proofs, publication failures, root mismatches, and low
  proving-vault balances.

Set the operator's registry start block to the actual registry deployment block. Test restoration
of the database, prover journal, weighted manifests, and published score files before relying on
the deployment.

## Release verification

Before announcing a network:

1. Create a small governed instance through the same public factory users will call.
2. Submit representative inputs and freeze a checkpoint.
3. Produce, publish, and submit a real proof.
4. Confirm the indexer independently derives the accepted root.
5. Fetch an account proof through the public API and verify it against the chain.
6. Exercise one governed settings change and the emergency pause path.

Publish the final addresses and verification keys through the tracked deployment manifest. See
[Addresses and vkeys](../verify/addresses-and-vkeys.md) and [Run a prover](./run-a-prover.md).
