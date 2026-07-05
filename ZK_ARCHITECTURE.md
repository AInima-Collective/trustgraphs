# ZK TrustGraph — A Trustless Compute Seam

**Status:** ✅ **Implemented (v1).** This spec is realized in `packages/pagerank-core` (canonical
fixed-point PageRank + encodings), `zk/program` (SP1 guest), `zk/prover` (host), the on-chain
`AttestationAccumulator` / `MerkleSnapshot.submitProof` / `SP1TrustGraphVerifier`, and the frontend
`frontend/lib/pagerank` port. Guest output is cross-checked byte-identical against native Rust,
Solidity (`test/unit/GoldenVectors.t.sol`), and TypeScript. Real STARK/Groth16 proving requires
≥16–32 GiB or the Succinct prover network — see [`zk/RUNBOOK.md`](./zk/RUNBOOK.md). Privacy remains
out of scope for v1.
**Scope:** How to replace WAVS as the *root producer* with a zero-knowledge proof of correct Trust-Aware PageRank, **without** touching EAS, `MerkleSnapshot`'s storage/verification API, the Zodiac governance module, the distributor, or the frontend proof format.
**Picking a producer?** Start at [`PRODUCER_TRADEOFFS.md`](./PRODUCER_TRADEOFFS.md) for the WAVS / optimistic / ZK side-by-side and decision tree.
**Relationship to [`PRIVACY_ARCHITECTURE.md`](./PRIVACY_ARCHITECTURE.md):** This is that document's Model C / Phase 3 made concrete for the *public-input* case. The seam specified here is the reusable substrate the privacy roadmap assumes — under encryption, only the guest's input-decoding step changes; the accumulator, journal, verifier, and write path are identical.

---

## 1. Executive summary

TrustGraph today gets its integrity from a **staked WAVS operator set**: operators compute Trust-Aware PageRank off-chain, an aggregator collects signatures, and `MerkleSnapshot.handleSignedEnvelope` writes the `{account → score}` root on-chain after `_serviceManager.validate(...)`. The guarantee is "an honest operator quorum computed this correctly."

Because TrustGraph's inputs (EAS attestations) are **public** and Trust-Aware PageRank is **deterministic**, we can replace that guarantee with a stronger, operator-free one: a **succinct proof that `root == PageRank(the exact on-chain edge set, canonical parameters)`**. A permissionless prover posts `(root, proof)`; a verifier contract checks it and writes through the *same* state path the WAVS handler used — reusing every existing consumer, not a new store — with WAVS itself removed (§7, Decision 5). No operator set, no aggregator, no bond, no challenge window, instant finality.

Two pieces make this sound:

1. **An input accumulator** in the EAS resolver, so the chain holds a trustless commitment to *exactly which edges existed* at snapshot time. Without this, a proof of `root == PageRank(E)` is worthless because the prover chose `E`.
2. **A verifier seam** on `MerkleSnapshot` that gates a write on a valid proof instead of an operator signature, binding the proof to (a) the accumulator's committed input set and (b) a governance-pinned parameter set.

The design deliberately keeps the on-chain contracts **dumb** and the guest **canonical**: the chain folds a raw event log and checks a proof; every semantic decision (dedup, last-write-wins, self-loop exclusion, weight caps, fixed-point PageRank) lives in exactly one place — the guest, which is `packages/pagerank` compiled to a zkVM.

---

## 2. Background: the current write path

