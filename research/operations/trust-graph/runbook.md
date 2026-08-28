# trust-graph — Operator Runbook

> Internal operations guide. This page is not part of the public product documentation.

How the zero-knowledge **root producer** (`trust-graph` program) is built, deployed, and run. This
replaces the WAVS operator set: the `{account → score}` merkle root is produced by a permissionless
SP1 proof of correct fixed-point Trust-Aware PageRank. See
[`architecture.md`](./architecture.md) (→ `research/ZK_ARCHITECTURE.md`) for the design and the
program index in [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md).

> **Sibling program.** The Safe signer-sync capability is a **second program** (`signer`) that reuses
> this program's accumulator and `paramsHash`. Its build/contracts/deploy/run loop lives in
> [`../signer-sync/runbook.md`](../signer-sync/runbook.md).

## Components

| Path                                                                              | What it is                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/zk-core`                                                                | Shared, program-agnostic byte encodings (words/fold/merkle/fixed/cid/journal). Single source of truth for the primitives; re-exported by every core crate. |
| `crates/pagerank-core`                                                          | Canonical fixed-point PageRank + selection + the trust-graph Params/Journal encodings. Re-exports `zk-core`. No floats.                                    |
| `zk/trust-graph-program`                                                        | SP1 guest crate for this program (root). The multi-bin `zk/program` crate holds the signer, hypercerts, contributions, and conformance guests.             |
| `zk/prover`                                                                       | Host CLI `trustgraph-prover`. Clap program groups: `trust-graph {vkey\|paramshash\|execute\|prove}` (and `signer …`).                                      |
| `crates/input-exporter`                                                         | Reconstructs `input.json` from chain (`EdgeFolded` + EAS) and self-checks it re-folds to the checkpoint `acc`.                                             |
| `contracts/src/eas/AttestationAccumulator.sol`                                    | Chained-hash accumulator (mixed into `EASIndexerResolver`).                                                                                                |
| `contracts/src/merkle/MerkleSnapshot.sol`                                         | `submitProof` write-gate + two-tier timelock authority.                                                                                                    |
| `contracts/src/merkle/SP1JournalVerifier.sol`                                     | `IZkVerifier` → SP1 gateway adapter (journal-agnostic; one instance per program vkey).                                                                     |
| `tests/golden/trust-graph.json` + `contracts/test/unit/golden/TrustgraphsGoldenVectors.t.sol` | Cross-language byte-format lock for this program (root vectors).                                                                                           |

## Toolchain

```bash
# SP1 (installs cargo-prove + the `succinct` rust toolchain)
curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
```

Pin the version. The SP1 _SDK_ is pinned to `=6.3.1` in `zk/prover/Cargo.toml`, and the vkey depends
on the exact toolchain build — read the reproducibility caveat in [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md)
before deriving any value you intend to deploy against. Full install walkthrough, including the
other toolchains: [`../setup.md`](../../../docs/build/setup.md).

## Build & test

The `task zk:*` targets take `PROGRAM=` (here `PROGRAM=trust-graph`); the raw `cargo`/`forge` commands
below are what they run.

```bash
# 1. Canonical core (native) — determinism + invariants
cargo test -p pagerank-core

# 2. Regenerate this program's golden vectors and cross-check against Solidity
task zk:vectors PROGRAM=trust-graph
#   ≡ cargo run -p pagerank-core --example export_golden > tests/golden/trust-graph.json
forge test --match-path 'contracts/test/unit/golden/TrustgraphsGoldenVectors.t.sol'

# 3. Full Solidity suite (accumulator, submitProof flow, existing consumers)
forge test

