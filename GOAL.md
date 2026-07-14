# GOAL — Multi-Program TrustGraph + the Hypercerts AT-Proto Graph

Build the offchain-attestation architecture into production, packaged so
TrustGraph is a **platform of ZK-proven graphs** rather than one program,
and ship its first partner instance:

> **A permissionless SP1 proof that turns Hypercerts' AT Protocol records
> — evaluations, endorsements, attributions — into a trust-weighted
> `{node → score}` merkle root nobody had to be trusted to compute.**

This file is the execution spec. The designs are done and normative:
[`research/OFFCHAIN_ATTESTATIONS_ZK.md`](research/OFFCHAIN_ATTESTATIONS_ZK.md)
(two-lane architecture, AnchorRegistry, envelopes, identity model C,
rule Φ), [`research/MULTI_PROGRAM_PLATFORM.md`](research/MULTI_PROGRAM_PLATFORM.md)
(repo reorganization: program vs instance, crate layout, contract reuse,
docs), and [`research/HYPERCERTS_ATPROTO_PLAN.md`](research/HYPERCERTS_ATPROTO_PLAN.md)
(graph semantics over `@hypercerts-org/lexicon` v1.1.0, verification
pipeline, partner asks). v1's `ZK_ARCHITECTURE.md` and the four
`research/offchain/` dossiers are the substrate; every *(soft)* number
in them dies at M1 or lives as a measured fact.

---

## Ground rules

1. **The design docs are normative.** A build-time deviation from the
   three plans above gets an entry in `docs/DEVIATIONS.md` (what, why,
   which section it touches). No silent divergence — especially not in
   anything that feeds a journal, a leaf, or `skippedDigest`.
2. **The parity discipline is non-negotiable and now per-program.**
   Every byte encoding exists in exactly one core crate and is proven
   byte-identical across native Rust, the SP1 guest, Solidity golden
   tests, and the TS port before it is used anywhere. An encoding change
   without regenerated vectors in the same PR is a CI failure.
3. **The degradation rule lives inside the proven statement.** Rule Φ,
   the deterministic skip rules (HYPERCERTS_ATPROTO_PLAN §3.5), and
   `skippedDigest` are guest code, never host policy. The moment a
   prover chooses freely which heads or records to include, the
   completeness construction is theater (OFFCHAIN doc §7.3).
4. **Fail closed per repo, degrade gracefully per graph.** A missing MST
   block, bad signature, or malformed record never aborts the epoch; it
   trips rule Φ / a skip rule for that node and is publicly recorded.
5. **No new CVL/FV surface until the contracts are finished** — fuzz,
   unit, golden, and e2e per milestone; FV consolidates after M4 if the
   contract set stabilizes (same policy as our other builds).
6. **Pinned externals:** SP1 `=6.3.1` (+ its patch line for
   sha2/k256/p256), `@hypercerts-org/lexicon` `=1.1.0`. Bumping either
   is a deliberate event with a vkey-rotation plan, not a lockfile
   accident.
7. **Vkey rotations are batched.** M0's refactor and M2's patched-crate
   additions both change existing ELFs; rotate root + signer verifiers
   once, at M2's deploy, through the constitutional-timelock path.

## Repo layout (target)

Per MULTI_PROGRAM_PLATFORM §3/§9 — abbreviated:

```
packages/
  zk-core/           shared words/fold/merkle/fixed/cid/journal (no_std)
  envelopes/         envelope trait; eas_offchain; atproto/{cbor,commit,mst,plc,carset}
  pagerank-core/     trust-graph + signer semantics (API preserved via re-exports)
  hypercerts-core/   record→edge mapping, hypercerts Params/Journal
zk/program/          bins: trustgraph-program · trustgraph-signer-program · hypercerts-program
zk/prover/           clap: prover <program> {vkey|paramshash|fetch|execute|prove}; witness/ (host-only)
src/contracts/       merkle/ (MerkleSnapshot journal-v2, SP1JournalVerifier), registry/AnchorRegistry.sol
test/golden/         trust-graph.json · hypercerts.json (+ per-program .t.sol / golden.test.ts)
docs/                PROGRAMS.md + {trust-graph,signer-sync,hypercerts}/ runbooks
indexer/             instance-aware config; anchor/offchainEdge/nodeBinding tables; firehose+PLC sidecar; CAR archive
frontend/lib/        zk-core/ (shared TS) + pagerank/ + hypercerts view (reduced parity tier, documented)
```

---

## Milestones

Each milestone merges to main with its tests green in CI and its
program's four-way parity job passing.

