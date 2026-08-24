# Trust composition contract architecture

> Internal implementation reference. This page is not part of the public product documentation.

`trust-compose` is a separate program that blends 2–8 already-proven same-chain allocation
outputs. It never imports raw vouches and never changes an existing source instance. The Rust/SP1
semantics and exact `TGCP`/`TGCM` encodings are described in the
[implementation record](../../../research/composition/README.md); this page describes how the
onchain capture and control plane make those inputs authoritative.

## Contract set

| Contract                          | Responsibility                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompositionSourceAdapterFactory` | Immutably pins the canonical instance registry, deploys provenance-pinned adapters only from that directory, and provides the append-only authenticity check that rejects ABI lookalikes. |
| `CompositionSourceAdapter`        | Pins a registry row, source controller, snapshot/verifier bytecode, SP1 vkey, lineage/family/output kind, and reviewed deployment-provenance digest.                                      |
| `CompositionSourceAccumulator`    | Pulls the active adapters in source-ID order, enforces availability/freshness/bounds, encodes exact `TGCM`, and stores it under a standard checkpoint.                                    |
| `TrustComposeParamsController`    | Validates complete `TGCP` proposals, timelocks them, and atomically advances the accumulator policy, snapshot params hash, and registry copy.                                             |
| `TrustComposeFactory`             | Creates and registers an isolated accumulator/snapshot/controller instance using the dedicated composition verifier and vkey.                                                             |

`MerkleSnapshot` also exposes an additive `IMerkleSnapshotProvenance` interface. A snapshot meant
to become a composition source constitutionally opts in once, before its first accepted state.
Every factory and the direct `DeployNetwork` script perform this opt-in inside the creating
transaction, since no later actor can (a governed instance's constitutional Safe cannot act before
its first root, and after the first root the window is closed forever). Every subsequently
accepted state records its checkpoint ID, acceptance block, pinned params hash, verifier address,
verifier runtime code hash, and optional `programVKey()`. The opt-in cannot be disabled.
Pre-existing snapshots that never opted in retain the legacy proof-submission storage/gas path;
the existing `MerkleState` struct and `IMerkleSnapshot` consumer ABI are unchanged.

## Atomic capture

`MerkleSnapshot.trigger()` reads the composition accumulator and then calls its `checkpoint()` in
one transaction. Both paths rebuild the same canonical manifest from authenticated `view` calls,
and Ethereum transactions cannot interleave a source update between them. The header commits the
current chain and `captureBlock = block.number`; every record commits:

```text
sourceId, snapshot, familyId, programId,
stateIndex, freezeBlock, outputRoot, blobSha256, cidDigest, totalValue,
weight, maxAgeBlocks, required
```

The accumulator is `sha256(exact TGCM bytes)` and `leafCount` is the source count. Each checkpoint
stores the full preimage, not only an event or digest, so a prover can recover it with
`getCaptureManifest(checkpointId)` after indexer loss. The checkpoint also pins its policy version
and adapter-set hash plus every source checkpoint ID. `MerkleSnapshot` retains each accepted state
by checkpoint even when two freezes share a block, and each adapter's `readCheckpoint(id)`
re-authenticates that exact historical state/proof/config record. A later source update cannot
alter those bytes. An unchanged source at a later trigger keeps the same state index but receives
the new capture block, which makes the new checkpoint distinct and honest.

Capture fails before checkpoint creation if a required source has no accepted state, has an empty
root/blob/CID/total, exceeds uint64/uint128 encoding bounds, comes from the future, or is older than
its policy's `maxAgeBlocks`. It also fails if the registry row/controller changed, snapshot or
verifier code changed, the accepted state used another verifier/vkey, or the adapter was not
created by the configured adapter factory.

V1 accepts only required same-chain `allocation` outputs from one admitted non-composition program
ID. Source IDs must be ascending, snapshots and adapters unique, weights positive and sum to
`1e18`, and the total count is 2–8. Composite sources, cross-chain sources, optional sources, and
unreviewed adapter contracts are deliberately excluded.

## Policy lifecycle and recovery

A proposal transaction carries the complete canonical `TGCP` bytes and adapter array. The
controller stores their commitments and a metadata digest, assigns a never-reused version, and
enforces the factory-configured delay. The owner may cancel while preserving the cancelled version
record. After the delay, anyone may activate by supplying the exact proposal preimage; a mismatch
reverts.

Activation installs the complete accumulator policy and updates the snapshot and instance-registry
params commitments in one transaction. Reverting any leg reverts all legs. A rollback is a new
proposal containing an older recovered preimage, so history is appended rather than rewritten.
Adapter-only recovery is also supported: when canonical `TGCP` bytes are unchanged, the reviewed
adapter set and version history advance while the unchanged guest params hash stays untouched.
Controller ownership uses OpenZeppelin's two-step transfer.

The manifest and adapter arrays are intentionally recoverable from transaction calldata instead of
being duplicated in controller storage. Version commitments record proposal, activation, and
cancellation times plus status, policy root/count, exact-byte SHA-256, adapter-set hash, params
hash, and metadata digest.

## Bounds and measured gas

The production test persists exact checkpoint manifests and their policy/adapter identities, and
measures approximately 677,312 gas at two sources and 1,916,283 gas at eight sources in the
repository's optimized IR Foundry profile.
The maximum includes all authenticated reads and durable `TGCM` storage. Permissionless triggering
remains bounded by the hard eight-source ceiling and the instance's fixed epoch schedule.

No production address is published yet. The dedicated development vkey is
`0x002781fb8a17a5586cec2eb47f891d9d292b25f9547e8f0a0309b67efb82d641`.
