# Local Testing — EAS / trust-graph (+ signer-sync)

This guide covers the **lane-1 EAS path**: the trust-graph root producer and the Safe
signer-sync program. The **hypercerts program** (atproto records, envelope 1, the lane-2-only
instance) has its own guide: [`docs/hypercerts/LOCAL_TESTING.md`](./docs/hypercerts/LOCAL_TESTING.md).

Two ways to exercise it locally:

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

What it does (`test/e2e/run.sh`) — **four stages**, all on a throwaway anvil:

1. **Reconstruction + guest cross-check** — deploys `SchemaRegistry` + `EAS` + `EASIndexerResolver`
   + a `(string comment, uint256 confidence)` schema → attests a 3-account ring and revokes one
   (4 folds) → `checkpoint()` → `input-exporter` rebuilds both the `GuestInput` and the
   `SignerInput` from chain (each self-checks the re-fold against the on-chain `acc`) → the
   prover's `trust-graph execute` / `signer execute` assert `guest == native`.
2. **On-chain submit (both programs)** — proves with `SP1_PROVER=mock`, deploys the real
   `SP1JournalVerifier` + `MerkleSnapshot` behind a `MockSP1Gateway`, and lands `submitProof` /
   `submitSignerProof` (the Safe's owners actually rotate). Only the SNARK check itself is mocked;
   journal binding, vkey pinning, and the write paths are production code.
3. **Two-lane (journal v2)** — deploys `AnchorRegistry`, an attester builds + anchors a signed
   envelope-0 chained log, a second node anchors and **withholds** its data, `trigger()`
   checkpoints both lanes, and one proof lands lane-1 EAS edges + lane-2 offchain edges in a
   single journal — with the withheld head degraded via rule Φ and committed in `skippedDigest`.
4. **Hypercerts instance** — the fourth program end-to-end (see the
   [hypercerts guide](./docs/hypercerts/LOCAL_TESTING.md)).

Each stage prints its own `… PASS` line. Real Groth16 proving (≥16–32 GiB or the prover network)
and the UI are the full stack below. The first run builds the guest ELFs (minutes); after that
it's seconds. Set `E2E_ONCHAIN=0` to run only stage 1.

---

## Full stack with the frontend + indexer

This runs the **real** on-chain path locally by forking mainnet, so a genuine Groth16 proof verifies
against Succinct's real SP1 gateway — no testnet, no mock. You supply a fork RPC, the gateway address,
and a proving backend.

```bash
export FORK_RPC_URL=https://eth-mainnet.<your-provider>   # archive-capable mainnet RPC
export SP1_VERIFIER_GATEWAY=0x...                      # Succinct's SP1 gateway on mainnet (docs.succinct.xyz)
# proving backend — pick ONE:
export SP1_PROVER=network NETWORK_PRIVATE_KEY=0x...    # Succinct prover network (no big box), OR
export SP1_PROVER=cpu                                  # local: ~16-32 GiB + `--features native-gnark`
```

### 1. Chain + services

```bash
# Terminal 1 — mainnet-fork chain (real SP1 gateway in state):
# `--chain-id 31337` is REQUIRED for the frontend: a bare `--fork-url` inherits mainnet's id (1), but
# the UI's wallet + `frontend/lib/wagmi.ts` expect the anvil default 31337. Without it, CLI/cast attests
# still land (cast auto-detects the node id) but *frontend* attestations are signed for the wrong chain,
# never fold, and `trigger()` later reverts NoNewInputs(). The override keeps all forked state (the SP1
# gateway verifies pure calldata; direct EAS attest isn't chain-id-bound).
anvil --fork-url "$FORK_RPC_URL" --chain-id 31337 --port 8545

# Terminal 2 — IPFS (score blobs the UI fetches), Postgres (Ponder), WARG:
docker compose -f docker-compose.dev.yml up
```

(`task start-all-local` does the docker part + a *non-fork* anvil; its `taskfile/services.yml` has a
commented `--fork-url` toggle if you prefer a single command.)

### 2. Deploy the full stack

**Single pass — no `PARAMS_HASH`, no bootstrap.** `DeployNetwork` computes `paramsHash` on-chain from
`params.json` *after* it registers the schema, so a lone `pnpm deploy:full` deploys and binds everything.
`MerkleSnapshot` gets a verifier bound to the **root** guest's vkey and `SignerSyncZkModule` gets one
bound to the **signer** guest's vkey — both pointing at the real gateway.

**`params.json`** — the governance params, the same file the prover feeds the guest (serialized
`pagerank_core::Params`). Author it from the template; leave `schema_uid` as the placeholder — the deploy
fills it in:

```bash
cp test/e2e/params.template.json params.json    # tune seeds / pool / damping… to taste
```

**Deploy constants** (vkeys + the signer selection hash — all derived from source, no chain state):

```bash
cd zk/prover
export SP1_PROGRAM_VKEY=$(cargo run -q --release -- trust-graph vkey)
export SP1_SIGNER_PROGRAM_VKEY=$(cargo run -q --release -- signer vkey)
export SELECTION_PARAMS_HASH=$(cargo run -q --release -- signer selectionparamshash)   # no arg → default selection
cd ../..
```

**Deploy** (one command):

```bash
DEPLOY_ENV=DEV RPC_URL=http://127.0.0.1:8545 pnpm deploy:full
```

The Network step deploys the resolver, registers the schema, then computes
`paramsHash = ParamsCodec.hash(params.json, schemaUid)` — byte-identical to the guest's Rust
`params_hash` (locked by `test/unit/GoldenVectors.t.sol`) — and constructs `MerkleSnapshot` with it.
Override the params path with `PARAMS_JSON=/path/to/params.json` if it isn't at the repo root.

**Sync the prover's `schema_uid`.** The proof's params must carry the deployed schema UID. A DEV deploy
covers every network in `config/networks.development.json`, so copy network 0's UID into `params.json`:

```bash
jq --arg s "$(jq -r '.schemas.vouching.uid' config/network_deploy_dev_0.json)" \
  '.schema_uid=$s' params.json > tmp && mv tmp params.json
```

(A single-network **PROD** deploy skips even this — the script writes the UID straight back into
`params.json`.)

> **Why plain DEV works now.** DEV regenerates the deployer key each run, but that no longer matters:
> the schema UID is produced *and* consumed inside the same deploy, so nothing has to reproduce across
> runs. (Needing it to reproduce is exactly what used to force a pinned-deployer, two-pass,
> restart-the-fork dance.) Reach for `DEPLOY_ENV=PROD` when you want the production timelock/config
> wiring and a fixed `FUNDED_KEY` — see the note in [`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md).

Addresses are written to `.docker/deployment_summary.json` (Safe/module addresses to
`.docker/zodiac_safes_deploy.json`), and the frontend + indexer read them from there.

### 3. Indexer

The indexer needs no code changes — it already indexes `MerkleSnapshot:MerkleRootUpdated` (scores) and
the Gnosis Safe owner events (from `submitSignerProof`'s rotation). Point it at the local fork and DB:

```bash
# indexer/.env.local (see indexer/.env.example):
#   PONDER_RPC_URL_1=http://localhost:8545
#   DATABASE_URL=postgresql://ponder:ponder@localhost:6432/ponder
#   PONDER_START_BLOCK=<fork block + 1>   # REQUIRED on a fork — else Ponder backfills all pre-fork blocks
export PONDER_START_BLOCK=$(( $(cast rpc anvil_nodeInfo --rpc-url http://localhost:8545 | jq -r '.forkConfig.forkBlockNumber') + 1 ))
pnpm indexer dev        # Ponder at http://127.0.0.1:65421
```

On a mainnet-fork anvil the resolver/snapshot live just above the fork block, so their dev `startBlock`
defaults to `1` (genesis on a plain anvil) would backfill ~25M pre-fork blocks. `PONDER_START_BLOCK`
pins the backfill to the fork tip; contracts whose events only fire later (gov/fund/safe) use `'latest'`.

### 4. Frontend

```bash
pnpm frontend dev       # http://localhost:3000
```

`predev` regenerates the frontend config from `.docker/deployment_summary.json` (so run it **after** the
deploy) and points `apis.ponder` at `http://127.0.0.1:65421`.

### 5. Produce data the UI shows

Run the permissionless root loop (checkpoint → `input-exporter` → `execute` → `prove --groth16` → pin
blob → `submitProof`) so there's a scored root to display. The signer variant → `submitSignerProof` is
in [`docs/signer-sync/RUNBOOK.md`](./docs/signer-sync/RUNBOOK.md).

**Set the addresses** (from the deploy artifacts — the doc used to leave these unset):

```bash
export RPC=http://localhost:8545
export PK=$(grep '^FUNDED_KEY=' .env | cut -d= -f2)     # any funded key — trigger()/submitProof are permissionless
export MERKLE_SNAPSHOT=$(jq -r .contracts.merkle_snapshot config/network_deploy_dev_0.json)
export EAS_INDEXER_RESOLVER=$(jq -r .contracts.eas_indexer_resolver config/network_deploy_dev_0.json)
export EAS=$(jq -r .eas .docker/eas_deploy.json)
```

**Attest first** — `trigger()` over an empty graph checkpoints zero scores. Build a vouching ring from
anvil's prefunded accounts:

```bash
task trustgraph:create-network NET_INDEX=0 TEST_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
```

**The loop:**

```bash
# checkpoint the accumulator, then read the new checkpoint id (first = 0).
# `trigger()` on MerkleSnapshot just calls `accumulator.checkpoint()` (it IS the checkpoint step) and
# freezes the current `(acc, leafCount)` for a proof. It's permissionless and reverts with
# NoNewInputs() unless at least one new edge folded since the last checkpoint — so attest first, then
# trigger (see the NoNewInputs troubleshooting note below if it reverts).
cast send $MERKLE_SNAPSHOT "trigger()" --rpc-url $RPC --private-key $PK
export ID=$(( $(cast call $EAS_INDEXER_RESOLVER "checkpointCount()(uint256)" --rpc-url $RPC) - 1 ))

# reconstruct input.json from chain (writes ./input.json at the repo root).
# --from-block starts the getLogs scan just above the fork so anvil serves the (local) EdgeFolded logs
# itself instead of proxying pre-fork ranges to your RPC — required on rate-limited tiers (Alchemy free
# caps getLogs at a 10-block range). The exporter re-folds edges to the checkpoint acc, so a too-high
# value errors rather than emitting a bad input.json.
FORK_BLOCK=$(cast rpc anvil_nodeInfo --rpc-url $RPC | jq -r '.forkConfig.forkBlockNumber')
cargo run -p input-exporter -- --rpc $RPC \
  --accumulator $EAS_INDEXER_RESOLVER --eas $EAS --checkpoint $ID --params params.json \
  --from-block $(( FORK_BLOCK + 1 )) --out input.json

# execute (fast, no proof) to get the submitProof args — and blob.json
EXEC=$( ( cd zk/prover && cargo run -q --release -- trust-graph execute ../../input.json ) ); echo "$EXEC"
export OUTPUT_ROOT=$(echo "$EXEC" | awk '/outputRoot:/{print $2}')
export IPFS_HASH=$(  echo "$EXEC" | awk '/ipfsHash:/{print $2}')
export CID=$(        echo "$EXEC" | awk '/cid:/{print $2}')
export TOTAL_VALUE=$(echo "$EXEC" | awk '/totalValue:/{print $2}')

# prove — cpu Groth16 needs --features native-gnark + ~16-32 GiB RAM (drop it for SP1_PROVER=network)
( cd zk/prover && cargo run --release --features native-gnark -- trust-graph prove ../../input.json --groth16 )

# pin the score blob so the UI can fetch it (kubo HTTP API — no ipfs CLI needed)
curl -sF file=@zk/prover/blob.json "http://localhost:5001/api/v0/add?cid-version=1&raw-leaves=true"

# submit. The extra bytes32(0) is the journal-v2 `skippedDigest` — always zero on this
# lane-1-only path (no anchor registry wired ⇒ the guest asserts the empty lane).
# (no xxd? use: "0x$(od -An -v -tx1 zk/prover/proof.bin | tr -d ' \n')")
cast send $MERKLE_SNAPSHOT "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,bytes)" \
  $ID $OUTPUT_ROOT $IPFS_HASH $CID $TOTAL_VALUE 0x0000000000000000000000000000000000000000000000000000000000000000 "0x$(xxd -p zk/prover/proof.bin | tr -d '\n')" \
  --rpc-url $RPC --private-key $PK
```

`execute` and `prove` both write `zk/prover/blob.json` (the `{account → score}` blob whose sha256 is
`ipfsHash` and whose CID is `cid`); the `curl` pins it at that CID. `submitProof` verifies from the
journal, so it lands even if you skip the pin — but the frontend needs the blob pinned to show scores.

Once `submitProof` lands, Ponder indexes `MerkleRootUpdated` and the frontend shows the scores; after
`submitSignerProof`, the Safe's owner changes flow through the Safe indexer to the UI.

---

## Notes & troubleshooting

- **No fork RPC / no proving hardware?** Use the [quick check](#quick-check--task-e2e) — it validates
  reconstruction, guest correctness, AND the on-chain write paths (mock-gateway) without a fork,
  real proof, or gateway.
- **`execute`/`vkey` get OOM-killed on a small box?** You're on the `cpu` backend (the `.env`
  default). Prefix executor-only commands with `SP1_PROVER=mock` — identical executor + byte-assert,
  no ~5 GiB prover allocation. `taskfile/zk.yml` and `test/e2e/run.sh` already pin this.
- **Gateway version.** `SP1_VERIFIER_GATEWAY` must be a gateway that has the verifier for the SP1 SDK
  version this repo pins (v6.3.1); it routes by the proof's 4-byte selector.
- **Local Groth16** (`SP1_PROVER=cpu`) needs `--features native-gnark` and a gnark/Go toolchain; the
  network backend (`SP1_PROVER=network`) does not.
- **Frontend shows nothing?** It reads `.docker/deployment_summary.json` at `predev` — re-run
  `pnpm frontend dev` after (re)deploying so the config regenerates.
- **Indexer empty?** Confirm `PONDER_RPC_URL_1` points at the fork and `DATABASE_URL` at the running
  Postgres (or drop `DATABASE_URL` to use Ponder's built-in pglite).
- **`trigger()` reverts with `custom error 0x6eb09b42` (`NoNewInputs()`)?** That's the accumulator's
  anti-spam guard: `checkpoint()` requires **at least one new edge folded since the last checkpoint**
  (`leafCount` must strictly exceed the previous checkpoint's — the first checkpoint is the only one
  allowed to freeze an empty set). You hit it by triggering twice with no attestation in between, or
  when the attestations you made *didn't fold into this resolver*. Diagnose by comparing the live edge
  count to the last checkpoint's:

  ```bash
  # live folded-edge count on the resolver (== the accumulator)
  cast call $EAS_INDEXER_RESOLVER "leafCount()(uint64)" --rpc-url $RPC
  # leafCount frozen by the most recent checkpoint
  LAST=$(( $(cast call $EAS_INDEXER_RESOLVER "checkpointCount()(uint256)" --rpc-url $RPC) - 1 ))
  cast call $EAS_INDEXER_RESOLVER "getCheckpoint(uint256)((bytes32,uint64,uint64))" $LAST --rpc-url $RPC
  ```

  If `leafCount()` hasn't moved past the checkpoint's, your attestations never reached the accumulator.
  Two common causes:

  1. **Wrong network.** A DEV deploy stands up *every* network in `config/networks.development.json` —
     each with its **own** resolver + accumulator + `MerkleSnapshot` (see `config/network_deploy_dev_<N>.json`).
     `$EAS_INDEXER_RESOLVER` / `$MERKLE_SNAPSHOT` point at network 0 only; an attestation made on another
     network's page folds into *that* network's accumulator. Check each resolver's `leafCount()` to find
     where your edges landed, then trigger that network's snapshot.
  2. **chainId mismatch (frontend attests don't fold).** If you ran `anvil --fork-url …` *without*
     `--chain-id 31337`, the node is chainId 1 but the UI/wallet sign for 31337 — CLI/cast attests land
     (cast auto-detects the id) yet frontend attests never execute, so `leafCount` never moves. Fix:
     restart with `--chain-id 31337` (see step 1) and redeploy.

  Only attestations against the **wired vouching schema** (the `schema_uid` whose resolver is that
  network's `EASIndexerResolver`) fold. Re-attest (e.g. `task trustgraph:create-network` or the UI's
  *Create Attestation*), confirm `leafCount()` bumped, then `trigger()` again. There's no separate
  "checkpoint the accumulator" call — `trigger()` **is** it (it just calls `accumulator.checkpoint()`);
  you can also call `checkpoint()` directly on the resolver for the same effect.

See [`README.md`](./README.md), [`docs/PROGRAMS.md`](./docs/PROGRAMS.md) (the program index),
[`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md), and
[`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md) for the design and the full
command reference. Hypercerts local testing: [`docs/hypercerts/LOCAL_TESTING.md`](./docs/hypercerts/LOCAL_TESTING.md).