| Stage | Where | What happens |
|---|---|---|
| Attestation | EAS, schema `string comment, uint256 confidence` | "Alice vouches for Bob." Public, timestamped. Resolver (`EASIndexerResolver.onAttest`) emits index events. |
| Trigger | `MerkleSnapshot.trigger()` | Emits `MerklerTrigger(triggerId)`; WAVS wakes the component. |
| Computation | WAVS operators, `components/trust-graph/` → `packages/pagerank` | `f64` Trust-Aware PageRank, `max_iterations` with `max_delta < tolerance` early-exit (`graph_computer.rs:290`); output quantized to `u64` at `1e6` (`graph_computer.rs:325`). |
| Commitment | `MerkleSnapshot.handleSignedEnvelope` → `_updateState` | `_serviceManager.validate(...)`, then writes `MerkleState{root, ipfsHash, ipfsHashCid, totalValue}`. Leaf = `keccak256(keccak256(abi.encode(account, value)))` (`MerkleSnapshot.sol:129`). |
| Consumption | `MerkleGovModule`, distributor, frontend | Merkle inclusion against `states[...]`. Historical snapshots retained. |

**The seam already exists.** `_updateState` (`MerkleSnapshot.sol:76`) is the single writer. Today one producer feeds it — the WAVS handler. We **replace** that producer with a proof-gated one. WAVS is removed, not run beside it.

```
   _updateState()  ◄─────  submitProof   ← ZK proof   (sole producer)
   (single writer)

   removed:  handleSignedEnvelope · IWavsServiceHandler · _serviceManager   ← WAVS operator path
```

Cutting WAVS entirely rather than dual-writing is deliberate and load-bearing: the guest is **fixed-point** and WAVS is **`f64`**, so the two producers compute *different roots for identical inputs*. Because `_updateState` overrides state per block (`MerkleSnapshot.sol:82-96`), running both would let the committed root flip with write order. It is one producer or the other — never both. See §7 Decision 5, and §8 for how to validate the guest before the cutover without a parallel writer.

---

## 3. Contract A — `AttestationAccumulator`

Folded into the resolvers (`EASIndexerResolver`, `AttesterEASIndexerResolver`), which are the only choke point every edge passes through. This converts *prover-chosen* input into *chain-pinned* input.

### 3.1 Primitive: an ordered running hash

The proof statement is "consume the **whole** edge set," not "prove one edge is a member." For whole-set consumption a **chained hash** is the minimal correct primitive — completeness falls out for free (the guest rehashes all leaves and must reproduce the stored `acc`). An incremental Merkle tree only earns its keep if a *future* consumer needs succinct inclusion proofs; it is a drop-in swap behind the same interface if that day comes. (See §7, Decision 3.)

```solidity
abstract contract AttestationAccumulator {
    bytes32 public acc;        // acc_i = keccak256(abi.encode(acc_{i-1}, leaf_i)); acc_0 = 0
    uint64  public leafCount;

    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    Checkpoint[] public checkpoints;

    event EdgeFolded(uint64 indexed index, bytes32 leaf, bytes32 acc); // optional; convenience for provers/indexers
    event InputsCheckpointed(uint256 indexed id, bytes32 acc, uint64 leafCount);

    // kind: 0 = attest, 1 = revoke
    function _fold(uint8 kind, address attester, address recipient, bytes32 uid, bytes32 dataHash) internal {
        bytes32 leaf = keccak256(abi.encode(kind, attester, recipient, uid, block.timestamp, dataHash));
        acc = keccak256(abi.encode(acc, leaf));
        emit EdgeFolded(leafCount++, leaf, acc);
    }

    function _checkpoint() internal returns (uint256 id) {
        id = checkpoints.length;
        checkpoints.push(Checkpoint(acc, leafCount, uint64(block.number)));
        emit InputsCheckpointed(id, acc, leafCount);
    }
}
```

### 3.2 Resolver wiring

The resolver that feeds the graph gets the same two added lines; nothing else about it changes. In the default deployment (`DeployNetwork.s.sol:102`) that is a single `EASIndexerResolver` on one schema, and PageRank consumes exactly that one schema (`eas_pagerank.rs:112` builds the graph for a single `config.schema_uid`) — so **one resolver = one ordered log = one `acc`**. (`AttesterEASIndexerResolver` / `PayableEASIndexerResolver` are alternates, not co-feeders.)

