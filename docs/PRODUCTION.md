# Production

> **No production deployment exists today** — the repo is set up for local testing, and the
> config that ships is the development template. When a real production network launches,
> create `config/networks.production.json` from
> [`../config/networks.development.template.json`](../config/networks.development.template.json)
> and follow this page.

### Deploy new network

Create `config/networks.production.json` (copy the development template) with the new
network's metadata set, but leave the contracts and schemas blank — they are filled in by
the deployment script.

Set the ZK deployment parameters in your environment (see `deploy/env.ts` and `.env.example`):

- `SP1_PROGRAM_VKEY` — the guest program verification key (`cargo run -p trustgraph-prover -- trust-graph vkey`)
- `SP1_SIGNER_PROGRAM_VKEY` / `SELECTION_PARAMS_HASH` — the signer-sync equivalents (see the
  [signer-sync runbook](./signer-sync/RUNBOOK.md))
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
prover network (`SP1_PROVER=network`). See [`docs/trust-graph/RUNBOOK.md`](./trust-graph/RUNBOOK.md) for the guest/host build
and the checkpoint → prove → submit flow.
