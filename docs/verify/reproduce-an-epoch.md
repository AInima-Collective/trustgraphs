# Reproduce an epoch from public data

Every trustgraphs score can be recomputed by anyone, from public data alone. That is the product
claim this page turns into a procedure: you do not have to trust the party who ran the prover,
because you can check the receipt.

Three properties make this possible, and each is pinned on-chain:

- **The complete input history is on the chain.** Every attested edge is folded into an
  on-chain chained-hash accumulator (`AttestationAccumulator`), and each epoch's checkpoint
  pins the exact input set: the accumulator value, the leaf count, and the block. Nothing the
  prover consumed can be hidden, and nothing can be silently omitted: an input set that
  doesn't re-fold to the checkpointed accumulator is rejected.
- **The scoring parameters are pinned by hash.** The proof is only valid under the
  `paramsHash` the chain pinned when the checkpoint froze, so the operator cannot quietly
  compute with different parameters. See the [algorithm spec](../concepts/algorithm.md) for
  what the parameters mean.
- **The program is pinned by verification key.** The on-chain verifier
  (`SP1JournalVerifier`) holds an immutable `programVKey` that identifies one exact guest
  binary. A proof from any other program, including a subtly modified one, does not verify.

Put together: if every server we operate vanished tomorrow, anyone holding this repository and
an RPC endpoint could reconstruct the inputs, recompute the scores, re-prove them, and check
the result against the chain. This page walks through doing exactly that.

**Honesty note on what is exercisable today:** there is no production chain deployment yet
(see [addresses and vkeys](./addresses-and-vkeys.md)). Both procedures below run today against
a local anvil deployment or a mainnet fork, which you can stand up with
[`build/setup.md`](../build/setup.md) and [`build/quickstart.md`](../build/quickstart.md). The
commands are the same ones a third party will run against a real chain once one exists; only
the RPC URL changes.

## Reproducing a trust-graph epoch

The flagship [trust-graph program](../build/trust-graph/runbook.md) ingests EAS attestations
(lane 1: on-chain attested data). The public inputs for an epoch are:

1. **The EAS attestation events** and the accumulator's `EdgeFolded` events, from any RPC.
2. **The on-chain checkpoint**: `MerkleSnapshot.trigger()` freezes `(acc, leafCount, block)`;
   the epoch you are checking names its checkpoint id.
3. **The governance-pinned params** (`params.json`), whose hash must equal the `paramsHash`
   pinned at that checkpoint. On a controller-backed network the full tuple is readable
   on-chain from `TrustgraphsParamsController.getCurrentParams()`.

The procedure:

```bash
# 0. Build the pinned tools: the SP1 guest ELFs and the prover host.
task zk:build

# 1. Reconstruct the checkpoint's exact edge set from chain events. The exporter
#    self-verifies that the reassembled set re-folds to the checkpointed accumulator
#    value and fails loudly on any gap.
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json \
  --snapshot $MERKLE_SNAPSHOT
# writes .trustgraph/trust-graph/input.json
# $ACCUMULATOR is the EASIndexerResolver address. --snapshot is required: it is half of
# the journal's instanceDomain. For a long history add --from-block <deployBlock>.

# 2. Re-derive the root, offline. This runs the real guest ELF in the SP1 executor and
#    byte-asserts its committed public values against the native implementation.
cd zk/prover
SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  cargo run --release -- trust-graph execute ../../.trustgraph/trust-graph/input.json
# equivalently: task zk:execute PROGRAM=trust-graph INPUT=../../.trustgraph/trust-graph/input.json
# prints: journalDigest, outputRoot, paramsHash, ipfsHash, cid, totalValue,
#         skippedDigest, recipient, instanceDomain; writes blob.json, the
#         {account -> score} preimage of ipfsHash.

# 3. Compare against the chain:
cast call $MERKLE_SNAPSHOT "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))"
# the root field must equal your outputRoot; ipfsHash and the CID string must match too.
```

If step 3 disagrees, one of two things is true. Either your input assembly differs from the
checkpoint's (the exporter's re-fold self-check catches this), or the on-chain root does not
follow from the public inputs under the pinned params and vkey. The second case is what
`submitProof` makes impossible without breaking the proof system: it recomputes the journal
digest from the chain-pinned checkpoint, the pinned `paramsHash`, and the submitted outputs,
and reverts unless the SNARK binds exactly that digest.

Full operational detail, including proving and submitting a root yourself, is in the
[trust-graph runbook](../build/trust-graph/runbook.md); the unattended version of the loop is
[run a prover](../build/run-a-prover.md).

## Worked example: reproducing a hypercerts epoch (clean-room, lane 2)

The [hypercerts program](../build/hypercerts/runbook.md) is the fully-worked example for
lane 2: off-chain signed data (AT-proto repositories) anchored on-chain by digest rather than
attested via EAS. Its reproduction procedure was written for the pilot's
independent-reproduction requirement and is preserved here in full.

The guarantee this procedure makes good on: *for any pilot epoch, a third party holding only public
data — the chain, the archived CARs, and the witness bundle — can re-derive the root and the full
`skippedDigest` preimage, with no appeal to our indexer.* Every step
uses only public inputs and this repo's code; nothing consults our infrastructure.

### Inputs (all public)

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

### Procedure

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

### What this does and does not rely on

- **Does:** the chain (anchor log + checkpoints + journal binding), the CAR/PLC bytes
  (self-certifying: content-addressed, signature-chained to the DID), this repo at the
  proven vkey's commit, and the pinned SP1 toolchain for vkey equality checks.
- **Does not:** our indexer, our API, our prover, or any statement by us. The bundle is a
  *convenience* copy of re-servable-at-the-time public data; its content hashes let you
  cross-check any other archive of the same revs.

The pilot's independent-reproduction requirement is this document executed by someone who is
not us.

## Related

- [Golden vectors](./golden-vectors.md): how every port of the algorithm is pinned to the
  proven guest.
- [Addresses and vkeys](./addresses-and-vkeys.md): where the deployment constants will live.
- [`research/ZK_ARCHITECTURE.md`](../../research/ZK_ARCHITECTURE.md): why the system is
  shaped this way.