**M0 — Platform reorg (MULTI_PROGRAM_PLATFORM §10, steps 1–5).**
Extract `zk-core`; split golden vectors + Solidity/TS golden tests per
program; `zk/prover` → clap program groups; `taskfile/zk.yml`
(`zk:vectors|vkey|execute|prove|parity` with `PROGRAM=`); docs reorg
(`docs/PROGRAMS.md`, per-program runbooks, research status banners,
CLAUDE.md link fixes); `SP1JournalVerifier` rename. **No behavior
changes.** *Exit:* all four parity layers green with **byte-identical
vectors to pre-reorg**; both existing programs prove e2e on anvil
through the new CLI; new vkeys derived and recorded in PROGRAMS.md.

**M1 — Phase-A spike (kills every soft number; ~days, throwaway code).**
On SP1 6.3.1: measured cycles + PGU for patched ecrecover, patched p256
verify, keccak, SHA-256/byte; PGU-to-cycle multiplier from
`ExecutionReport`; one live prover-network request for a real clearing
price. MST walk prototype (decode + range walk + invariant checks)
validated against `indigo`'s Go implementation on real CARs, including a
**Hypercerts-record fixture** (their PDS or a local PDS seeded with
v1.1.0 records); benchmark `serde_ipld_dagcbor` vs a hand-rolled MST/
record parser. *Exit:* a numbers table committed to
`research/offchain/05-spike-results.md`; go/no-go on parser choice; cost
model in HYPERCERTS_ATPROTO_PLAN §8 updated from measured data.

**M2 — Lane-2 infrastructure + envelope 0 (OFFCHAIN doc Phase B).**
`AnchorRegistry` (fold, registration gate, epoch schedule) +
`MerkleSnapshot` journal v2 (two-lane, empty-lane-as-zero-accumulator —
the **only** journal shape in the codebase; v1 exists solely as the
frozen live deployment) + `InstanceRegistry` (per-chain instance →
contract-set discovery) + checkpoint wiring; `envelopes` crate with the trait + EAS-offchain
chained-log envelope (ecrecover in-guest, `revokeOffchain` deletion set,
`(attester, uid)` leaf binding); rule Φ + `skippedDigest` in the
trust-graph guest; indexer anchor tables; frontend recompute updated for
journal v2. Batched vkey rotation for root + signer. *Exit:* two-lane
proof e2e on anvil — lane-1 EAS edges + lane-2 envelope-0 fixture in one
journal; golden vectors for journal v2 + anchor leaf locked four ways;
withholding test (anchored head, data withheld → rule Φ path, skip
recorded and root still lands).

**M3 — atproto envelope (OFFCHAIN doc Phase C, minus product surface).**
In-guest per HYPERCERTS_ATPROTO_PLAN §5: dag-cbor/DRISL decode (parser
per M1's verdict), commit signature verify (k256 + p256, low-S, 64-byte
compact — re-verify wire format against the cryptography spec first,
dossier 01 flag), did:plc audit-log chain verification with 72h
provisional rule, MST multi-range walk with canonical-structure
invariants, fail-closed block handling, absence semantics. Host side:
PLC mirror client, `getRepo`/firehose fetch, CAR archival keyed
`(did, rev)`, witness bundle format. *Exit:* conformance suite vs indigo
vectors green (structure, absence, equivocation, boundary-fencing
cases); the guest proves a real Bluesky repo and a seeded Hypercerts
repo end-to-end; a tampered-block fixture fails closed into
`skippedDigest`.

**M4 — The hypercerts program.** `hypercerts-core`: §2 collection set,
§3 edge semantics (E1–E4, per-activity normalization, ack gating,
`allowedIssuers`, self-edge exclusion, deterministic skip rules), decimal
string → fixed-point parser, `link.evm` binding verification, two node
classes + artifact nodes, hypercerts Params/Journal + `ParamsCodec`
twin; third guest bin + `prover hypercerts` group incl. `fetch`; golden
vectors + Solidity + TS golden tests; indexer instance tables +
`skippedNode` audit view; minimal frontend instance view (reduced parity
tier, labeled as such). *Exit:* full pipeline on a local PDS seeded with
the partner fixture — anchor → fetch → prove → `submitProof` → root on
anvil; TS recompute reproduces root + `skippedDigest` from indexed
edges; anti-gaming vectors green (self-evaluation, padded contributor
list, non-allowlisted issuer, satellite-weight discount each provably
inert or discounted).

