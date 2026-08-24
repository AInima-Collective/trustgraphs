# GOAL — Ship the `nostr-workspace` Program

> **Status (2026-08-19): S0–S4 implemented and locally verified; S5 non-synthetic pilot pending.**

Build and pilot the Buzz/Nostr design in
[`research/BUZZ_NOSTR_PLAN.md`](../BUZZ_NOSTR_PLAN.md) as a new, isolated
Trustgraphs program:

> **A Buzz workspace can anchor its signed Nostr history, prove deterministic trust scores over
> vouches, merges, completed-job evidence, and forum upvotes, and publish the standard journal-v3
> root without trusting the prover to select or compute the result.**

The program is named **`nostr-workspace`**. Its core crate is
`crates/nostr-workspace-core`, its isolated SP1 workspace is `zk/nostr-program`, its program id is
`keccak256("nostr-workspace")`, and its output domain is
`keccak256("trustgraphs.output.nostr-member.v1")`.

This file is the execution spec. The research plan remains the design authority except where the
implementation clarifications below make an underspecified or unsafe choice explicit. A material
change to either document must update both or be recorded in
[`research/DEVIATIONS.md`](../DEVIATIONS.md) before code depending on it merges.

---

## Outcome

When this goal is complete:

1. A pinned Buzz deployment exports a complete, versioned witness for an anchored community audit
   head (Option A) and for any enabled self-committed member/agent logs (Option C).
2. The shared envelope crate verifies the audit chain, witness commitment, NIP-01 ids and BIP-340
   signatures, NIP-OA delegations, roster, replacement, and deletion rules with the same code
   natively and inside SP1.
3. `nostr-workspace-core` maps the accepted V1/G1/J1/F1 signals to a deterministic graph, computes
   the standard fixed-point Trust-Aware PageRank distribution, emits dual-domain leaves for bound
   members, and commits the ordinary 12-field journal-v3 public values.
4. The prover, operator, contracts, indexer, frontend, and documentation recognize the new program
   through authenticated program/instance metadata. Existing program semantics and vkeys do not
   change.
5. Two consecutive epochs from a real local or pilot Buzz workspace are anchored, proven, landed,
   indexed, and independently reproduced by another authorized archive holder. The second epoch
   exercises replacement, revocation/deletion, membership change, and carry/drop behavior.

The honest product statement is intentionally narrower than “public Nostr reputation.” A proof is
publicly verifiable, but a member-scoped archive is reproducible only by members or other authorized
archive holders. Option A proves correctness relative to the community-operated relay/exporter’s
enumeration; it does not prove that an adversarial relay recorded every event it received.

---

## Normative baseline and pins

- Product and protocol design:
  [`research/BUZZ_NOSTR_PLAN.md`](../BUZZ_NOSTR_PLAN.md), especially its §12 decision record.
