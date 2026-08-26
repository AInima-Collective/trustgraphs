# Run a prover

The operator keeps network scores current. It discovers registered instances, freezes eligible
checkpoints, reconstructs their inputs, requests proofs, publishes score files, and submits valid
results.

Running a prover is optional for network members. It is useful for network operators who want
independent availability or who plan to collect funded proving bounties.

## Proving policy

- **Operator-funded:** with `[paid]` disabled, the operator subsidizes every supported instance it
  discovers, subject to its capability, gas, cadence, and loss-budget limits. This is not an
  allowlist mode.
- **Curated subsidy:** with `[paid]` enabled, instance IDs under `[curated]` are still paid by the
  operator. Signer-sync work is treated as curated as well.
- **Vault-funded:** with `[paid]` enabled, other supported instances must have an eligible proving
  vault quote before the operator spends money on them.

Configure these policies deliberately. A permissionless network factory does not imply an
unlimited free proving service.

## Requirements

An operator needs:

- an RPC endpoint and the canonical `InstanceRegistry` address;
- the registry deployment block, so discovery does not scan from genesis;
- a supported SP1 proving backend;
- a separately funded transaction signer;
- durable IPFS-compatible publication targets and gateways; and
- a persistent volume for the state directory.

An active non-dry run requires `SUBMITTER_PRIVATE_KEY` for checkpoint and submission transactions.
The Succinct network backend (`prover.backend = "network"`) also requires
`NETWORK_PRIVATE_KEY`; the local CPU backend does not. Keep proving-service and transaction
credentials separate.

It does not need a Rust toolchain, a source checkout, or a GitHub account. The published image
carries the daemon and the binaries it shells out to, and it is anonymously pullable.

## Minimal configuration

```toml
rpc = "https://sepolia-rpc.example"
registry = "0x4369ad64D4E378BEc45eE1081394cCD8A0052904"
chain_id = 11155111
registry_from_block = 11565416
# Every helper RPC call has its own deadline; it is never allowed to wait forever.
rpc_timeout_seconds = 30

[curated]
instances = []

[paid]
enabled = true
vault = "0x..."
recipient = "0x..."

[prover]
backend = "network"
groth16 = true

[ipfs]
min_success = 2

[[ipfs.targets]]
name = "primary"
kind = "kubo"
api = "https://ipfs-api.example"
gateway = "https://ipfs.example/ipfs/"

[[ipfs.targets]]
name = "backup"
api = "https://backup-api.example"
gateway = "https://backup.example/ipfs/"

[ops]
# One directory holds everything the daemon owns: the request journal, the heartbeat, the
# per-checkpoint working files, and both recovery caches. Mount a volume here. Relative paths in
# this file resolve against the file, never against the working directory the daemon started in.
state_dir = "/data"
# Read-only health and heartbeat listener. Three GET routes, no control plane.
listen = "0.0.0.0:8080"
# Absolute wall-clock deadline for input reconstruction and other helper processes.
tool_timeout_seconds = 900
```

Capability limits, gas policy, finality, budgets, weighted-manifest recovery, and alert delivery
should also be configured before production use.

Tracked production profiles may keep endpoint credentials outside TOML by using an `env:NAME`
reference for `rpc`, a target's `api` or `gateway`, and `ops.alert_webhook`. The operator resolves
those references at startup and fails if a variable is absent or empty. Private keys are never
config fields: supply `SUBMITTER_PRIVATE_KEY` and `NETWORK_PRIVATE_KEY` separately.

Pinata uses a typed target rather than pretending its v3 upload API is Kubo:

```toml
[[ipfs.targets]]
name = "pinata"
kind = "pinata"
api = "https://uploads.pinata.cloud/v3/files"
gateway = "env:IPFS_GATEWAY"
token_env = "IPFS_PIN_API_KEY"
```

The token variable must contain a Pinata bearer JWT. The daemon sends `network=public`, requires
Pinata's returned CID to equal the guest's CIDv1 raw commitment, and then reads the exact bytes
back through the configured gateway. Canonical score blobs larger than 256 KiB are refused before
proving because a chunked DAG would have a different CID. Kubo targets remain the default when
`kind` is omitted.