# 4. Guest ELFs + prover host. The host embeds programs from every detached guest workspace.
task zk:build
#   See taskfile/zk.yml for the explicit guest workspace list and host build.
```

> Step 4 is the one that bites. `sp1_build` does not watch the path dependencies under
> `crates/`, so after editing a core crate cargo will happily reuse a stale ELF — `task zk:build`
> touches `build.rs` to force the pickup. And because the demo and the operator harnesses run with
> `SP1_SKIP_PROGRAM_BUILD=true`, a checkout that has never run this fails with a missing-file error
> from `include_elf!` rather than anything about guests. See
> [`../setup.md`](../../../docs/build/setup.md#build-the-zk-guest-programs).

## Determine the deploy constants

```bash
cd zk/prover
# The guest verification key (imageId). Constitutional constant; pinned in the SP1 verifier.
cargo run --release -- trust-graph vkey        # -> 0x....   (programVKey)
#   ≡ task zk:vkey PROGRAM=trust-graph
```

> **vkey:** the current trust-graph vkey is recorded in [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md) (it
> rotates whenever the guest ELF changes, even for refactors that don't change semantics).

The canonical `paramsHash` is **not** a manual deploy input — `DeployNetwork` computes it on-chain from
`params.json` after registering the schema (`ParamsCodec.hash`, byte-identical to the guest's
`params_hash`, locked by `TrustgraphsGoldenVectors.t.sol`). The CLI still computes it for
verification/CI; `paramshash` reads a full `GuestInput` (`{edges, params}`) by default, so pass a bare
params file with `--params`:

```bash
cargo run --release -- trust-graph paramshash --params params.json   # -> 0x....
```

`params.json` is a serialized `pagerank_core::Params` (the governance-pinned PageRank parameters).

For a factory-created or migrated network, `params.json` is no longer an
operational source of truth. `TrustgraphsParamsController.getCurrentParams()`
stores the complete current tuple on-chain, and the operator reconstructs its
transient file from that call on every catalog refresh. A local file remains a
deployment input for the legacy `DeployNetwork` path and a useful independent
hash check; it must never shadow a controller-backed registry entry.

> **params schema v3.** The params hash prepends version word `3`, removes the retired founder
> multiplier, and retains two domain separators at the end — `accumulator` (the
> instance's `EASIndexerResolver`) and `chain_id` — so two identically-configured instances cannot
> accept each other's proofs ([`../create-a-network.md`](../create-a-network.md) §1.1). They are properties of an _instance_, not of the
> governance file: `DeployNetwork` / `TrustgraphsFactory` supply them at creation, and
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

1. **SP1 verifier** — `contracts/script/DeployZkVerifier.s.sol` with the SP1 verifier-gateway address for the
   target chain and the `programVKey` from `trust-graph vkey`. (`DeployZkVerifier` deploys the shared
   `SP1JournalVerifier` bytecode; each program is a separate labeled instance with its own vkey.)
2. **Network** — use `GovernedTrustgraphsFactory.createGovernedInstance` for a new community (the app
   creation wizard does). It calls the canonical `TrustgraphsFactory` through a newly created Safe,
   deploys the resolver, snapshot, distributor and `TrustgraphsParamsController`, publishes version
   1, and enables the snapshot-specific Merkle governance module. The Safe is the community admin
   and controller owner from that transaction. When prepaying, pass a nonzero initial policy whose
   paid interval is at least the effective score epoch and whose cap covers the priced band-1 fee;
   the Safe installs it before bootstrap handoff. Zero value must use the zero/zero unpaid policy.
   Direct `TrustgraphsFactory.createInstance` remains a lower-level seam for scripted/legacy
   bring-up where governance, any paid policy, and authority handoff are coordinated separately;
   `DeployNetwork.s.sol` is the non-factory legacy path.
   That legacy script requires a nonzero `epochLength` argument and applies it before returning;
   zero is rejected because it disables the schedule and hands checkpoint timing to callers. If
   its distributor flag is enabled, its additional distributor-owner argument must name an
   initialized Safe; an EOA is rejected before broadcast.
3. **Timelocks** — `contracts/script/DeployTimelocks.s.sol` deploys the constitutional (long-delay) and
   operational (short-delay) `TimelockController`s. On a controller-backed trust graph, call
   `proposeConstitutionalTransfer(timelock)` from the current holder, then have the timelock execute
   `acceptConstitutionalTransfer()`; acceptance grants the successor before removing the old holder.
   Transfer ownership of `TrustgraphsParamsController` to the operational timelock through its
   two-step ownership flow. The controller—not the timelock directly—remains the snapshot's sole
   `OPERATIONAL_ROLE` holder. The snapshot refuses to revoke or renounce its final constitutional
   holder, and the accepted successor immediately inherits every `ProvingVault` community control.

## Produce a root (the permissionless loop)

> **This is the fallback, not the primary path.** The proof scheduler
> ([`../run-a-prover.md`](../run-a-prover.md)) runs this whole sequence unattended — it freezes the
> checkpoint on the contract's cadence, reconstructs the input, proves it, and submits, with a
> journal that keeps a crash from paying twice. Reach for the manual loop when you are debugging
> the daemon, bringing up a network before the daemon knows about it, or self-proving a one-off.
> The on-chain path is identical either way; `submitProof` is permissionless and does not care who
> called it.
>
> Self-hosting the daemon against your own instance is documented in
> [`../run-a-prover.md`](../run-a-prover.md) §5 and needs no relationship with us.

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
[`research/SCORING_ROTATION_LOCAL.md`](../../../research/SCORING_ROTATION_LOCAL.md). It includes the exact checkpoint hashes,
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
> [`local-testing.md`](./local-testing.md) §"Deploy the full stack".

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

The signer program's deploy constant (`SP1_SIGNER_PROGRAM_VKEY`) and the module's five-field
selection/liveness policy are in
[`../signer-sync/runbook.md`](../signer-sync/runbook.md).

### Rotating the trust-graph vkey (guest change runbook)

Any change to the trust-graph guest — including `pagerank-core`, `zk-core`, or `envelopes` code it
compiles in — rotates the trust-graph program vkey. The 2026-08-13 audit batch (H-5 anchored-count
head-replay fix + M-12 CAR bounds-checks) is such a rotation, and it ALSO changes `AnchorRegistry`
(the anchor leaf gains the head's signed `count` word and `anchor()` verifies the owner's
co-signature for address nodes), so lane-2 instances redeploy the registry alongside the verifier.
Per the batching rule, group every guest-affecting change into one rotation:

1. Land the guest edits in one batch; regenerate golden vectors
   (`cargo run -p pagerank-core --example export_golden > tests/golden/trust-graph.json` — and the
   hypercerts feed if `zk-core` encodings changed) in the same commit; confirm guest==native,
   Solidity goldens, and the frontend TS golden test are green.
2. `cargo run -q --release -- trust-graph vkey` → the new `SP1_PROGRAM_VKEY`.
3. Deploy a new `SP1JournalVerifier(gateway, newVkey)`; point `MerkleSnapshot` at it via its
   governance (`setZkVerifier`, constitutional timelock). Old proofs stop verifying at that instant.
4. If the anchor encoding or ingress contract changed (including the bounded/admitted #12
   registry), do **not** point a checkpointed snapshot at a new registry. Deploy a new accumulator,
   bounded `AnchorRegistry`, verifier, and snapshot; bind both lanes before checkpoint 0;
   re-register nodes and re-anchor current heads. Preserve the old final root/blob and contract
   addresses, update the same directory row, and have the old snapshot's constitutional authority
   call `ProvingVault.migrate`. The directory event sequence is the generation link; the old
   registry remains queryable.
5. Re-export inputs and prove checkpoint 0 with the new guest; record the new vkey in
   [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md).

### Deploy + loop

```bash
# 1. Fork + deploy the full stack (EAS, both verifiers, MerkleSnapshot, the Safe with MerkleGovModule
#    + SignerSyncZkModule, timelocks, distributor). Writes .docker/deployment_summary.json.
anvil --fork-url "$FORK_RPC_URL" --silent &
RPC_URL=http://127.0.0.1:8545 pnpm deploy:full

