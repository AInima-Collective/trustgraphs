# hypercerts — Architecture

The design lives in
[`../../research/HYPERCERTS_ATPROTO_PLAN.md`](../../research/HYPERCERTS_ATPROTO_PLAN.md) (graph
semantics, verification pipeline, partner asks), built on the two-lane offchain-attestation
architecture in
[`../../research/OFFCHAIN_ATTESTATIONS_ZK.md`](../../research/OFFCHAIN_ATTESTATIONS_ZK.md).

`hypercerts` is the third program: a ZK-proven trust graph over **Hypercerts' AT Protocol records**
(evaluations, endorsements, attributions, badges) published with `@hypercerts-org/lexicon` — **pinned
at `=1.1.0`** (bumping it is a deliberate event with a vkey-rotation plan — a build-plan ground rule).
It consumes those published lexicons rather than minting a greenfield vouch schema, maps records to
weighted edges (`hypercerts-core`), and proves the same `{node → score}` merkle root permissionlessly
with SP1 — inputs anchored by the two-lane commitment (`AnchorRegistry` + journal v2), completeness
enforced in-guest by rule Φ and the deterministic skip rules. Node identity resolves through
`app.certified.link.evm` DID↔address bindings; the pilot launches score-only (no gov/distributor) on
Optimism.

To operate the program, see [`RUNBOOK.md`](./RUNBOOK.md); to exercise it end to end locally,
[`LOCAL_TESTING.md`](./LOCAL_TESTING.md); to re-derive a proven epoch from public data,
[`REPRODUCE.md`](./REPRODUCE.md). Open asks on the Hypercerts side are in
[`PARTNER_BRIEF.md`](./PARTNER_BRIEF.md).

> **Still unwritten.** The graph-semantics reference (`GRAPH_SEMANTICS.md`) and the pinned-lexicon
> reference (`LEXICONS.md`) were planned alongside the runbook and have not been written. Until they
> are, the semantics of record→edge mapping live in `packages/hypercerts-core` and the research plan
> above, and the pinned lexicon version is the `=1.1.0` stated here.