- Lane-2, rule-Φ, journal, and availability model:
  [`research/OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md).
- Program isolation and integration checklist:
  [`docs/build/add-a-program.md`](../../docs/build/add-a-program.md).
- Closest built precedent: `crates/envelopes/src/atproto/`,
  `crates/hypercerts-core/`, and the Hypercerts prover/indexer/docs paths.
- SP1 and crypto baseline: SP1 `=6.3.1`, patched `sha2` and `k256` tags already measured in
  [`research/nostr/README.md`](../nostr/README.md). Any SP1 or patch-tag change requires a new
  benchmark, a reviewed lockfile diff, and a vkey-rotation decision.
- Buzz reconnaissance baseline: `block/buzz@a362fecc2389955f942c9581bdfeba379ab115b3`
  (2026-08-18). S0 may deliberately select a newer commit, but all fixtures and source assertions
  must name one immutable SHA. Never build consensus behavior against moving `main`.
- Nostr behavior is pinned to the selected Buzz release’s `rust-nostr` version plus the cited NIPs.
  If Buzz behavior and generic NIP prose differ, the fixture records the difference and the program
  either reproduces Buzz exactly or rejects the shape. It never guesses.

---

## Implementation clarifications

These close gaps found while checking the research plan against the current Trustgraphs and Buzz
code. They are part of the goal, not optional polish.

### 1. Option A and Option C are one mixed input set

`envelopeKind = 2` identifies the Nostr envelope on-chain. The versioned envelope witness carries
an internal commitment variant (`buzz-audit-v1`, `self-log-v1`, and, only if activated at S0,
`sidecar-head-v1`). Params contain an **allowed-variant bitmap**, not one singular
`commitment_kind`: a community-node anchor may use A/A′ and a `did:nostr` node may use C.

The same Nostr event can be committed by the workspace audit head and by its author’s self-log. It
is verified once, deduplicated by event id before graph semantics, and assigned the strongest
successfully verified provenance class. It never creates two edges or two units of weight.

### 2. `dataCommitment` binds the exact witness bytes

S0 freezes a deterministic, length-prefixed binary bundle format (`TGNW v1`). For every selected
head, the guest recomputes `sha256(TGNW-envelope-bytes)` and requires equality with that anchor’s
`dataCommitment`. A raw CIDv1 can use that SHA-256 digest, but the digest is not itself an
availability proof or a public URL.

Missing bytes for a trust-relevant `EventCreated` entry invalidate that head; the prover may not
turn an omitted event into an “unknown kind” or discretionary event-level skip. Malformed bytes
that are present and committed follow the closed deterministic skip rules. Every skip preimage is
archived and reconstructs `skippedDigest` exactly.

### 3. Option A v1 is a bounded full-prefix proof

The v1 guest re-folds audit sequence `1..=anchored_count` from genesis. This is the simplest claim
that really matches the research plan, but its work is cumulative rather than “events this epoch.”
S0 benchmarks **audit entries, relevant event bytes, and signatures**, not merely events per epoch,
and fixes a pilot cap below the measured proving limit.

The exporter reads the audit log and event rows (including soft-deleted/replaced relevant rows) from
a consistent, read-only database snapshot. Before anchoring it must prove locally that:

- audit is enabled and the chain verifies;
- every trust-relevant stored event older than the configured audit-settle window has exactly one
  `EventCreated` entry;
- every trust-relevant `EventCreated` entry through the chosen head has event bytes;
- the roster and relay key match the instance configuration; and
- the exact TGNW bundle passes the production envelope verifier and hashes to `dataCommitment`.

An audit-worker write failure is therefore an anchoring health failure, not a silently skipped
event. If the selected Buzz deployment cannot pass this gate, S0 either activates and fully
specifies A′ under a pinned committer key or stops for a design amendment. It does not quietly
weaken A.

Incremental/recursive audit proofs or a proven persistent graph-state commitment are a later scale
upgrade. A previous anchored head alone is not enough to reconstruct the full current graph.

### 4. The eligible node universe includes delegated agents

The relay-signed kind-13534 roster defines eligible human members. A separate agent node is
eligible when a valid NIP-OA credential links its event key to an owner who is in that epoch’s
roster; the profile kind 10100 may provide display metadata but is not the authority. This corrects
the shorthand “roster = all nodes”: Buzz virtual agents need not appear in the active-member roster.

Agent and owner remain separate scored nodes. An invalid, expired, out-of-kind, self-owned, or
ambiguous OA tag cannot create agent provenance. Owner aggregation is not in v1.

### 5. Nostr state rules are exact, not approximately LWW

- NIP-01 replaceable/addressable selection is greatest `created_at`, then **lowest event id** for a
  timestamp tie, matching Buzz and NIP-01. Audit sequence must not reverse that result.
- Program lifecycle ordering for ordinary non-replaceable events uses committed audit/log order;
  an author-controlled timestamp is not a global clock.
- Kind-5 deletion supports both `e` and `a` targets, checks that the deletion author owns the
  target, honors the deletion timestamp bound for addressable versions, and never permits deletion
  of another author’s event.
- Every v1 event, including Option-C events, gets a valid NIP-01 id **and event signature**. The
  self-log head signature is an additional completeness credential, not a replacement for event
  signatures. Signature amortization is deferred until it has a separate, reviewed batch-signature
  statement and NIP-OA compatibility proof.

### 6. J1 is completed-job evidence, not requester acceptance

Buzz currently defines kinds 43001–43006 but does not freeze a job payload/reference contract. A
request signed by a requester plus a result signed by an agent proves that a requested job received
a claimed result; it does **not** prove that the requester accepted the work’s quality.

S0 freezes a Trustgraphs-compatible J1 profile with exact `h`, `p`, and marked `e` tag cardinality,
request/result linkage, content bounds, lifecycle resolution, and NIP-OA requirements. Until Buzz
has a requester-signed result acknowledgement, J1 is named “completed-job evidence,” receives the
lowest/capped starting weight, and is never described in UI or docs as an acceptance. A later
requester-signed acknowledgement can define J2 without changing historical J1 semantics.

### 7. One community anchor hides inner work from ordinary pricing

`AnchorRegistry.anchorCount` is one for a community head even when the bundle contains thousands
of audit entries and signatures. Therefore `nostr-workspace` is conservatively placed in the
vault’s top supported band, like `trust-compose`, rather than priced from `leafCount + anchorCount`.
The operator authenticates and enforces exact bundle work limits (entries, relevant events, bytes,
NIP-01 signatures, and OA signatures) before proving. Unknown/oversized work is refused before
wallet or prover-network spend.

The “no contract changes” statement means no semantic change to `AnchorRegistry`,
`MerkleSnapshot`, or journal v3. A new params codec, verifier deployment, InstanceRegistry row, and
explicit `ProvingVault` program/pricing branch are expected platform integration.

---

## Non-negotiable invariants

1. **One canonical Rust implementation.** Serialization, audit folding, signatures, OA parsing,
   replacement/deletion, edge semantics, params hashing, leaves, and journal encoding live in
   `packages/`; host code assembles bytes but does not define consensus.
2. **The guest re-folds the complete on-chain anchor log.** It asserts the checkpointed
   `anchorAcc/anchorCount`, rejects unsupported envelope/node/commitment combinations, and applies
   rule Φ inside the proven statement.
3. **No discretionary omission.** Every committed relevant event is accepted, deterministically
   skipped with a closed reason, or invalidates its whole head. Host filtering never decides graph
   truth.
4. **All relationship edges are content-backed.** G1 needs the referenced PR/patch root; J1 needs
   the linked request and result; F1 needs the referenced post/comment; V1 needs one canonical
   subject. Hint-only `p` tags never establish target authorship.
5. **Every cheap signal is bounded.** Self-edges are inert; F1 counts only literal `"+"` and a
   later `"-"` revokes that voter/target state; pair/type caps apply before type weights sum; J1 is
   capped and discounted until requester acknowledgement exists.
6. **Params and domains are versioned.** The relay key, community UUID, chain id, accepted
   commitment variants, weights/caps, staleness, seed-set root, and every consensus limit entering
   policy are covered by `paramsHash`. Output-domain reuse is forbidden.
7. **Bounds exist in consensus and operations.** Event bytes, content bytes, tag count, tag
   elements, tag-string bytes, audit-detail bytes, audit entries, events, and signatures have
   explicit checked maxima. Unbounded allocation is a test failure.
8. **Existing vkeys stay byte-identical.** `zk/nostr-program` is a detached workspace. Adding the
   program must not edit existing core semantics or dependency graphs; CI records existing vkeys
   before and after.
9. **Secrets and member-scoped content stay scoped.** Relay/database credentials never enter
   fixtures, manifests, journals, logs, score blobs, frontend responses, or public IPFS. A digest
   may be public while its preimage remains access-controlled.
10. **Trust claims remain precise.** Option A is relay/exporter-attested enumeration; Option C is
    self-committed enumeration with admitted-relayer anchoring availability. A bogus high count by
    an admitted relayer can deny later non-address anchors under the current registry; tests and
    runbooks record this governance/availability risk rather than calling Option C fully
    censorship-proof.

---

## Scope

### In v1

- Envelope kind 2 with Buzz audit-chain A and self-log C; A′ only if S0 activates it.
- V1 vouch kind 36382, G1 merged git status, J1 completed-job evidence, and F1 forum upvote.
- Kind-13534 roster verification and OA-derived agent eligibility.
- Separate member/agent scores plus the existing mutual Nostr↔EVM binding and dual-domain leaves.
- Lane-2-only production guest, journal v3, params codec, verifier/instance deployment, paid/curated
  operator support, authenticated score-program indexing, reduced-tier browser recomputation, and
  trust-compose source compatibility.
- Member-scoped pilot archive, with public archive supported as an instance deployment policy but
  not required for the pilot.

### Explicitly deferred

- Option B upstream event-set commitment and any Block/Buzz upstream dependency.
- NIP-85 publication, kind-number coordination, and ERC-8004 explorer integration. These are S5
  follow-ons and do not gate the proof pipeline.
- Workflow approvals, reactions, encrypted DMs/memory/cost metrics, NIP-GS contribution bridging,
  owner-aggregated agent identity, and a full browser-side envelope verifier.
- Recursive audit checkpoints, persistent proven graph state, per-head subproof aggregation, and
  public DA upgrades. The bounded full-prefix pilot produces the evidence used to design them.
- A generic public-relay crawler or any claim of global Nostr completeness.

---

## Target additions

```text
crates/envelopes/src/nostr/        event, audit, self-log, OA, replacement, TGNW verification
crates/nostr-workspace-core/       params, binding, semantics, compute, golden exporter
zk/nostr-program/                    detached conformance + production SP1 bins and lockfile
zk/prover/src/programs/nostr_workspace.rs
zk/prover/src/witness/nostr.rs       host-only exporter/archive support behind witness-nostr
contracts/src/params/NostrWorkspaceParamsCodec.sol
tests/fixtures/nostr/buzz/<sha>/      pinned real Buzz conformance export + adversarial derivatives
tests/golden/nostr-workspace.json     Rust/guest/Solidity/TypeScript production vectors
research/operations/nostr-workspace/          architecture, runbook, local testing, archive policy
```

Existing generic registries, snapshot/verifier bytecode, journal encoding, PageRank machinery, and
Merkle consumers are reused. Program dispatch, deployment, pricing, schema, API, and UI tables gain
reviewed `nostr-workspace` rows rather than inferring the program from names or blob shape.

---

## Execution map

| Stage  | Purpose                                                             | Depends on           | May merge independently when                                     |
| ------ | ------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| **S0** | Freeze the real Buzz/Nostr contract and limits                      | accepted research    | conformance ADR + fixture + measured caps are committed          |
| **S1** | Build envelope 2 and its conformance guest                          | S0                   | native/guest verification and adversarial suite agree            |
| **S2** | Build `nostr-workspace-core`, production guest, and parity          | S1                   | V1/G1/J1/F1 compute and four-way bytes are frozen                |
| **S3** | Build export, archive, anchor, and offline proving flows            | S0; integrates S1/S2 | a real Buzz bundle is reproducible offline and safe to anchor    |
| **S4** | Integrate contracts, operator, indexer, frontend, composition, docs | S2 + S3              | two-epoch anvil e2e passes through production surfaces           |
| **S5** | Pilot and harden                                                    | S4                   | authorized clean-room reproduction and operational sign-off pass |

S1 and the host-only portion of S3 may proceed in parallel after S0. Nothing consensus-facing may
merge with placeholder kinds, an unpinned job schema, a zero `dataCommitment`, or unmeasured bounds.

---

## S0 — Protocol freeze and real fixture

Stand up the selected Buzz commit locally with audit enabled and create a workspace containing two
humans, one OA-delegated agent, a relay-signed roster, and real events for every v1 rule and binding
path. Export source-derived bytes; do not hand-author a JSON fixture that can agree with our own
mistake.

Freeze in a short ADR under `tests/fixtures/nostr/buzz/<sha>/README.md`:

- the exact audit hash preimage, including community UUID bytes, big-endian sequence, RFC3339
  microsecond timestamp form, optional-field presence bytes, canonical recursive JSON, and genesis;
- all audit actions at the pin, the precise `EventCreated` detail shape, queue/write failure
  behavior, replacement retention, and which relevant rows require direct database export;
- NIP-01 serialization bytes against the pinned `rust-nostr`, including every ASCII control byte,
  Unicode, empty strings, tag strings, maximum integers, and adversarial escaping;
- roster signature/key source and exact tag grammar; relay NIP-11 `self` is a cross-check, not a
  dynamically trusted key;
- NIP-OA grammar and published vectors, with boundary cases for every clause;
- exact G1 root kinds/tags, F1 target/content behavior, and the Trustgraphs J1 profile;
- an exact address-binding carrier kind/schema and exact Option-C head-event kind/schema after a
  collision sweep; and
- Buzz ingest limits plus stricter circuit caps, expressed in both bytes and counts.

The fixture must contain valid and invalid variants for duplicate `auth` tags, OA window edges,
same-second replacement ties, `e` and `a` deletions, wrong-author deletion, missing referenced
objects, `+`→`-` vote state, self edges, an audit gap, a changed bundle byte, a duplicate A+C event,
and an agent whose OA owner is not in the roster.

Benchmark marginal and whole-fixture cycles/PGU for audit hashing, NIP-01 verification, OA
verification, and the combined envelope. Set hard v1 caps and a conservative operator work model
from measured PGU. Re-run the existing schnorr benchmark if any pinned crypto input changed.

**S0 exit:** the pinned local Buzz export round-trips through an independent host verifier;
serializer bytes match Buzz/rust-nostr for the entire corpus; J1, the Option-C head, and the binding
carrier have no unspecified kind/tag/content fields; the full-prefix pilot ceiling fits the agreed
proving and archive budgets. If any of those is false, implementation stops here and the research
plan is amended.

---

## S1 — Envelope 2 and conformance guest

Add `crates/envelopes/src/nostr/` with small auditable modules and no host-only dependencies.
Implement:

1. Strict TGNW v1 decoding with checked lengths and canonical re-encoding.
2. Community and `did:nostr` node-id derivation with fixed lowercase/UUID rules.
3. Full Buzz audit-prefix verification, sequence/previous-hash invariants, relevant-event coverage,
   exact anchored head/count checks, and bundle `dataCommitment` verification.
4. Option-C self-log fold and signed head-event verification, including instance/domain binding and
   exact owner/event-author equality.
5. NIP-01 canonical serialization, SHA-256 id, patched `k256::schnorr` verification, and strict
   key/signature parsing for every relevant event.
6. NIP-OA extraction, exact-preimage signature verification, closed condition parsing, and
   event-kind/time enforcement.
7. Relay-signed roster verification, OA-derived agent eligibility, protocol replacement, kind-5
   tombstones, deterministic event ordering, and the closed error/skip taxonomy.

Add native fixture tests plus a conformance bin in the detached `zk/nostr-program` workspace. The
guest commits `(nodeId, head, count, dataCommitment, acceptedEventsDigest, skippedDigest)` and fails
on any mismatch. Tests mutate every signed/hashed field independently and cover allocation/cap
boundaries. Fuzz/property tests assert canonical encode/decode idempotence, order independence where
promised, and no panic for any bounded witness.

**S1 exit:** the real Buzz fixture verifies byte-identically natively and in SP1; every adversarial
derivative has the expected hard-fail or skip result; a missing committed relevant event cannot
produce a root; the measured whole-envelope cost remains inside S0’s cap.

---

## S2 — Program semantics, production guest, and four-way parity

Add `crates/nostr-workspace-core` as the only source of graph truth. Freeze and test:

- V1: one addressable vouch state per `(author, subject)`, strict 0–100 weight grammar, weight zero
  and valid tombstone revocation.
- G1: merged status 1631 author → authenticated root-event author, accepted root-kind allowlist,
  mandatory two-sided presence, no hint-author fallback, no self edge.
- J1: requester → OA-valid agent only when the exact linked request/result lifecycle resolves to a
  completed result with no later cancel/error; low starting weight and per-pair/epoch cap; UI label
  “completed-job evidence.”
- F1: voter → authenticated post/comment author; literal `+` is the only positive state, `-`
  clears it, malformed/arbitrary content is inert, per-pair cap applies.
- Event-id deduplication across A/C followed by strongest-provenance selection, per-type LWW/state,
  type weights, caps, then deterministic summation into one pair edge.
- Current roster plus OA-authorized-agent eligibility, self-edge exclusion, seeds, fixed-point
  PageRank, point distribution, score blob, member/agent metadata, EIP-712 address binding, and
  dual-domain leaves.

Freeze the params ABI and its validation. At minimum it covers rank parameters, canonical
community UUID, relay pubkey, chain id, allowed commitment variants, four type weights, provenance
multiplier(s), F1/J1 caps, rule-Φ staleness, seed-set root, and any moderation flag that is truly in
v1. Starting weights require checked-in sensitivity/adversarial evidence and default to the
dark-launch/discount posture; they are not picked solely to make the demo look balanced.

Add the production SP1 bin in `zk/nostr-program`, the prover
`nostr-workspace {vkey|paramshash|execute|prove}` group, the golden exporter,
`NostrWorkspaceParamsCodec.sol`, Solidity golden tests, and the reduced-tier TypeScript recompute
port. The browser recomputes semantics/root/journal from authenticated envelope-verified rows; it
does not claim to re-verify BIP-340 or audit-chain bytes.

Golden/adversarial vectors include every rule alone and in conflict, mixed A+C duplicates,
replacement/deletion, OA failure, roster removal, binding/rebinding/unbinding, and a colliding
32-byte key from another program domain.

**S2 exit:** native Rust equals the production guest; Rust/guest/Solidity/TypeScript reproduce the
frozen params, journal, skip digest, leaves, root, and score blob; `task zk:parity
PROGRAM=nostr-workspace` is green; all previously shipped program vkeys equal their pre-S2 values.

---

## S3 — Exporter, archive, anchoring, and offline proof input

Add `zk/prover/src/witness/nostr.rs` behind `witness-nostr` plus a small operational command surface
that separates privileged collection from offline proving:

1. `inspect` verifies the selected Buzz SHA/schema, relay key, audit-enabled state, queue/worker
   health, database coverage, and configured caps without writing an anchor.
2. `export` captures a consistent audit prefix and all required event rows, builds canonical TGNW,
   runs the production envelope verifier, writes a content digest/CID and redacted manifest, and
   stores the bundle under `(community, count, head)`.
3. `anchor` reads only a previously verified immutable manifest, rehashes the bundle, checks the
   on-chain node/role/count/capacity state, simulates, and submits envelope kind 2. Re-running is
   idempotent and never invents a higher count.
4. `assemble` reconstructs the complete checkpoint anchor log and selected A/C bundles into the
   production `GuestInput`; `execute` and `prove` are network- and credential-free from there.

Option C gets a deterministic log/head builder and recovery/export story. The guest, exporter, and
anchor command agree on the exact signed head preimage. A/C duplicate events are visible in the
manifest and resolved only by core consensus code.

Archive configuration distinguishes `public`, `member-scoped`, and `private-operator` access. The
pilot uses member-scoped storage. Public manifests contain hashes, counts, program/schema versions,
and provenance, never credentials or plaintext from a scoped bundle. Republish/repair verifies the
same digest before replacing storage and cannot change an already anchored preimage.

**S3 exit:** a fresh checkout with the pinned fixture can export, anchor to anvil, assemble offline,
execute, and prove; a second authorized process reproduces identical TGNW and `GuestInput` bytes;
audit gaps, stale relay keys, partial snapshots, altered archives, oversized inputs, stale counts,
and missing credentials all fail before anchor or proving spend.

---

## S4 — Platform and product integration

Wire the built program through every authenticated platform seam:

- register node-kind policy 2 (`did:nostr`) and 3 (`buzz:community`) in deployment/runbook code;
- deploy `EmptyLaneAccumulator`, `AnchorRegistry`, `MerkleSnapshot`, a labeled
  `SP1JournalVerifier`, and the reciprocal binding in the established lane-2 order;
- register the exact `(program, snapshot, verifier, registry, paramsHash)` in `InstanceRegistry`;
- add conservative top-band `ProvingVault` pricing and operator exact-work preflight;
- add `Program::NostrWorkspace` to operator-core, catalog/params reads, scheduler, durable
  witness/proof/publication recovery, and the detached prover ELF map;
- add the score-program/output-domain row, schemas/migrations, anchor/score/binding/agent
  provenance, paginated APIs, and fail-closed program dispatch in the indexer;
- add a typed frontend instance view for members, agents, owner provenance, scores/proofs, epoch
  trust class, skip summary, archive access policy, and reduced-recompute status without exposing
  scoped event content;
- prove that a registered `nostr-workspace` output can be captured as a `trust-compose` source
  without domain confusion; and
- add architecture, runbook, local-testing, verification, program-index, production, and recovery
  documentation with the trust/availability limitations stated beside the happy path.

Extend the main e2e with two checkpoints. Epoch one contains all four signals and one bound member.
Epoch two changes a vouch, applies a valid deletion, changes membership, flips a forum vote, adds or
resolves a job lifecycle, withholds one C bundle within rule Φ, and lands a different reproducible
root. Include a twin-instance replay rejection and an unknown-program/domain rejection.

**S4 exit:** the two-epoch path runs anchor → checkpoint → offline input → SP1 execution/proof →
publish → `submitProof` → authenticated index/API/frontend → trust-compose capture. Restart tests
cover export, proving, publication, submission, and indexing boundaries. No existing program’s
tests, vkey, APIs, or tables regress.

---

## S5 — Pilot and hardening

Run the member-scoped pilot against a non-synthetic Buzz workspace pinned to the supported source
profile. Before the first anchor, record the relay key, community id, roles, caps, params, archive
policy, deploy transaction set, vkey, program/output domains, and a rollback/disable procedure.

The pilot must:

- land at least two consecutive epochs, including one real Groth16 proof if the configured SP1
  environment supports it;
- stay below the measured audit/event/signature/byte ceilings with at least 2× operational margin;
- reproduce one landed epoch byte-for-byte from a clean checkout operated by a second authorized
  archive holder;
- demonstrate alerting and recovery for audit lag/gap, archive loss, relay-key mismatch, invalid
  self-log, oversized work, proof failure, reverted submission, and indexer replay;
- publish the full `skippedDigest` preimage and redacted provenance for each epoch; and
- receive a focused security review of canonical encodings, signature/delegation validation,
  completeness/omission paths, bounds, secret handling, and cross-program/domain isolation.

**S5 exit:** pilot evidence and accepted risks are checked in or linked from the runbook; an
authorized third party can reproduce the root without the original prover; the operator can recover
from every tested failure without changing consensus inputs; docs make no public-availability,
requester-acceptance, relay-honesty, or “fully trustless Option C” claim that the implementation does
not establish.

---

## Optional S5 follow-ons — never release blockers

- Publish proven score projections as NIP-85 kind-30382 assertions under a distinct
  per-(instance, program-version) service key after freezing the score→0–100 normalization and
  proof-provenance tags.
- Coordinate experimental kind 36382 and the binding/head kinds with Block and the wider Nostr
  registry. Coordination may cause a versioned future migration; it does not rewrite v1 history.
- Offer Option B upstream only after the pilot demonstrates value.
- Point the ERC-8004 explorer at proof-backed agent nodes without merging ERC-8004 identity into
  Nostr identity.

---

## Verification matrix

Every milestone runs the focused suites it introduces and the materially affected existing suites.
Before S4/S5 exit, CI and release evidence include:

```text
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo test --manifest-path zk/nostr-program/Cargo.toml
task zk:parity PROGRAM=nostr-workspace
forge test
pnpm --dir packages/indexer test
pnpm --dir packages/frontend test
pnpm --dir packages/frontend lint
pnpm --dir packages/frontend build
task e2e
```

The detached prover/operator builds and the real SP1 execute/prove path run separately with their
documented features. Generated ABIs, Ponder/Drizzle code, deployment artifacts, vkey tables, golden
vectors, and fixture provenance are committed in the same change that alters them.

Every bug or counterexample becomes a minimal committed regression. Security-sensitive expected
failures may not be waived by snapshotting a new output.

---

## Done when

This goal is complete only when all of the following are true:

1. S0–S5 have met their exit criteria; optional follow-ons remain optional.
2. A complete anchored Buzz audit prefix and mixed A/C witness can be independently re-folded,
   verified, scored, and matched to a landed journal/root by an authorized archive holder.
3. V1/G1/J1/F1, roster/OA eligibility, A+C deduplication, replacement/deletion, rule Φ, address
   binding, and dual-domain leaves have adversarial regressions in native and guest code.
4. Four-way consensus parity and the full affected test/build matrix are green, and every prior
   production vkey is unchanged.
5. Operator pricing and limits account for inner witness work rather than the single outer anchor;
   no oversized or unauthenticated bundle reaches proving spend.
6. The program is discoverable only through authenticated InstanceRegistry and score-program
   bindings, is consumable by trust-compose, and fails closed across wrong program/output domains.
7. The runbook lets a new authorized operator deploy, export, anchor, prove, publish, reproduce,
   rotate params, diagnose skips, and recover archives without oral knowledge or secret leakage.
8. The documented trust statement matches reality: prover correctness is cryptographic;
   workspace enumeration is relay/exporter-attested for A; C is self-committed but relayer-gated for
   on-chain availability; member-scoped data is not publicly reproducible.
