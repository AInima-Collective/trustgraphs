# Trust composition creation and rotation runbook

This runbook covers the onchain capture/control layer. The browser workflow and durable provenance
routes are documented in the [frontend guide](./frontend.md); operator publication and independent
API recomputation are documented in the [operator/indexer guide](./operator-indexer.md).

For the supported path, open `/create/composition`. The workspace performs the source provenance
reads, exact V1 preview, adapter deployment, quote/cadence preflight, calldata simulation, and
creation or rotation described below. The manual calls remain useful for recovery and independent
verification.

## Deploy the factory

Compositions are created through `TrustComposeFactory`, deployed once per chain by
`script/DeployTrustComposeFactory.s.sol` together with its own verifier (an `SP1JournalVerifier`
pinned to the `trust-compose` guest's vkey), the `CompositionSourceAdapterFactory` used in "Admit
sources" below, and its `REGISTRAR_ROLE` grant on the instance registry. The factory constructor
cross-checks the vkey it is given against the verifier's own `programVKey()` and reverts on a
mismatch.

On a local dev stack this is automatic: `pnpm deploy:contracts` (or `task demo:deploy`, which also
derives the vkeys) runs the `Composition ZK Verifier` and `Trust Compose Factory` steps and writes
`.docker/zk_verifier_composition_deploy.json` and `.docker/trust_compose_factory_deploy.json`. The
pipeline fails closed when `SP1_COMPOSITION_PROGRAM_VKEY` is unset
(`cargo run -p trustgraph-prover -- trust-compose vkey`).

On a real chain, run the same two scripts by hand; the exact commands, the epoch floor and
activation delay arguments, and their fail-closed floors are in
[production.md](../production.md#deploy-the-weighted-and-compose-factories). The activation delay
is immutable and is the review window between `proposePolicy` and the earliest `activatePolicy`.

The frontend reads the factory address from
`deployment_summary.trustComposeFactory.trust_compose_factory` (or `TRUST_COMPOSE_FACTORY_ADDRESS`)
during config generation; without it the workspace stays in read-only preview mode. The indexer
reads the same summary key, or the per-chain address variables named in the
[operator/indexer guide](./operator-indexer.md).

## Admit sources

Every source must be a same-chain, non-composition instance registered in `InstanceRegistry` with:

- an immutable program-specific verifier exposing nonzero `programVKey()`;
- a nonzero per-instance params controller;
- a `MerkleSnapshot` with `enableStateProvenance()` called before its first accepted state; and
- at least one accepted, nonempty allocation output.

Every current factory (trust graph, weighted, contributions, and trust-compose itself) and the
direct `DeployNetwork` script enable state provenance inside the creating transaction, so anything
minted through them is admissible by construction. Only snapshots deployed before this behavior
existed need the manual constitutional call, and it is only possible while the snapshot still has
zero accepted states: once a root lands, the window is closed permanently and the network can
never serve as a composition source.

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
