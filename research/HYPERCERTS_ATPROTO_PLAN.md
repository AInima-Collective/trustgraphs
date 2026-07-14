# Hypercerts × TrustGraph — AT Protocol Trust Graph Implementation Plan

**Status:** Planning, 2026-07-14. Execution spec: [`/GOAL.md`](../GOAL.md) (milestones M1–M5).
**Scope:** A concrete plan for the first production consumer of the offchain-attestation architecture: a ZK-proven trust graph over **Hypercerts' AT Protocol records**, published with `@hypercerts-org/lexicon` (v1.1.0, pinned). The output is the familiar `{node → score}` merkle root, proven permissionlessly by SP1, anchored by the two-lane input commitment.
**Relationship to [`OFFCHAIN_ATTESTATIONS_ZK.md`](./OFFCHAIN_ATTESTATIONS_ZK.md):** that document is the architecture (AnchorRegistry, envelope abstraction, identity model C, rule Φ, withholding analysis) — all of it is inherited unchanged. This document supplies what it deliberately left open: a real lexicon corpus, real graph semantics, and a partner. Where the architecture doc said "greenfield vouch lexicon," Hypercerts changes the answer: **we consume their published lexicons instead of minting our own** (and their `app.certified.link.evm` record resolves most of open question 5).
**Packaging:** this ships as the third program (`hypercerts`) on the multi-program platform ([`MULTI_PROGRAM_PLATFORM.md`](./MULTI_PROGRAM_PLATFORM.md)); everything instance-shaped (contracts, indexer views, params) follows that document.

---

## 1. Executive summary

Hypercerts publishes impact claims, evaluations, endorsements, and funding records as AT Protocol records in user repos. Those records already form a trust graph in all but name: evaluators score work, issuers award badges, recipients accept them, funders pay contributors, and every record is DID-attributed inside a signed, MST-committed repo. Our architecture needs exactly that shape: **per-repo completeness commitments (the PDS-signed commit) enumerated by an on-chain AnchorRegistry**, verified in-guest, folded into PageRank, committed as a proven root.

What Hypercerts gets: sybil-resistant, manipulation-evident **actor reputation and trust-weighted evaluation scores for hypercerts**, computed by a permissionless prover nobody has to trust, consumable on-chain (rewards, curation, gating) and off (ranking, discovery). What we get: the first real corpus for envelope 1, a partner running PDSes with real users, and a lexicon suite we don't have to invent — including the DID↔EVM binding record.

The one genuinely new design layer this plan adds over the architecture doc is **graph semantics** (§3): which records become edges, how string-typed unnormalized weights become fixed-point edge weights, how trust flows through *activity* records to their contributors, and how self-asserted participant lists are kept from being a free reputation printer. Everything below that layer — anchoring, MST range walks, PLC verification, rule Φ, cost model — is inherited with parameters filled in.

## 2. The input corpus

Pinned dependency: `@hypercerts-org/lexicon` **v1.1.0** (SemVer; consumers pin, never track `main`). The records we consume, and the MST collections the guest walks per repo:

| Collection (NSID) | Role in the graph | Load-bearing fields |
|---|---|---|
| `app.certified.graph.follow` | actor → actor edge (weakest) | `subject` (bare DID), `createdAt` |
| `app.certified.badge.award` | actor → actor-or-record endorsement, typed | `badge` (strongRef → definition), `subject` (DID \| strongRef), `createdAt` |
| `app.certified.badge.response` | recipient confirmation + weight on an inbound award | `badgeAward` (strongRef), `response` (accepted/rejected), `weight` (string) |
| `org.hypercerts.context.evaluation` | actor → record scored assessment (strongest) | `subject` (strongRef), `score{min,max,value}` (numeric strings), `evaluators[]`, `createdAt` |
| `org.hypercerts.claim.activity` | content node + attribution edges | `contributors[]` (`contributorIdentity`, `contributionWeight`) |
| `org.hypercerts.context.acknowledgement` | consent gate on attribution | `subject` (strongRef), `acknowledged` (bool) |
| `app.certified.link.evm` | DID ↔ EVM address binding | `eip712Message{did, evmAddress, chainId, timestamp, nonce}` + signature |

Explicitly **deferred to v2**: `funding.receipt` (economic edges need currency normalization and an anonymous-`from` policy), `context.measurement` (evidence weighting, not trust), `attachment`, collections/hyperboards, and record-level `signatures[]` verification (v1.1.0 attestation-spec signatures give *platform provenance*; useful, but not required for soundness since the commit signature already binds the repo).

Facts about the corpus that shape the design (from the lexicon review):

