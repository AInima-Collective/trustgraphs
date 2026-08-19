# Nostr workspace production checklist

The program is built and has passed the two-epoch Anvil rehearsal; the non-synthetic member-scoped
pilot remains an S5 gate. Before its first production anchor, record and independently review:

- chain, `InstanceRegistry` row, deployment transactions, all contract addresses/code hashes,
  reciprocal bindings, node registrations, role holders, timelocks, capacity, and epoch schedule;
- Buzz upstream SHA plus compatibility-patch digest, migration digest, relay key, community UUID,
  audit health, archive ACL/storage redundancy, and authorized reproduction holders;
- exact program/output ids, SP1 6.3.1 guest vkey, params preimage/hash, all work caps and measured 2×
  operating margin, vault top-band policy, prover backend, recipient, and publication quorum;
- indexer score-program binding, deployment start block, sidecar path/ACL, API pagination limits,
  frontend domain/proof checks, monitoring destinations, and rollback/disable contacts.

Alerts must cover audit delay/gap, relay/schema/source drift, invalid or stale self-log, archive loss,
capacity/work limits, executor/prover failure, CID unreadability or byte mismatch, reverted/stale proof,
indexer lag/root mismatch, unknown program/domain, and role/config changes.

The production claim is narrow: proof correctness is cryptographic; Option A completeness is relative
to the community relay/exporter; Option C is author-committed but on-chain availability remains
admitted-relayer gated; member-scoped archives are not publicly reproducible; J1 proves a result for
a request, not requester acceptance.

Use [`pilot.md`](./pilot.md) as the release record. It remains explicitly incomplete until the two
real epochs, second-holder reproduction, alert drills, and independent review are attached.
