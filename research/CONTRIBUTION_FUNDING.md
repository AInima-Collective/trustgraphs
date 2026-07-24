# Contribution Funding on EAS (v1 design)

**Status:** design draft, 2026-07-22 — since **Built** as the contributions program (full round proven + paid out on local anvil; see [`docs/PROGRAMS.md`](../docs/PROGRAMS.md) and [`docs/contributions/`](../docs/contributions/)).
**Depends on:** lane-1 EAS pipeline, ZK root producer, `MerkleFundDistributor`.
**Successor:** v2 may add further ingestion lanes beyond EAS (see §8).

## 1. What we're building

An attestation-based contribution system on TrustGraph:

1. **Claim** — attest to something you contributed, or nominate someone else's contribution.
2. **Value** — others attest to how valuable that contribution is.
3. **Distribute** — a funding pool is split according to the valuations, weighted by the
   proven reputation of the people who made them.

The reputation weights come from the existing Trust-Aware PageRank root; the distribution
itself is computed inside a ZK proof and paid out through `MerkleFundDistributor`, so the
entire path from "who vouched for whom" to "who gets paid what" is permissionlessly
verifiable.

## 2. Schemas

Three new EAS schemas. **They must NOT point at the existing `EASIndexerResolver`
instance** — the guest consumes every edge folded into an accumulator without any
schema filtering (`schema_uid` appears only in `params_hash`, never in edge selection),
so registering them against the live resolver would inject their edges into the trust
graph as garbage vouches. They get their own resolver + accumulator (§3).

### 2.1 `contribution.claim`

```
string title, bytes32 contentHash, string uri, address[] contributors, uint32[] shares
```

- Attester may or may not be among `contributors` — a claim naming only others is a
  **nomination**.
- `shares` are relative attribution weights; the guest normalizes per-claim to Σ = 1
  (hypercerts E4 rule: padding the list dilutes, never mints).
- The contribution's node identity is the attestation UID.
- Revocation retracts the claim entirely (standard lane-1 revocation semantics: any
  `kind=1` for the UID excludes the attest edge regardless of order).

### 2.2 `contribution.response`

```
bytes32 claimUID, uint8 response   // 1 = accept, 2 = reject
```

- Only meaningful when attested by an address listed in the claim's `contributors`.
- Consent multiplier on that contributor's attribution share (mirrors hypercerts
  acknowledgement semantics):
  - accepted → 1.0
  - no response → `unacceptedMult` (default 0.5) — nominations count at a discount
    until the nominee opts in
  - rejected → 0 (people must be able to refuse attribution and funds)
- Self-claims (attester ∈ contributors) count as implicitly accepted for the attester's
  own share.

### 2.3 `contribution.valuation`

```
bytes32 claimUID, uint8 score      // score ∈ [0, 100]
```

- One live valuation per (rater, claim): last-write-wins by
  `(block_timestamp, fold_index)`, same rule as trust edges. Revocable.
- The absolute scale barely matters — scores are normalized per-rater (§5), so a
  valuation expresses *relative* value across the things you rated. This is deliberate
  (§5.1).

## 3. Architecture: a fifth program on the platform

Following the platform pattern (one guest binary, one journal shape, own vkey, own
params schema):

```
trust vouches ──▶ existing EASIndexerResolver ──▶ trust accumulator (acc A)
claims/responses/valuations ──▶ NEW ContributionResolver ──▶ contrib accumulator (acc B)

contrib guest:  verify completeness of A and B
                PageRank over trust edges (A)          → rep scores
                aggregate valuations (B) rep-weighted  → payout vector
                commit journal v2

on-chain:       contrib MerkleSnapshot (own vkey + paramsHash)
                MerkleFundDistributor pointed at it
```

Design points:

- **Two input commitments, zero new primitives.** Journal v2 already carries two
  independent chained-hash commitments: `(acc, leafCount)` and
  `(anchorAcc, anchorCount)`. The contrib program uses the first for the trust
  accumulator and the second for the contribution accumulator. Both are the same fold
  primitive; nothing about the frozen 10-word journal changes.
- **One new resolver contract.** `ContributionResolver is SchemaResolver,
  AttestationAccumulator`, serving all three new schemas. Because the accumulator leaf
  has no schema field, the resolver must discriminate: fold a schema tag into the `kind`
  byte (e.g. `kind = schemaIndex * 2 + isRevoke`) or mix the schema UID into `dataHash`.
  Either works; the tag-in-`kind` variant keeps the leaf ABI unchanged and the guest
  dispatch trivial.
- **Reputation is recomputed in-proof, not read from a posted root.** This is the
  established platform rule (signer-sync precedent): the contrib guest re-runs the exact
  `pagerank-core` algorithm over the trust edges it verified, sharing `paramsHash`
  semantics with the main instance. No cross-proof trust, no root-freshness races.
