# ZK TrustGraph — Operator Runbook

How the zero-knowledge root producer is built, deployed, and run. This replaces the WAVS operator
set: the `{account → score}` merkle root is now produced by a permissionless SP1 proof of correct
fixed-point Trust-Aware PageRank. See `ZK_ARCHITECTURE.md` for the design and the `scratchpad/zk/`
`DECISIONS.md` / `PLAN.md` for the locked choices.

## Components

| Path | What it is |
|---|---|
| `packages/pagerank-core` | Canonical fixed-point PageRank + selection + all byte encodings. Single source of truth. No floats. |
| `zk/program` | Two SP1 guest bins: `trustgraph-program` (root) and `trustgraph-signer-program` (signer selection). |
| `zk/prover` | Host CLI: `execute`/`prove`/`vkey`/`paramshash` (root) and `signer-execute`/`signer-prove`/`signer-vkey`/`signer-selectionparamshash`. |
| `packages/input-exporter` | Reconstructs `input.json` from chain (`EdgeFolded` + EAS) and self-checks it re-folds to the checkpoint `acc`. |
| `src/contracts/eas/AttestationAccumulator.sol` | Chained-hash accumulator (mixed into `EASIndexerResolver`). |
| `src/contracts/merkle/MerkleSnapshot.sol` | `submitProof` write-gate + two-tier timelock authority. |
| `src/contracts/merkle/SP1TrustGraphVerifier.sol` | `IZkVerifier` → SP1 gateway adapter. |
| `src/contracts/zodiac/SignerSyncZkModule.sol` | `submitSignerProof` write-gate + on-chain Safe owner-set diff. |
| `test/golden/vectors.json` + `test/unit/GoldenVectors.t.sol` | Cross-language byte-format lock (root + signer). |

## Toolchain

```bash
# SP1 (installs cargo-prove + the `succinct` rust toolchain)
curl -L https://sp1.succinct.xyz | bash && ~/.sp1/bin/sp1up   # pins v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
```

## Build & test

```bash
# 1. Canonical core (native) — determinism + invariants
cargo test -p pagerank-core

# 2. Regenerate golden vectors and cross-check against Solidity
cargo run -p pagerank-core --example export_golden > test/golden/vectors.json
forge test --match-path 'test/unit/GoldenVectors.t.sol'

# 3. Full Solidity suite (accumulator, submitProof flow, existing consumers)
forge test

# 4. Guest ELF (riscv zkVM)
cd zk/program && cargo prove build && cd ../..

# 5. Host
cd zk/prover && cargo build --release && cd ../..
```

## Determine the deploy constants

```bash
cd zk/prover
# The guest verification key (imageId). Constitutional constant; pinned in the SP1 verifier.
cargo run --release -- vkey                 # -> 0x....   (programVKey)
# The canonical params hash. Operational constant; set on MerkleSnapshot.
cargo run --release -- paramshash params.json   # -> 0x....
```

`params.json` is a serialized `pagerank_core::Params` (the governance-pinned PageRank parameters).
Omit it to use the built-in sample.

## Validate the guest matches native (do this before every deploy)

```bash
cd zk/prover
SP1_PROVER=cpu cargo run --release -- execute            # built-in sample
SP1_PROVER=cpu cargo run --release -- execute input.json # a real checkpoint's input
# Asserts the guest's committed public values == native pagerank-core::compute. Prints the journal.
```

## Deploy

Order matters (the resolver *is* the accumulator, and `MerkleSnapshot` needs its address):

1. **SP1 verifier** — `script/DeployZkVerifier.s.sol` with the SP1 verifier-gateway address for the
   target chain and the `programVKey` from `vkey`.
2. **Network** — `script/DeployNetwork.s.sol` deploys `EASIndexerResolver` (accumulator), then
   `MerkleSnapshot(zkVerifier, paramsHash, accumulator, deployer, deployer)`, the schema, and the
   distributor. Pass the `paramsHash` from `paramshash`.
3. **Timelocks** — `script/DeployTimelocks.s.sol` deploys the constitutional (long-delay) and
   operational (short-delay) `TimelockController`s and transfers `CONSTITUTIONAL_ROLE` /
   `OPERATIONAL_ROLE` off the deployer to them. (Finalized in WP7.)

## Produce a root (the permissionless loop)

```bash
# 1. Anyone freezes a checkpoint:
cast send $MERKLE_SNAPSHOT "trigger()"        # emits InputsCheckpointed(id, acc, leafCount, block)

# 2. Reconstruct the checkpoint's exact edge set from chain (self-checks it re-folds to `acc`):
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json --out input.json
# $ACCUMULATOR = the EASIndexerResolver address; params.json = serialized pagerank_core::Params.
# For a large history set --from-block <deployBlock>; RPCs that cap eth_getLogs ranges: tune --chunk.

# 3. Prove:
cd zk/prover
cargo run --release -- prove input.json --groth16   # writes proof.bin = abi.encode(publicValues, seal)

# 4. Pin the canonical blob to IPFS (raw, CIDv1 — matches the guest's ipfsHash/cid):
ipfs add --cid-version=1 --raw-leaves blob.json      # CID must equal the guest's cid

# 5. Submit:
cast send $MERKLE_SNAPSHOT \
  "submitProof(uint256,bytes32,bytes32,string,uint256,bytes)" \
  $CHECKPOINT_ID $OUTPUT_ROOT $IPFS_HASH $CID $TOTAL_VALUE $(xxd -p -c0 proof.bin)
```

`submitProof` recomputes the journal digest from the chain-pinned checkpoint + stored `paramsHash` +
the submitted outputs, and reverts unless the proof binds exactly that digest. It files the result at
the checkpoint's freeze block, so historical `states[...]` mean "inputs as of block N".

