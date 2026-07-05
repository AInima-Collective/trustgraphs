## Production

### Deploy new network

Add a new network to `config/networks.production.json` with all the correct metadata set, but leave the contracts and schemas blank as they will be filled in by the deployment script.

Set the ZK deployment parameters in your environment (see `deploy/env.ts`):

- `PARAMS_HASH` — the governance-pinned PageRank parameter hash
- `SP1_PROGRAM_VKEY` — the guest program verification key (`cargo run -p trustgraph-prover -- vkey`)
- `SP1_VERIFIER_GATEWAY` — the canonical SP1 verifier gateway on the target chain

Then deploy the contracts, which will deploy and fill in the missing values:

```bash
pnpm deploy:contracts
```

This deploys EAS + resolvers, the `SP1TrustGraphVerifier`, `MerkleSnapshot` (with the accumulator and
the two-tier governance timelocks), the Zodiac `MerkleGovModule` Safe, and the reward distributor.

### Run the prover

The `{account → score}` root is produced by a permissionless SP1 proof — anyone can post `(root, proof)`
via `MerkleSnapshot.submitProof`. Real STARK → Groth16 proving needs ≥16–32 GiB of RAM or the Succinct
prover network (`SP1_PROVER=network`). See [`zk/RUNBOOK.md`](./zk/RUNBOOK.md) for the guest/host build
and the checkpoint → prove → submit flow.
