# Run a prover

The operator keeps network scores current. It discovers registered instances, freezes eligible
checkpoints, reconstructs their inputs, requests proofs, publishes score files, and submits valid
results.

Running a prover is optional for network members. It is useful for network operators who want
independent availability or who plan to collect funded proving bounties.

## Proving models

- **Self-funded:** you pay proving and transaction costs for selected networks.
- **Curated:** you explicitly subsidize selected instance IDs.
- **Vault-funded:** the operator proves only when the instance's vault covers its quote.

Configure these policies deliberately. A permissionless network factory does not imply an
unlimited free proving service.

## Requirements

An operator needs:

- an RPC endpoint and the canonical `InstanceRegistry` address;
- the registry deployment block, so discovery does not scan from genesis;
- a supported SP1 proving backend;
- a separately funded transaction signer;
- durable IPFS-compatible publication targets and gateways; and
- persistent storage for the request journal and status heartbeat.

Real network proving also requires `NETWORK_PRIVATE_KEY`. Submission uses
`SUBMITTER_PRIVATE_KEY`; keep the two credentials separate.

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
journal_path = "./operator/journal.jsonl"
status_path = "./operator/status.json"
```

Capability limits, gas policy, finality, budgets, weighted-manifest recovery, and alert delivery
should also be configured before production use.

## Run it

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

## Monitor and recover

The status file is the current heartbeat. Alert if its tick time stops advancing or an instance
enters a held state. The append-only journal records proof requests, submissions, settlements, and
recovery decisions; back it up because losing it can duplicate paid work.

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