- **Checkpointing:** the contrib `MerkleSnapshot.trigger()` freezes both accumulators at
  one block, exactly as the main instance freezes lane 1 + lane 2 today. Open wiring
  question: whether the contrib snapshot reads the trust accumulator's existing
  checkpoints or pushes its own (checkpoints are per-accumulator state; two snapshots
  triggering one accumulator needs a look).
- **Outputs:** merkle leaves are the standard `(address, value)` OZ leaves, where value
  is the payout weight from §4. Per-contribution scores are **not** proven in v1 — they
  are deterministic from the same committed inputs, so the indexer derives them for
  display and anyone can recompute. (If we later want them proven, the dual-domain
  `bytes32 nodeId` leaf primitive from hypercerts drops in.)

## 4. Scoring: two-stage, not flow-through

Hypercerts composes everything into one PageRank pass (valuations are edges into
artifact nodes, rank flows through). For v1 I propose the simpler **two-stage**
aggregator:

**Stage 1 — reputation.** Trust-Aware PageRank over the vouch graph only, unchanged
algorithm, contrib-instance params. Produces `rep(r)` for every address, normalized to
sum = scale.

**Stage 2 — rep-weighted budgeted valuation.**

For rater `r` with eligible valuations `{(c, s_{r,c})}` (after §5 filters):

```
σ_r(c) = s_{r,c} / Σ_{c'} s_{r,c'}          # rater's budget share for contribution c
S(c)   = Σ_r  rep(r) · σ_r(c)               # contribution score
P(a)   = Σ_c  S(c) · attribShare(a,c) · consentMult(a,c)   # contributor payout weight
```

`P` is fed through the existing `distribute_points_generic` quantization to produce the
integer `(address, value)` allocation of `totalPool`.

Why two-stage over flow-through:

- **The rep graph stays clean.** In flow-through, valuation edges alter reputation
  itself — getting funded raises your rank, which raises your future rating power: a
  rich-get-richer loop welded into the core metric. Two-stage keeps "who is trusted"
  and "what got funded this round" legibly separate. If we ever want funding to feed
  reputation, we do it deliberately (e.g. via ordinary vouches or a v2 edge type), not
  as a side effect.
- **It keeps the property that matters.** The per-rater normalization `σ_r` preserves
  the budgeted-voice property that makes flow-through resistant to score inflation
  (§5.1) — it *is* the one-hop PageRank step, extracted.
- **Explainable.** "Your payout = Σ over your contributions of (rep-weighted average
  esteem × your share)" fits in a sentence. Flow-through payouts are only explainable
  as "the eigenvector said so."
- **Cheap and low-risk in-guest.** One PageRank + one weighted sum, all existing
  fixed-point plumbing (weights via the `confidence`-style clamp, no floats, BTreeMap
  ordering).

## 5. Anti-gaming

### 5.1 Structural (free)

- **Budgeted voice.** Because `σ_r` normalizes per rater, rating everything 100 gives
  each thing `rep(r)/n` — enthusiasm splits your voice, it can't mint value. This is
  the failure mode that kills naive "average the stars" systems, and it's the property
  Optimism's RetroPGF converged toward (budget allocation, not independent scores)
  after three rounds of score-inflation pain.
- **Sybil resistance inherited.** A fresh address has teleport-dust rep; its
  valuations are worth ~nothing. Creating raters doesn't help unless the trust graph
  (seeded) vouches for them.
- **Attribution Σ = 1 per claim.** Contributor-list padding dilutes.
- **Everything revocable, last-write-wins,** same reconciliation rules as trust edges —
  no ordering games.

### 5.2 Explicit rules (in-guest filters, all provable skips)

- **Self-valuation dropped:** rater ∈ claim's `contributors`, or rater is the claim's
  attester.
- **Collaborator discount:** a rater who shares *any* claim in the round with
  contributor `a` has their valuations of `a`'s other contributions discounted by
  `collaboratorMult` (default 0.5; a param, 0 = hard exclusion). This is the cheap
  first cut at conflict-of-interest rings ("you rate my thing, I rate yours"); full
  correlation-discounting (raters with near-identical valuation vectors share one
  voice, cluster-match style) is a v1.1 candidate once we see real data.
- **Minimum rater rep:** `rep(r) < minRaterRep` ⇒ valuations ignored. Kills dust-spam
  that would otherwise bloat the guest for no score effect.
- **Round window:** claims count only if `block_timestamp ∈ [roundStart, roundEnd]`;
  valuations and responses until the checkpoint freeze. Both bounds in `paramsHash`.
  Timestamps are already folded into every accumulator leaf, so windows are provable.

### 5.3 Known residual risks

