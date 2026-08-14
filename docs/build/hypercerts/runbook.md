# hypercerts — Operator Runbook

How the **hypercerts** root producer (the third SP1 program) is deployed and run today. It proves a
trust-weighted `{node → score}` merkle root over **Hypercerts' AT Protocol records** and commits it on
a `MerkleSnapshot` (journal v3), permissionlessly. This is a **lane-2-only** instance (no EAS lane 1):
the input commitment is the two-lane `AnchorRegistry` of per-repo head anchors, not an
`AttestationAccumulator`.

See [`architecture.md`](./architecture.md) (→ [`../../../research/HYPERCERTS_ATPROTO_PLAN.md`](../../../research/HYPERCERTS_ATPROTO_PLAN.md))
for the design, [`networks-and-programs.md`](../../concepts/networks-and-programs.md) for the program index and the vkey, and the
sibling [`../trust-graph/runbook.md`](../trust-graph/runbook.md) for the shared prove/submit plumbing
this reuses. The **exact end-to-end sequence this runbook operationalizes is the `hypercerts` stage of
[`test/e2e/run.sh`](../../../test/e2e/run.sh)** (deploy → register → anchor → trigger → prove →
submitProof → InstanceRegistry); every command below mirrors a real step there.

> **Program vs. instance.** `hypercerts` is one program (one guest, one vkey, one journal shape). This
> runbook stands up **one instance** of it: Sepolia for rehearsal, Ethereum mainnet for the pilot. Standing
> up another instance later costs only a deployment (no Rust, no guest, no vectors) —
> [`networks-and-programs.md`](../../concepts/networks-and-programs.md).

---


> **One-script deploy:** the whole battery below is also available as a single labeled script —
> `forge script script/DeployHypercertsInstance.s.sol:DeployHypercertsInstance --sig "run(string)" <label>`
> (env: `SP1_VERIFIER_GATEWAY`, `HYPERCERTS_VKEY`, `HYPERCERTS_PARAMS_HASH`,
> `HYPERCERTS_EPOCH_LENGTH`, `HYPERCERTS_MAX_TOTAL_INPUTS`, optional `INSTANCE_REGISTRY` + admin
> overrides); it writes
> `.docker/hypercerts_instance_<label>_deploy.json`. Third-party epoch reproduction is
> documented in [`reproduce-an-epoch.md`](../../verify/reproduce-an-epoch.md).

## Components (hypercerts-specific)

