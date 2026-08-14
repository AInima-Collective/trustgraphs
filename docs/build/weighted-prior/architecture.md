# Weighted-prior contract architecture

`trust-graph-weighted` is a separate program identity. It does not upgrade or reinterpret an
existing `trust-graph` instance. The scoring and manifest decision is frozen in
[`research/WEIGHTED_PRIOR_DECISION.md`](../../../research/WEIGHTED_PRIOR_DECISION.md); this page
describes its on-chain commitment lifecycle.

## Contracts and commitments

`WeightedTrustgraphsFactory` accepts one canonical TGWP V1 manifest in `createInstance` calldata.
It checks the manifest magic, version, chain, exact length, 1–2,048 row count, strictly increasing
nonzero addresses, positive weights, exact `1e18` sum, sorted-pair Merkle root, and exact-byte
SHA-256. The factory derives these fields rather than trusting caller-supplied values:

```text
priorRoot       = merkleRoot(manifest rows)
priorCount      = manifest row count
manifestSha256  = sha256(exact manifest bytes)
schemaUid       = the new resolver's schema
accumulator     = the new resolver
chainId         = the creation chain
```

The final 13-field tuple is hashed by `WeightedPriorParamsCodec`. Its order and integer widths are
frozen against `weighted-prior-core`. The registry program is
`keccak256("trust-graph-weighted")`; the params and manifest version is exactly 1.

The contract stores no manifest and no prior-entry array. `WeightedPriorParamsController` stores
the active params tuple, an optional pending commitment, and O(1) commitment/provenance metadata
per activated version. Exact manifest bytes remain in the creation or proposal transaction input.

## Rotation state machine

```text
active Vn --proposePrior(manifest, metadataDigest)--> pending Vn+1
pending Vn+1 --cancelPrior()------------------------> active Vn
pending Vn+1 --delay + activatePrior(Vn+1)---------> active Vn+1
```

Only the controller owner may propose or cancel. Anyone may activate after the factory-fixed
delay. A proposal validates all manifest bytes before recording its commitment; it cannot be
overwritten, activated early, activated under a different version, or replayed after activation.
Activation updates `MerkleSnapshot.paramsHash`, `InstanceRegistry.paramsHash`, controller state,
and version history in one transaction.

`MerkleSnapshot.trigger()` copies the currently active hash into `checkpointParamsHash(id)`. A
pending proposal does not change that hash. Activation also cannot rewrite a hash already pinned
to an earlier checkpoint, so an in-flight proof keeps the parameters that were active when its
inputs froze.

## Recovery identity

For V1, start with `WeightedInstanceCreated` and decode `CreateArgs.manifest` from that
transaction's `createInstance` input. For later versions, start with `PriorProposed` and decode the
`manifest` argument from that transaction's `proposePrior` input. Recompute every validation step,
then require equality with the event's version, root, count, SHA-256, metadata digest, params hash,
and ready time. `InitialPriorPublished` and `PriorActivated` carry the complete active params tuple;
`versionCommitment(version)` supplies the current on-chain cross-check.

The transaction identified by the event receipt is authoritative. A raw-CID mirror is a cache, not
a substitute for those exact bytes. If transaction calldata is unavailable or any recomputation
differs, the version is unavailable and proving must stop; never accept another manifest because
its provenance description looks equivalent. Automated ingestion and archival-RPC fallback are
implemented by issue #54.

## Bounds and isolation evidence

The production max-row controller test measures the real `proposePrior` path: validation, Merkle
construction, SHA-256, pending-version/provenance storage, and event emission. At 2,048 entries it
uses 3,579,477 execution gas; ABI calldata costs 448,484 gas, producing a 4,048,961-gas L1 upper
bound after adding 21,000 intrinsic gas. The test enforces `execution < 5,000,000` and
`total < 4,500,000`. The lower-level validator/store harness is also gated and measures 3,349,958
execution / 3,819,070 total gas.

With optimizer, IR, and 200 runs, production runtime sizes are 12,431 bytes for the weighted
factory, 8,286 bytes for the controller, and 12,910 bytes for its creation-code deployer. The
factory therefore retains 12,145 bytes under EIP-170. The existing governed factory remains 21,978
bytes with 2,598 bytes of headroom. Reproduce with:

```sh
forge test --match-path test/unit/WeightedPriorValidator.t.sol -vv
forge test --match-path test/unit/factory/WeightedPriorParamsController.t.sol
forge test --match-path test/unit/factory/WeightedPriorLifecycleInvariant.t.sol
forge test --match-path test/unit/factory/WeightedTrustgraphsFactory.t.sol
forge build --sizes
```
