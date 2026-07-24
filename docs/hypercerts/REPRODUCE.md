# Reproducing a hypercerts epoch from public data (clean-room)

The build plan's "Done when" #3: *for any pilot epoch, a third party holding only public data — the
chain, the archived CARs, and the witness bundle — can re-derive the root and the full
`skippedDigest` preimage, with no appeal to our indexer.* This is the procedure. Every step
uses only public inputs and this repo's code; nothing consults our infrastructure.

## Inputs (all public)

1. **Chain state** (any RPC for the instance's chain):
   - the instance's contract set — discoverable on-chain via `InstanceRegistry` (or the
     deploy JSON): `MerkleSnapshot`, `AnchorRegistry`, `SP1JournalVerifier`;
   - the epoch's checkpoint id and its `anchorCheckpoints(id)` = `(anchorAcc, anchorCount)`;
   - the full `HeadAnchored` event log of the `AnchorRegistry` up to the checkpoint block.
2. **The witness bundle** (published per epoch; also reconstructible from the PDSes while
   they still serve the revs, and from anyone's CAR archive after): per registered DID, the
   repo CAR at the consumed rev and the PLC audit log. `trustgraph-prover witness fetch`
   produces/archives these; the bundle manifest carries content hashes.
3. **The governance-pinned params** (`params.json`) whose hash equals the on-chain
   `paramsHash` — publishable bytes; verify with `prover hypercerts paramshash params.json`.

## Procedure

```bash
# 0. Build the tools from the pinned source (the proven epoch names its vkey; the vkey
#    pins the guest; the guest pins this code).
cargo build --release -p input-exporter && (cd zk/prover && cargo build --release)

# 1. Reconstruct the anchor log from chain events and self-check the re-fold against the
#    checkpointed anchorAcc (fails loudly on any gap):
#    - collect HeadAnchored(foldIndex, nodeId, envelopeKind, head, dataCommitment, ts)
#      in fold order up to the checkpoint block;
#    - fold anchor leaves (zk_core::anchor::anchor_leaf) and compare to
#      MerkleSnapshot.anchorCheckpoints(checkpointId).
#    The exporter's lane-2 path does exactly this (--anchor-registry + --snapshot).

# 2. Assemble the GuestInput: params + the reconstructed anchors + the bundle's witnesses.
#    (For the pilot, the published bundle IS this input's witness half; the anchors half
#    comes from step 1 — never from the bundle.)

# 3. Re-derive, offline:
cd zk/prover && SP1_PROVER=mock cargo run --release -- hypercerts execute ../../.trustgraph/hypercerts/hypercerts_input.json
# prints: outputRoot, ipfsHash, cid, totalValue, skippedDigest — and writes
#   hypercerts_blob.json   (the {nodeId -> score} preimage of ipfsHash)
#   hypercerts_skips.json  (the FULL skippedDigest preimage: every (nodeId, reason,
#                           epochObserved) the guest committed — rule-Φ and record-level)

# 4. Compare against the chain:
cast call $SNAPSHOT "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))"
#    outputRoot must match; recompute skippedDigest from hypercerts_skips.json (fold of
#    sorted skip leaves — zk_core::anchor::skipped_digest) and compare to the submitted
#    value; keccak of the CID string and sha256 of the blob must match the journal fields.
```

A mismatch at step 4 means the on-chain epoch does not follow from the public inputs —
which, because `submitProof` binds the journal digest to the SNARK, can only happen if you
assembled different inputs (wrong rev, wrong anchor set) — re-check step 1's self-check —
or the prover consumed data you don't have, which the anchor log makes impossible to hide:
every consumed head is on-chain, and every skipped one is in `hypercerts_skips.json`.

## What this does and does not rely on

- **Does:** the chain (anchor log + checkpoints + journal binding), the CAR/PLC bytes
  (self-certifying: content-addressed, signature-chained to the DID), this repo at the
  proven vkey's commit, and the pinned SP1 toolchain for vkey equality checks.
- **Does not:** our indexer, our API, our prover, or any statement by us. The bundle is a
  *convenience* copy of re-servable-at-the-time public data; its content hashes let you
  cross-check any other archive of the same revs.

The independent-reproduction requirement of the pilot (M5 exit) is this document executed
by someone who is not us.