| Path | What it is |
|---|---|
| `packages/hypercerts-core` | The record→edge semantics (research plan §3) + fixed-point Trust-Aware PageRank + the `Params`/`Journal` encodings. Re-exports `zk-core`/`pagerank-core`. No floats. |
| `packages/envelopes` | Envelope-1 (atproto) verification: CAR/MST walk, commit signature, PLC key-chain, `link.evm` EIP-712. Verified in-guest. |
| `zk/program` (bin `trustgraph-hypercerts-program`) | The hypercerts guest `[[bin]]`. |
| `zk/prover` (`trustgraph-prover hypercerts …`) | Host CLI group: `hypercerts {vkey \| paramshash \| execute \| prove \| buildinput}`. `buildinput` and witness assembly (the shared `witness fetch` group) need `--features witness-atproto`. |
| `src/contracts/merkle/EmptyLaneAccumulator.sol` | The lane-1 stand-in: `checkpoint()` returns monotonic ids, `acc = 0, leafCount = 0` (the guest asserts the empty lane). Bound one-shot to its `MerkleSnapshot` at deploy, so only `trigger()` may mint — on a lane-2-only instance the checkpoint id is the only thing separating one epoch's inputs from another's. |
| `src/contracts/registry/AnchorRegistry.sol` | Lane-2 input commitment: bounded chained-hash log of per-repo head anchors. `REGISTRAR_ROLE` admits DID nodes; `ANCHORER_ROLE` admits relayers. |
| `src/contracts/merkle/MerkleSnapshot.sol` | `trigger()` (freezes both lanes) + `submitProof` (journal v3) + two-tier authority + `epochLength` schedule. |
| `src/contracts/merkle/SP1JournalVerifier.sol` | The SP1 gateway adapter, one labeled instance pinned to the **hypercerts vkey**. |
| `src/contracts/registry/InstanceRegistry.sol` | Per-chain directory: frontends/indexers discover the contract set on-chain. |
| `test/golden/hypercerts.json` + `test/unit/golden/HypercertsGoldenVectors.t.sol` | Four-way byte lock (native / guest / Solidity / TS) for this program. |
| `indexer/` bundle API (`src/api/hypercerts.ts`) | Serves `{nodeId, score, proof[]}` bundles — see [§ Score-bundle API](#score-bundle-api). |

## Toolchain + the vkey reproducibility caveat

```bash
curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version v6.3.1   # SDK pinned =6.3.1 in zk/prover/Cargo.toml
export PATH="$HOME/.sp1/bin:$PATH"
```

> **The vkey is toolchain-reproducible, not machine-portable** ([`networks-and-programs.md`](../../concepts/networks-and-programs.md),
> measured). The hypercerts guest vkey is
> **`0x00b22def0bde6796acb3442691deb78056393de318e658aead32b38dbb425346`** (journal v3, SP1 6.3.1). But the value
> depends on the exact `succinct` toolchain build — a reinstall shifted sibling vkeys with zero source
> change. **Derive the deployment vkey on the pinned toolchain recorded here, not an arbitrary box**,
> and diff it against the table in [`networks-and-programs.md`](../../concepts/networks-and-programs.md) before trusting it:
> ```bash
> cd zk/prover && cargo run --release -- hypercerts vkey   # must equal the value above
> ```
> Any guest change (or a `[patch.crates-io]` crypto bump that recompiles the ELF) **rotates this vkey
> and the sibling trust-graph/signer vkeys**; batch rotations through the constitutional timelock —
> see [§ vkey rotation](#vkey-rotation-constitutional-batched).

## Build & test (before every deploy)

```bash
cargo test -p hypercerts-core                              # determinism + §3 semantics + invariants
task zk:vectors PROGRAM=hypercerts                         # regenerate test/golden/hypercerts.json
forge test --match-path 'test/unit/golden/HypercertsGoldenVectors.t.sol'
forge test                                                 # accumulator + submitProof + registry suites
task zk:build                                              # every [[bin]] ELF + the prover host

# Guest == native over the seeded two-repo fixture (no external witness, no proof):
cd zk/prover && SP1_PROVER=cpu cargo run --release -- hypercerts execute
#   ≡ task zk:execute PROGRAM=hypercerts — asserts committed public values == native compute; prints the journal.
```

---

## Deploy battery (Sepolia rehearsal → Ethereum mainnet)

Rehearse the **entire** battery on **Sepolia** first (mock gateway is fine for the rehearsal proof;
a real Groth16 proof needs `SP1_PROVER=network`). Repeat verbatim on **Ethereum mainnet** for the pilot with the
canonical Succinct gateway. Order matters: the snapshot needs the verifier + empty accumulator at
construction, and the registry is wired in afterward.

Derive the deploy constants first:

```bash
cd zk/prover
export HC_VKEY=$(cargo run -q --release -- hypercerts vkey)          # must equal the networks-and-programs.md value
export HC_PARAMS_HASH=$(cargo run -q --release -- hypercerts paramshash ../../.trustgraph/hypercerts/hypercerts_input.json)  # keccak of the 17-word Params (§6.1)
cd ../..
export GATEWAY=0x...    # Succinct SP1 verifier gateway for the target chain (docs.succinct.xyz); must carry the v6.3.1 verifier
export DEPLOYER=$(cast wallet address --private-key "$PK")
```

> `paramshash` deserializes a full `GuestInput` (`{params, anchors, witnesses, strongref_targets}`),
> not a bare params file — pass a built `hypercerts_input.json` (or `jq '{params: ., anchors: [], witnesses: [], strongref_targets: {}}' params.json`).
> The on-chain twin is `HypercertsParamsCodec` (golden-locked to the crate's `params_hash`).

### Contract set, in order

Mirrors the e2e `hypercerts` stage. Substitute the labeled forge **scripts** for `forge create` on a
real chain where a script exists; the `forge create` lines are the exact constructor args.

```bash
# 1. Empty lane-1 accumulator (acc = 0, leafCount = 0 — the guest asserts this).
HC_EMPTY_ACC=$(forge create src/contracts/merkle/EmptyLaneAccumulator.sol:EmptyLaneAccumulator \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)

# 2. AnchorRegistry (lane-2 head log). Choose an immutable cap from the combined lifetime budget.
#    Hypercerts has an empty lane 1; other programs must separately control their lane-1 ingress.
HC_MAX_TOTAL_INPUTS=50000
HC_REGISTRY=$(forge create src/contracts/registry/AnchorRegistry.sol:AnchorRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$OPERATIONAL_TIMELOCK" "$HC_MAX_TOTAL_INPUTS" | jq -r .deployedTo)

# 3. SP1JournalVerifier pinned to the hypercerts vkey (one labeled instance; same bytecode as the others).
HC_VERIFIER=$(forge create src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$GATEWAY" "$HC_VKEY" | jq -r .deployedTo)

# 4. MerkleSnapshot(verifier, paramsHash, EMPTY accumulator, constitutionalAdmin, operationalAdmin).
#    NOTE: lane-1 accumulator = the EmptyLaneAccumulator, NOT an EAS resolver.
HC_SNAPSHOT=$(forge create src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$HC_VERIFIER" "$HC_PARAMS_HASH" "$HC_EMPTY_ACC" "$CONSTITUTIONAL_TIMELOCK" "$OPERATIONAL_TIMELOCK" | jq -r .deployedTo)

# 5. Wire the anchor registry into the snapshot (constitutional — it changes which inputs are committed).
cast send "$HC_SNAPSHOT" "setAnchorRegistry(address)" "$HC_REGISTRY" --rpc-url "$RPC" --private-key "$PK"

# 6. Complete the registry's reciprocal one-shot binding from the deployer/binder account.
cast send "$HC_REGISTRY" "bindSnapshot(address)" "$HC_SNAPSHOT" --rpc-url "$RPC" --private-key "$PK"

# 7. Set the weekly epoch schedule (constitutional). 302,400 blocks @ 2s = 1 week (§6.1).
cast send "$HC_SNAPSHOT" "setEpochLength(uint64)" 302400 --rpc-url "$RPC" --private-key "$PK"

# 8. Register the instance so frontends/indexers discover the set on-chain.
HC_ID=$(cast keccak "hypercerts")
cast send "$INSTANCE_REGISTRY" "register(bytes32,(bytes32,address,address,address,bytes32))" \
  "$HC_ID" "($(cast keccak "hypercerts"),$HC_SNAPSHOT,$HC_VERIFIER,$HC_REGISTRY,$HC_PARAMS_HASH)" \
  --rpc-url "$RPC" --private-key "$PK"
```

No gov module and no distributor at launch: **the root is the product**; Hypercerts consumes it via
merkle proofs in their own contracts/apps (and the [bundle API](#score-bundle-api) for off-chain).

### Roles and what each knob does

| Role | Held by | Knobs | Meaning |
|---|---|---|---|
| **CONSTITUTIONAL_ROLE** (MerkleSnapshot) | long-delay `TimelockController` | `setZkVerifier`, pre-checkpoint `setAccumulator`/`setAnchorRegistry`, `setEpochLength`, hooks, two-step authority handoff | The truth-defining tier. The final holder cannot revoke/renounce itself. After checkpoint 0, changing an input lane requires a new snapshot plus explicit migration, preventing checkpoint-id/history reuse. |
| **OPERATIONAL_ROLE** (MerkleSnapshot) | short-delay `TimelockController` | `setParamsHash` | Tuning: rotate the seed set, adjust weights/damping. Moves a new `paramsHash` with no guest change. |
| **REGISTRAR_ROLE** (AnchorRegistry) | operational timelock (or a PDS-allowlist steward it delegates to) | `registerNode(nodeId, kind)` | The registration gate. At launch it admits DID nodes on the **PDS allowlist** (Hypercerts' PDSes). Address nodes self-register via `register()` and are **not** registrar-mintable. |
| **ANCHORER_ROLE** (AnchorRegistry) | at least two independent relayers | `anchor(...)` | Admission to finite proving capacity. Every node count must increase; address heads remain owner-signed. A relayer can censor but cannot forge semantics. |
| — (permissionless) | anyone | `MerkleSnapshot.trigger()`, `MerkleSnapshot.submitProof(...)` | The permissionless prove loop; neither call can enlarge the input set. |

---

## Epoch operations (the weekly loop)

### 1. Witness fetch + CAR archival (a soundness duty, not a convenience)

For every **registered** DID, assemble the offline witness bundle (repo CAR at its current commit +
PLC audit log), archived at observation time. Old atproto commits are **not re-servable** and deletion
is trace-free, so archival is what keeps a proven epoch auditable after the PDS moves on (Partner Brief
§2c).

```bash
cd zk/prover
cargo run --release --features witness-atproto -- \
  witness fetch --did did:plc:<repo1> --did did:plc:<repo2> ... \
  --relay-url https://bsky.network --plc-url https://plc.directory
# Archives into .trustgraph/hypercerts/witness-archive/ by default (--archive-dir overrides):
# <did>/<rev>.car + plc-<ts>.json + manifest.json, and prints each head_sha256
# (the value you anchor). The bundle re-verifies offline; `execute`/`prove` are network-free from here.
```

The indexer sidecar subscribes to the firehose for the registered DID set and archives blocks keyed
`(did, rev)`; it doubles as the **equivocation watch** (two signed heads at overlapping revs = a
publishable proof of PDS misbehavior). `takendown/suspended/deactivated` repos stop being servable and
hit rule Φ like any withheld head; the archived CAR still proves the last anchored state within the
k-epoch window.

### 2. Anchor the heads (admitted relay)

DID nodes must be registered first. A holder of `ANCHORER_ROLE` then relays the head. Use multiple
independent relayers because v1 deliberately trades permissionless force inclusion for Sybil-safe
capacity; the signature/guest checks preserve correctness, while the relayer set controls inclusion.

```bash
# One-time per DID node (REGISTRAR_ROLE): kind 1 = DID.
cast send "$HC_REGISTRY" "registerNode(bytes32,uint8)" "$NODE_ID" 1 --rpc-url "$RPC" --private-key "$REGISTRAR_PK"
# NODE_ID = keccak256(utf8(did)) (`hypercerts_core::semantics::did_node_id`; `hypercerts
# buildinput` prints each node's id on stdout).

# Anchor a head (envelopeKind 1 = atproto; dataCommitment 0 for v1 — the CAR archive is the
# availability proof). `count` is the head's monotonic revision ordinal (H-5 leaf word; increment it
# per anchored head). Non-address node kinds need no head signature — pass 0x.
cast send "$HC_REGISTRY" "anchor(bytes32,uint8,bytes32,uint64,bytes32,bytes)" "$NODE_ID" 1 "$HEAD_SHA256" 1 \
  0x0000000000000000000000000000000000000000000000000000000000000000 0x \
  --rpc-url "$RPC" --private-key "$ANCHORER_PK"
```

### 3. Trigger the checkpoint (weekly cadence)

`trigger()` is gated by `epochLength` (reverts `EpochNotElapsed` before the week is up) and freezes
**both** lanes at one boundary: lane 1 is the empty accumulator (`acc = 0`), lane 2 is the registry's
`(anchorAcc, anchorCount)`. The schedule is anchored when configured. If the transaction lands late,
it consumes the already-fixed boundary for that epoch; it cannot shift the following weeks.

```bash
cast send "$HC_SNAPSHOT" "trigger()" --rpc-url "$RPC" --private-key "$PK"   # emits SnapshotTriggered + AnchorsCheckpointed
CP=<checkpointId from the event>
cast call "$HC_SNAPSHOT" "anchorCheckpoints(uint256)(bytes32,uint64)" "$CP" --rpc-url "$RPC"   # the (anchorAcc, anchorCount) the guest must re-fold to
```

### 4. Prove (real proofs on the network; mock only for rehearsal)

Assemble the `GuestInput` (params + the checkpoint's anchor set + the archived witnesses) with
`hypercerts buildinput --params params.json` (or `--seed-did`), then
prove. The anchors' `block_timestamp`s in the input **must** be the real on-chain timestamps so the
guest's re-fold matches the checkpointed `anchorAcc` (the e2e stage patches them from `cast block`);
`buildinput` emits `0` placeholders in fold order — rewrite each from its `HeadAnchored` event/tx.

```bash
cd zk/prover
# Real proof — Succinct prover network (no big box) or a 16-32 GiB machine with --features native-gnark:
SP1_PROVER=network NETWORK_PRIVATE_KEY=0x... \
  cargo run --release -- hypercerts prove ../../.trustgraph/hypercerts/hypercerts_input.json --groth16
#   writes .trustgraph/hypercerts/hypercerts_proof.bin + hypercerts_blob.json
#   ≡ task zk:prove PROGRAM=hypercerts.  SP1_PROVER=mock is REHEARSAL ONLY (stubs the SNARK).
cd ../..

# Pin the canonical nodeId-keyed blob at the guest's CID:
ipfs add --cid-version=1 --raw-leaves .trustgraph/hypercerts/hypercerts_blob.json   # CID must equal the guest's `cid`
```

### 5. submitProof + post-checks

Journal v3 is an 8-arg `submitProof` — `skippedDigest` (added in v2) and `recipient` (v3):

```bash
# From `hypercerts execute`: outputRoot, ipfsHash, cid, totalValue, skippedDigest, recipient.
cast send "$HC_SNAPSHOT" \
  "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
  "$CP" "$OUTPUT_ROOT" "$IPFS_HASH" "$CID" "$TOTAL_VALUE" "$SKIPPED_DIGEST" "$RECIPIENT" \
  "$(xxd -p -c0 .trustgraph/hypercerts/hypercerts_proof.bin)" \
  --rpc-url "$RPC" --private-key "$PK"
```

> **This program depends on journal v3 more than any other.** Its params carry no instance-unique
> field, and lane 1 is permanently `(0, 0)`, so before v3 two identically-configured hypercerts
> instances accepted each other's proofs. The `instanceDomain` the guest commits — and
> `submitProof` rebuilds from `address(this)` + `block.chainid` — is what separates them. Set it
> from the snapshot you are submitting to (`--snapshot` on `buildinput`), or the proof lands
> nowhere.

`submitProof` recomputes the journal digest from the chain-pinned checkpoint (both lanes) + stored
`paramsHash` + submitted outputs and reverts unless the proof binds exactly that digest. After it lands,
check:

- **root** — `getLatestState()` root == the proven `outputRoot`.
- **skippedDigest vs expected skips** — it commits the rule-Φ / record-level skip set for the epoch. If
  a DID you expected to include shows up skipped (or vice versa), the witness set and the anchor set
  disagree; reconcile before the next epoch. The **preimage** (which nodes, and why) is off-chain: it
  lives in the prover's archived bundle and is served/validated by the indexer's `skipped_node` table
  against this on-chain digest.

---

## Failure modes

### Withheld heads (rule Φ)

A node can anchor a head and withhold the data behind it. The guest cannot verify a head it cannot
fetch, so **rule Φ** carries forward the node's newest *usable* head within the k-epoch staleness
window and, when none is usable, drops the node's out-edges — recording it in `skippedDigest` with a
reason (`CARRIED` = an older head was used; `DROPPED` = nothing usable). Operators see this as a
**non-zero `skippedDigest`** on an epoch where a registered node went dark; the indexer's
`skipped_node` rows (validated against the digest) name the node. This is expected, publicly committed
degradation, not an error: a withholding PDS keeps a node's *given* reputation alive for k epochs
(~28 days at k=4), then its out-edges drop.

### Stale-checkpoint races

`trigger()` is permissionless, so two operators can freeze overlapping checkpoints; `submitProof` is
**monotonic** (an older-or-equal checkpoint cannot clobber a newer applied one — it reverts). If your
prove run is slow and someone lands a newer checkpoint first, your proof for the older checkpoint is
rejected: re-export against the latest checkpoint and re-prove. Prove against the checkpoint you
intend to land, and confirm `lastAppliedCheckpoint` before spending proving time.

### vkey rotation (constitutional, batched)

Any guest change — new `hypercerts-core` semantics, a `[patch.crates-io]` crypto bump, or the lexicon
leaving v1.1.0 (Partner Brief §3) — rotates the hypercerts vkey **and** recompiles the sibling ELFs
(the single `build.rs` builds every `[[bin]]`), so the trust-graph/signer vkeys move too. Procedure:

1. Re-derive all affected vkeys on the **pinned toolchain**; diff against [`networks-and-programs.md`](../../concepts/networks-and-programs.md).
2. Deploy a fresh `SP1JournalVerifier(gateway, newHypercertsVkey)`.
3. Through the **constitutional timelock**, `setZkVerifier(newVerifier)` on the hypercerts snapshot —
   and batch the sibling instances' rotations into the same timelock cycle.
   Do not dribble rotations.

---

## Params (research plan §6.1)

Governance-pinned, all fixed-point at `precision_scale` (1e18), tunable via the operational-timelock
`paramsHash` path with **no** guest change.

| Parameter | `Params` field | Launch value |
|---|---|---|
| Epoch length | (`setEpochLength`) | 1 week = **302,400** blocks @ 2s |
| Rule-Φ carry-forward horizon | `lane2_max_head_age` | k=4 epochs ≈ 28 days = **2,419,200** s |
| PDS-attested discount | `pds_attested_weight_fp` | **0.5** |
| Evaluation edge (reference) | `w_eval_fp` | **1.0** |
| Attribution edge | `w_attrib_fp` | **0.8** |
| Badge edge | `w_badge_fp` | **0.5** |
| Follow edge | `w_follow_fp` | **0.2** |
| Confirmed-edge boost | `ack_boost_fp` | **2.0** |
| Named-but-unacknowledged attribution | `unacked_attrib_fp` | **0.5** |
| Damping / tolerance / iterations / pool | `damping_fp` / `tolerance_fp` / `max_iterations` / `total_pool` | inherit v1 (0.85 / 1e-6 / 100 / 1e24) |
| Seed set | `trusted_seed_dids` | partner-curated DID list |

### `params.json` (serde field names; U256 as `0x`-hex, `max_iterations`/`lane2_max_head_age` as plain ints)

```json
{
  "damping_fp": "0xbcbce7f1b150000",
  "tolerance_fp": "0xe8d4a51000",
  "max_iterations": 100,
  "trust_multiplier_fp": "0x1bc16d674ec80000",
  "trust_share_fp": "0x214e8348c4f0000",
  "trust_decay_fp": "0xb1a2bc2ec500000",
  "precision_scale": "0xde0b6b3a7640000",
  "total_pool": "0xd3c21bcecceda1000000",
  "trusted_seed_dids": ["did:plc:<seed1>", "did:plc:<seed2>"],
  "w_follow_fp": "0x2c68af0bb140000",
  "w_badge_fp": "0x6f05b59d3b20000",
  "w_eval_fp": "0xde0b6b3a7640000",
  "w_attrib_fp": "0xb1a2bc2ec500000",
  "ack_boost_fp": "0x1bc16d674ec80000",
  "unacked_attrib_fp": "0x6f05b59d3b20000",
  "pds_attested_weight_fp": "0x6f05b59d3b20000",
  "lane2_max_head_age": 2419200
}
```

`paramsHash` hashes these 17 words in this order (with `trusted_seed_dids` folded to a `seedSetRoot`
over the sorted seed nodeIds); it is golden-locked four ways (`hypercerts_core::compute::params_hash`).

### How a params update flows

1. Edit `params.json`, recompute `HC_PARAMS_HASH = trustgraph-prover hypercerts paramshash <hypercerts_input.json>`.
2. Propose `setParamsHash(HC_PARAMS_HASH)` through the **operational timelock**.
3. From the next checkpoint, `submitProof` binds the new hash: prove with the same `params.json` you
   hashed (a mismatch reverts). Seed-set edits, weight tweaks, and the k-epoch horizon all ride this
   path; **none** of them touch the guest or the vkey.

---

## Score-bundle API

The indexer serves `{nodeId, score, proof[]}` bundles so Hypercerts' apps get ranking + a merkle proof
**without running any infrastructure** (HYPERCERTS_ATPROTO_PLAN §10.3). It is a convenience over the
canonical interface (the on-chain root + proofs), never a second source of truth: every bundle carries
the proof and root, so a consumer verifies it against the chain and can ignore the endpoint entirely.

- **Routes** (`indexer/src/api/hypercerts.ts`, mounted at `/hypercerts` in `src/api/index.ts`):
  - `GET /hypercerts/score/:nodeId` — bundle at the current root of the single instance
    (`?snapshot=0x…` / `?root=…` override).
  - `GET /hypercerts/:snapshot/score/:nodeId` and `GET /hypercerts/:snapshot/:root/score/:nodeId`.
  - `GET /hypercerts/roots?snapshot=0x…` — known roots, newest first.
- **Proof** is rebuilt with the guest's exact OZ StandardMerkleTree over the **same leaf set the guest
  emits** — unified `keccak(nodeId, value)` leaves for every scored node **plus** v1
  `keccak(address, value)` leaves for `link.evm`-bound nodes (`indexer/src/api/hypercerts-tree.ts`, a
  documented port of `frontend/lib/pagerank/merkle.ts` + `recompute.ts`). The API cross-checks the
  recomputed root against the on-chain `outputRoot` before serving (409 on mismatch).
- **Data source**: the `offchain.hypercerts_metadata` + `offchain.hypercerts_score` tables (the lane-2
  twins of `merkle_metadata`/`merkle_entry`). Their ingestion (`ingestHypercertsScores` in
  `indexer/src/anchor.ts`) runs on each hypercerts `MerkleRootUpdated`: it fetches the pinned blob at
  the event's CID, reads DID labels + `link.evm` bindings from the prover's sidecar bundle
  (`HYPERCERTS_BUNDLE_PATH`, written by `hypercerts execute`/`prove`), rebuilds the guest's output
  tree, and only upserts rows once the rebuilt root reproduces the on-chain `outputRoot`. With no
  ingested rows the routes 404. The proof-construction logic is also verified independently by
  `indexer/src/api/hypercerts-tree.test.ts` (`node --test`). (`skipped_node` ingestion remains a
  documented stub — see `ingestSkippedNodes` in the same file.)

---

## Notes / limits (pilot)

- **Lane-2-only.** Lane 1 is the empty accumulator; the guest asserts `acc = 0, leafCount = 0`. If EAS
  edges are ever wanted, that is a different accumulator and a params/guest decision, not a config flip.
- **Node identity** resolves through `app.certified.link.evm` DID↔address bindings, verified in-guest
  both directions. Satellite (DID-only) nodes get scores and proofs; on-chain claiming requires binding.
- **Real proving** needs the Succinct prover network or a 16–32 GiB box (`--features native-gnark` for
  the Groth16 wrap); `SP1_PROVER=cpu` on a small box OOMs. Pilot-scale cost is single-digit dollars per
  epoch, monolithic (Partner Brief / plan §8).
- **Privacy is out of scope**: atproto records are public by construction.
