# contributions — Architecture

The design lives in
[`../../research/CONTRIBUTION_FUNDING.md`](../../research/CONTRIBUTION_FUNDING.md)
(schemas §2, architecture §3, two-stage scoring §4, anti-gaming §5, round
lifecycle §6, decisions §9 — normative; deviations are recorded in
[`../DEVIATIONS.md`](../DEVIATIONS.md)). The frozen wire format —
schema strings, fold `kind` tags, the 21-word params tuple, journal reuse,
blob format — is [`INTERFACES.md`](./INTERFACES.md).

`contributions` is the fifth program
([`../PROGRAMS.md`](../PROGRAMS.md)): attest a contribution (or nominate
one), let others score it, and split a funding pool by those valuations
weighted by the raters' **proven** reputation — the whole path from vouch
graph to payout computed inside one SP1 proof and claimed through
`MerkleFundDistributor`. Canonical semantics live in
`packages/contributions-core` (stage-1 reputation is
`pagerank-core::calculate` imported, never forked), compiled into the
`contributions-program` guest, ported to TS in
`frontend/lib/contributions/` (the indexer's display recompute imports the
same module), and golden-locked four ways in
`test/golden/contributions.json`.

## The two-accumulator wiring

Journal v2 is reused unmodified with both lanes live:

| slot | commitment | contract |
|---|---|---|
| A — `(acc, leafCount)` | the **vouch graph** (reputation input) | `TrustAccumulatorMirror` over the trust instance's `EASIndexerResolver` accumulator |
| B — `(anchorAcc, anchorCount)` | the **record log** (claims / responses / valuations, kinds 0–5) | `ContributionResolver` (an `AttestationAccumulator` with a schema-UID allowlist), read as `IAnchorRegistry` |

**The mirror decision:** accumulator checkpoints are per-accumulator state, so
letting a second `MerkleSnapshot` checkpoint the trust accumulator directly
would race the trust instance's own trigger cadence. The mirror never pushes
into the trust accumulator: its `checkpoint()` *reads* the live
`(acc, leafCount)` and freezes the pair locally — the proven input commitment
is identical because `acc` already commits to the full ordered edge log. The
mirror is bound one-shot to its snapshot (`bindSnapshot`), so nothing else can
grow its checkpoint array and desync lane A from lane B; one
`trigger()` on the contributions snapshot freezes both lanes at the same
block. Re-pointing lane A is a constitutional event on the snapshot
(`setAccumulator` to a new mirror), never a mutation of the mirror.

The resolver holds an immutable allowlist of the three schema UIDs (set once
post-registration) and **reverts** attestations from any other schema — the
`kind = schemaIndex * 2 + isRevoke` tag is trustworthy because schemaIndex is
the resolver's own allowlist index, not attacker-supplied.

## Proof + payout path

`trigger()` → `prover contributions fetch` (re-folds the `EdgeFolded` logs of
both lanes to the checkpointed accumulators, embeds the params sidecar) →
guest: reconcile (revocation-excludes, LWW, round window) → stage-1 PageRank →
stage-2 filters/budgets/consent/carve-out → `distribute_points_generic` →
journal v2 (`paramsHash` = the 21-word tuple; `skippedDigest` = 0 in v1;
outputs: root over `(address, value)` leaves + canonical blob CID) →
`submitProof` (journal digest reconstructed from checkpointed storage) →
`distribute`/`claim`/`sweep` on `MerkleFundDistributor`. The indexer's
per-claim scores are a root-validated display recompute, never a second
source of truth.

Operations: [`RUNBOOK.md`](./RUNBOOK.md). Local walkthrough with the golden
6-persona round: [`LOCAL_TESTING.md`](./LOCAL_TESTING.md).
