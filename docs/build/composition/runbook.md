# Trust composition creation and rotation runbook

This runbook covers the onchain capture/control layer. The browser workflow and durable provenance
routes are documented in the [frontend guide](./frontend.md); operator publication and independent
API recomputation are documented in the [operator/indexer guide](./operator-indexer.md).

For the supported path, open `/create/composition`. The workspace performs the source provenance
reads, exact V1 preview, adapter deployment, quote/cadence preflight, calldata simulation, and
creation or rotation described below. The manual calls remain useful for recovery and independent
verification.

## Admit sources

Every source must be a same-chain, non-composition instance registered in `InstanceRegistry` with:

- an immutable program-specific verifier exposing nonzero `programVKey()`;
- a nonzero per-instance params controller;
- a `MerkleSnapshot` whose constitutional authority called `enableStateProvenance()` before its
  first accepted state; and
- at least one accepted, nonempty allocation output.

For each source, call `CompositionSourceAdapterFactory.create` with the source registry and
instance ID, a canonical nonzero source ID, nonzero family ID, `keccak256("allocation")`, and the
digest of the reviewed deployment/provenance packet. Record the emitted adapter address. A later
registry controller or contract-set rewrite intentionally makes the adapter fail closed.

## Create an instance

Build source-ID-ascending `TGCP` V1 bytes. Use 2–8 required records, one admitted program ID,
positive uint64 weights summing exactly to `1e18`, unique snapshots, and per-source ages no greater
than the params-wide maximum. Pass adapters in the same order.

Call `TrustComposeFactory.createInstance`. In `params`, leave factory-derived fields
`sourcePolicyRoot`, `sourceCount`, `policyManifestSha256`, `accumulator`, and `chainId` zero. Set the
frozen domains and bounds to the values documented in the
[implementation record](../../../research/composition/README.md). The factory:

1. validates the complete policy and the dedicated composition verifier/vkey;
2. deploys the accumulator, snapshot, and timelocked controller;
3. binds their circular references and removes itself from all roles;
4. registers `keccak256("trust-compose")` with the controller as params authority; and
5. installs/publishes policy version 1 after discovery events exist.

Check the registered snapshot, verifier, accumulator, params hash, controller, epoch length, and
controller owner before funding or triggering it.

## Trigger and recover a capture

Anyone may call `MerkleSnapshot.trigger()` after the fixed epoch boundary. Treat a revert as
preflight failure: do not substitute an older, optional, or redistributed source. Once successful,
read:

```text
CompositionSourceAccumulator.getCheckpoint(checkpointId)
CompositionSourceAccumulator.getCaptureManifest(checkpointId)
CompositionSourceAccumulator.checkpointPolicyVersion(checkpointId)
CompositionSourceAccumulator.checkpointAdapterSetHash(checkpointId)
CompositionSourceAccumulator.getCaptureSourceCheckpointIds(checkpointId)
MerkleSnapshot.checkpointParamsHash(checkpointId)
```

Verify `sha256(manifest) == checkpoint.acc`, the header chain/capture block/count, and every adapter
state with `readCheckpoint(sourceCheckpointId)` before providing the bytes and source blobs to the
composition prover. Frozen checkpoints do not expire and are never recomputed under a later policy.

## Rotate, cancel, roll back, or recover

The controller owner calls `proposePolicy(manifest, adapters, metadataDigest)`. Archive the full
transaction input and review the returned version/proposal ID/readiness time. Before readiness the
owner may call `cancelPolicy`; cancelled version numbers are permanent gaps and remain queryable.

At or after readiness, any account calls:

```text
activatePolicy(expectedVersion, exactManifest, exactAdapters)
```

Recheck that the accumulator policy version, snapshot params hash, controller current hash, and
registry params hash agree. To roll back, propose the exact older manifest/adapters as a new
version. To replace a damaged adapter without changing guest policy bytes, deploy a reviewed
replacement through the same adapter factory and propose the unchanged manifest with the new
adapter list. Transfer controller authority with `transferOwnership` followed by the successor's
`acceptOwnership`; a pending successor has no power before acceptance.

## Local verification

```sh
task composition:contracts
forge test --match-path test/unit/composition/TrustComposeCapture.t.sol -vv
task zk:parity PROGRAM=trust-compose
```

The contract suite covers atomic source updates, unchanged-source boundaries, unavailable/empty/
stale/overflow states, arbitrary adapter lookalikes, controller/verifier/vkey drift, delayed
rotation/cancellation/rollback/recovery/ownership, factory role removal, legacy regressions, and
2/8-source gas.
