# Deploy to production (advanced)

> **No production deployment exists today** — the repo is set up for local testing, and the
> config that ships is the development template. When a real production network launches,
> create `config/networks.production.json` from
> [`config/networks.development.template.json`](../../config/networks.development.template.json)
> and follow this page.

### Deploy new network

Create `config/networks.production.json` (copy the development template) with the new
network's metadata set, but leave the contracts and schemas blank — they are filled in by
the deployment script.

Set the ZK deployment parameters in your environment (see `deploy/env.ts` and `.env.example`):

- `SP1_PROGRAM_VKEY` — the guest program verification key (`cargo run -p trustgraph-prover -- trust-graph vkey`)
- `SP1_SIGNER_PROGRAM_VKEY` / `SELECTION_PARAMS_HASH` — the signer-sync equivalents (see the
  [signer-sync runbook](./signer-sync/runbook.md))
- `SP1_VERIFIER_GATEWAY` — the canonical SP1 verifier gateway on the target chain

There is **no `PARAMS_HASH` env var**: `DeployNetwork` computes the params hash on-chain from
`params.json` (the same file the prover feeds the guest) right after it registers the schema —
see the note in `.env.example`.

Then deploy the contracts, which will deploy and fill in the missing values:

```bash
pnpm deploy:contracts
```

This deploys EAS + resolvers, the `SP1JournalVerifier`, `MerkleSnapshot` (with the accumulator and
the two-tier governance timelocks), the Zodiac `MerkleGovModule` Safe, and the reward distributor.

### Run the prover

The `{account → score}` root is produced by a permissionless SP1 proof — anyone can post `(root, proof)`
via `MerkleSnapshot.submitProof`. Real STARK → Groth16 proving needs ≥16–32 GiB of RAM or the Succinct
prover network (`SP1_PROVER=network`). See [`trust-graph/runbook.md`](./trust-graph/runbook.md) for the guest/host build
and the checkpoint → prove → submit flow.

In production that loop is not driven by hand. Deploy the **proof scheduler** and it keeps every
instance's scores fresh with nobody watching: [`run-a-prover.md`](./run-a-prover.md) is the whole
contract — what it does, how to configure it, what it alerts on, and how to recover it.

Three things to get right before the first tick:

1. **`registry_from_block`.** Set it to the `InstanceRegistry` deployment block. Left at 0 the
   daemon scans from genesis, which most providers reject outright as an archive request — the
   failure is not slowness, it is no catalog and every tick failing. Startup alerts if you forget.
2. **Two keys, separately funded.** `NETWORK_PRIVATE_KEY` (prover network requester) and
   `SUBMITTER_PRIVATE_KEY` (submit gas). They are split because the payee lives in the journal, so
   the submitting key holds no value and rotates freely.
3. **A real Groth16 proof, verified by the canonical gateway, before anything else.** This is the
   one thing the build could not exercise (11 GiB box, no network key — [`DEVIATIONS`](../../research/DEVIATIONS.md)
   #20). Every proof in CI wraps at a mock gateway. Prove one checkpoint for real, submit it, watch
   it land, and only then start the daemon.

### Run the indexer

The indexer has two production processes: a versioned writer and a stable read server. Set:

```bash
PONDER_RPC_URL_<chainId>=https://your-archive-capable-rpc   # note: the production profile in
                                        # indexer/ponder.config.ts is currently pinned to chain 10
                                        # (reads PONDER_RPC_URL_10); the go-forward production
                                        # chain is Ethereum mainnet (chain 1)
PONDER_START_BLOCK_<chainId>=<earliest configured contract deployment block>
PONDER_DATABASE_SCHEMA=trustgraph_v1   # change for every indexing-code release
PONDER_VIEWS_SCHEMA=trust-graph         # stable; the frontend reads this
DATABASE_URL=postgresql://...
IPFS_GATEWAY=https://.../ipfs/
```

Then run `docker compose -f docker-compose.prod.yml up -d`. The writer backfills into the versioned
schema and only publishes the stable views after it is ready. `ponder-server` waits for that
readiness signal and serves port 65421; a writer crash or restart does not take the last completed
read schema away.

Startup refuses three unsafe states before Ponder runs: the wrong chain id, deployment-summary
addresses with no code, or an RPC that cannot answer historical state at the start block. It also
records a finalized block hash in Postgres. A later production identity mismatch is never reset
automatically—verify the RPC/database and deploy to a new versioned schema. Use
`pnpm --dir indexer preflight` for the same checks without starting Ponder.

### Run the proving vault

Optional, and only if you intend to pay for roots or let communities pay for their own.
[`ProvingVault`](../../src/contracts/vault/ProvingVault.sol) is the tank a community tops up so
somebody keeps proving its scores; [`IProvingVault`](../../src/interfaces/vault/IProvingVault.sol)
documents why each piece is shaped the way it is. Deploy order and the settings that matter:

```
ProvingVault(registry, usdc, ethUsdFeed, feedMaxStaleness, minEthUsd, maxEthUsd, feeSetter, admin)
```

- **The price feed must be 8-decimal** — the constructor asserts it. An 18-decimal feed would
  underpay every prover by 1e10.
- **`minEthUsd` / `maxEthUsd` are a sanity band, not decoration.** `maxPerRootUsd` is denominated
  in oracle-USD and the ETH leg converts at the same oracle, so a low-but-fresh price caps nothing:
  at $1/ETH a $50 claim withdraws 50 ETH. An out-of-band answer is treated as no answer.
- **Price the bands before anyone creates an instance** (`setFeePerRootUsd(program, band, usd)`),
  or the first roots land and pay nothing. Band 0 is reserved for "we do not price this" and
  refuses to be set.
- **The factory's `vault` constructor argument** is what makes `createInstance` payable, so a
  community can deploy its network endowed with a year of roots in one transaction. Passing zero
  means "no prepay path", and sending value to such a factory reverts rather than being kept.

Communities then set their own limits with `setPolicy(instanceId, minPaidIntervalBlocks,
maxPerRootUsd)`. That is the only enforceable cadence: `EPOCH_FLOOR` binds at creation only, since
`setEpochLength` is constitutional and any creator can lower their own epoch afterwards.
