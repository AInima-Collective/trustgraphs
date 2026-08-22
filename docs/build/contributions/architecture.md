# contributions — architecture

`contributions` is the platform's funding program: attest a contribution (or nominate someone
else's), let others score it, and split a funding pool by those valuations weighted by the
raters' **proven** reputation. The whole path from vouch graph to payout split is computed
inside one SP1 proof, and claims are paid out through `MerkleFundDistributor`.

**Inputs.** Two accumulators, frozen together at one checkpoint. Slot A is the trust instance's
vouch graph, read through a `TrustAccumulatorMirror`; it drives stage-1 reputation, so standing
in a round never comes from round activity. Slot B is the contribution record log: claims,
accept/reject responses, and 0–100 valuations, attested against three allowlisted EAS schemas
whose `ContributionResolver` folds every record (kinds 0–5) into the contribution accumulator.
The round window and every scoring parameter are pinned as the 21-word `paramsHash`
([`interfaces.md`](./interfaces.md) §3).

**What the guest computes and commits.** Stage-1 reputation is `pagerank-core::calculate`
imported, never forked; stage-2 applies the rep-weighted budgeted valuation with the design's §5
filters (self-valuations dropped, dust-rep raters dropped, collaborator ratings discounted,
out-of-window claims inert, rejected consent zeroed, unaccepted shares halved) and the evaluator
carve-out, then quantizes to the integer pool. The journal is the shared v3 tuple reused
unmodified ([`interfaces.md`](./interfaces.md) §4): both accumulator checkpoints, `paramsHash`,
an `outputRoot` over `(address, value)` payout leaves, the canonical blob's sha256 and CID,
`totalValue`, `skippedDigest` (zero in v1), the bounty `recipient`, and the `instanceDomain`.

**Who consumes the output.** `MerkleFundDistributor`: a funder calls `distribute` with the
proven root pinned, anyone executes `claim`s whose funds always go to the leaf's account, and
deadline-carrying rounds can be swept back to the funder. The indexer recomputes per-claim
scores for display, validated against the proven root and never a second source of truth; the
frontend's round screens read that API.

Canonical semantics live in `crates/contributions-core`, compiled into the
`contributions-program` guest, ported to TS in `packages/frontend/lib/contributions/` (the indexer's
display recompute imports the same module), and golden-locked four ways in
`tests/golden/contributions.json`.

## The two-accumulator wiring

The shared journal (v3 — [`interfaces.md`](./interfaces.md) §4) is reused unmodified with both
lanes live:

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
block. Lane A can be re-pointed to a new mirror only before checkpoint 0. Once history exists, the
safe path is a replacement snapshot plus explicit directory/vault migration; the mirror itself is
never mutated. This prevents a new accumulator from reusing checkpoint ids or lowering historical
freeze blocks.

The resolver holds an immutable allowlist of the three schema UIDs (set once
post-registration) and **reverts** attestations from any other schema — the
`kind = schemaIndex * 2 + isRevoke` tag is trustworthy because schemaIndex is
the resolver's own allowlist index, not attacker-supplied.

## Proof + payout path

`trigger()` → registry `paramsAuthority` → `ContributionsParamsUpdated` tuple →
`prover contributions fetch` (re-folds the `EdgeFolded` logs of both lanes to
the checkpointed accumulators and embeds that hash-checked public tuple) →
guest: reconcile (revocation-excludes, LWW, round window) → stage-1 PageRank →
stage-2 filters/budgets/consent/carve-out → `distribute_points_generic` →
journal v3 (`paramsHash` = the 21-word tuple; `skippedDigest` = 0 in v1;
outputs: root over `(address, value)` leaves + canonical blob CID) →
`submitProof` (journal digest reconstructed from checkpointed storage) →
`distribute`/`claim`/`sweep` on `MerkleFundDistributor`. The indexer's
per-claim scores are a root-validated display recompute, never a second
source of truth.

The design of record is
[`research/CONTRIBUTION_FUNDING.md`](../../../research/CONTRIBUTION_FUNDING.md)
(schemas §2, architecture §3, two-stage scoring §4, anti-gaming §5, round
lifecycle §6, decisions §9 — normative; deviations are recorded in
[`research/DEVIATIONS.md`](../../../research/DEVIATIONS.md)). The frozen wire
format — schema strings, fold `kind` tags, the 21-word params tuple, journal
reuse, blob format — is [`interfaces.md`](./interfaces.md); the program index
is [`networks-and-programs.md`](../../concepts/networks-and-programs.md). The
pre-launch security review of record is
[`research/audits/2026-07-M6.md`](../../../research/audits/2026-07-M6.md).

Operations: [`runbook.md`](./runbook.md). Local walkthrough with the golden
6-persona round: [`local-testing.md`](./local-testing.md).
