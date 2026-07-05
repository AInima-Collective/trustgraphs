# Local Testing

Two ways to exercise TrustGraph locally:

- **[Quick check — `task e2e`](#quick-check--task-e2e)** — one command, no UI, no proving. Deploys
  EAS + the resolver on a throwaway anvil, attests, checkpoints, reconstructs `input.json` from chain,
  and cross-checks the SP1 guest against native. Best for verifying a change end-to-end fast.
- **[Full stack with the frontend + indexer](#full-stack-with-the-frontend--indexer)** — a
  **mainnet-fork** anvil (so Succinct's real SP1 verifier gateway is in state), the full contract set,
  real proofs, `submitProof` / `submitSignerProof`, and the UI + Ponder indexer showing the results.

Ports/services used by the full stack:

| Service | URL | Started by |
|---|---|---|
| anvil (fork) | http://localhost:8545 | `anvil --fork-url …` |
| Ponder indexer | http://127.0.0.1:65421 | `pnpm indexer dev` |
| frontend | http://localhost:3000 | `pnpm frontend dev` |
| IPFS (score blobs) | http://localhost:5001 (api) | `docker compose -f docker-compose.dev.yml up` |
| Postgres (Ponder) | localhost:6432 | `docker compose -f docker-compose.dev.yml up` |

Prereqs (one-time): [Foundry](https://getfoundry.sh) (`anvil`/`forge`/`cast`), Rust (`cargo`), `jq`,
Docker, and the SP1 toolchain (`curl -L https://sp1.succinct.xyz | bash && sp1up`). Then `task -y setup`.

---

## Quick check — `task e2e`

```bash
task e2e            # or: bash test/e2e/run.sh
```

What it does (`test/e2e/run.sh`): starts its own anvil → deploys `SchemaRegistry` + `EAS` +
`EASIndexerResolver` + a `(string comment, uint256 confidence)` schema → attests a 3-account ring and
revokes one (4 folds) → `checkpoint()` → runs `input-exporter` for both the `GuestInput` and the
`SignerInput` (each self-checks that the reconstructed edges re-fold to the on-chain `acc`) → runs the
prover's `execute` / `signer-execute` and asserts `guest == native`. Prints `E2E PASS`.

It **stops before real Groth16 proving** (which needs ≥16–32 GiB or the prover network) and doesn't
touch the UI — that's the full stack below. The first run builds the guest ELF (a few minutes); after
that it's seconds.

---

## Full stack with the frontend + indexer

This runs the **real** on-chain path locally by forking mainnet, so a genuine Groth16 proof verifies
against Succinct's real SP1 gateway — no testnet, no mock. You supply a fork RPC, the gateway address,
and a proving backend.

```bash
export FORK_RPC=https://eth-mainnet.<your-provider>   # archive-capable mainnet RPC
export SP1_VERIFIER_GATEWAY=0x...                      # Succinct's SP1 gateway on mainnet (docs.succinct.xyz)
# proving backend — pick ONE:
export SP1_PROVER=network NETWORK_PRIVATE_KEY=0x...    # Succinct prover network (no big box), OR
export SP1_PROVER=cpu                                  # local: ~16-32 GiB + `--features native-gnark`
```

### 1. Chain + services

```bash
# Terminal 1 — mainnet-fork chain (real SP1 gateway in state):
anvil --fork-url "$FORK_RPC" --port 8545

# Terminal 2 — IPFS (score blobs the UI fetches), Postgres (Ponder), WARG:
docker compose -f docker-compose.dev.yml up
```

(`task start-all-local` does the docker part + a *non-fork* anvil; its `taskfile/services.yml` has a
commented `--fork-url` toggle if you prefer a single command.)

### 2. Deploy the full stack

Compute the deploy constants and deploy. `MerkleSnapshot` gets a verifier bound to the **root** guest's
vkey and `SignerSyncZkModule` gets one bound to the **signer** guest's vkey — both pointing at the real
gateway.

```bash
cd zk/prover
export SP1_PROGRAM_VKEY=$(cargo run -q --release -- vkey)
export SP1_SIGNER_PROGRAM_VKEY=$(cargo run -q --release -- signer-vkey)
export SELECTION_PARAMS_HASH=$(cargo run -q --release -- signer-selectionparamshash)   # default selection
export PARAMS_HASH=$(cargo run -q --release -- paramshash params.json)                 # see the note below
cd ../..

DEPLOY_ENV=DEV RPC_URL=http://127.0.0.1:8545 pnpm deploy:full
```

> **`PARAMS_HASH` ⇄ schema bootstrapping.** `PARAMS_HASH` binds `params.schema_uid`, but the schema is
> registered *during* the deploy, so a fresh deployment is two-phase: deploy EAS + the resolver + the
> schema first, read the schema uid, set `params.schema_uid` to it, compute `PARAMS_HASH`, then deploy
> the rest. See [`zk/RUNBOOK.md`](./zk/RUNBOOK.md) → "Real end-to-end on a mainnet fork". Once the
> schema uid is a fixed governance constant you skip phase one.

Addresses are written to `.docker/deployment_summary.json` (Safe/module addresses to
`.docker/zodiac_safes_deploy.json`), and the frontend + indexer read them from there.

### 3. Indexer

The indexer needs no code changes — it already indexes `MerkleSnapshot:MerkleRootUpdated` (scores) and
the Gnosis Safe owner events (from `submitSignerProof`'s rotation). Point it at the local fork and DB:

```bash
# indexer/.env.local (see indexer/.env.example):
#   PONDER_RPC_URL_1=http://localhost:8545
#   DATABASE_URL=postgresql://ponder:ponder@localhost:6432/ponder
pnpm indexer dev        # Ponder at http://127.0.0.1:65421
```

### 4. Frontend

```bash
pnpm frontend dev       # http://localhost:3000
```

`predev` regenerates the frontend config from `.docker/deployment_summary.json` (so run it **after** the
deploy) and points `apis.ponder` at `http://127.0.0.1:65421`.

### 5. Produce data the UI shows

Run the two permissionless loops so there's a scored root + a rotated Safe to display. The exact
commands (checkpoint → `input-exporter` → `prove --groth16` → pin blob → `submitProof`; and the signer
variant → `submitSignerProof`) are in [README §8–9](./README.md#8-produce-a-score-root-the-permissionless-zk-loop)
and [`zk/RUNBOOK.md`](./zk/RUNBOOK.md). In short:

```bash
cast send $MERKLE_SNAPSHOT "trigger()" --rpc-url http://localhost:8545 --private-key $PK
cargo run -p input-exporter -- --rpc http://localhost:8545 \
  --accumulator $EAS_INDEXER_RESOLVER --eas $EAS --checkpoint $ID --params params.json --out input.json
( cd zk/prover && cargo run --release -- prove input.json --groth16 )   # +--features native-gnark for SP1_PROVER=cpu
ipfs add --cid-version=1 --raw-leaves blob.json
cast send $MERKLE_SNAPSHOT "submitProof(uint256,bytes32,bytes32,string,uint256,bytes)" \
  $ID $OUTPUT_ROOT $IPFS_HASH $CID $TOTAL_VALUE $(xxd -p -c0 zk/prover/proof.bin) --rpc-url http://localhost:8545 --private-key $PK
```

`$MERKLE_SNAPSHOT` / `$EAS_INDEXER_RESOLVER` / `$EAS` come from `.docker/deployment_summary.json`
(helpers: `task config:merkle-snapshot-address`, etc.). `$OUTPUT_ROOT` / `$IPFS_HASH` / `$CID` /
`$TOTAL_VALUE` are printed by `cargo run -p trustgraph-prover -- execute input.json`.

Once `submitProof` lands, Ponder indexes `MerkleRootUpdated` and the frontend shows the scores; after
`submitSignerProof`, the Safe's owner changes flow through the Safe indexer to the UI.

---

## Notes & troubleshooting

- **No fork RPC / no proving hardware?** Use the [quick check](#quick-check--task-e2e) — it validates
  the reconstruction + guest correctness without a chain, proof, or gateway.
- **Gateway version.** `SP1_VERIFIER_GATEWAY` must be a gateway that has the verifier for the SP1 SDK
  version this repo pins (v6.3.1); it routes by the proof's 4-byte selector.
- **Local Groth16** (`SP1_PROVER=cpu`) needs `--features native-gnark` and a gnark/Go toolchain; the
  network backend (`SP1_PROVER=network`) does not.
- **Frontend shows nothing?** It reads `.docker/deployment_summary.json` at `predev` — re-run
  `pnpm frontend dev` after (re)deploying so the config regenerates.
- **Indexer empty?** Confirm `PONDER_RPC_URL_1` points at the fork and `DATABASE_URL` at the running
  Postgres (or drop `DATABASE_URL` to use Ponder's built-in pglite).

See [`README.md`](./README.md), [`zk/RUNBOOK.md`](./zk/RUNBOOK.md), and
[`ZK_ARCHITECTURE.md`](./ZK_ARCHITECTURE.md) for the design and the full command reference.