- **Numbers are strings and weights are un-normalized by design** ("normalization can be performed by the consuming application"). The guest gets a strict decimal-string → fixed-point parser; any record that fails the grammar is skipped deterministically (§3.5).
- **`knownValues` are open vocabularies, not enums** — `badgeType` etc. cannot be trusted as a closed set; treat unknown values by the default edge-type weight, never by rejection.
- **`strongRef` pins an exact record version by CID.** Cross-repo references are therefore *content-verifiable without the target repo's inclusion proof*: hash the supplied block, compare to the ref's CID (§5).
- **The author DID (repo owner) is the only cryptographically-attributed actor.** `evaluators[]`, `measurers[]` and friends are self-asserted lists that may name other people. v1 rule: **the edge source is always the repo owner**; listed co-evaluators are ignored until a co-signature mechanism exists (§3.4).

## 3. Graph semantics v1

### 3.1 Nodes

Per the architecture doc's model C (unified node set), with one addition — **artifact nodes**:

- **Bound actor** — EVM address + DID, bound via `app.certified.link.evm` verified in-guest both directions (EIP-712 recover → address; record presence in the DID's signed repo → DID-side consent). Gets both leaf domains (`keccak(nodeId, value)` and the v1 address leaf).
- **Satellite actor** — DID only, PDS-attested edges, `pdsAttestedWeightFp` discount. Scores visible and provable; on-chain claiming requires binding first.
- **Artifact** — an `org.hypercerts.claim.activity` record, `nodeId = keccak("at://" ‖ did ‖ "/" ‖ collection ‖ "/" ‖ rkey)`. Artifacts hold scores too — **this is the partnership's headline output**: a trust-weighted impact score per hypercert, not just per person. Artifacts never vote or claim; they are score sinks/conduits.

### 3.2 Edges

| # | Source → Target | From record | Weight (before type multiplier) |
|---|---|---|---|
| E1 | author → subject DID | `graph.follow` | 1 |
| E2 | author → subject (DID or artifact) | `badge.award` | 1; ×`ackBoostFp` if a matching `badge.response` with `response=accepted` exists (response `weight` clamped to [0,1] replaces the 1 when present); ×0 if `rejected` |
| E3 | author → subject artifact | `context.evaluation` | `(value − min) / (max − min)` clamped to [0,1]; malformed score → skip |
| E4 | artifact → contributor DID | `activity.contributors[]` | `contributionWeight / Σ contributionWeight` over the activity's parseable contributors; ×`ackBoostFp` if the contributor's repo holds an `acknowledgement{subject→activity, acknowledged:true}`; unacknowledged attribution gets `unackedAttribFp` (< 1) so being *named* is worth less than *confirming* |
| E5 | (v2) funder → recipient | `funding.receipt` | deferred |

Trust composes exactly the way PageRank wants it to: an evaluator's E3 edge flows rank *into* the activity, and the activity's E4 edges flow it *out* to contributors, weighted by attribution share. A well-evaluated hypercert lifts its acknowledged contributors; nobody wrote a special case for it.

Each edge's final weight = base weight × per-type multiplier (`wFollowFp`, `wBadgeFp`, `wEvalFp`, `wAttribFp`) × authorization-class multiplier (`1` for user-signed/bound, `pdsAttestedWeightFp` for satellite) — all fixed-point fields in the hypercerts `Params`, all inside `paramsHash`, all governance-tunable without touching the guest.

### 3.3 Anti-gaming defaults

- Self-edges excluded (existing rule, extended: an author's E3 on their own activity, and E4 back to themselves, are dropped before normalization — you cannot evaluate your own work into rank, and self-attribution only redistributes what others gave the artifact).
- E4 normalization is per-activity (Σ = 1), so padding a contributor list dilutes rather than mints.
- E2 `badge.definition.allowedIssuers`, when present, is enforced in-guest: award from a non-listed issuer → skip.
- Duplicate edges (same source, target, type) collapse by last-write-wins on `(createdAt, rkey)` within the repo — same reconciliation discipline as v1, per-repo instead of per-accumulator, with the anchor fold index as the cross-repo tie-break.

### 3.4 What we do NOT trust

Explicitly out of the trusted base, documented for the partner: `evaluators[]` beyond the author (self-asserted), free-string `contributorIdentity` values that aren't DIDs (skipped — no node to attach), `did:web` actors (no auditable key history; excluded from satellite status per the architecture doc), `createdAt` as a global clock (used only for intra-repo ordering; epoch membership comes from anchor time).

### 3.5 Deterministic skip rules

Every "skip" above must be provable, not discretionary: the guest applies a closed rule list (malformed decimal, non-DID identity, `allowedIssuers` miss, unknown collection shape, self-edge) and the count/reasons fold into the journal's `skippedDigest` alongside rule Φ's availability skips. A prover cannot silently drop a record it dislikes; a watcher holding the CAR can recompute the skip set.

## 4. Identity: adopt `app.certified.link.evm`

The architecture doc's open question 5 (mint a binding lexicon vs. converge on `org.chainagnostic.verification`) resolves for this instance: **use the partner's record.** `app.certified.link.evm` is EIP-712 (`{did, evmAddress, chainId, timestamp, nonce}` + 130–132-hex signature), lives in the DID's repo (DID-side consent via the signed commit), open-unioned for future ERC-1271/6492 — structurally identical to what we designed. In-guest verification: ecrecover the EIP-712 digest → address; require the record in the walked repo. Nonce/timestamp give replay protection; last-valid-binding-wins per DID; one address may bind many DIDs but a DID binds one address at a time.

Two caveats to carry: (a) the record's optional `signatures[]` (platform provenance) is *additional* evidence, not a substitute for the EIP-712 proof; (b) EOA bindings apply across EVM chains per the lexicon's own note — fine, since scores are chain-agnostic until claim time.

## 5. Per-repo verification pipeline (envelope 1, instantiated)

Inherited from the architecture doc §4.2 and dossier 01, with the Hypercerts specifics filled in:

1. **Anchor resolution** — rehash the `AnchorRegistry` fold to the epoch checkpoint; per registered node take the newest valid head ≤ boundary (max `rev`), rule Φ for stale/withheld (carry ≤ k epochs, then out-edges drop).
2. **Commit verification** — DRISL/dag-cbor decode the commit block; SHA-256 → CID must match the anchored head; verify `sig` (64-byte compact r‖s, low-S, k256 or p256 by multikey prefix) against the DID's `#atproto` key.
3. **PLC binding** — verify the did:plc audit-log chain in-circuit (genesis hash = DID suffix, each op signed by predecessor rotation keys, nullification rules, last op's `verificationMethods.atproto` = the commit key). Bindings younger than 72h are provisional (previous key also accepted for one epoch). Host feeds the log from **our own PLC mirror** (streaming API, live since Jan 2026); the mirror head is committed in the witness bundle.
4. **MST multi-range walk** — one walk, seven contiguous ranges (`[NSID ‖ "/", NSID ‖ "0")` per §2's collection list), enforcing the canonical invariants: strictly ascending keys, layer rule `floor(clz₂₅₆(sha256(key))/2)`, mandatory prefix compression, correct interleave; **any referenced block missing from the witness ⇒ fail closed for that repo** (rule Φ takes over, `skippedDigest` records it).
5. **Record decode** — dag-cbor decode each record in-range (5–20k cycles/record; a hand-rolled narrow-schema parser is the fallback if `serde_ipld_dagcbor` v0.6.4 benchmarks poorly in the Phase-A spike); apply §3 semantics.
6. **Cross-repo strongRefs** — resolve by CID against witness-supplied blocks (content-verified, no inclusion proof needed). Semantics: the referenced *version* is what the edge means; later deletion of the target does not retract the referrer's edge (the evaluation is the evaluator's own statement). `badge.response` and `acknowledgement` back-references must additionally appear in *their author's own walked repo* — that's what makes confirmation a two-sided fact.

## 6. Contracts and deployment (instance shape)

Per the platform doc: this is an **instance of the two-lane machinery with lane 1 empty** (`acc = 0` — no EAS feed at launch; the lane stays in the journal so a future EAS-side Hypercerts feed is a params change, not a redesign).

- `AnchorRegistry` (hypercerts instance): epoch schedule contract-fixed; registration gate = **allowlist-of-PDSes bootstrap** (Hypercerts' own PDSes) with the "invited-by" rule (one inbound edge from a bound node) as the planned decentralization step — Jake-decision on timing.
- `MerkleSnapshot` (journal v2) + `SP1JournalVerifier` (hypercerts vkey): standard deploys via the labeled scripts.
- No gov module, no distributor at launch. The root is the product; Hypercerts consumes it via merkle proofs in their own contracts/apps.
- **Chain: Optimism** (decided 2026-07-14) — sub-cent anchors, EAS predeployed if lane 1 ever opens, and operational familiarity from the v1 deployment. Registered in the per-chain `InstanceRegistry` (platform doc §4).

### 6.1 Launch parameters (v0 — decided 2026-07-14; all fixed-point in `Params`, governance-tunable via `paramsHash`)

| Parameter | Value | Rationale |
|---|---|---|
| Epoch length | **1 week** (302,400 blocks @ 2s) | matches evaluation/badge cadence; tight enough for weekly pilot feedback |
| k (rule-Φ carry-forward) | **4 epochs** (~28 days) | a dead/withholding PDS keeps a node's *given* reputation alive one month, then out-edges drop |
| `pdsAttestedWeightFp` | **0.5** | satellite edges are the corpus; allowlisted partner PDSes justify a mild rather than punitive discount |
| `wEvalFp` | **1.0** | scored expert assessment is the reference edge |
| `wAttribFp` | **0.8** | attribution through evaluated work is near-first-class |
| `wBadgeFp` | **0.5** | typed endorsement, cheaper to mint than an evaluation |
| `wFollowFp` | **0.2** | cheapest social signal |
| `ackBoostFp` | **2.0** | a confirmed edge (accepted badge / acknowledged attribution) is worth double its unconfirmed form |
| `unackedAttribFp` | **0.5** | being *named* is worth half of *confirming* |
| Damping / iterations / tolerance / output quantum | inherit v1 values | no reason to diverge; one fewer thing to re-validate |
| Seed set | **partner-curated list** in `Params` | v1's seed-weighting mechanism unchanged; Hypercerts nominates the initial evaluator/steward DIDs |
| Registration gate | **PDS allowlist** (Hypercerts' PDSes) at launch; the invited-by rule (one inbound edge from a bound node) activates by governance post-pilot | griefing control now, decentralization path already coded |
| Epoch prover | **we operate it for the pilot** (permissionless path open — anyone may out-prove us); bounty deferred until M1's measured costs say what it should pay | pilot-scale costs are single-digit dollars/epoch; incentive design isn't the bottleneck |

These are starting values, not commitments — every one of them moves through the operational-timelock `paramsHash` path with no guest change.

## 7. Prover, witness assembly, archival

- `prover hypercerts fetch` builds the witness bundle: enumerate registered DIDs → `getRepo` CAR (or firehose-maintained copies) at the anchored `rev` → PLC audit logs from our mirror → strongRef target blocks → bundle manifest with content hashes. Bundle is deterministic given the anchor set; `execute`/`prove` are offline from there.
- **CAR archival at observation time is mandatory** (old commits are not re-servable; deletion is trace-free). The indexer sidecar subscribes to the firehose (Sync v1.1, `prevData`-inductive) for the registered DID set, archives blocks keyed `(did, rev)`, and doubles as the equivocation watch (two signed heads at overlapping revs = publishable proof of PDS misbehavior).
- Account-status edge case: `takendown/suspended/deactivated` repos stop being servable → they hit rule Φ like any withheld head; the archived CAR still allows proving the *last anchored* state within the k-epoch window.

## 8. Cost model (pre-spike, all *(soft)*)

Assume launch-scale 1k repos / 50–100k records: per-attester commit sig (~220k cycles k256, more for p256) + SHA-256 MST walk + dag-cbor decode (5–20k/record) ≈ **1–3B cycles ≈ 2–6B PGU ≈ single-digit dollars and well under an hour** on the prover network; monolithic proof (aggregation threshold ~120B cycles is far away). At 10k repos, per-repo compressed sub-proofs (cached until `rev` changes) move cost to churn — that's platform Phase D, not launch. The Phase-A spike (GOAL M1) replaces every number here with a measured one.

## 9. Asks and flags for the Hypercerts team

1. **CAIP-19 reference on `activity`** (schema gap, confirmed): nothing links an atproto activity to its on-chain ERC-1155 hypercert. Not launch-blocking for the trust graph, but required the day scores should gate token-side behavior. Propose an optional `onchainRef` field or companion record.
2. **PDS enumeration + firehose access** for their user repos, and blessing for our CAR archival of trust-relevant collections (public data; still worth stating).
3. **Platform signing-key publication** (their README already recommends a long-lived keypair) so record-level `signatures[]` can be pinned for provenance in v2.
4. **Lexicon change protocol**: we pin v1.1.0; additive changes are fine, but the seven collections in §2 becoming `.v2` NSIDs is a guest change + vkey rotation — we need release-notes lead time.
5. **Acknowledgement UX**: E4's `ackBoostFp` only bites if contributors actually acknowledge; worth surfacing in their product ("confirm your contribution" = "activate your reputation").
6. Optional: converge `link.evm` with `org.chainagnostic.verification` upstream — their call; we verify either shape behind the same trait.

## 10. Open questions — resolved 2026-07-14

1. **Bootstrap connectivity:** partner-curated seed list in `Params`, same mechanism as v1 (Jake).
2. **Issuer penalty on rejected badges:** no for v1 — PageRank has no negative edges; a rejection zeroes the award and nothing more. A penalty regime is a design change, revisit only with evidence of badge-spam (Jake).
3. **Artifact score consumption:** both surfaces ship, with a clear division of trust. The **canonical interface is the on-chain root + merkle proofs** (`keccak(nodeId, value)` leaves) — anything of Hypercerts' that gates value or behavior verifies a proof and inherits the full trust story. The **indexer API serves `{nodeId, score, proof[]}` bundles** so their apps get ranking/discovery without running infrastructure — the API is a convenience that hands out proofs, never a second source of truth (an app can check any bundle against the root). This costs nothing extra: both fall out of the same journal, and the proof-bundle endpoint is the same code path the v1 frontend already uses.
