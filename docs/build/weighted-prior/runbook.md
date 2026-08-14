# Weighted-prior rotation and recovery runbook

This is the administrator procedure for an already-created `trust-graph-weighted` instance. It
does not apply to binary-seed `trust-graph` controllers.

## Propose

Before signing, retain the exact canonical TGWP bytes and the provenance document whose digest is
being submitted. Pin the raw-CID mirror first. Locally recheck chain ID, count, address order,
positive weights, exact `1e18` sum, root, and SHA-256, then call:

```solidity
controller.proposePrior(manifest, metadataDigest)
```

Record the transaction hash and `PriorProposed` event. Verify the event names `version() + 1`, and
that its root, count, SHA-256, metadata digest, params hash, and `readyAt` equal the local preview.
Also verify that the snapshot and registry still expose the old active params hash. A proposal is
only a preview; it must not change proving inputs yet.

If a proposal is wrong, the controller owner calls `cancelPrior()` before activation. A cancelled
transaction remains in chain history, but it never becomes a parameter version. Submit a fresh
proposal; pending proposals cannot be overwritten.

## Activate

During the delay, every proving operator should retrieve the proposal transaction input and repeat
the checks above. After `readyAt`, anyone may call:

```solidity
controller.activatePrior(pendingVersion)
```

Confirm `PriorActivated`, then require these four values to be identical:

- `controller.currentParamsHash()`;
- `WeightedPriorParamsCodec.hash(controller.getCurrentParams())`;
- `MerkleSnapshot.paramsHash()`; and
- the instance registry row's `paramsHash`.

The old version remains valid only for checkpoints whose `checkpointParamsHash(id)` pinned it
before activation. New triggers pin the new version. Do not cancel or resubmit an in-flight proof
merely because the live version changed; compare against the checkpoint-pinned hash.

## Recover exact bytes

1. Read `versionCommitment(version)` and locate its creation/proposal event.
2. Fetch that event receipt's transaction from an archival RPC.
3. Decode `CreateArgs.manifest` for version 1 or the first argument of `proposePrior` for later
   versions. Do not use event arrays; none exist.
4. Validate the TGWP bytes independently and require their root, count, SHA-256, params hash, and
   metadata digest to equal the event and controller history.
5. Cache and pin the exact bytes under their SHA-256 raw CID.

Fail closed when the transaction input cannot be fetched, the manifest is malformed, its chain ID
is wrong, or any commitment differs. Mirror loss alone is recoverable from chain history; loss of
both configured archival history and all exact-byte mirrors is an availability incident, not
permission to reconstruct or renormalize a replacement list.
