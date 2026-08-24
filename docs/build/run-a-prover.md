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
rpc = "https://rpc.example"
registry = "0x..."
chain_id = 10
registry_from_block = 123456789

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
```

Capability limits, gas policy, finality, budgets, weighted-manifest recovery, and alert delivery
should also be configured before production use.

The daemon refuses to start rather than write its journal somewhere it will not survive. It
creates `state_dir`, but not the tree above it: an absolute path whose parent is missing is what
an unmounted volume looks like, and a journal on a container's own filesystem is gone at the next
deploy — after which the operator re-requests, and re-pays for, proofs it already has.

## Run it

```bash
docker volume create operator-state
docker run -d --name operator \
  -v operator-state:/data \
  -v "$PWD/operator.toml:/etc/trustgraph/operator.toml:ro" \
  -e SUBMITTER_PRIVATE_KEY -e NETWORK_PRIVATE_KEY \
  -p 8080:8080 \
  ghcr.io/jakehartnell/trustgraphs-operator:latest
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

Every release publishes the guest table its image was built from — each program's ELF sha256 and
verification key against a public source commit — so a deployed verifier's pinned vkey can be
checked against source without trusting whoever deployed it.

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
instance enters a held state. The append-only journal records proof intents and outcomes, submission gas and
failures, publication attempts, and composition-availability retries. Weighted-manifest recovery
uses its separate cache and metrics. Back up all persistent operator state; losing the request
journal can duplicate paid work.

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
