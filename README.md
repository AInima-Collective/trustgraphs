# TrustGraph

Some next-gen attestation-based governance tools.

**Status:** HIGHLY EXPERIMENTAL! Please experiment with us.

Governance weight comes from **Trust-Aware PageRank** over [EAS](https://attest.org) attestations.
Everything that used to run on a WAVS operator set is now produced by **permissionless SP1
zero-knowledge proofs** — anyone who can generate a valid proof can post it, no quorum:

- The `{account → score}` merkle root is proven and committed via `MerkleSnapshot.submitProof`.
- The Safe multisig's owner set (the top-scored accounts) is proven and rotated via
  `SignerSyncZkModule.submitSignerProof`.

The canonical algorithm + every on-chain byte encoding live in `packages/pagerank-core` (the single
source of truth), compiled to the SP1 guests in `zk/program`, driven by the host in `zk/prover`, and
ported to the browser in `frontend/lib/pagerank`. See [`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md),
the per-program runbooks under [`docs/`](./docs/), and [`research/SIGNER_SYNC_ZK_PLAN.md`](./research/SIGNER_SYNC_ZK_PLAN.md).

## Programs

TrustGraph is a **platform of ZK-proven graphs**. Each SP1 program has its own guest bin, journal,
verification key, and golden vectors; [`docs/PROGRAMS.md`](./docs/PROGRAMS.md) is the full index.

| Program | Status | Docs |
|---|---|---|
| **trust-graph** — the `{account → score}` root producer | Live | [architecture](./docs/trust-graph/ARCHITECTURE.md) · [runbook](./docs/trust-graph/RUNBOOK.md) |
| **signer-sync** — proven Safe owner-set rotation | Built | [architecture](./docs/signer-sync/ARCHITECTURE.md) · [runbook](./docs/signer-sync/RUNBOOK.md) |
| **hypercerts** — trust graph over AT-Protocol records | Planned | [architecture](./docs/hypercerts/ARCHITECTURE.md) |

## Try it in 30 seconds

See the whole loop run end-to-end on a throwaway local chain — no config, no running node:

```bash
task e2e
```

It spins up its own anvil, deploys EAS + the resolver, creates attestations, freezes a checkpoint,
reconstructs the prover's `input.json` from chain with `input-exporter` (self-checking that it
re-folds to the on-chain `acc`), and cross-checks the SP1 guest against native — printing `E2E PASS`.

Needs [Foundry](https://getfoundry.sh) (`anvil`/`forge`/`cast`), Rust (`cargo`), `jq`, and the SP1
toolchain (`curl -L https://sp1.succinct.xyz | bash && sp1up`). The first run builds the guest ELF, so
give it a few minutes; after that it's seconds. It stops before real Groth16 proving (which needs
≥16–32 GiB or the prover network) — the full loop, step by step, is in [Usage](#usage) §8–9.

To run the **full stack locally with the frontend + indexer** (a mainnet-fork anvil, real proofs, and
the UI showing the results), see [`LOCAL_TESTING.md`](./LOCAL_TESTING.md).

> **Note on proving.** Running the guest in the SP1 *executor* (to validate correctness) works
> anywhere. Generating a real STARK→Groth16 *proof* needs ≥16–32 GiB of RAM or the Succinct prover
> network (`SP1_PROVER=network`). For a local dev loop you can validate with `execute` and, if you
> lack the hardware, use the network for the final `prove`. See [`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md).

## Usage

### 1. System setup

Follow [README_SETUP.md](./README_SETUP.md) for system tools, then install the SP1 toolchain and
project dependencies:

```bash
# SP1 (cargo-prove + the `succinct` Rust toolchain, pinned to v6.3.1)
curl -L https://sp1.succinct.xyz | bash && ~/.sp1/bin/sp1up
export PATH="$HOME/.sp1/bin:$PATH"

# Node deps + forge submodules
task -y setup
```

### 2. Solidity

```bash
# Build the contracts (`forge build` also works)
task build:forge

# Run the Solidity tests (contracts, submitProof/signer flows, cross-language golden vectors)
task test
```

### 3. PageRank core + ZK guests

`packages/pagerank-core` is the canonical implementation shared by the guests, the host, and the
frontend.

```bash
# Native core: determinism, invariants, and the selection rule
cargo test -p pagerank-core

# (optional) Regenerate the golden vectors and re-lock them against Solidity
cargo run -p pagerank-core --example export_golden > test/golden/trust-graph.json
forge test --match-path 'test/unit/golden/TrustGraphGoldenVectors.t.sol'

# Build the guest ELFs (root producer + signer-sync) and the host CLI
cd zk/program && cargo prove build && cd ../..
cd zk/prover  && cargo build --release && cd ../..
```

Validate that the guests match native `pagerank-core` (no proving, runs anywhere):

```bash
cd zk/prover
cargo run --release -- trust-graph execute  # root producer: guest == native
cargo run --release -- signer execute       # signer selection: guest == native
cd ../..
```

Full on-chain acceptance (spins up anvil, deploys EAS + resolver, attests, checkpoints, reconstructs
`input.json` with `input-exporter`, and cross-checks the guest) — needs anvil + the SP1 toolchain:

```bash
task e2e
```

### 4. Start backend services

> [!NOTE]
> Keep this running in its own terminal (stop with `ctrl+c`). Use new terminals for the steps below.

```bash docci-background docci-delay-after=5
cp .env.example .env
task -y start-all-local   # Anvil, IPFS, and the ponder database
```

### 5. Deploy contracts

Deploys the full set: EAS + resolvers (with the attestation accumulator), `MerkleSnapshot` + **two**
SP1 verifiers (one bound to the root guest's vkey, one to the signer guest's) + governance timelocks,
the reward distributor, and a Zodiac Safe with the `MerkleGovModule` (governance) and
`SignerSyncZkModule` (owner rotation).

```bash
# Deploy constants read from env (see deploy/env.ts):
#   PARAMS_HASH             = cargo run -p trustgraph-prover -- trust-graph paramshash [params.json]
#   SP1_PROGRAM_VKEY        = cargo run -p trustgraph-prover -- trust-graph vkey
#   SP1_SIGNER_PROGRAM_VKEY = cargo run -p trustgraph-prover -- signer vkey
#   SELECTION_PARAMS_HASH   = cargo run -p trustgraph-prover -- signer selectionparamshash [input.json]
#   SP1_VERIFIER_GATEWAY    = the canonical SP1 gateway (present in a mainnet-fork anvil)
pnpm deploy:full
```

For a **real on-chain verify locally**, run anvil as a mainnet fork so Succinct's SP1 gateway is in
state — see [`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md) → "Real end-to-end on a mainnet fork" (it also covers
the `PARAMS_HASH` ⇄ schema bootstrapping).

Deployed addresses are written to `.docker/deployment_summary.json` (and the Safe/module addresses to
`.docker/zodiac_safes_deploy.json`). Helpers: `task config:merkle-snapshot-address`, etc.

### 6. Start the frontend and indexer

**In two new terminals:**

```bash
pnpm frontend dev    # http://localhost:3000
pnpm indexer dev     # Ponder — indexes EAS/MerkleSnapshot/gov/fund/Safe events directly
```

### 7. Create a test network of attestations

```bash
# 40+ real attestations across chains, clusters, and mutual-vouching patterns
TEST_ADDRESS=$(task config:wallet-address) task trustgraph:full-setup
```

Attestations are created **directly against EAS** (from the UI or the `task forge:*` helpers) — there
is no off-chain trigger service anymore.

### 8. Produce a score root (the permissionless ZK loop)

The root is not produced automatically — anyone runs this loop:

```bash
# a. Freeze a checkpoint of the current attestation set:
cast send $MERKLE_SNAPSHOT "trigger()"        # emits InputsCheckpointed(id, acc, leafCount, block)

# b. Reconstruct that checkpoint's exact edge set from chain into input.json. The exporter re-folds
#    the reconstructed edges and refuses to emit unless they reproduce the checkpoint's `acc`:
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json --out input.json
#    ($ACCUMULATOR is the EASIndexerResolver; params.json is the serialized pinned Params.)

# c. Prove the fixed-point PageRank (writes proof.bin = abi.encode(publicValues, seal)):
cd zk/prover
SP1_PROVER=network cargo run --release -- trust-graph prove input.json --groth16
#    local instead (needs ~16–32 GiB + a gnark/Go toolchain):
#    SP1_PROVER=cpu cargo run --release --features native-gnark -- trust-graph prove input.json --groth16

# d. Pin the canonical blob (raw CIDv1 — must equal the guest's cid). `prove`/`execute` write blob.json:
ipfs add --cid-version=1 --raw-leaves blob.json
#    or via a running kubo daemon without the ipfs CLI:
#    curl -sF file=@blob.json "http://localhost:5001/api/v0/add?cid-version=1&raw-leaves=true"

# e. Submit (note the 0x prefix on the proof blob):
cast send $MERKLE_SNAPSHOT \
  "submitProof(uint256,bytes32,bytes32,string,uint256,bytes)" \
  $CHECKPOINT_ID $OUTPUT_ROOT $IPFS_HASH $CID $TOTAL_VALUE "0x$(xxd -p proof.bin | tr -d '\n')"
```

> **Where does `input.json` come from?** It's a serialized `GuestInput` (edges + params) — the exact
> attestation set the checkpoint froze. `input-exporter` (in `packages/input-exporter`) reconstructs
> it from the accumulator's `EdgeFolded` events + EAS `getAttestation`, and self-checks by re-folding
> to the checkpoint's `acc`. Omit it and the prover/`execute` use a built-in sample instead.

`submitProof` rebuilds the journal digest from the chain-pinned checkpoint + stored `paramsHash` + the
submitted outputs and reverts unless the proof binds exactly that digest. Full detail (edge
reconstruction, governance, gas) is in [`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md).

### 9. Rotate the Safe owner set (signer-sync ZK loop, optional)

Rotate the Safe's owners to the current top-scored accounts, proven correct:

```bash
# a. Freeze a checkpoint (same accumulator as the root):
cast send $MERKLE_SNAPSHOT "trigger()"

# b. Reconstruct the SignerInput (adds --signer --selection), then prove the top-N selection:
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json \
  --signer --selection selection.json --out input.json
cd zk/prover
SP1_PROVER=network cargo run --release -- signer prove input.json --groth16   # writes signer_proof.bin
#    local instead: SP1_PROVER=cpu cargo run --release --features native-gnark -- signer prove input.json --groth16

# c. Submit to rotate owners (SIGNERS ascending & unique; THRESHOLD in [1, |SIGNERS|]):
cast send $SIGNER_SYNC_MODULE \
  "submitSignerProof(uint256,address[],uint256,bytes)" \
  $CHECKPOINT_ID "[$SIGNERS]" $THRESHOLD $(xxd -p -c0 signer_proof.bin)
```

The module verifies the proof, then diffs the proven owner set against the Safe's **live** owner list
on-chain (correct `prevOwner` pointers and the `1 ≤ threshold ≤ ownerCount` invariant at every step).
The selection rule (`topN` / `minThreshold` / `targetThresholdBps`) is governance-pinned as
`selectionParamsHash` — set it at deploy (`SELECTION_PARAMS_HASH`) or later via the module owner's
`setSelectionParamsHash`. See [`research/SIGNER_SYNC_ZK_PLAN.md`](./research/SIGNER_SYNC_ZK_PLAN.md).

### 10. Explore other functionality

```bash
task forge:update-rewards
task forge:query-rewards
task forge:claim-rewards
task forge:query-rewards-balance
```
