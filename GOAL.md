# GOAL — Contribution Funding on EAS (the contributions program)

Build the v1 contribution-funding system:

> **Attest to a contribution (or nominate one), let others attest to its
> value, and split a funding pool by those valuations weighted by the
> raters' proven reputation — with the whole path from vouch graph to
> payout computed inside an SP1 proof and claimed through
> `MerkleFundDistributor`.**

This file is the execution spec. The design is done and normative:
[`research/CONTRIBUTION_FUNDING.md`](research/CONTRIBUTION_FUNDING.md)
(schemas §2, architecture §3, two-stage scoring §4, anti-gaming §5,
round lifecycle §6, decisions §9). This is the **fifth program** on the
platform ([`docs/PROGRAMS.md`](docs/PROGRAMS.md)); it must demonstrate
the platform claim again: no semantic change to `pagerank-core`,
`zk-core`, or any existing program's encodings.

**Target for this GOAL: a full round proven and paid out on local anvil,
driven end-to-end through the frontend.** Testnet/production deployment
is a later GOAL.

---

## Ground rules

1. **The design doc is normative.** Deviations get an entry in
   `docs/DEVIATIONS.md` (what, why, which § it touches) — especially
   anything feeding the journal, a leaf, `paramsHash`, or the fold.
2. **Parity discipline, per-program.** Every byte encoding lives in
   `packages/contributions-core` and is proven byte-identical across
   native Rust, the SP1 guest, Solidity golden tests
   (`test/golden/contributions.json`), and the TS port before use.
   Encoding change without regenerated vectors in the same PR = CI
   failure.
3. **Scoring rules are guest code, never host or indexer policy.** The
   filters (self-valuation, collaborator discount, `minRaterRep`, round
   window), the consent multipliers, σ_r normalization, and the
   carve-out all execute in-guest. The indexer's per-contribution
   scores are a *display recompute* validated against the proven root
   (`assert recomputed root == on-chain root` before trusting rows) —
   convenience, never a second source of truth.
4. **Frozen things stay frozen.** Journal v2 (10 words) is reused
   as-is: `(acc, leafCount)` = the trust accumulator checkpoint,
   `(anchorAcc, anchorCount)` = the contribution accumulator
   checkpoint. No new journal shape. v1 leaves are address-domain only.
5. **No new FV surface** — fuzz, unit, golden, e2e per milestone; FV
   consolidates after the contract set stabilizes (post-M6), same
   policy as prior builds.
6. **Frontend copy passes the plain-reader test.** No internal spec
   numbering (§, INV-*, param names) in the DOM; a normal DeFi user
   understands each screen on first read; jargon defined in place.
7. **Sensible defaults over stalls.** Open items from design-doc §10
   get a recorded default here (see Decisions) and a param, not a
   blocker.

## Interface freeze (IF) — merges first, everything hangs off it

A single small PR that freezes, in `packages/contributions-core` +
`docs/contributions/INTERFACES.md`:

- **The three schema strings** (design §2.1–2.3) exactly as registered:
  `contribution.claim` = `string title, bytes32 contentHash, string uri,
  address[] contributors, uint32[] shares`; `contribution.response` =
  `bytes32 claimUID, uint8 response`; `contribution.valuation` =
  `bytes32 claimUID, uint8 score`.
- **The fold `kind` tagging** for the contribution accumulator:
  `kind = schemaIndex * 2 + isRevoke`, schemaIndex 0 = claim,
  1 = response, 2 = valuation (kinds 0–5). Same leaf ABI as
  `AttestationAccumulator` today; only the `kind` domain is new, and it
  is per-accumulator-instance, so nothing existing changes.
- **The Params layout + `params_hash`** (with Solidity `ParamsCodec`
  twin): the rep params mirrored from the trust program (damping,
  tolerance, maxIterations, trustMultiplier, trustShare, seeds,
  weightFieldIndex, min/max weight, precisionScale) plus the contrib
  params: `roundStart`, `roundEnd`, `unacceptedMultFp`,
  `collaboratorMultFp`, `minRaterRepFp`, `evaluatorCarveoutBps`,
  `totalPool`, and the three schema UIDs (binding the kind tags to
  concrete schemas inside the proven statement).
- **Blob format**: canonical sorted `{"0x<address>":"<decimal>"}`, same
  as trust-graph lane 1.