The tracked Sepolia policy is `deployments/operator.sepolia.toml`. It intentionally requires the
release manifest to contain exactly one curated showcase instance, uses one real Pinata target
instead of counting aliases as independent durability, and pages at 80% of each rolling global
budget before the hard cap stops new work.

Give that volume a name. `journal.jsonl` is the one file whose loss costs money: a fresh journal
re-requests, and re-pays for, proofs the operator already has. The image declares `/data` a
volume, so the journal never lands on the container's own writable layer. But the volume you get
by not naming one is anonymous, and an anonymous volume is orphaned the moment the container is
replaced rather than restarted, which is what a deploy does.

The daemon has a guard of its own, and it is worth knowing what it covers. When a config names a
`state_dir`, the daemon creates that directory but not the tree above it, so
`state_dir = "/mnt/operator/state"` refuses to start while `/mnt/operator` is missing: that is
what an unmounted volume looks like from inside. `state_dir = "/data"` cannot trip the same check,
because its parent is `/` and `/` always exists. For the layout above, the named volume is the
protection, not the guard.

## Run it

```bash
docker volume create operator-state
docker run -d --name operator \
  -v operator-state:/data \
  -v "$PWD/operator.toml:/etc/trustgraph/operator.toml:ro" \
  -e SUBMITTER_PRIVATE_KEY -e NETWORK_PRIVATE_KEY \
  -p 8080:8080 \
  ghcr.io/ainima-collective/trustgraphs-operator:latest
```

From a source checkout, the same daemon with the same config:

```bash
# Read the chain and print decisions without sending transactions.
cargo run --release --manifest-path zk/operator/Cargo.toml -- \
  --config ./operator.toml --once --dry-run

# Run one active pass.
cargo run --release --manifest-path zk/operator/Cargo.toml -- \
  --config ./operator.toml --once

# Run continuously.
cargo run --release --manifest-path zk/operator/Cargo.toml -- \
  --config ./operator.toml
```

Start with `--dry-run` after every configuration change.

An active run refuses to start unless `[ipfs]` has at least one target and `min_success` is at
least one. Targetless operation is available only with `--dry-run`: the operator will not submit
an onchain CID that it did not first publish and read back successfully.

Every release publishes the guest table its image was built from — each program's ELF sha256 and
verification key against a public source commit — so a deployed verifier's pinned vkey can be
checked against source without trusting whoever deployed it. When `release_manifest` is set, the
operator enforces this at startup for both the trust-graph and signer guests: either a vkey or ELF
digest mismatch stops the process before its first chain scan or proof request.

## Monitor and recover

With `[ops] listen` set, three read-only routes answer from outside the box:

- `/health` — the process is up.
- `/ready` — it is doing its job, or is legitimately busy doing it. Proving, publishing, and
  watching for a transaction receipt are each judged against their own limit rather than the tick
  cadence, so a proof in progress does not read as a wedge. The body says which phase and for how
  long. A daemon that has never completed a pass is never ready, so a container healthcheck needs
  a start period long enough to cover a first tick that proves.
- `/status` — the sanitized heartbeat, which is what `OPERATOR_STATUS_URL` in the app reads.

The status file is the same heartbeat on disk. Alert if its tick time stops advancing or an
instance enters a held state. The append-only journal records proof intents and outcomes,
submission gas, pending finality watches and reorgs, failures, publication attempts, and
composition-availability retries. Weighted-manifest recovery uses its separate cache and metrics.
Back up all persistent operator state; losing the request journal can duplicate paid work.

Score publication is part of success. A valid onchain root without an available score file cannot
render member scores. The operator therefore reads published bytes back from the configured
gateways before submission.

To restore a missing score file for an accepted checkpoint:

```bash
cargo run --release --manifest-path zk/operator/Cargo.toml -- \
  --config ./operator.toml republish \
  --instance 0xINSTANCE_ID --checkpoint CHECKPOINT_ID
```

The command reconstructs and checks the historical output before publishing it again.

Back up `journal.jsonl`. Restoring it onto a fresh machine is a tested path: the daemon re-attaches
to what the journal says was already paid for instead of requesting it again.