```solidity
function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
    emit IEAS.Attested(a.recipient, a.attester, a.uid, a.schema);
    emit AttestationAttested(address(_eas), a.uid);
    _fold(0, a.attester, a.recipient, a.uid, keccak256(a.data));   // ← added
    return true;                                                    // (AttesterEAS...: `== _targetAttester`)
}

function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
    emit AttestationRevoked(address(_eas), a.uid);
    _fold(1, a.attester, a.recipient, a.uid, keccak256(a.data));   // ← added
    return true;
}
```

> **Invariant — one accumulator per checkpoint.** A checkpoint freezes a *single* `(acc, leafCount)`, so every edge feeding a given graph must flow through *one* ordered log. `AttestationAccumulator` is a mix-in with per-contract storage; if you ever point PageRank at more than one resolver/schema, do **not** give each its own `acc`. They must share one accumulator (deploy it as a standalone singleton the resolvers call into) or the journal must bind every contributing `acc`. The default single-resolver topology needs neither — this note exists so the mix-in is not copied into a second live feeder by reflex.

### 3.3 Deliberate design points

- **Raw log, not reconciled state.** The chain does **not** dedup, apply last-write-wins, drop self-loops, or cap weights. It folds the raw ordered event log. All reconstruction happens **inside the guest**, because the guest *is* `eas_pagerank.rs` compiled to the zkVM (which already timestamp-sorts + overrides at `eas_pagerank.rs:135`, excludes self-loops per `PLAN.md`, and caps weights). Keeping the chain dumb means the accumulator **cannot disagree** with the compute logic — there is exactly one definition of "what the edges mean."
- **`dataHash`, not raw data.** We commit `keccak256(a.data)` and the guest supplies the preimage (recovered from EAS storage via `getAttestation(uid)`). One storage word per attest; the confidence/comment decode stays schema-coupled to nothing on-chain.
- **`block.timestamp` is folded in**, because the sort/override logic is timestamp-ordered — the guest needs the same timestamps the chain saw, so they must be committed, not prover-supplied.
- **Fold order is the canonical tie-break.** `leafCount` gives each edge a strictly increasing index in fold order. The reconciliation sort is timestamp-keyed and many edges share a block timestamp, so the guest breaks last-write-wins ties by fold index — a stable sort over fold order, i.e. the total order `(timestamp, fold index)`. The chain, the guest, and the browser recompute must all agree on this order (see §4.1 and §8).
- **Checkpointing freezes a snapshot.** New attestations keep moving `acc`; a `Checkpoint` freezes `(acc, count, block)` so an in-flight proof has a stable target. Wire `_checkpoint()` into `MerkleSnapshot.trigger()` so the existing trigger → compute → submit lifecycle is preserved 1:1.
- **Cost:** ~1 warm SLOAD + 2 keccak + 1 SSTORE per attestation (~8–12k gas). This is the price of trustless inputs and the only sound option (see §7, Decision 4). It is small relative to EAS's own attestation base cost.

---

## 4. Contract B — the verifier seam on `MerkleSnapshot`