*Exit:* the doc + a stub `contributions-core` with the codec and
`params_hash` under test. Nothing else may merge before this.

---

## Milestones

Each milestone merges to main with tests green and the program's parity
job passing. **Lanes marked ∥ are independent after their stated
prerequisite and should run as parallel subagent lanes.**

**M0 — Contracts + deploy battery.** *(prereq: IF)*
`ContributionResolver is SchemaResolver, AttestationAccumulator` in
`src/contracts/eas/resolvers/`: folds with the IF kind tags, and — new
requirement — **holds an immutable allowlist of the three schema UIDs
(set once post-registration) and reverts attestations from any other
schema**. (Anyone can register a garbage schema pointing at any
resolver; the live `EASIndexerResolver` tolerates this because open
vouching makes it harmless, but here the kind tag must be
trustworthy.) Contrib `MerkleSnapshot` instance (journal v2,
`epochLength` set, paramsHash storage) + `MerkleFundDistributor`
instance. Deploy script `DeployContributionsInstance.s.sol` following
`DeployHypercertsInstance.s.sol`, schema registration via
`Schema.s.sol`, `program: "contributions"` network entries in
`config/networks.development.json` with `schemas[]` (incl. `fields` so
`SchemaManager` picks them up), addresses into
`.docker/deployment_summary.json`, `deploy/env.ts` threading, and a
mock-ERC20 (test USDC) deploy for the pool.
*Exit:* Foundry suite green — fold-parity golden test against IF
vectors, schema-allowlist rejection, revocation folds, checkpoint
freeze of both accumulators in one `trigger()`; `pnpm deploy:contracts`
stands the full contrib instance up on anvil.

