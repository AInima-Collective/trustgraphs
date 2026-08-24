# Run trustgraphs locally

This walkthrough starts a local chain, storage, database, indexer, frontend, and proving flow.

## Install and build

Complete [repository setup](./setup.md), then build the SP1 guest programs:

```bash
task setup
task zk:build
```

The guest build may take several minutes the first time. Rebuild it after changing consensus code
under `crates/` or a guest program under `zk/`.

## Start local services

Run Anvil in one terminal:

```bash
anvil --block-time 1
```

Start IPFS and Postgres in another:

```bash
task start-all-local
```

Then start the indexer and frontend in separate terminals:

```bash
pnpm indexer start
pnpm frontend dev
```

The frontend is available at `http://localhost:3000`; the indexer API is available at
`http://localhost:65421`.

## Deploy and prove the demo

From the repository root:

```bash
task demo
```

The demo deploys the local contracts, creates and seeds a network, produces its initial proofs,
publishes the score files to local IPFS, submits the roots, and waits for the indexer to observe
them.

Open the Networks page in the frontend and select the demo network. You should see its members,
accepted score checkpoint, governance features, and any attached contribution round.

## Keep the prover running

`task demo` finishes after the seeded walkthrough. To deploy the same stack and keep the operator
watching for later checkpoints, run:

```bash
task demo:live
```

If the demo is already deployed, use `task demo:operator` instead.

## Verify the environment

Run the contract and end-to-end suites when changing the stack:

```bash
task test
task e2e
```

For operator configuration and recovery behavior, see [Run a prover](./run-a-prover.md).