## Rotate the Safe signer set (the signer-sync loop)

A second, independent proof rotates a Zodiac Safe's owner set to the top-scored accounts. It reuses
the same accumulator + `paramsHash` as the root (so the score root and the signer set are consistent
by construction — same inputs, same params, same deterministic algorithm), but has its own guest,
journal, verification key, and verifier instance — `MerkleSnapshot` is untouched. See
`SIGNER_SYNC_ZK_PLAN.md`.

Deploy constants (in addition to the root's):

```bash
cd zk/prover
cargo run --release -- signer-vkey                              # -> programVKey for the signer guest
cargo run --release -- signer-selectionparamshash input.json   # -> selectionParamsHash
# input.json is a serialized pagerank_core::SignerInput (edges + params + selection). Omit for the sample.
```

`SignerSyncZkModule` is deployed + enabled by `script/DeployZodiacSafes.s.sol`, reusing the
MerkleSnapshot's `zkVerifier`/`accumulator`/`paramsHash`. Set `selectionParamsHash` at deploy via the
`SELECTION_PARAMS_HASH` env var (default `0` → inert until governance sets it).

Build the signer input, validate, then run the loop:

```bash
# Reconstruct the SignerInput (GuestInput + selection) from chain:
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json \
  --signer --selection selection.json --out input.json

cd zk/prover
SP1_PROVER=cpu cargo run --release -- signer-execute input.json   # guest == native (no proof)
cargo run --release -- signer-prove input.json --groth16          # writes signer_proof.bin
```

```bash
# 1. Freeze a checkpoint (same trigger() as the root):
cast send $MERKLE_SNAPSHOT "trigger()"
# 2. Submit. SIGNERS must be strictly ascending + unique; THRESHOLD in [1, |SIGNERS|]:
cast send $SIGNER_SYNC_MODULE \
  "submitSignerProof(uint256,address[],uint256,bytes)" \
  $CHECKPOINT_ID "[$SIGNERS]" $THRESHOLD $(xxd -p -c0 signer_proof.bin)
```

`submitSignerProof` rebuilds the signer journal digest from the chain-pinned checkpoint + stored
`paramsHash`/`selectionParamsHash` + the submitted `signerSetRoot`/`targetThreshold`, verifies, then
diffs the proven set against the Safe's **live** owner linked list on-chain (correct `prevOwner`
pointers; `1 ≤ threshold ≤ ownerCount` preserved at every intermediate add/remove/swap). Signer guest
cost ≈ **1.85M cycles**.

## Governance (two-tier)

MerkleSnapshot:

- **Constitutional** (long timelock): `setZkVerifier`, `setAccumulator`. Changing the guest = deploy a
  new `SP1TrustGraphVerifier(gateway, newVkey)` and `setZkVerifier` through this timelock.
- **Operational** (short timelock): `setParamsHash`. Rotating seeds / tuning damping goes here. An
  operational-key compromise CANNOT swap the guest.

`SignerSyncZkModule`: its `owner` (set a `TimelockController` in production) governs `setZkVerifier`,
`setAccumulator`, `setParamsHash`, and `setSelectionParamsHash`. Deploy a new signer verifier +
`setZkVerifier` when the signer guest changes.

## Proving & on-chain gas — status and requirements

What is validated end-to-end in CI-class hardware:
- **Guest correctness**: `execute` runs the real guest ELF in the SP1 RISC-V executor and its committed
  public values are asserted **byte-identical** to native `pagerank-core::compute` and to the Solidity
  golden vectors (`test/golden/vectors.json`) and the frontend TS port. Guest cost ≈ **1.79M cycles**
  for the sample (seconds-to-minutes to prove on adequate hardware).
- **Verification key** (deploy constant): `0x00a3d155dede72bb1651783cb67497e4215bf9bfd688096cb33bbef7a632a819`
  for the current guest (`cargo run -p trustgraph-prover -- vkey`). Re-derive after any guest change.
- **On-chain verify adapter** (`SP1TrustGraphVerifier`) is unit-tested against a mock verifier
  (`test/unit/MerkleSnapshot.t.sol`): it binds `keccak256(publicValues) == journalDigest` and delegates
  to the SP1 gateway with the immutable `programVKey`.

What requires a bigger machine or the prover network:
- **STARK core / Groth16 proof generation** is memory-heavy. On an 11 GiB machine both OOM (SIGKILL);
  SP1 CPU proving of this program needs roughly **16–32 GiB RAM** (or a GPU), or use the **Succinct
  prover network** (`SP1_PROVER=network` with `NETWORK_PRIVATE_KEY`). Run:
  `SP1_PROVER=network cargo run -p trustgraph-prover -- prove input.json --groth16`.
- **Groth16 wrapping** additionally needs the `native-gnark` feature (gnark FFI). Enable it in
  `zk/prover/Cargo.toml` (`features = ["blocking", "native-gnark"]`) on a machine that can build it.

Expected on-chain cost of `submitProof`:
- State write + journal keccak + hooks ≈ **~346k gas** (measured with a mock verifier).
- SP1 Groth16 verify via the gateway ≈ **~270–330k gas** (SP1 constant, version-dependent).
- Total ≈ **~0.6M gas** per root update. This is a per-snapshot cost, not per-user.

## Notes / limits (v1)

- Privacy is out of scope (inputs are public by construction).
- The fixed-point port **redefines** the canonical scores (validated bounded-close to the legacy f64:
  `cargo run -p pagerank-core --example diff_harness` → 0.0% of pool delta across random graphs).
- Trust-weighted PageRank can fail to converge for some weight configs; both the guest and the legacy
  impl then stop at `max_iterations` and agree — the cap defines the canonical output.