**M1 — `contributions-core` (the proven semantics).** *(prereq: IF;
∥ with M0)*
The core crate, no_std-compatible like its siblings: decode the three
payloads (malformed → deterministic skip), reconciliation
(last-write-wins per key by `(block_timestamp, fold_index)`, revocation
excludes, one live valuation per (rater, claim)), stage-1 rep =
`pagerank-core::calculate_generic` over the trust edges (algorithm
untouched — import, don't fork), stage-2 per design §4: eligibility
filters (self-valuation, collaborator discount via same-round co-claim,
`minRaterRep`, round window), σ_r budget normalization, S(c), P(a) with
consent multipliers, carve-out β scaling contributor weights by 1−β and
adding rater leaves pro-rata rep × participated, then
`distribute_points_generic` quantization, blob, leaves, journal.
Golden vectors `test/golden/contributions.json` + Solidity golden test
+ property/fuzz suite. Properties that must hold under fuzz:
Σ payouts = totalPool exactly; contributor-list padding never increases
any outsider's payout; self-valuations and out-of-window records are
provably inert; β = 0 ⇒ zero rater leaves; rejected consent ⇒ zero for
that share; removing a below-`minRaterRep` rater changes nothing.
*Exit:* four-way parity green (native / guest via M2 / Solidity / TS
via M4 — the vector file is the contract between lanes); property
suite green; a hand-computed 6-persona worked example reproduced
exactly (this fixture is reused by M5).

**M2 — Guest + host.** *(prereq: M1 encodings frozen)*
`zk/program` bin `contributions-program` (thin shell: read
`GuestInput` → compute → commit `journal_encoded`), `zk/prover` clap
group `prover contributions {vkey|paramshash|fetch|execute|prove}`
where `fetch` exports `input.json` from the two on-chain checkpoints,
`taskfile/zk.yml` wired for `PROGRAM=contributions`, vkey derived and
recorded in `docs/PROGRAMS.md`.
*Exit:* `execute` over anvil-exported real checkpoint data reproduces
the M1 vectors byte-identically; mock-prove → `submitProof` lands a
root on local anvil.

**M3 — Indexer lane.** *(prereq: M0 deployed + IF; ∥ with M2, M4)*
Ponder sources for `contributionResolver` + contrib `merkleSnapshot` +
contrib `merkleFundDistributor` via `deployment_summary.json`
aggregation (ABIs added to `frontend/lib/contract-abis`; backfill
start-blocks; presence-gated). Onchain tables (house conventions:
snake_case, indexed FKs): `contribution_claim` (decoded: title,
contentHash, uri, contributors+shares, attester, timestamps, revoked),
`contribution_response`, `contribution_valuation` (decoded, LWW
surfaced as `superseded` flag rather than deletion). Offchain schema
(numeric-78 rule): `contribution_score` per (snapshot, claimUID) with
S(c) and per-contributor breakdown, `contribution_round` metadata.
Derived scoring: a TS recompute of stage-2 (byte-identical port —
shares `frontend/lib/contributions/` code, see M4) run on
`MerkleRootUpdated`, mirroring `ingestHypercertsScores`: rebuild the OZ
tree from the IPFS blob, **assert recomputed root == on-chain root**
(mismatch ⇒ 409/refuse, never serve). API routes under
`/contributions`: round summary, claims-with-scores list,
`/:snapshot/score/:claimUID`, per-account payout `{value, proof[]}`
bundle (the `merkleEntry` path the claim UI consumes), skip/audit view
(why a valuation was filtered — powering honest UI copy). Existing
generic distributor handlers already cover the new instance; verify,
don't duplicate.
*Exit:* against an M0 anvil deployment + an M1 fixture blob: tables
populate from seeded attestations, derived scores match the fixture's
hand-computed values, proof bundles verify against the posted root,
`hypercerts`/trust-graph routes untouched (regression run).

**M4 — Frontend lane.** *(prereq: M0 config entries + IF; ∥ with M2,
M3)*
Config plumbing first: `program: "contributions"` filtering in
`lib/config.ts`, `scripts/generate-config.ts` contract map,
`wagmi:generate`. TS port `frontend/lib/contributions/` (stage-2
aggregation + blob/leaf encode, `golden.test.ts` against the M1
vectors — this is the fourth parity leg; the indexer imports this same
logic). Pages, reusing shadcn primitives and the network-page
patterns:
- **Round view** (`app/network/[id]/` for contributions-program
  networks): round window status, claims list with live derived scores,
  each claim expandable to its valuations and to *why* something was
  discounted (plain language: "rated by a collaborator, counted at
  half weight" — never param names).
- **Submit a contribution**: title/uri/contentHash, contributors +
  shares editor (self-claim prefilled; nomination = listing others),
  via `useAttestation` + `SchemaManager` (schema entries come free
  from the M0 config).
- **Respond**: accept/reject for claims naming you, with the funding
  consequence stated plainly.
- **Rate contributions**: 0–100 per claim **with the budget made
  visible** — the UI shows your rating power splitting across
  everything you've rated (σ_r), because the plain-reader rule demands
  users understand that rating everything highly dilutes each rating.
- **Payout**: claim page cloned from `_distribute` (distribute with
  `expectedRoot` pinned for the admin path, `claim`/claim-all,
  ERC20 approve, fee display) driven by the `/contributions`
  proof-bundle API.
*Exit:* every screen functional against the M3 indexer + M0 anvil
stack with mocked scores until M2 lands; golden.test.ts green; copy
passes the plain-reader rule (reviewed against ground rule 6).

**M5 — Local-anvil E2E: one full round, UI-driven.** *(prereq: M0–M4)*
Seed script per the `trustgraph.yml` persona pattern
(`create-contribution-round-network`): vouch graph incl. trusted
seeds, then claims (incl. one nomination, one rejected consent, one
unaccepted), valuations (incl. a self-valuation and a
collaborator-pair that must be discounted), all matching the M1
worked-example fixture. Full lifecycle exercised **through the UI
where a user would** (attest/respond/rate/claim) and via task where an
operator would (`trigger` → `prover contributions fetch/execute/prove`
→ pin blob → `submitProof` → `distribute` mock-USDC):
*Exit:* final on-chain balances equal the fixture's hand-computed
payouts to the wei, including the 1% evaluator carve-out; indexer
scores equal guest blob; a second round over the same instance (new
window params) also lands cleanly — proving rounds are repeatable;
`docs/contributions/LOCAL_TESTING.md` + `RUNBOOK.md` written and
followed cold by a fresh session.

**M6 — Hardening.** *(distributor work ∥ from M0 on)*
`MerkleFundDistributor` expiry + sweep (design §7): per-distribution
`claimDeadline` param, post-deadline `sweep(distributionIndex)`
returning unclaimed funds to the round funder; keep open-claim
(decided: claims pay only the leaf's account) but document it.
New deployments only — the live trust-graph distributor instance is
untouched. Then the adversarial pass: anti-gaming vector suite as
Foundry + core-crate tests (each §5 attack provably inert or
discounted), `/code-review` + solidity-auditor over the new contract
surface, fuzz budget bump in CI.
*Exit:* sweep path tested incl. sweep-vs-late-claim race; audit
findings triaged to issues with fixes or accepted-risk notes; CI
carries the full program parity job.

## Parallelization map

```
IF ──┬── M0 (contracts) ──┬── M3 (indexer)  ∥ ──┐
     └── M1 (core crate) ─┼── M2 (guest/host) ∥ ─┼── M5 (e2e round) ── M6 close-out
                          └── M4 (frontend)  ∥ ──┘
distributor sweep (M6 part) ∥ any time after M0
```

Subagent guidance: M2/M3/M4 are the three parallel lanes; the M1
golden-vector file is the inter-lane contract — lanes build against
vectors + fixture blobs, never against each other's branches. M3 and
M4 share `frontend/lib/contributions/` (frontend owns it; indexer
imports), so land that module early in M4's lane.

## Decisions (locked; from design §9 + defaults per ground rule 7)

| Decision | Resolution |
|---|---|
| Aggregator | Two-stage (design §4), locked |
| Evaluator carve-out | `evaluatorCarveoutBps`, default 100 (1%), 0 disables; in-proof |
| Consent | `unacceptedMult` 0.5, rejected 0 |
| Collaborator discount | `collaboratorMult` param, start 0.5; same-round co-claim predicate |
| First live round | ≤ $5k, USDC or WETH — **local testing uses a mock ERC20 ("test USDC")** |
| `minRaterRep` (default pending §10) | Absolute epsilon just above the teleport floor; a param — tune at M5 with real fixture numbers |
| Per-contribution scores | Indexer-derived + root-validated, not proven (design §3); dual-domain leaves deferred |
| Program name / tag | `contributions` (crate `contributions-core`, bin `contributions-program`, network `program: "contributions"`) |
| Journal | v2 reused unmodified; slot A = trust acc, slot B = contrib acc |
| Distributor sweep | Build in M6, new deployments only; open-claim kept |

Still open (do not block this GOAL): production pool token (USDC vs
WETH), `paramsHash` rotation governance lane (waits on
`UPGRADE_GOVERNANCE.md` review), production chain + round cadence.

## Execution notes — model allocation

Same principle as prior builds: **delegate work whose output is
machine-checkable; keep work whose failure mode is silent.**

**Fable (main session):** everything inside the proven statement —
stage-2 arithmetic, filters, consent/carve-out math, params/leaf/blob
encodings, the IF freeze itself; the worked-example fixture (it is the
cross-lane oracle, a wrong fixture poisons every lane); counterexample
triage; milestone acceptance; DEVIATIONS calls.

**Subagent lanes:** M0 contract suite + deploy battery; M2 CLI/taskfile
plumbing; M3 indexer (tables/handlers/routes) against frozen vectors;
M4 pages against the fixture; seed scripts; docs. Frame adversarial
prompts as property refutation ("refute: padding `contributors[]`
increases an outsider's payout"), not exploit development.

## Bug capture

Every counterexample → minimal committed repro → GitHub issue (§ of the
design doc it touches, trace, affected encoding) → failing test stays
expected-fail until the fix flips it. Findings that contradict
`CONTRIBUTION_FUNDING.md` are DEVIATIONS events; findings that weaken
its §5 anti-gaming table reopen that section in the research doc.

## Done when

1. **All milestones exited** with stated criteria; the contributions
   parity job (native / guest / Solidity / TS) green in CI.
2. **One command stands the world up:** from a clean checkout,
   `task start-all-local` + deploy + seed + the M5 round produce a
   paid-out round on anvil, reproduced by a fresh session following
   `docs/contributions/LOCAL_TESTING.md` only.
3. **The money math is audited by construction:** for the M5 round, a
   third party holding only chain data + the IPFS blob re-derives every
   payout to the wei, including carve-out and every discount applied.
4. **The platform claim held again:** adding the fifth program touched
   no semantics in `pagerank-core`/`zk-core`/existing programs, and
   `docs/PROGRAMS.md` documents the program accurately.
5. **A normal DeFi user can use it:** every M4 screen passes the
   plain-reader rule; the round can be completed without reading any
   internal doc.
