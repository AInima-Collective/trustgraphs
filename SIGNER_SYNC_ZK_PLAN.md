# Safe Signer-Sync → ZK Replacement Plan

Status: **proposed** (design only — not yet implemented). The WAVS `safe-signer-sync`
component, `SignerSyncManagerModule.sol`, and their deploy/config were removed in the WAVS
teardown. This document specifies how to bring the capability back as a permissionless SP1 proof,
analogous to the ZK root producer (`packages/pagerank-core` → `zk/program` → `zk/prover` →
`MerkleSnapshot.submitProof`, verified by `SP1TrustGraphVerifier` behind `IZkVerifier`).

## 1. What it did (the capability we are replacing)

`safe-signer-sync` turned the TrustGraph score ranking into the owner set of a Gnosis Safe:

1. **Trigger:** `MerkleSnapshot` emits `MerkleRootUpdated(outputRoot, ipfsHash, ipfsHashCid, totalValue)`
   on every new proven root. That fired the component.
2. **Input:** it fetched the scored blob from IPFS (by CID from the event) and read the Safe's current
   owners via `getSigners()`/`getOwners()`.
3. **Compute:** ranked the top-N accounts by score, computed a target threshold
   (`ceil(target × N)` clamped to `[min, N]`), and diffed the desired owner set against the current
   one, emitting a batch of `SWAP_SIGNER` / `ADD_SIGNER` / `REMOVE_SIGNER` / `CHANGE_THRESHOLD` ops.
4. **On-chain effect:** WAVS operators signed the op batch; the aggregator submitted it to
   `SignerSyncManagerModule.handleSignedEnvelope`, which validated the operator quorum and executed
   the Safe owner-management calls (`addOwnerWithThreshold` / `removeOwner` / `swapOwner` /
   `changeThreshold`) through the Zodiac module.

Two correctness problems in the old implementation the ZK version should fix:

- **`prevSigner` fragility:** the off-chain diff assumed the returned owner array order equals the
  Safe's internal linked-list order. It need not — so `removeOwner`/`swapOwner` prev-pointers could be
  wrong. The ZK design moves the diff on-chain where the real linked list is available.
- **Blob-schema drift:** the component expected `{tree:[{account,reward,claimable,proof}]}`, but the
  ZK producer's canonical blob is the compact `{"0x<addr>":"<value>"}` (`pagerank-core::cid`). The ZK
  design derives the signer set from the *proven scores* directly, not from a loose JSON blob.

## 2. Design principle: prove the selection, keep the diff on-chain

The only step that needs a trust guarantee is **top-N selection + threshold** from a chain-pinned
score set. Owner-set *diffing* (swap/add/remove ordering, `prevSigner` pointers) is a function of live
Safe state and is cheap and safe to do on-chain. So:

- **In the guest:** prove the *target signer set + target threshold* is the correct deterministic
  function of the pinned input commitment (`acc`/`leafCount`) and pinned params.
- **On-chain:** the module reads current owners via `getOwners()`, computes the diff against the proven
  target set with correct linked-list pointers, and executes. No operator quorum, no off-chain ranking.

This mirrors how `MerkleSnapshot` binds a proven `outputRoot` and lets consumers prove membership later.

## 3. Recommended shape: fuse into the existing root proof

Re-running PageRank in a second proof is the dominant cost (already ≥16–32 GiB / prover network).
**Extend the existing root-producer guest** to also commit the signer selection, so one proof, one
checkpoint, and one PageRank run produce both the score root and the signer set — and they can never
drift apart because they share `acc`/`leafCount`.

### 3.1 `pagerank-core` additions

- New `SelectionParams { top_n: u32, min_threshold: u32, target_threshold_bps: u32 }`, folded into a
  `selection_params_hash` exactly like the existing `params_hash` (`encode.rs`).
- A pure `select_signers(scores, selection) -> (Vec<Address>, u256 threshold)`:
  - total order = **score descending, then address ascending** (deterministic tie-break so the set is
    unique and not prover-chosen),
  - take top-N, then **sort the chosen N addresses canonically (ascending)**,
  - `threshold = clamp(ceil_div(target_bps * N, 10_000), min_threshold, N)`, and guarantee `N ≥ 1`.
- `signer_set_root`: a commitment over the canonically-sorted N addresses. Reuse the
  `merkle::seed_set_root`-style hashing already in `pagerank-core::merkle`.

### 3.2 Journal / public inputs

Extend the current 7-field `Journal` with two fields (or add a parallel journal if you prefer a
separate proof):

| field | source |
|---|---|
| `acc` (bytes32), `leafCount` (u64) | chain-pinned input commitment (unchanged) |
| `paramsHash` (bytes32) | PageRank params (unchanged) |
| `selectionParamsHash` (bytes32) | `keccak256(topN, minThreshold, targetThresholdBps)` |
| `signerSetRoot` (bytes32) | commitment to the ordered target owner set |
| `targetThreshold` (uint256) | proven threshold |
| (existing) `outputRoot`, `ipfsHash`, `cidDigest`, `totalValue` | unchanged |

