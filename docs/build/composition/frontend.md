# Composition preview and provenance UI

The composition workspace at `/create/composition` creates or rotates a separate `trust-compose`
instance from complete, already-proved address allocations. It does not combine raw graph edges,
seed another score program, or infer that configured weights are fair. Every source's raw point
scale normalizes into its governed quota.

## Select and authenticate sources

The workspace reads candidates from the ordinary and weighted instance catalogs, then permits only
same-chain address allocation sources with one identical authenticated program ID. The picker
pre-reads each candidate's `provenanceEnabled` and `getStateCount` from the chain and states why a
candidate is not selectable: waiting on its first accepted root, provenance still enableable by its
constitutional authority, or permanently ineligible because a root landed before provenance was
enabled. Selecting a source cross-checks the indexer's canonical `/merkle/:snapshot/current`
entries against onchain `provenanceEnabled`, `getStateCount`, `getStateAtIndex`, and
`getStateProvenance` reads. A mismatch, missing blob, stale state, empty output, or unavailable
route blocks preview and signing.

The default publisher family is a visible suggestion derived from program/controller identity. It
is a governed label, not a proof that publishers are independent. Shared families and near-clone
correlation require explicit acknowledgement. Before signing, each source also needs an adapter
created by the factory's append-only `CompositionSourceAdapterFactory` from the displayed source
review digest.

## Review the exact preview

Equal weights are the default and use exact integer `1e18` units; remainder units follow canonical
source-ID order. An edited policy must still give every source a positive weight and total exactly
100%. The preview reproduces the production V1 core in the browser and displays:

- each exact source quota alongside its non-influential raw total;
- per-account, per-source contribution and Hamilton rounding delta;
- pairwise support overlap, correlation, and distribution disagreement;
- support coverage, concentration, and leave-one-out sensitivity;
- the A/B/C simplex grid for three-source policies;
- TGCP policy bytes/hash/root, TGCM capture bytes/hash, canonical output bytes/CID/root; and
- measured work band/cycles plus the vault's conservative band-3 quote and epoch cadence.

Sparse support, source absence for an account, zero quota, caps, source/controller-family overlap,
staleness, unavailability, and missing quote/prepayment have explicit preflight results. Required
sources fail closed: capture never substitutes another root or redistributes a missing quota.

## Simulate, create, and rotate

Creation leaves `sourcePolicyRoot`, `sourceCount`, `policyManifestSha256`, `accumulator`, and
`chainId` zero for the factory to derive. The UI hashes the complete calldata after simulation and
refuses to sign if any transaction field or preview input changes. Rejecting a wallet request does
not discard an otherwise current simulation.

Rotation loads the controller's active, pending, cancelled, and superseded receipts. The owner may
propose or cancel; after `readyAt`, anyone may activate only the exact indexed TGCP manifest and
ordered adapter preimage. If those bytes are degraded or unavailable, activation remains blocked.

The frontend configuration is additive:

```json
{
  "trustCompose": {
    "factory": "0x…"
  }
}
```

An older indexer returns an explicit rolling-deployment message. An absent factory leaves preview
and existing provenance readable without presenting signing as available.

## Inspect landed provenance

`/compositions` is the durable catalog. `/compositions/:instanceId` retains policy and epoch
history; policy routes expose exact activation preimages and governance receipts; epoch routes
download the complete evidence bundle, exact capture record, attribution rows, and individual
address proofs.

The epoch screen keeps cryptographic and governance provenance separate. When creation/rotation
was previewed in the same browser, it compares policy manifest, capture manifest, output blob, CID,
and root commitments byte-for-byte. A reorg-safe refresh reloads canonical indexer history rather
than trusting a removed receipt.
