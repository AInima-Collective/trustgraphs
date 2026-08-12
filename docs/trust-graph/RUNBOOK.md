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

| Path                                                                              | What it is                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/zk-core`                                                                | Shared, program-agnostic byte encodings (words/fold/merkle/fixed/cid/journal). Single source of truth for the primitives; re-exported by every core crate. |
| `packages/pagerank-core`                                                          | Canonical fixed-point PageRank + selection + the trust-graph Params/Journal encodings. Re-exports `zk-core`. No floats.                                    |
| `zk/program`                                                                      | Multi-bin SP1 guest crate. `trustgraph-program` bin = this program (root).                                                                                 |
| `zk/prover`                                                                       | Host CLI `trustgraph-prover`. Clap program groups: `trust-graph {vkey\|paramshash\|execute\|prove}` (and `signer …`).                                      |
| `packages/input-exporter`                                                         | Reconstructs `input.json` from chain (`EdgeFolded` + EAS) and self-checks it re-folds to the checkpoint `acc`.                                             |
| `src/contracts/eas/AttestationAccumulator.sol`                                    | Chained-hash accumulator (mixed into `EASIndexerResolver`).                                                                                                |
| `src/contracts/merkle/MerkleSnapshot.sol`                                         | `submitProof` write-gate + two-tier timelock authority.                                                                                                    |
| `src/contracts/merkle/SP1JournalVerifier.sol`                                     | `IZkVerifier` → SP1 gateway adapter (journal-agnostic; one instance per program vkey).                                                                     |
| `test/golden/trust-graph.json` + `test/unit/golden/TrustGraphGoldenVectors.t.sol` | Cross-language byte-format lock for this program (root vectors).                                                                                           |

## Toolchain

```bash
# SP1 (installs cargo-prove + the `succinct` rust toolchain)
curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
```

Pin the version. The SP1 _SDK_ is pinned to `=6.3.1` in `zk/prover/Cargo.toml`, and the vkey depends
on the exact toolchain build — read [`../PROGRAMS.md`](../PROGRAMS.md)'s reproducibility caveat
before deriving any value you intend to deploy against. Full install walkthrough, including the
other toolchains: [`../SETUP.md`](../SETUP.md).

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

# 4. Guest ELFs + prover host. One `[[bin]]` per program in zk/program, all built together.
task zk:build
#   ≡ cd zk/program && cargo prove build && touch ../prover/build.rs
#     SP1_SKIP_PROGRAM_BUILD=true sh -c 'cd zk/prover && cargo build --release'
```