**M5 — Pilot with Hypercerts, on Optimism.** Full-dress rehearsal on OP
Sepolia first (deploy battery + one proven epoch), then the pilot
instance on **Optimism** (decided 2026-07-14): AnchorRegistry with
PDS-allowlist gate, snapshot + verifier deploys via labeled scripts,
`InstanceRegistry` entry, weekly epochs (params per
HYPERCERTS_ATPROTO_PLAN §6.1), indexer + archival sidecar running
against their real PDS(es), the `{nodeId, score, proof[]}` bundle API,
`docs/hypercerts/` runbook complete, §9 partner asks delivered as a
written brief (CAIP-19 gap, key publication, lexicon change protocol,
ack UX). *Exit:* ≥3 consecutive weekly epochs proven permissionlessly on
Optimism over real partner data with zero manual intervention; an
independent party (or clean-room run) reproduces one epoch's root
byte-identically from public data; joint review with the Hypercerts
team signed off.

**Deferred (explicitly not this GOAL):** per-repo compressed sub-proofs
and blob/Blobstream `dataCommitment` (Phase D — trigger: >~10k repos or
epoch proving > ~1h), the privacy track (Phase E), `funding.receipt` /
`measurement` edges, record-level `signatures[]` verification, a full
browser-side envelope verifier, governance/distributor consumers for the
hypercerts instance, a prover bounty (we run the pilot prover; the
permissionless path stays open).

## Decisions (resolved 2026-07-14 — record, not open items)

| Decision | Resolution |
|---|---|
| Pilot chain | **Optimism** (OP Sepolia rehearsal first) |
| Backwards compatibility / v1 migration | **None.** Live trust-graph deployment stays frozen on journal v1, never migrated; codebase carries journal v2 only; clean renames, no aliases |
| Epoch length / staleness k | 1 week / 4 epochs (HYPERCERTS_ATPROTO_PLAN §6.1) |
| `pdsAttestedWeightFp` and edge-type params | Starting values fixed in §6.1 (eval 1.0 / attrib 0.8 / badge 0.5 / follow 0.2, ackBoost 2.0, unackedAttrib 0.5, PDS-attested 0.5); all timelock-tunable |
| Bootstrap / seed | Partner-curated seed list in `Params`, v1 mechanism |
| Registration gate | PDS allowlist at launch → invited-by rule activates by governance post-pilot |
| Rejected badge → issuer penalty | No for v1 |
| Artifact score consumption | Canonical = on-chain root + merkle proofs; indexer serves `{nodeId, score, proof[]}` bundles as convenience (HYPERCERTS_ATPROTO_PLAN §10.3) |
| Monorepo / `InstanceRegistry` | Monorepo stays; `InstanceRegistry` built (M2) |

Remaining external dependency: Hypercerts' responses to the §9 partner
asks (CAIP-19 gap, PDS/firehose access, key publication, lexicon change
protocol) — needed by M5, none block M0–M4.

## Execution notes — model allocation

Same principle as prior builds: **delegate work whose output is
machine-checkable; keep work whose failure mode is silent.**

**Fable (main session):** everything inside the proven statement —
envelope verification logic, MST invariant enforcement, rule Φ and skip
rules, journal/leaf encodings, edge-semantics arithmetic (normalization,
ack gating), PLC chain verification; the M0 extraction plan (a wrong cut
here is silent debt); counterexample triage; milestone acceptance;
DEVIATIONS calls.

**Opus subagents:** per-crate test suites against frozen encodings;
golden-vector regeneration plumbing and CI wiring; the indexer sidecar +
archival store; clap/taskfile/deploy-script restructuring; fixture
construction (seeded PDS, tampered CARs, equivocation pairs); docs
migration; frontend instance view. Reconnaissance (lexicon drift checks,
spec re-verification) goes lower. Frame adversarial-testing prompts as
property verification ("refute: a padded contributor list mints rank"),
not exploit development.

## Bug capture

Every counterexample → minimal committed repro → GitHub issue (plan
section, trace, affected encoding) → failing test stays expected-fail
until the fix flips it. Findings that contradict a plan doc are
DEVIATIONS events; findings that weaken the OFFCHAIN doc's trust-surface
table (§8) reopen that row in the research doc itself.

## Done when

1. **All six milestones exited** with their stated criteria, every
   program's four-way parity job green in CI.
2. **The pilot stands on its own:** three-plus consecutive permissionless
   epochs over real Hypercerts data, independently reproduced, partner
   sign-off recorded.
3. **Completeness is auditable end-to-end:** for any pilot epoch, a
   third party holding only public data (chain + archived CARs + the
   witness bundle) can re-derive the root and the full `skippedDigest`
   preimage — no appeal to our indexer required.
4. **The platform claim is demonstrated, not asserted:** adding the
   hypercerts program touched no line of `pagerank-core`'s semantics,
   and `docs/PROGRAMS.md` accurately describes how the fourth program
   would be added.
5. **The partner brief is delivered** (HYPERCERTS_ATPROTO_PLAN §9) with
   written responses on the CAIP-19 gap and the lexicon change protocol.