```solidity
interface IZkVerifier {
    // SP1: verify(vkey, publicValues, proof). RISC Zero: verify(seal, imageId, journalDigest).
    // Abstracted so the stack choice is reversible.
    function verify(bytes calldata proof, bytes32 journalDigest) external view; // reverts on invalid
}

// added to MerkleSnapshot
IZkVerifier public zkVerifier;
bytes32 public imageId;        // guest program id / vkey — defines "correct computation"  (constitutional)
bytes32 public paramsHash;     // keccak(damping, tolerance, maxIters, seedSetRoot, totalPool, weightCaps, precisionScale)  (operational)
uint256 public lastAppliedCheckpoint;

function submitProof(
    uint256 checkpointId,
    bytes32 outputRoot,
    bytes32 ipfsHash,
    string calldata ipfsHashCid,
    uint256 totalValue,
    bytes calldata proof
) external {
    require(checkpointId > lastAppliedCheckpoint, "stale");   // monotonic; an older snapshot cannot clobber a newer one
    Checkpoint memory c = checkpoints[checkpointId];

    // The journal is the ENTIRE ABI between contract and guest. Bind all of it —
    // including the CID *string* consumers fetch by, whose 32-byte digest alone is otherwise unproven.
    bytes32 journal = keccak256(abi.encode(
        c.acc, c.leafCount,                 // which inputs   (chain-pinned)
        paramsHash,                         // which params   (governance-pinned)
        outputRoot, ipfsHash,               // scored tree + canonical-blob digest
        keccak256(bytes(ipfsHashCid)),      // ...and the CID string that points at that blob
        totalValue                          // summed points
    ));
    zkVerifier.verify(proof, journal);      // reverts if invalid

    lastAppliedCheckpoint = checkpointId;
    // File at the checkpoint's INPUT-FREEZE block, not the submission block, so
    // "score as of block N" stays honest despite permissionless, delayed, racy proving.
    _updateStateAtBlock(c.blockNumber, outputRoot, ipfsHash, ipfsHashCid, totalValue);
    emit MerkleRootUpdated(outputRoot, ipfsHash, ipfsHashCid, totalValue);
}
```

`_updateStateAtBlock(uint256 blockNumber, …)` is `_updateState` with the block it keys on lifted to a parameter (today it hard-codes `block.number`, `MerkleSnapshot.sol:82`). Monotonic `checkpointId` application ⇒ monotonic freeze blocks ⇒ `stateBlocks` stays ascending, so the existing binary-search-over-history invariant holds unchanged. `c.blockNumber` is read from chain-pinned checkpoint storage, so it needs no journal binding.

```solidity
// unchanged consumers; only the keying block is now explicit
function _updateStateAtBlock(uint256 blockNumber, bytes32 root, bytes32 ipfsHash, string memory ipfsHashCid, uint256 totalValue) internal {
    // ... identical body to _updateState, using `blockNumber` in place of `block.number`
}
```

### 4.1 What the guest must commit to (the contract ⇄ guest interface)

The `journal` above is the complete interface. The guest, given preimages for all `leafCount` leaves plus the private inputs (seed list, `data` preimages):

1. Recompute the chained `acc` from the leaves; assert it equals `c.acc` and that the leaf count equals `c.leafCount`. → **completeness + integrity of inputs**
2. Decode each `data`; apply revoke / last-write-wins / self-loop filter / weight cap exactly as `eas_pagerank.rs`, resolving last-write-wins ties by the total order `(timestamp, fold index)` (§3.3). → **deterministic reconciliation**
3. Assert the supplied params (incl. `seedSetRoot` over the sorted seed list) hash to `paramsHash`. → **no favorable-parameter cheating**
4. Run **fixed-point** Trust-Aware PageRank (the `f64` → fixed-point port; see `PRIVACY_ARCHITECTURE.md` and the guest-diff scope).
5. Build the **exact** `keccak256(keccak256(abi.encode(account, value)))` leaf tree → `outputRoot`; hash the canonical IPFS JSON → `ipfsHash`; encode its CID string → `ipfsHashCid`; sum points → `totalValue`.
6. Write `(acc, leafCount, paramsHash, outputRoot, ipfsHash, keccak256(ipfsHashCid), totalValue)` to the journal.

The snapshot's block is *not* in the journal — it is read on-chain from the chain-pinned checkpoint (`c.blockNumber`), so the guest never commits to it.

Because step 5 reproduces the on-chain leaf format (`MerkleSnapshot.sol:129`), **every existing consumer keeps working with zero client changes** — `MerkleGovModule` votes, distributor claims, and frontend inclusion proofs are all unaffected.

### 4.2 IPFS

`ipfsHash` is *proven* to match the scored data (the guest hashes the same canonical JSON it commits to `outputRoot`), and the CID *string* consumers fetch by is now bound in the journal too (`keccak256(bytes(ipfsHashCid))`) — so a valid proof cannot ship a digest that matches the data alongside a CID string that resolves elsewhere. Availability itself — someone actually pinning the blob — remains a liveness assumption, identical to today. The proof upgrades "trust the pinner computed honestly" to "trust the pinner is online."