`journal_encoded` (static ABI words) and `journal_digest = keccak256(...)` carry over in style. The
contract rebuilds the digest from **stored** governance params + **submitted** `signerSetRoot`/
`targetThreshold`, so any mismatch fails verification — the same binding pattern as
`MerkleSnapshot.submitProof` and `SP1TrustGraphVerifier.verify`.

### 3.3 Host (`zk/prover`)

Add `selectionparamshash` and signer outputs to the existing host CLI (`vkey` / `paramshash` /
`execute` / `prove`). `execute` should cross-check the guest's committed signer set against a native
`select_signers` run, same as it already cross-checks the journal. If the signer proof is fused into
the root proof, no new vkey is needed; if it is a separate guest, mint a new immutable `programVKey`
for a second `SP1TrustGraphVerifier` instance.

## 4. New contract: `SignerSyncZkModule` (replaces `SignerSyncManagerModule`)

A Zodiac `Module` enabled on the Safe, consuming the proof permissionlessly. It replaces the
operator-quorum `handleSignedEnvelope` with `submitSignerProof`:

```solidity
function submitSignerProof(
    uint256 checkpointId,
    address[] calldata signers,   // the N target owners, canonical (ascending) order
    uint256 targetThreshold,
    bytes calldata proof
) external;
```

Logic (reusing `MerkleSnapshot`'s shape):

1. **Monotonicity:** reject `checkpointId <= lastApplied` (as `MerkleSnapshot`).
2. **Pin inputs:** `Checkpoint c = accumulator.getCheckpoint(checkpointId)` → `acc`, `leafCount`.
3. **Bind & verify:** `signerSetRoot = _root(signers)`; rebuild
   `journalDigest = keccak256(abi.encode(c.acc, c.leafCount, paramsHash, selectionParamsHash,
   signerSetRoot, targetThreshold))`; call `zkVerifier.verify(proof, journalDigest)`.
   (Passing `signers[]` explicitly and re-hashing keeps the journal small while guarding the array
   against manipulation.)
4. **On-chain diff (stays imperative):** read `getOwners()`, compute the swap/add/remove sequence
   against the *real* Safe linked list (correct `prevSigner`), then `exec` the owner calls and
   `changeThreshold(targetThreshold)`. Reuse the owner-management bodies from the old
   `_executeOperations` (recoverable from git history), but drive them from on-chain state.

Governance knobs mirror `MerkleSnapshot`: two-tier `AccessControl` timelocks own `zkVerifier`,
`accumulator`, `paramsHash`, and `selectionParamsHash`; the constitutional tier owns the verifier /
accumulator, the operational tier owns the params.

## 5. Hard parts / invariants

1. **Safe threshold invariant:** Safe requires `1 ≤ threshold ≤ ownerCount` at *every intermediate
   step*. The on-chain diff must order add/remove ops so the invariant holds throughout the batch, and
   never transiently drop below one owner.
2. **`prevSigner` correctness:** solved by diffing on-chain against the real linked list — but this is
   nontrivial Solidity and costs gas proportional to owner churn. This is the main reason to prove only
   the target set, not the op list.
3. **Determinism / ties:** the guest's total order must be total (score desc, address asc) so the
   proven set is unique regardless of prover.
4. **Liveness:** like the root producer, proving is delayed and racy; monotonic `checkpointId` gating is
   the model. Fusing both roots in one proof keeps the signer set and score root consistent.
5. **Never-empty owner set:** selection must guarantee `N ≥ 1`; the module must refuse a proof that
   would empty the Safe.

## 6. Frontend / indexer

- The Ponder `gnosis_safe` table (owners/threshold via Safe events) already surfaces the owner set and
  is unaffected — the UI keeps reading it. No WAVS dependency returns.
- The old `safe_signer_sync.template.json` config (top_n / min_threshold / target_threshold) becomes
  on-chain governance params behind the timelock; expose them via a small read + admin UI if desired.

## 7. Work-package sketch

- **WP-S1** `pagerank-core`: `SelectionParams`, `selection_params_hash`, `select_signers`,
  `signer_set_root`, golden vectors (Rust ↔ Solidity byte-parity, as with the root producer).
- **WP-S2** guest + host: commit `signerSetRoot` + `targetThreshold` (fused into the root guest);
  host `execute` cross-check.
- **WP-S3** `SignerSyncZkModule.sol`: `submitSignerProof`, on-chain diff, timelock governance, tests
  (unit + golden + Safe-invariant fuzz).
- **WP-S4** deploy: add the module to `DeployZodiacSafes.s.sol` (enable on the Safe, register params),
  wire into `deploy/env.ts`.
- **WP-S5** docs: fold into `ZK_ARCHITECTURE.md`; retire this plan file.