# 2. Attest (UI or `task forge:vouch ...`), then run the "Produce a root" loop above against the
#    deployed MerkleSnapshot — real `prove --groth16` (add `--features native-gnark` for SP1_PROVER=cpu),
#    real submitProof. (For the signer loop see ../signer-sync/runbook.md.)

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

- **Constitutional** (long timelock): `setZkVerifier`, pre-checkpoint `setAccumulator`, epoch/input
  wiring, hooks, and the two-step constitutional handoff. Changing the guest = deploy a new
  `SP1JournalVerifier(gateway, newVkey)` and `setZkVerifier` through this timelock. Once checkpoint 0
  exists, accumulator re-pointing is locked: deploy a replacement snapshot, preserve the last
  root/blob as migration evidence, update the directory, and authorize `ProvingVault.migrate` from
  the old snapshot's constitutional authority. This avoids checkpoint-id reuse and descending
  historical freeze blocks until a generation-aware migration protocol exists.
- **Operational** (direct owner, Safe, or short timelock):
  `TrustgraphsParamsController.updateParams(fullTuple, evidenceURI)`. The
  controller validates the shared safety envelope, writes snapshot + registry
  atomically, publishes the complete version, and holds the snapshot's raw-hash
  role. An operational compromise can change a computationally valid scoring
  policy but cannot swap the guest, accumulator, schema, or other locked
  identity fields.