---

## 5. End-to-end lifecycle

```
1. Users attest / revoke on EAS
      → resolver._fold(...) advances (acc, leafCount)                    [every tx, ~10k gas]

2. Anyone calls MerkleSnapshot.trigger()
      → _checkpoint() freezes (acc, leafCount, block) as checkpoint N     [snapshot inputs]

3. A permissionless prover:
      - reads all leaves up to checkpoint N (events + EAS getAttestation)
      - runs the SP1 guest → proof + (outputRoot, ipfsHash, totalValue)
      - pins the {account, score} JSON to IPFS

4. Anyone calls submitProof(N, outputRoot, ipfsHash, cid, totalValue, proof)
      → zkVerifier.verify(...) checks root == PageRank(checkpoint N inputs, params)
      → _updateStateAtBlock(checkpoint N's block, ...)  writes the snapshot [filed at input-freeze block]

5. Governance / rewards / frontend read states[...] as before            [unchanged]
```

WAVS is gone: `submitProof` is the only producer, so there is no writer contention. `lastAppliedCheckpoint` still guards against a stale checkpoint clobbering a newer one when provers race, and results are filed at each checkpoint's freeze block (step 2), so historical `states[...]` line up with input time rather than proof-submission time.

---

## 6. Trust surface

| Element | Controlled by | Risk if abused | Mitigation |
|---|---|---|---|
| `acc` folding | Nobody — deterministic in resolver | none; pure function | — |
| Input completeness | The chained hash | none if guest reproduces `acc` | proven in-circuit |
| `imageId` / `zkVerifier` | **Constitutional** authority | redefine "correct PageRank" | long timelock, rare, high scrutiny |
| `paramsHash` (esp. `seedSetRoot`) | **Operational** authority | favorable seeds/damping | short timelock, governance, event-logged |
| IPFS availability | Whoever pins | liveness only (`ipfsHash` proven) | bounty / multiple pinners |
| Prover liveness | Permissionless | no root gets posted | anyone can prove; optional bounty from pool |

The honest one-line summary: this seam **moves trust from "an honest operator quorum computed it" to "governance honestly set the guest + params, and the SNARK did the rest."** Everything between those two governance knobs is trustless.

---

## 7. Resolved design decisions

### Decision 1 — `imageId` / `paramsHash` authority → **two-tier timelock**

These are the only two knobs that define truth, but they differ in risk and cadence, so split them:

- **Constitutional tier** — `imageId`, `zkVerifier`: changes what "correct PageRank" *means*. Rare, high-scrutiny, **long timelock (~14–30d)**, founding multisig → governance. A compromise here is total.
- **Operational tier** — `paramsHash` (damping, tolerance, `maxIters`, seed set, pool, weight caps, precision): changes at governance cadence, **short timelock (~2–7d)**, governance-controlled.

Rationale: seed rotation must not be gated behind a circuit-upgrade ceremony, and an operational-key compromise must **not** be able to swap the guest. The timelock delay is the load-bearing safety property — the window in which users can exit or challenge a malicious change before it applies to their scores. Implement with two `TimelockController`s (or one with role separation); start proposer = founding multisig, hand the operational proposer role to `MerkleGovModule` once stable.

> Circularity note: governance power derives from scores, which derive from `paramsHash`. A captured majority could entrench itself via the seed set. This is the standard DAO self-amendment risk; the timelock + a diverse, slowly-rotating seed set are the mitigations, not a cure.

### Decision 2 — zkVM stack → **SP1** (reversible)

