# Trust-compose operator and indexer

`trust-compose` is an isolated score program. Its accumulator checkpoint count is the number of
sources (2–8), not the amount of proving work. The production operator therefore never prices or
schedules it from `leafCount` alone.

## Operator boundary

For each current or historical checkpoint the operator recovers the exact stored `TGCM` capture,
checks its SHA-256 and source count against the accumulator checkpoint, derives every raw CID from
the captured source SHA-256, and fetches the exact bytes through every configured publication
gateway. At least `[ipfs].min_success` gateways must return the committed bytes. The native
`composition-core` computation must then reproduce all policy, source, attribution, output, CID,
root, total, recipient, and instance-domain commitments before a proof request is journaled.

Scheduling uses the highest band selected by authenticated source count, aggregate canonical
entries, union accounts, or aggregate source bytes. A small policy with very large blobs therefore
cannot buy the small-source price. The vault conservatively maps every `trust-compose` checkpoint
to its largest configured fee band; the operator additionally rejects a paid quote below the exact
measured-cycle cost.

Publication is complete only after the configured target minimum accepts the output and its
gateway reads back byte-identical content. Availability, prove, publication, and deterministic
submission failures remain separate journal records. To repair lost output availability without
changing a historical result:

```sh
cargo run --manifest-path zk/operator/Cargo.toml -- republish \
  --instance 0xINSTANCE_ID --checkpoint CHECKPOINT_ID
```

## Indexer boundary

Configure the factory with `TRUST_COMPOSE_FACTORY_ADDRESS_10` on Optimism or
`TRUST_COMPOSE_FACTORY_ADDRESS_31337` locally. Ponder discovers each controller, accumulator, and
snapshot from factory events. Policy manifests and adapter lists are recovered from their creation
or proposal transaction calldata; adapter identities and nonzero deployment-provenance digests are
recorded as governance-admitted provenance.

A composition root is not served unless the indexer independently reproduces:

- the authenticated program and semantic output domain;
- the complete params tuple/hash, TGCP policy, adapter-set commitment, TGCM capture, and all source
  checkpoint IDs;
- every canonical source blob, CID digest, SHA-256, total, and Merkle root;
- both Hamilton passes and every exact/ideal attribution row;
- output canonical bytes, SHA-256, raw CID, root, and total; and
- the snapshot's accepted checkpoint provenance (params, verifier, codehash, and program key).

Any mismatch or unavailable blob stops ingestion before generic score rows become visible. The
composition factory enables snapshot state provenance at creation so this accepted-state check is
mandatory rather than inferred from a root event.

## Bulk APIs

All list routes accept bounded `limit` and `offset` parameters:

- `GET /compositions`
- `GET /compositions/:instanceId/policies`
- `GET /compositions/:instanceId/epochs`
- `GET /compositions/:instanceId/epochs/:checkpointId/sources`
- `GET /compositions/:instanceId/epochs/:checkpointId/attribution`
- `GET /compositions/:instanceId/epochs/:checkpointId/bundle`

Attribution may be filtered by `account` or `sourceId`. Responses name `cryptographic` provenance
separately from `governance`: the former was committed by the capture/proof/accepted state, while
the latter identifies the policy controller, adapters, deployment review digests, and metadata
that admitted those sources.
