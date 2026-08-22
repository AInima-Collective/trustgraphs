# Weighted-prior rotation and recovery runbook

This is the administrator procedure for an already-created `trust-graph-weighted` instance. It
does not apply to binary-seed `trust-graph` controllers.

## Deploy the factory

Weighted instances are created through `WeightedTrustgraphsFactory`, deployed once per chain by
`contracts/script/DeployWeightedTrustgraphsFactory.s.sol` together with its own verifier (an
`SP1JournalVerifier` pinned to the `trust-graph-weighted` guest's vkey, never the trust-graph root
verifier) and its `REGISTRAR_ROLE` grant on the instance registry.

On a local dev stack this is automatic: `pnpm deploy:contracts` (or `task demo:deploy`, which also
derives the vkeys) runs the `Weighted ZK Verifier` and `Weighted Factory` steps and writes
`.docker/zk_verifier_weighted_deploy.json` and `.docker/weighted_factory_deploy.json`. The pipeline
fails closed when `SP1_WEIGHTED_PROGRAM_VKEY` is unset
(`cargo run -p trustgraph-prover -- trust-graph-weighted vkey`).

On a real chain, run the same two scripts by hand; the exact commands, the epoch floor and
activation delay arguments, and their fail-closed floors are in
[production.md](../production.md#deploy-the-weighted-and-compose-factories). The activation delay
is immutable and is the review window between `proposePrior` and the earliest `activatePrior`.

## Import, preview, and create in the app

Open `/create/weighted`. The workspace remains useful for import, exact preview, and export even
when the current deployment has no weighted factory address; transaction buttons stay disabled in
that state. A configured `weightedFactory` comes from
`deployment_summary.weightedFactory.weighted_factory` (written by the deploy step above) or
`WEIGHTED_FACTORY_ADDRESS` during frontend config generation.

The importer accepts at most 2 MiB and 1–2,048 entries:

- CSV starts with exactly `account,weight` (a UTF-8 BOM, CRLF, and quoted human fields are accepted
  on input).
- JSON uses `trustgraph-weighted-prior-input-v1`, a canonical decimal-string `chainId`, and
  `{ "account": string, "weight": string }` entries.
- Weights are positive canonical decimal strings with at most 18 fractional digits. Signs,
  exponents, leading integer zeroes, trailing fractional zeroes, numeric JSON values, and zero are
  rejected with row/field errors.
- Accounts are addresses or ENS names. Duplicates are checked after name resolution; the zero
  address, a wrong chain, a normalized-zero row, and over-cap input fail closed.

Canonical CSV is lowercase-address sorted, has no BOM, uses LF, and ends in one LF. Canonical JSON
is minified in `schema`, `chainId`, `entries` property order, uses the same address/entry order, and
has no terminal LF. The exact Hamilton normalization, TGWP manifest, sorted-pair Merkle root, and
SHA-256 are the production TypeScript implementation from the #52 fixture gate. Export CSV, JSON,
TGWP, and provenance together; the provenance digest submitted on chain is the SHA-256 of that
exact provenance JSON.

ENS is import-only. The browser resolves names on Ethereum mainnet at one finalized block using the
target chain's ENSIP-11 coin type, records the block number/hash and resolved address in provenance,
and puts only the address in canonical/consensus bytes. Immediately before simulation and again
before signing, it resolves every imported name at a fresh finalized block. Any changed address
rebuilds every derived artifact, clears the gas/simulation approval, and requires a new review.
An address-only import does not depend on mainnet RPC availability.

The review shows every on-chain commitment, exact calldata, normalized shares, largest/top-10
share, HHI, prior-only day-zero root, and wallet gas estimate. The maximum-size path always runs in
a cancellable Web Worker with live phases. The 2026-08-14 repository Node/V8 CI-class run took
233.448 ms for 2,048-entry canonicalization, Merkle construction, and 40 exact iterations—above
the 100 ms synchronous target—so supported Chrome and Firefox deliberately use the asynchronous
path regardless of local speed. The reproducible record is
[`../../../research/weighted-priors/frontend-benchmarks.csv`](../../../research/weighted-priors/frontend-benchmarks.csv).

For rotation, load the weighted instance first. The app shows the active/pending versions,
availability diagnosis, activation time, and added/removed/changed rows. It refuses review/signing
when the indexer cannot recover the active exact bytes. Proposal signing only starts the timelock;
activation is a separate simulated transaction after `readyAt`.

The binary prefill assistant reads the old instance's starting accounts and assigns each weight
`1`. It always creates a **new** `trust-graph-weighted` instance. It never changes the binary
instance in place and does not preserve its checkpoint history or semantics.

Recovery is non-destructive: editing source/provenance clears all derived state; a rejected file
keeps the editable input and lists field errors; cancelling preview leaves the import available for
a rebuild; unavailable indexer bytes leave history/diagnostics visible but disable rotation.

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

## Operator behavior

The proving daemon discovers `trust-graph-weighted` from the instance registry and routes it only
to the isolated weighted core and guest. On every tick it validates and caches the active manifest,
and also the pending manifest during the activation delay. Recovery order is:

1. the bounded local cache;
2. every configured raw-CID gateway; then
3. archival creation/proposal calldata.

Every source is untrusted until the shared core reproduces the checkpoint-pinned params version,
chain ID, count, root, and SHA-256. A missing or mismatched manifest disables proving for that
instance. Configured mirror failures are retained in `*.metrics.json`, retried after
`weighted_manifests.retry_seconds`, emitted as `weighted_manifest_degraded`, and sent to the normal
operator alert webhook. The cache refuses limits too small to retain constitutional max-size active
and pending manifests. Its limits are global, but pruning always protects the newest two distinct
versions for every instance; if that fleet-wide pinned set exceeds either ceiling, recovery alerts
and fails instead of evicting active or pending data. Size both ceilings for the operated fleet.

For a restart or old-checkpoint repair, the checkpoint's own `checkpointParamsHash` selects the
full `InitialPriorPublished`/`PriorActivated` tuple, and that version selects the original
manifest-bearing transaction. The current version is never substituted for a superseded one.

## Indexer and API

Set `WEIGHTED_FACTORY_ADDRESS_10` in production or
`WEIGHTED_FACTORY_ADDRESS_31337` locally (a generated
`deployment_summary.weightedFactory.weighted_factory` is also accepted). Ponder then discovers the
factory's controller, resolver, and snapshot children and replays proposal, cancellation,
activation, checkpoint, and normalized-entry history. Deterministic `(instance, version)` and
`(instance, version, position)` keys make a reorg rollback/reapply duplicate-free.

The HTTP surface is separate from the binary-seed `/instances` routes:

- `GET /weighted-priors` — weighted instance catalog;
- `GET /weighted-priors/:instanceId/versions` — paginated/filterable status history;
- `GET /weighted-priors/:instanceId/versions/:version` — commitment and provenance metadata; and
- `GET /weighted-priors/:instanceId/versions/:version/entries` — address-ordered normalized
  entries with decimal-string weights.

`availability.status` is `available`, `degraded`, or `unavailable`; an unavailable record remains
visible with its source transaction and diagnosis but has no entries. This does not change any
existing binary trust-graph response shape.