SP1 proves the least-modified Rust (smallest port from `graph_computer.rs`), its `publicValues` map cleanly onto the `abi.encode` journal, and its keccak precompile lets the guest build the **exact** keccak `MerkleSnapshot` leaf format cheaply — so existing proofs keep working. Groth16-wrapped verify is ~250–300k gas. Low-conviction and fully reversible: the `IZkVerifier` seam means switching to RISC Zero changes only the verify signature and journal-digest encoding. RISC Zero's Steel (on-chain state reads in-guest) is *not* a differentiator here — the design deliberately supplies inputs via the accumulator rather than reading chain state in-circuit.

### Decision 3 — accumulator primitive → **chained hash now**

An incremental Merkle tree only buys succinct *inclusion* proofs, and there is no consumer that needs one. Whole-set consumption touches every leaf regardless, so a tree adds ~log₂(n) keccaks/attest and code complexity for zero present benefit. Keep the chained hash; revisit only when a feature needs "prove edge X was/wasn't in snapshot N" without replaying the log. The swap is behind `AttestationAccumulator` and does not touch the verifier or journal.

### Decision 4 — per-attest gas → **eager fold, accept ~8–12k**

Lazy batching is a trap: it either reintroduces a trusted committer or cannot prove completeness, because *something* on-chain must commit the count+hash or a prover can silently drop an edge. The fold **is** the trustlessness. It is small next to EAS's attestation base cost. Micro-optimizations: keep exactly two hot storage slots (`acc`, `leafCount`); the `EdgeFolded` event is optional convenience (provers can recover preimages from EAS's own state), so drop it if you want to shave a log.

### Decision 5 — WAVS coexistence → **complete replacement, not parallel**

Dual-writing WAVS (`f64`) and ZK (fixed-point) into the same per-block state slot is unsound: they produce *different roots for identical inputs*, and `_updateState` overrides per block, so the committed root would flip with write order. So cut WAVS at the seam — remove `IWavsServiceHandler`, `_serviceManager`, and `handleSignedEnvelope`; `submitProof` becomes the sole producer, and `trigger()` becomes the checkpoint function (its `MerklerTrigger` wake-event is now redundant — provers watch `InputsCheckpointed` — and can be dropped). The guest is validated **off-chain** before the cutover (§8), since there is no longer a live parallel writer to shadow it against.

### Decision 6 — result filing block → **checkpoint freeze block, not submission block**

`_updateState` today stamps state with `block.number` (`MerkleSnapshot.sol:82`). Under permissionless proving, submission is delayed and racy, so the submit-time block is a meaningless label for the snapshot. File results at the checkpoint's freeze block (`c.blockNumber`) instead, so `states[...]` mean "inputs as of block N" and governance's "score as of block N" stays honest. Monotonic `checkpointId` ⇒ monotonic freeze blocks ⇒ `stateBlocks` stays ascending, so the binary-search invariant is preserved for free.

---

## 8. Honest tradeoffs and open questions

