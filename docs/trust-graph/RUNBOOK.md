# trust-graph — Operator Runbook

How the zero-knowledge **root producer** (`trust-graph` program) is built, deployed, and run. This
replaces the WAVS operator set: the `{account → score}` merkle root is produced by a permissionless
SP1 proof of correct fixed-point Trust-Aware PageRank. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) (→ `research/ZK_ARCHITECTURE.md`) for the design and the
program index in [`../PROGRAMS.md`](../PROGRAMS.md).

> **Sibling program.** The Safe signer-sync capability is a **second program** (`signer`) that reuses
> this program's accumulator and `paramsHash`. Its build/deploy/run loop lives in
> [`../signer-sync/RUNBOOK.md`](../signer-sync/RUNBOOK.md).

## Components

| Path | What it is |
|---|---|
| `packages/zk-core` | Shared, program-agnostic byte encodings (words/fold/merkle/fixed/cid/journal). Single source of truth for the primitives; re-exported by every core crate. |
| `packages/pagerank-core` | Canonical fixed-point PageRank + selection + the trust-graph Params/Journal encodings. Re-exports `zk-core`. No floats. |
| `zk/program` | Multi-bin SP1 guest crate. `trustgraph-program` bin = this program (root). |
| `zk/prover` | Host CLI `trustgraph-prover`. Clap program groups: `trust-graph {vkey\|paramshash\|execute\|prove}` (and `signer …`). |
| `packages/input-exporter` | Reconstructs `input.json` from chain (`EdgeFolded` + EAS) and self-checks it re-folds to the checkpoint `acc`. |
| `src/contracts/eas/AttestationAccumulator.sol` | Chained-hash accumulator (mixed into `EASIndexerResolver`). |
| `src/contracts/merkle/MerkleSnapshot.sol` | `submitProof` write-gate + two-tier timelock authority. |
| `src/contracts/merkle/SP1JournalVerifier.sol` | `IZkVerifier` → SP1 gateway adapter (journal-agnostic; one instance per program vkey). |
| `test/golden/trust-graph.json` + `test/unit/golden/TrustGraphGoldenVectors.t.sol` | Cross-language byte-format lock for this program (root vectors). |

## Toolchain

```bash
# SP1 (installs cargo-prove + the `succinct` rust toolchain)
curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up
# (the SP1 *SDK* is pinned to =6.3.1 in zk/prover/Cargo.toml; the vkey depends on the exact
#  toolchain build — see ../PROGRAMS.md's reproducibility caveat before deriving deploy values)
export PATH="$HOME/.sp1/bin:$PATH"
```

## Build & test

The `task zk:*` targets take `PROGRAM=` (here `PROGRAM=trust-graph`); the raw `cargo`/`forge` commands
below are what they run.

```bash
# 1. Canonical core (native) — determinism + invariants
cargo test -p pagerank-core

# 2. Regenerate this program's golden vectors and cross-check against Solidity
task zk:vectors PROGRAM=trust-graph
#   ≡ cargo run -p pagerank-core --example export_golden > test/golden/trust-graph.json
forge test --match-path 'test/unit/golden/TrustGraphGoldenVectors.t.sol'

# 3. Full Solidity suite (accumulator, submitProof flow, existing consumers)
forge test

# 4. Guest ELF (riscv zkVM) — build.rs builds every [[bin]] in zk/program
cd zk/program && cargo prove build && cd ../..

# 5. Host
cd zk/prover && cargo build --release && cd ../..
```

## Determine the deploy constants

```bash
cd zk/prover
# The guest verification key (imageId). Constitutional constant; pinned in the SP1 verifier.
cargo run --release -- trust-graph vkey        # -> 0x....   (programVKey)
#   ≡ task zk:vkey PROGRAM=trust-graph
```

