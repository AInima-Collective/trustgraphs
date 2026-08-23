# Graph lineage and endorsement architecture

Graph lineage is an optional advisory control plane. It gives a continuing graph an authenticated
actor identity and evidence history without treating a Merkle root as a signer and without adding
any write path to account scores, Merkle roots, proofs, or trust-compose V1 weights.

## Three identities

`GraphLineageRegistry` derives each stable lineage as:

```text
keccak256(abi.encode(
  keccak256("trustgraphs.graph-lineage.v1"),
  chainId,
  InstanceRegistry,
  instanceId
))
```

A display name, metadata URI, output root, or snapshot address is never the actor identity. Two
registries or instance IDs therefore cannot collide even when their presentation and current root
are identical.

Every configuration version commits the lineage, version, program, snapshot, verifier,
registry/accumulator, params hash, params controller, resolved authority, family, method, scope,
identity domain, and source-lineage policy. Every epoch then commits that configuration plus the
accepted checkpoint, input-freeze block, root, canonical blob SHA-256, CID-string digest, total,
acceptance block, and program vkey.

## Authority and rotation

The canonical `InstanceRegistry.paramsAuthority(instanceId)` is the controller. If it exposes a
nonzero `owner()`, that owner is the authority; otherwise the controller itself (for example a
Safe executing a transaction) is the authority. Only that live authority can register, sync,
publish an epoch, issue, or revoke.

`configurationLive` reads the underlying registry and controller every time. A program, snapshot,
verifier, accumulator, params-controller, params-hash, or controller-owner change immediately
suspends the old configuration and all claims pinned to it. The new authority must call
`syncConfiguration` to create the next append-only version. This fail-closed check does not wait
for the indexer.

## Endorsements

An endorsement pins exact issuer and subject configurations, one scope, one of five kinds,
`0..1e18` weight, start/end times, evidence URI, evidence digest, monotonically increasing
issuer/scope sequence, and explicit supersession/revocation references. Validity is finite and at
most 90 days.

Only `referral` enters adjacency. Integrity, methodology, agreement, and warning records remain
evidence or eligibility signals. Warning is non-propagating; there is no negative-transitive
recurrence. Each issuer/scope referral row can spend at most `1e18`. It may name at most 64
distinct referral subjects over the registry's lifetime, not 64 concurrently active subjects.
That append-only identity cap permanently bounds the history scanned during issuance and reads;
expiry, revocation, supersession, or configuration rotation frees referral budget but does not
free a subject slot. Issuance checks the whole remaining validity interval, so overlapping
future-dated heads cannot activate above the budget ceiling. Unused mass remains explicit.

An evidence digest of zero is not silently trusted: it is rendered as mutable evidence. The API
and `/graph-lineages` UI also expose shared family, method, controller, and authority, so correlated
claims are not presented as independent confirmation.

## Indexer and API trust boundary

Ponder stores current lineage state plus append-only configuration, epoch, endorsement,
supersession, and revocation history. The paginated `/graph-lineages` API first compares a current
configuration with authenticated `InstanceRegistry` binding state. For any candidate active claim,
it then calls `endorsementStatus` on the configured registry. RPC failure returns
`verification-unavailable`, never active.

`GET /graph-lineages/referrals?scopeHash=...` emits only canonically active referrals, exact spent
and unused budgets, overlap diagnostics, and mutable-evidence flags. Its output is explicitly
previous-epoch/advisory input. `POST /graph-lineages/recommendations` adds a finalized-cutoff,
sparse-prior recommendation and diagnostics; neither endpoint is an automatic composition policy.