The signer module's governance surface is documented in
[`../signer-sync/runbook.md`](../signer-sync/runbook.md).

## M1 full-guest cost calibration

Operator cost model v1 prices the complete prepared witness, not just its attestation count. Its
named terms are retained in logs and the request intent:

```
base(program)
+ 64 * witness_bytes + 8,000 * raw_records + 75,000 * signature_checks
+ 2,000 * raw_records * ceil(log2(max(raw_records, 2)))
+ 4,000 * (unique_nodes + live_edges) + 2,000 * max_out_degree
+ iterations_run * (5,000 * unique_nodes + 10,000 * live_edges)
+ 10,000 * output_leaves * ceil(log2(max(output_leaves, 2)))
```

The per-program base is 3M cycles for trust root and signer, 4M for contributions, and 5M for
Hypercerts and Nostr. Arithmetic saturates rather than wrapping. Stage 1 applies conservative
algebraic bounds from authenticated checkpoint counts and uses `max_iterations`; after input
reconstruction, Stage 2 substitutes the exact graph shape and deterministic `iterations_run`
immediately before the paid request intent. The intent records both iteration fields, the estimate,
and the model version. For signer-sync, `raw_records` at the prepared gate includes both score-edge
records and the complete authenticated direct-vote activity chain.

This calibration was rerun on 2026-08-23 with SP1 v6.3.1 on aarch64 Linux. Every row executed the
fresh guest ELF, byte-asserted `guest == native`, and then compared the v1 estimate with the guest's
global instruction clock. The disconnected-tail row preserves the schema-v3 consensus rule that
unreachable nodes remain exactly zero and do not participate in the stopping delta.

| Case | Raw | Live edges | Nodes | Max out | Iterations | Measured cycles | Estimated cycles | Headroom |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| trust sample | 6 | 3 | 3 | 1 | 57 | 903,623 | 5,958,808 | 6.59x |
| signer sample (6 edges + 2 activity) | 8 | 3 | 3 | 1 | 57 | 991,874 | 5,989,112 | 6.04x |
| contributions sample | 25 | 6 | 5 | 4 | 4 | 1,308,761 | 5,992,192 | 4.58x |
| Hypercerts sample | 5 | 4 | 5 | 2 | 3 | 1,711,762 | 6,338,512 | 3.70x |
| Nostr sample | 24 | 4 | 3 | 2 | 41 | 5,289,098 | 22,677,824 | 4.29x |
| connected V=25, degree<=2, maxIterations=1 | 38 | 38 | 25 | 2 | 1 | 2,335,137 | 5,656,456 | 2.42x |
| connected V=100, degree<=4 | 250 | 250 | 100 | 4 | 30 | 66,973,643 | 108,664,096 | 1.62x |
| connected V=200, degree<=8 | 900 | 900 | 200 | 8 | 34 | 244,915,295 | 399,802,496 | 1.63x |
| V=200, degree<=4, unreachable tail=80 | 500 | 500 | 200 | 4 | 30 | 114,210,886 | 213,768,096 | 1.87x |
| connected V=400, degree<=8 | 1,800 | 1,800 | 400 | 8 | 34 | 538,786,913 | 797,188,160 | 1.48x |

