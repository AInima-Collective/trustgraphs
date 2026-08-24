# Run trustgraphs locally

This walkthrough starts a local chain, storage, database, contracts, proof flow, indexer, and
frontend. Begin in a local checkout of the Trustgraphs repository.

## Install and build

Complete [repository setup](./setup.md), then build the SP1 guest programs:

```bash
task setup
task zk:build
```

The guest build may take several minutes the first time. Rebuild it after changing consensus code
under `crates/` or a guest program under `zk/`.

## Start the local infrastructure

Run Anvil in one terminal:

```bash
anvil --block-time 1
```

Start IPFS and Postgres in another:

```bash
task start-all-local
```

## Deploy and prove the demo

From the repository root:

```bash
task demo
```

The demo replaces the local deployment summary, deploys the contracts, creates and seeds the demo
instances, produces their initial proofs, publishes output files to local IPFS, and submits the
roots. It finishes after the results are accepted onchain; it does not require the indexer to have
ingested them.

Run this step before starting the indexer. The indexer reads the deployment summary at startup, so
an indexer left running across a fresh deployment can continue watching stale contract addresses.

## Start the application

After deployment, start the indexer and frontend in separate terminals:

```bash
pnpm indexer start
pnpm frontend dev
```

The frontend is available at `http://localhost:3000`; the indexer API is available at
`http://localhost:65421`. Give the indexer time to ingest the deployment, then open Networks and
select the demo network. You should see its members, accepted checkpoints, governance features,
and attached contribution round.

If you run `task demo` again, restart the indexer afterwards so it loads the new deployment
summary.

## Keep the prover running

`task demo` finishes after the seeded walkthrough. To deploy the same stack and keep the operator
watching for later checkpoints, run:

```bash
task demo:live
```

Start or restart the indexer after that deployment begins. If the demo is already deployed and the
indexer is watching the correct addresses, use `task demo:operator` instead.

## Verify the environment

Run the contract and end-to-end suites when changing the stack:

```bash
task test
task e2e
```

For operator policy, publication, and recovery behavior, see [Run a prover](./run-a-prover.md).