> Step 4 is the one that bites. `sp1_build` does not watch the path dependencies under
> `packages/`, so after editing a core crate cargo will happily reuse a stale ELF — `task zk:build`
> touches `build.rs` to force the pickup. And because the demo and the operator harnesses run with
> `SP1_SKIP_PROGRAM_BUILD=true`, a checkout that has never run this fails with a missing-file error
> from `include_elf!` rather than anything about guests. See
> [`../SETUP.md`](../SETUP.md#build-the-zk-guest-programs).

## Determine the deploy constants

```bash
cd zk/prover
# The guest verification key (imageId). Constitutional constant; pinned in the SP1 verifier.
cargo run --release -- trust-graph vkey        # -> 0x....   (programVKey)
#   ≡ task zk:vkey PROGRAM=trust-graph
```

> **vkey:** the current trust-graph vkey is recorded in [`../PROGRAMS.md`](../PROGRAMS.md) (it
> rotates whenever the guest ELF changes, even for refactors that don't change semantics).

The canonical `paramsHash` is **not** a manual deploy input — `DeployNetwork` computes it on-chain from
`params.json` after registering the schema (`ParamsCodec.hash`, byte-identical to the guest's
`params_hash`, locked by `TrustGraphGoldenVectors.t.sol`). The CLI still computes it for
verification/CI; `paramshash` reads a full `GuestInput` (`{edges, params}`) by default, so pass a bare
params file with `--params`:

```bash
cargo run --release -- trust-graph paramshash --params params.json   # -> 0x....
```

`params.json` is a serialized `pagerank_core::Params` (the governance-pinned PageRank parameters).

For a factory-created or migrated network, `params.json` is no longer an
operational source of truth. `TrustGraphParamsController.getCurrentParams()`
stores the complete current tuple on-chain, and the operator reconstructs its
transient file from that call on every catalog refresh. A local file remains a
deployment input for the legacy `DeployNetwork` path and a useful independent
hash check; it must never shadow a controller-backed registry entry.

> **params schema v2.** `Params` carries two domain separators at the end — `accumulator` (the
> instance's `EASIndexerResolver`) and `chain_id` — so two identically-configured instances cannot
> accept each other's proofs (`FACTORY.md` §1.1). They are properties of an _instance_, not of the
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

Order matters (the resolver _is_ the accumulator, and `MerkleSnapshot` needs its address):

1. **SP1 verifier** — `script/DeployZkVerifier.s.sol` with the SP1 verifier-gateway address for the
   target chain and the `programVKey` from `trust-graph vkey`. (`DeployZkVerifier` deploys the shared
   `SP1JournalVerifier` bytecode; each program is a separate labeled instance with its own vkey.)
2. **Network** — use `GovernedTrustGraphFactory.createGovernedInstance` for a new community (the app
   creation wizard does). It calls the canonical `TrustGraphFactory` through a newly created Safe,
   deploys the resolver, snapshot, distributor and `TrustGraphParamsController`, publishes version
   1, and enables the snapshot-specific Merkle governance module. The Safe is the community admin
   and controller owner from that transaction. Direct `TrustGraphFactory.createInstance` remains a
   lower-level seam for scripted/legacy bring-up where governance is attached and authority handed
   off separately; `DeployNetwork.s.sol` is the non-factory legacy path.
3. **Timelocks** — `script/DeployTimelocks.s.sol` deploys the constitutional (long-delay) and
   operational (short-delay) `TimelockController`s. On a controller-backed trust graph, transfer
   the snapshot's `CONSTITUTIONAL_ROLE` to the constitutional timelock and transfer ownership of
   `TrustGraphParamsController` to the operational timelock through its two-step ownership flow.
   The controller—not the timelock directly—remains the snapshot's sole `OPERATIONAL_ROLE` holder.

## Produce a root (the permissionless loop)

> **This is the fallback, not the primary path.** The proof scheduler
> ([`docs/OPERATOR.md`](../OPERATOR.md)) runs this whole sequence unattended — it freezes the
> checkpoint on the contract's cadence, reconstructs the input, proves it, and submits, with a
> journal that keeps a crash from paying twice. Reach for the manual loop when you are debugging
> the daemon, bringing up a network before the daemon knows about it, or self-proving a one-off.
> The on-chain path is identical either way; `submitProof` is permissionless and does not care who
> called it.
>
> Self-hosting the daemon against your own instance is documented in
> [`OPERATOR.md`](../OPERATOR.md) §5 and needs no relationship with us.

### Manual proving

```bash
# 1. Anyone freezes a checkpoint:
cast send $MERKLE_SNAPSHOT "trigger()"        # emits InputsCheckpointed(id, acc, leafCount, block)

# 2. Reconstruct the checkpoint's exact edge set from chain (self-checks it re-folds to `acc`):
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json \
  --snapshot $MERKLE_SNAPSHOT [--recipient 0x…]
# (writes .trustgraph/trust-graph/input.json; override with --out)
# $ACCUMULATOR = the EASIndexerResolver address; params.json = serialized pagerank_core::Params.
# --snapshot is REQUIRED: it is half of the journal-v3 instanceDomain that submitProof rebuilds
# from address(this) + block.chainid, so an input exported without it proves nothing any snapshot
# will accept. --recipient is the bounty payee (default zero = no bounty, which is what you want
# when self-proving).
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
# $SKIPPED_DIGEST and $RECIPIENT come from the `execute` output above; echo them exactly.
cast send $MERKLE_SNAPSHOT \
  "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
  $CHECKPOINT_ID $OUTPUT_ROOT $IPFS_HASH $CID $TOTAL_VALUE $SKIPPED_DIGEST $RECIPIENT \
  $(xxd -p -c0 .trustgraph/trust-graph/proof.bin)
```

`submitProof` recomputes the journal digest from the chain-pinned checkpoint + the `paramsHash`
**pinned at that checkpoint's `trigger()`** + the submitted outputs + `recipient` + an
`instanceDomain` it derives from its own address and chain id, and reverts unless the proof binds
exactly that digest. It files the result at the checkpoint's freeze block, so historical
`states[...]` mean "inputs as of block N".

Three consequences worth knowing before you debug a revert:

- **A params rotation between trigger and submit does not invalidate your proof.** Every checkpoint
  is proven under the hash pinned when its inputs froze; the rotation binds the _next_ one. A
  verifier rotation is different and deliberately does invalidate in-flight proofs — that is the
  SP1-soundness emergency path.
- **`recipient` must match what the guest committed**, byte for byte. It is how the bounty is made
  unstealable: copy someone's pending transaction and you pay them their fee and refund yourself
  only gas. Zero is legitimate and means "no bounty".
- **`UnpinnedCheckpoint` means the checkpoint was not minted by `trigger()`.** With the accumulator
  bound to its snapshot that should be unreachable; if you see it, something minted a checkpoint
  out of band.

## Change scoring parameters

The recorded two-version local guest execution and direct→timelock ownership exercise are in
[`SCORING_ROTATION_LOCAL.md`](./SCORING_ROTATION_LOCAL.md). It includes the exact checkpoint hashes,
guest journal digests, and the safe two-step timelock handoff command.

Scoring changes are operational, but they are typed and versioned. Do not call
`MerkleSnapshot.setParamsHash` directly on a controller-backed trust graph.
That raw method exists for other programs and legacy recovery; bypassing the
registered controller creates an inconsistency that the operator refuses and
alerts on.

1. Open **Settings → Scoring**. Confirm that the controller, snapshot, and
   registry hashes agree. The current tuple is read from RPC even when the
   indexer is unavailable; version history may be unavailable in that state.
2. Choose **Propose changes**. The draft starts from the exact live tuple and
   records its parent hash. Only damping, tolerance, iteration cap, weight
   bounds, trust multiplier/share/decay, seeds, and points pool are editable.
   Instance identity fields remain locked.
3. Resolve every seed, pass the shared-envelope client check and controller
   simulation, and review the checkpoint-named PageRank comparison. A changed
   parent hash makes the draft stale and non-submittable.
4. Submit through the authority the controller actually exposes:
   - an EOA owner applies directly;
   - an authorized Safe action is handed to the existing Merkle governance
     proposal screen;
   - an operational `TimelockController` action is scheduled for at least
     `getMinDelay()` and executed only by its configured executor;
   - a Safe without app-native routing receives a Safe Transaction Builder
     bundle.
5. If signer sync is enabled, the canonical bundle updates
   `SignerSyncZkModule.paramsHash` first and the controller last. Safe and
   timelock batches are atomic. A direct sequence that stops after the signer
   leg is explicitly **resume required**; reuse the same draft so the
   controller is not advanced under a different hash.
6. After execution, the new version is **current, awaiting checkpoint**. The
   next successful `trigger()` pins it and makes it active. A checkpoint frozen
   before execution remains provable under its old hash.

Rollback is not a storage rewrite. Open a new draft whose editable values match
an older tuple and publish it as the next version. The version number remains
monotonic, evidence and executor provenance remain append-only, and settled
roots keep their original meaning.

### Legacy migration ceremony

Migration transfers a real capability and is constitutional. Never run it
silently against a community network. Announce the exact instance, tuple,
controller owner, and every legacy operational holder; use the community's Safe
or timelock batch when that is the current administrator.

From a cold checkout, build and test first:

```bash
pnpm install --frozen-lockfile
forge build
forge test
```

Then invoke `script/MigrateTrustGraphParamsController.s.sol` with the existing
`instanceId`, snapshot, registry, deployed
`TrustGraphParamsControllerDeployer`, exact `params.json`, schema UID,
accumulator, chain ID, intended EOA/Safe/timelock owner, and a complete array of
legacy `OPERATIONAL_ROLE` holders. For an EOA-administered development instance:

```bash
export RPC_URL=http://127.0.0.1:8545
export FUNDED_KEY=0x... # current registry + snapshot administrator

forge script script/MigrateTrustGraphParamsController.s.sol:MigrateTrustGraphParamsController \
  --rpc-url "$RPC_URL" --broadcast \
  --sig 'run(bytes32,address,address,address,string,bytes32,address,uint64,address,address[])' \
  "$INSTANCE_ID" "$SNAPSHOT" "$INSTANCE_REGISTRY" "$PARAMS_CONTROLLER_DEPLOYER" \
  "$PARAMS_JSON" "$SCHEMA_UID" "$ACCUMULATOR" "$CHAIN_ID" "$CONTROLLER_OWNER" \
  "[$LEGACY_OPERATIONAL_HOLDER]"
```

The script refuses a tuple that does not reproduce both the snapshot and
registry hash. Its order is association → grant controller → verify grant →
publish version 1 → revoke every enumerated legacy holder. It repeats all
postconditions after broadcast. For a Safe/timelock, encode those same ordered
calls as one reviewed batch; do not export an EOA key or bypass the existing
authority.

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

MerkleSnapshot and the typed trust-graph controller:

- **Constitutional** (long timelock): `setZkVerifier`, `setAccumulator`. Changing the guest = deploy a
  new `SP1JournalVerifier(gateway, newVkey)` and `setZkVerifier` through this timelock.
- **Operational** (direct owner, Safe, or short timelock):
  `TrustGraphParamsController.updateParams(fullTuple, evidenceURI)`. The
  controller validates the shared safety envelope, writes snapshot + registry
  atomically, publishes the complete version, and holds the snapshot's raw-hash
  role. An operational compromise can change a computationally valid scoring
  policy but cannot swap the guest, accumulator, schema, or other locked
  identity fields.

The signer module's governance surface is documented in
[`../signer-sync/RUNBOOK.md`](../signer-sync/RUNBOOK.md).

## Proving & on-chain gas — status and requirements

What is validated end-to-end in CI-class hardware:

- **Guest correctness**: `trust-graph execute` runs the real guest ELF in the SP1 RISC-V executor and
  its committed public values are asserted **byte-identical** to native `pagerank-core::compute` and to
  the Solidity golden vectors (`test/golden/trust-graph.json`) and the frontend TS port. Guest cost ≈
  **1.79M cycles** for the sample (seconds-to-minutes to prove on adequate hardware).
- **Verification key** (deploy constant): recorded in
  [`../PROGRAMS.md`](../PROGRAMS.md) — `cargo run -p trustgraph-prover -- trust-graph vkey`. Re-derive
  after any guest change.
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