> **vkey:** the current trust-graph vkey is recorded in [`../PROGRAMS.md`](../PROGRAMS.md) (it
> rotates whenever the guest ELF changes, even for refactors that don't change semantics). The
> **frozen v1 Optimism deployment** keeps its already-deployed vkey
> `0x00a3d155dede72bb1651783cb67497e4215bf9bfd688096cb33bbef7a632a819` and is never migrated;
> fresh deployments use the current value.

The canonical `paramsHash` is **not** a manual deploy input — `DeployNetwork` computes it on-chain from
`params.json` after registering the schema (`ParamsCodec.hash`, byte-identical to the guest's
`params_hash`, locked by `TrustGraphGoldenVectors.t.sol`). The CLI still computes it for
verification/CI, but note `paramshash` deserializes a full `GuestInput` (`{edges, params}`), not a bare
params file — wrap it:

```bash
jq '{edges: [], params: .}' params.json | cargo run --release -- trust-graph paramshash /dev/stdin   # -> 0x....
```

`params.json` is a serialized `pagerank_core::Params` (the governance-pinned PageRank parameters).

> **params schema v2.** `Params` carries two domain separators at the end — `accumulator` (the
> instance's `EASIndexerResolver`) and `chain_id` — so two identically-configured instances cannot
> accept each other's proofs (`FACTORY.md` §1.1). They are properties of an *instance*, not of the
> governance file: `DeployNetwork` / `TrustGraphFactory` supply them at creation, and
> `input-exporter` fills them from the connection it is reading, erroring if `params.json` names a
> different instance. A hand-computed `paramshash` over a `params.json` whose `accumulator` /
> `chain_id` are still zero will NOT match the deployed snapshot — read the value off the chain
> (`snapshot.paramsHash()`) or off the `InstanceCreated` event instead.

## Validate the guest matches native (do this before every deploy)

```bash
cd zk/prover
SP1_PROVER=cpu cargo run --release -- trust-graph execute            # built-in sample
SP1_PROVER=cpu cargo run --release -- trust-graph execute ../../.trustgraph/trust-graph/input.json # a real checkpoint's input
#   ≡ task zk:execute PROGRAM=trust-graph
# Asserts the guest's committed public values == native pagerank-core::compute. Prints the journal.
```

## Deploy

Order matters (the resolver *is* the accumulator, and `MerkleSnapshot` needs its address):

1. **SP1 verifier** — `script/DeployZkVerifier.s.sol` with the SP1 verifier-gateway address for the
   target chain and the `programVKey` from `trust-graph vkey`. (`DeployZkVerifier` deploys the shared
   `SP1JournalVerifier` bytecode; each program is a separate labeled instance with its own vkey.)
2. **Network** — `script/DeployNetwork.s.sol` deploys `EASIndexerResolver` (accumulator), then
   `MerkleSnapshot(zkVerifier, paramsHash, accumulator, deployer, deployer)`, the schema, and the
   distributor. Pass the `paramsHash` from `trust-graph paramshash`.
3. **Timelocks** — `script/DeployTimelocks.s.sol` deploys the constitutional (long-delay) and
   operational (short-delay) `TimelockController`s and transfers `CONSTITUTIONAL_ROLE` /
   `OPERATIONAL_ROLE` off the deployer to them.

## Produce a root (the permissionless loop)

```bash
# 1. Anyone freezes a checkpoint:
cast send $MERKLE_SNAPSHOT "trigger()"        # emits InputsCheckpointed(id, acc, leafCount, block)

# 2. Reconstruct the checkpoint's exact edge set from chain (self-checks it re-folds to `acc`):
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json
# (writes .trustgraph/trust-graph/input.json; override with --out)
# $ACCUMULATOR = the EASIndexerResolver address; params.json = serialized pagerank_core::Params.
# For a large history set --from-block <deployBlock>; RPCs that cap eth_getLogs ranges: tune --chunk.

# 3. Prove:
cd zk/prover
cargo run --release -- trust-graph prove ../../.trustgraph/trust-graph/input.json --groth16
#   writes .trustgraph/trust-graph/proof.bin = abi.encode(publicValues, seal)
#   ≡ task zk:prove PROGRAM=trust-graph
cd ../..

# 4. Pin the canonical blob to IPFS (raw, CIDv1 — matches the guest's ipfsHash/cid):
ipfs add --cid-version=1 --raw-leaves .trustgraph/trust-graph/blob.json   # CID must equal the guest's cid

# 5. Submit:
cast send $MERKLE_SNAPSHOT \
  "submitProof(uint256,bytes32,bytes32,string,uint256,bytes)" \
  $CHECKPOINT_ID $OUTPUT_ROOT $IPFS_HASH $CID $TOTAL_VALUE $(xxd -p -c0 .trustgraph/trust-graph/proof.bin)
```

`submitProof` recomputes the journal digest from the chain-pinned checkpoint + stored `paramsHash` +
the submitted outputs, and reverts unless the proof binds exactly that digest. It files the result at
the checkpoint's freeze block, so historical `states[...]` mean "inputs as of block N".

## Real end-to-end on a mainnet fork (with the UI)

To exercise the **real** on-chain path — a genuine Groth16 proof verified by Succinct's real SP1
verifier — without a testnet, run anvil as a **mainnet fork**: the canonical SP1 verifier gateway is
part of forked state, so `submitProof` really verifies. The steps below are manual (you supply the
fork RPC, the gateway, and the proving backend); each is a real command, not a wrapper.

> **paramsHash is computed by the deploy — no bootstrap.** `DeployNetwork` deploys the resolver,
> registers the schema, then computes `paramsHash` from `params.json` + the fresh schema UID and builds
> `MerkleSnapshot` with it — one pass, no precomputed `PARAMS_HASH`, no restart. For a single-network
> deploy it also writes the schema UID, resolver address and chain id back into `params.json`; for
> DEV/multi-network, copy them from `config/network_deploy_<env>_<i>.json` into the prover's
> `params.json` — or use the factory's enumeration loop, which reads all three off the chain. See
> [`LOCAL_TESTING.md`](./LOCAL_TESTING.md) §"Deploy the full stack".

### Prerequisites / env

```bash
export FORK_RPC_URL=https://eth-mainnet.<your-provider>      # archive-capable mainnet RPC to fork
export SP1_VERIFIER_GATEWAY=0x...                        # Succinct's SP1 gateway on mainnet (docs.succinct.xyz)
# proving backend — pick ONE:
export SP1_PROVER=network NETWORK_PRIVATE_KEY=0x...      # Succinct prover network (no big box), OR
export SP1_PROVER=cpu                                    # local: needs ~16-32 GiB + `--features native-gnark`
```

The gateway routes a proof to the version-specific verifier by the 4-byte selector prefixed on the
proof, so it must be a gateway that has the verifier for the SDK version this repo pins (v6.3.1).

### Two programs, two verifiers

The root and the signer are **different programs with different vkeys**, so the full deploy stands up
**two** `SP1JournalVerifier`s (both pointing at the same gateway) — `MerkleSnapshot` gets the root one,
`SignerSyncZkModule` gets the signer one. Compute the root program's constant:

```bash
cd zk/prover
export SP1_PROGRAM_VKEY=$(cargo run -q --release -- trust-graph vkey)
cd ../..
# No PARAMS_HASH: DeployNetwork computes it on-chain from params.json after registering the schema.
```

The signer program's deploy constants (`SP1_SIGNER_PROGRAM_VKEY`, `SELECTION_PARAMS_HASH`) are in
[`../signer-sync/RUNBOOK.md`](../signer-sync/RUNBOOK.md).

### Deploy + loop

```bash
# 1. Fork + deploy the full stack (EAS, both verifiers, MerkleSnapshot, the Safe with MerkleGovModule
#    + SignerSyncZkModule, timelocks, distributor). Writes .docker/deployment_summary.json.
anvil --fork-url "$FORK_RPC_URL" --silent &
DEPLOY_ENV=DEV RPC_URL=http://127.0.0.1:8545 pnpm deploy:full

# 2. Attest (UI or `task forge:vouch ...`), then run the "Produce a root" loop above against the
#    deployed MerkleSnapshot — real `prove --groth16` (add `--features native-gnark` for SP1_PROVER=cpu),
#    real submitProof. (For the signer loop see ../signer-sync/RUNBOOK.md.)

# 3. Point the UI + indexer at the fork:
pnpm indexer dev     # indexes MerkleRootUpdated (scores) + the Safe's owner changes directly
pnpm frontend dev    # http://localhost:3000
```

The indexer needs **no changes**: `merkleSnapshot:MerkleRootUpdated` (scores) and the Gnosis Safe
owner events (from `submitSignerProof`'s owner rotation) are already handled. The deploy propagates
the MerkleSnapshot, Safe, MerkleGovModule, and SignerSyncZkModule addresses into the networks config
the indexer + frontend read.

## Governance (two-tier)

MerkleSnapshot:

- **Constitutional** (long timelock): `setZkVerifier`, `setAccumulator`. Changing the guest = deploy a
  new `SP1JournalVerifier(gateway, newVkey)` and `setZkVerifier` through this timelock.
- **Operational** (short timelock): `setParamsHash`. Rotating seeds / tuning damping goes here. An
  operational-key compromise CANNOT swap the guest.

The signer module's governance surface is documented in
[`../signer-sync/RUNBOOK.md`](../signer-sync/RUNBOOK.md).

## Proving & on-chain gas — status and requirements

What is validated end-to-end in CI-class hardware:
- **Guest correctness**: `trust-graph execute` runs the real guest ELF in the SP1 RISC-V executor and
  its committed public values are asserted **byte-identical** to native `pagerank-core::compute` and to
  the Solidity golden vectors (`test/golden/trust-graph.json`) and the frontend TS port. Guest cost ≈
  **1.79M cycles** for the sample (seconds-to-minutes to prove on adequate hardware).
- **Verification key** (deploy constant): re-derived at M0 exit and recorded in
  [`../PROGRAMS.md`](../PROGRAMS.md) — `cargo run -p trustgraph-prover -- trust-graph vkey`. Re-derive
  after any guest change. (The frozen v1 deployment keeps `0x00a3d155…`.)
- **On-chain verify adapter** (`SP1JournalVerifier`) is unit-tested against a mock verifier
  (`test/unit/MerkleSnapshot.t.sol`): it binds `keccak256(publicValues) == journalDigest` and delegates
  to the SP1 gateway with the immutable `programVKey`.

What requires a bigger machine or the prover network:
- **STARK core / Groth16 proof generation** is memory-heavy. On an 11 GiB machine both OOM (SIGKILL);
  SP1 CPU proving of this program needs roughly **16–32 GiB RAM** (or a GPU), or use the **Succinct
  prover network** (`SP1_PROVER=network` with `NETWORK_PRIVATE_KEY`). Run:
  `SP1_PROVER=network cargo run -p trustgraph-prover -- trust-graph prove input.json --groth16`.
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
