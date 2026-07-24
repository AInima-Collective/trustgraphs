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

> **Runbook comes at M4/M5.** The build was the plan's sequence M1→M5 (spike → lane-2 infra → atproto
> envelope → the hypercerts program → the Optimism pilot). The operator runbook (`RUNBOOK.md`), graph
> semantics reference (`GRAPH_SEMANTICS.md`), and pinned-lexicon reference (`LEXICONS.md`) land with the
> program itself at **M4**, completed for the pilot at **M5**. This directory holds only this pointer
> until then.