- **Public-input caveat.** In the *public* case, an optimistic (bond + challenge-window) producer buys nearly the same trust for far less effort, precisely because inputs are re-derivable — specced out as the sibling design in [`OPTIMISTIC_ARCHITECTURE.md`](./OPTIMISTIC_ARCHITECTURE.md), which shares Contract A and the journal tuple verbatim and swaps only the write gate. ZK earns its cost here through **instant finality, no honest-watcher liveness assumption, no bonded capital**, and — decisively — because it is **the same machinery the privacy roadmap needs anyway** (optimism *cannot* extend to encrypted inputs — watchers have nothing to recompute — so private TrustGraph forces this design). If TrustGraph stays permanently public and finality latency is acceptable, prefer optimistic and keep the `IAdjudicator`→`IZkVerifier` upgrade seam; if privacy is on the roadmap, build this now and reuse it under encryption.
- **The fixed-point port is the bulk of the work, not a footnote.** `graph_computer.rs` runs `f64` Trust-Aware PageRank, normalizes to sum 1 by float division (`graph_computer.rs:298`), then scales by `1e6` in `distribute_points`. The guest must reproduce *all* of this in canonical fixed-point: the iteration, the `max_delta < tolerance` early-exit (`graph_computer.rs:289`), the normalization division, and the rounding spread across ~1k accounts. This **changes every account's score, weight, and reward** — a one-time spec migration, not a rounding nit. Side benefit: fixed-point is *more* deterministic than `f64`-in-WASM (which is not bit-reproducible across platforms), so consolidating to a single fixed-point implementation compiled to both the zkVM guest and the browser (`usePageRankComputer.ts`) removes an existing latent nondeterminism. Every contract interface above is additive; this is the real work item.
- **Last-write-wins ties are ordering, not rounding.** Same-block attestations share `block.timestamp`, and `eas_pagerank.rs:135` uses a stable sort by timestamp — so ties currently resolve to *processing order*. The guest must pin that to **fold index** (the accumulator's `leafCount` order), and the browser recompute must use the identical total order `(timestamp, fold index)`, or proven and locally-recomputed scores silently diverge for any account touched by a same-block override.
- **Validating the cutover without a parallel writer.** Removing WAVS (Decision 5) means you cannot A/B the two producers on-chain. Instead, before flipping: run the fixed-point guest off-chain over historical checkpoints and diff its scores against WAVS's `f64` output — expect small, bounded, explainable deltas; a large one is a port bug. Then run on a testnet deployment. The `imageId` timelock (Decision 1) is the last line of defense if a port bug reaches production.
- **Prover liveness / incentives.** `submitProof` is permissionless, but *someone* must run the prover. Same liveness need as an operator, now open to anyone; optionally fund a small posting bounty from the pool.
- **Proving cost at scale.** `iters × edges` fixed-point ops for N≈1k is low-millions of cycles — seconds-to-minutes on a prover network, a non-issue. The chained `acc` also costs N *sequential* keccaks in-guest; fine with SP1's keccak precompile at this size. Revisit both past ~100k accounts.
- **Snapshot semantics vs. governance.** Filing results at the checkpoint freeze block (Decision 6) makes historical `states[...]` mean "inputs as of block N", so a late proof cannot retroactively shift a live vote's weights. Still confirm proposals reference the checkpoint/state index they intend.
- **Metadata leakage** (attestation count, timing, node set) is public by construction here — a non-issue while public, but note it carries into the private design.

---

## 9. Recommendation

Build the seam as **resolver accumulator → checkpoint on `trigger()` → permissionless SP1 proof → verifier gate → `_updateStateAtBlock`**, cutting WAVS at the seam (Decision 5) and validating the guest off-chain before the cutover (§8). Split the two truth-defining knobs across a constitutional and an operational timelock. Treat the fixed-point guest port and the `usePageRankComputer.ts` reconciliation as the primary work item — they are the only places the *numbers* change; every contract interface above is additive.

---

## Appendix — files this design touches

- `src/contracts/eas/resolvers/EASIndexerResolver.sol` — add `AttestationAccumulator` mix-in + two `_fold` lines (the single schema resolver that feeds the graph; **not** the alternates, per the §3.2 one-accumulator invariant)
- `src/contracts/merkle/MerkleSnapshot.sol` — add `submitProof`, `zkVerifier`/`imageId`/`paramsHash`/`lastAppliedCheckpoint`, `_checkpoint()` in `trigger()`; refactor `_updateState` → `_updateStateAtBlock(blockNumber, …)` so proofs file at the checkpoint freeze block; **remove** `IWavsServiceHandler`, `_serviceManager`, `handleSignedEnvelope`
- `src/interfaces/merkle/IMerkleSnapshot.sol` — add `InputsCheckpointed`, `Checkpoint`, proof events/errors
- new `IZkVerifier` + SP1/RISC Zero verifier deployment
- `packages/pagerank/`, `components/trust-graph/src/` — fixed-point guest (separate scope)
- `frontend/hooks/usePageRankComputer.ts` — reconcile to the guest's fixed-point output
- governance: two `TimelockController`s owning the constitutional vs. operational setters