- **Collusion among reputable insiders** is reduced (collaborator discount, budget
  property) but
  not eliminated — two high-rep raters valuing each other's *unshared* claims still
  works. Mitigations that money at scale would justify: correlation discounting,
  pairwise-comparison elicitation, valuation staking. Deliberately out of v1 scope;
  keep round pools modest until observed.
- **Seed power now steers money,** not just scores. This raises the stakes on
  `GRAPH_SEEDING.md` (weighted teleport prior) and on the params-change lanes in
  `UPGRADE_GOVERNANCE.md` — `paramsHash` rotation per round is an OPERATIONAL_ROLE
  action and needs to sit inside whatever governance lane we adopt.

## 6. Round lifecycle

1. **Configure:** set contrib-instance `paramsHash` with the round window + weights
   (`unacceptedMult`, `collaboratorMult`, `minRaterRep`, `evaluatorCarveoutBps`,
   PageRank params, `totalPool` scale).
2. **Contribute:** claims attested during `[roundStart, roundEnd]`.
3. **Evaluate:** valuations + responses attested until the epoch boundary.
   `MerkleSnapshot.epochLength` (contract-fixed, never prover-chosen) gates
   `trigger()`, which freezes both accumulators at one block.
4. **Prove:** anyone runs the contrib prover against the checkpoint;
   `submitProof(checkpointId, …)` files the root at the input-freeze block.
5. **Fund + distribute:** `distribute(token, amount, expectedRoot)` — the
   `expectedRoot` guard pins the round to the intended proof, ETH or any ERC20,
   fee-aware. Contributors `claim()` pro-rata, one claim per (distribution, account).
6. **Evaluator carve-out (in-proof):** `evaluatorCarveoutBps` (default 100 = 1%,
   0 disables) reserves a pool slice for raters — curation is itself a contribution,
   and a small guaranteed slice fights evaluator apathy. The guest scales contributor
   weights by `1 − β` and adds rater leaves pro-rata `rep × participated` scaled by
   `β`, so it's one proven tree and one `distribute()`; raters below `minRaterRep`
   earn nothing, consistent with their valuations being ignored.

## 7. Distributor hardening before real funds

The first live round is capped small (≤ $5k, USDC or WETH), which bounds the blast
radius, but two TODOs already flagged in the contract header become load-bearing:

- **Unclaimed-fund sweep:** no refund/expiry path exists; dust and never-claimers lock
  funds forever. Needs an expiry + sweep-to-distributor (or roll-into-next-round).
  At first-round scale this is tolerable-but-ugly rather than blocking; it must land
  before pools grow.
- **Open claim:** anyone can trigger a claim *to* the rightful account. Probably fine
  (funds can't be redirected) but decide deliberately; note interactions with
  contracts-as-contributors.

Also: distributor pays `account` directly — contributors that are contracts (Safes,
splitters) work naturally, which is how teams should claim shared work (or split via
`shares` at claim time).

## 8. v2: other ingestion lanes

The aggregator is source-agnostic by design: any record system that can supply the
three primitives — a claim with attribution shares, a scored valuation referencing it,
and a consent signal — plus an identity binding to an EVM address can feed the same
two-stage pipeline as an additional lane. Nothing in §4/§5 assumes EAS or addresses
except the final leaf domain.

Hypercerts/AT-proto is one example we may add support for:
`org.hypercerts.claim.activity` → claims, `org.hypercerts.context.evaluation` →
valuations, consent via acknowledgement, identity via `app.certified.link.evm`;
unbound contributors would accrue score in `bytes32` leaves held until they bind
(escrow-until-bound needs design). Other candidates fit the same slot — e.g. records
from a project's own tooling (issue trackers, package registries) attested through a
bridge, once each source's authenticity story is proven in-guest like lane 2 is today.

## 9. Decisions (v1)

1. **Aggregator:** two-stage (§4) is locked for v1.
2. **Evaluator carve-out:** yes — `evaluatorCarveoutBps`, default 100 (1%), settable
   to 0. Computed in-proof (§6 step 6).
3. **Consent defaults:** `unacceptedMult = 0.5`, rejected = 0.
4. **Collaborator discount:** in — `collaboratorMult` is a param, starting at 0.5,
   with same-round co-claim as the v1 conflict predicate.
5. **First round:** ≤ $5k, in USDC or WETH (token not yet chosen).

## 10. Open questions

1. **`minRaterRep` shape:** absolute score vs rank cutoff, and the value. Current
   recommendation: a low absolute epsilon just above the teleport floor — its job is
   pruning noise, not gatekeeping; rank cutoffs create cliff effects at the boundary.
2. **Pool token:** USDC vs WETH for round one (distributor handles either).
3. **paramsHash rotation:** per-round window changes require OPERATIONAL_ROLE — which
   `UPGRADE_GOVERNANCE.md` lane should own it?
4. **Per-contribution scores:** indexer-derived only (v1 proposal) or proven via
   dual-domain leaves from day one?