Reproduce the matrix after rebuilding every guest:

```bash
cargo build --release --manifest-path zk/prover/Cargo.toml
SP1_SKIP_PROGRAM_BUILD=true cargo run --release --manifest-path zk/prover/Cargo.toml \
  --example m1_guest_cost_matrix
```

The shipped host profile v2 is anchored to the largest calibrated row above: 1,800 raw/live
records. Its cheap pre-download bound must admit two endpoints per record, so it permits 3,600
conservatively bounded unique nodes and 1,800 maximum out-degree, lane-2 anchors, and signature
checks. It retains 100 iterations and an independent 128 MiB witness memory ceiling; the published
matrix did not establish a maximum serialized witness size, so that field is not presented as a
calibration result. Boundary and one-over tests lock every dimension.

This makes the binding order explicit. The default profile's raw-record and conservative-node
ceilings co-bind around 1,800 inputs. If an operator raises that profile, the unchanged 8B-cycle
default accepts 3,467 and refuses 3,468 max-iteration trust inputs under the v1 model. The on-chain
`InputCapacity.MAX_TOTAL_INPUTS` and vault price band remain 200,000: they are protocol/payment
ceilings, not evidence that this host can prove that much work. Both the profile and cycle limit are
configurable and published in the status heartbeat, so a better-resourced prover can raise them
without changing a guest or vkey. Refusals name the configured limit, and **another prover may
accept the same valid checkpoint**.

## Proving & on-chain gas — status and requirements

What is validated end-to-end in CI-class hardware:

- **Guest correctness**: `trust-graph execute` runs the real guest ELF in the SP1 RISC-V executor and
  its committed public values are asserted **byte-identical** to native `pagerank-core::compute` and to
  the Solidity golden vectors (`tests/golden/trust-graph.json`) and the frontend TS port. The current
  strict trust sample measures **903,623 cycles**; the calibrated matrix above covers all five
  PageRank-bearing production guests.
- **Verification key** (deploy constant): recorded in
  [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md) — `cargo run -p trustgraph-prover -- trust-graph vkey`. Re-derive
  after any guest change.
- **On-chain verify adapter** (`SP1JournalVerifier`) is unit-tested against a mock verifier
  (`contracts/test/unit/MerkleSnapshot.t.sol`): it binds `keccak256(publicValues) == journalDigest` and delegates
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

## Tolerance floor and fixed-iteration semantics

The validator accepts `toleranceFp` from `1e6` through `1e15`. The lower bound is an
**empirical operating margin**, not a proof that integer PageRank cannot cycle. At damping
0.85, periodic graphs do form finite fixed-point limit cycles when tolerance is one unit,
but the measured residual movement stayed between zero and six units:

| Nodes | Out-degree | Largest measured residual movement |
|---:|---:|---:|
| 10 | 3 | 2 units |
| 50 | 3 / 10 | 0 units |
| 200 | 6 / 20 | 2 / 0 units |
| 800 | 6 / 20 | 6 / 1 units |
| 2,000 | 6 | 5 units |

The `1e6` floor is therefore six orders of magnitude above the largest observed cycle and
six below the shipped `1e12` tolerance. This finite sweep is evidence, not a no-cycle
theorem. `maxIterations` remains consensus: exhausting it produces the canonical result;
`converged`, `iterations_run`, and `final_max_delta` are operator telemetry.

## Notes / limits (params schema v3)

- Privacy is out of scope (inputs are public by construction).
- The fixed-point port **redefines** the canonical scores. The retired f64 engine's deterministic
  migration fixture remains frozen in `pagerank-core`'s `legacy_float_fixture_is_preserved` test;
  the original eight generated cases had 0.0% whole-point payout delta.
- Fixed-point PageRank can fail to converge for some periodic graphs; the guest then stops at
  `max_iterations` — the cap defines the canonical output.
