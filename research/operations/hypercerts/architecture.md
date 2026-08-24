# hypercerts — architecture

> Internal implementation reference. This page is not part of the public product documentation.

`hypercerts` is the third SP1 program: a ZK-proven trust graph over **Hypercerts' AT Protocol
records** rather than EAS attestations. It consumes the lexicons the Hypercerts ecosystem
already publishes instead of minting a greenfield vouch schema, maps records (evaluations,
endorsements, attributions, badges, follows) to weighted edges, runs the same fixed-point
Trust-Aware PageRank, and proves the `{node → score}` merkle root permissionlessly with SP1.

**Inputs.** The off-chain substrate is the `@hypercerts-org/lexicon` record set, **pinned at
`=1.1.0`** (bumping it changes the guest and rotates the verification key, so it is a
deliberate, coordinated event; see the vkey-rotation procedure in [`runbook.md`](./runbook.md)).
Repo head anchors are committed on-chain in `AnchorRegistry`, the lane-2 log of the two-lane
offchain-attestation architecture; lane 1 is a permanent `EmptyLaneAccumulator` whose
`(acc = 0, leafCount = 0)` the guest asserts. The guest verifies every anchored head in-circuit
(envelope 1: CAR/MST walk, commit signature, PLC key chain) and derives the edge graph from the
records (`crates/hypercerts-core`). Completeness is enforced by rule Φ and the deterministic
skip rules: a withheld head is carried forward within the k-epoch staleness window or the node's
out-edges drop, and every skip is committed. Node identity resolves through
`app.certified.link.evm` DID↔address bindings, verified in-guest in both directions.

**What the journal commits.** The shared journal tuple, bound by the same
`MerkleSnapshot`/`SP1JournalVerifier` machinery as every other program: both lane commitments
(lane 1 empty, lane 2 the checkpointed `(anchorAcc, anchorCount)`), the `paramsHash` over the
17-word hypercerts params, the `outputRoot` over nodeId-keyed leaves (plus address leaves for
`link.evm`-bound nodes), the canonical blob's sha256 and CID, `totalValue`, the `skippedDigest`
committing the epoch's rule-Φ and record-level skips, the bounty `recipient`, and the
`instanceDomain`. The domain matters more here than for any other program: the params carry no
instance-unique field, so it is the only thing stopping two identically-configured instances
from accepting each other's proofs.

**Who consumes the output.** Hypercerts' own apps and contracts, via merkle proofs against the
on-chain root; the indexer's score-bundle API serves `{nodeId, score, proof[]}` bundles as a
convenience that every consumer can verify against the chain and ignore entirely. The pilot is
score-only, with no governance module and no distributor: the root is the product. Ethereum
mainnet is the target chain, and nothing is deployed to a production chain yet.

The design of record is
[`research/HYPERCERTS_ATPROTO_PLAN.md`](../../../research/HYPERCERTS_ATPROTO_PLAN.md) (graph
semantics, verification pipeline, partner asks), built on the two-lane offchain-attestation
architecture in
[`research/OFFCHAIN_ATTESTATIONS_ZK.md`](../../../research/OFFCHAIN_ATTESTATIONS_ZK.md).

To operate the program, see [`runbook.md`](./runbook.md); to exercise it end to end locally,
[`local-testing.md`](./local-testing.md); to re-derive a proven epoch from public data,
[`reproduce-an-epoch.md`](../../../docs/verify/reproduce-an-epoch.md). Open asks on the Hypercerts side
are in [`research/HYPERCERTS_PARTNER_BRIEF.md`](../../../research/HYPERCERTS_PARTNER_BRIEF.md).

> **No standalone semantics reference.** There is no separate graph-semantics or pinned-lexicon
> reference doc: the record→edge mapping semantics live in `crates/hypercerts-core` and the
> research plan above, and the pinned lexicon version is the `=1.1.0` stated here.
