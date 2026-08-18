# Buzz × Nostr — Proving Workspace Trust In-Circuit

**Status:** 🔬 Research spike 2026-08-16; hardening pass + **§12 decision record (Jake) 2026-08-18** — design accepted, build not started. Option A confirmed viable from buzz source the same day (§4).
**Question:** Can trustgraphs prove trust graphs over data living in [buzz](https://github.com/block/buzz) (Block's Nostr-based human+agent workspace), and what is the right circuit + lane design?
**Relationship to [`OFFCHAIN_ATTESTATIONS_ZK.md`](./OFFCHAIN_ATTESTATIONS_ZK.md):** that document classed Nostr "not a substrate — prior art only" for exactly one reason: no per-identity completeness commitment. This spike answers the completeness question buzz-specifically and specifies **envelope kind 2** behind the same trait as envelopes 0 (EAS-offchain) and 1 (atproto). Nothing else in the two-lane architecture changes.
**Relationship to [`HYPERCERTS_ATPROTO_PLAN.md`](./HYPERCERTS_ATPROTO_PLAN.md):** the buzz program is to Nostr what the hypercerts program is to atproto — a typed-record graph program over an anchored offchain substrate. The build recipe, two-sided edge rules, skip-code discipline, and dual-domain leaf pattern carry over nearly verbatim.

---

## 1. Executive summary

> **Buzz workspaces already produce, every day, exactly the thing trustgraphs proves: signed statements of who trusted whose work.** Every message, PR merge, workflow approval, and completed agent job in buzz is a BIP-340-signed Nostr event authored by a per-member key — humans and AI agents alike. The trust graph is latent in the workspace; this program makes it provable, portable, and composable.

Concretely: a community running buzz deploys a **nostr-workspace program instance** of trustgraphs. Each epoch, an anchored commitment pins the workspace's event set; the SP1 guest verifies every event's schnorr signature, applies deterministic edge rules (vouches, merges, agent-job acceptances, forum votes), and proves the resulting scores. The output is the standard journal-v3 root every trustgraphs consumer already understands — governance weights, reward splits, and (via **trust-compose**) a source that any other graph can blend in with a governed weight.

Why this is worth doing now:

- **Agents are first-class citizens of buzz — and ideal citizens of lane 2.** Buzz agents hold their own keypairs and sign their own work. Buzz's **NIP-OA delegation** (an owner's BIP-340 signature authorizing an agent key, scoped by kind and time window) is verifiable in-circuit with two schnorr checks: the strongest agent↔owner binding any substrate we've evaluated offers. This is the missing provenance layer for the ERC-8004 agent-reputation thread (#58–#62): agent reputation fed by *proven work events*, not by self-reported feedback.
- **Nostr events are the most circuit-friendly attestation format we have evaluated.** An event id *is* the SHA-256 of a canonical serialization (NIP-01), and the signature is BIP-340 schnorr over secp256k1 — the curve our patched guest stack already runs. The guest never parses attacker JSON: it re-serializes from a structured witness and hashes. No CBOR, no MST, no DID directory. **Measured on our stack (2026-08-16): a complete event verification — serialize, id, BIP-340 — is 48,858 cycles / 75,696 PGU** ([`offchain/05-spike-results.md`](./offchain/05-spike-results.md) §4). And the ground is unoccupied: no public project proving Nostr events inside a zkVM was found — the offchain research's "nobody ZK-proves graph compute over offchain attestations" claim extends cleanly to Nostr.
- **The completeness gap has buzz-shaped answers.** Generic Nostr has no completeness commitment (relays can hide events — the reason the 2026-07 research parked it). Buzz is not generic Nostr: it is a single-relay, closed-membership workspace that already maintains a **per-community SHA-256 audit hash chain** and signs membership rosters with a relay key. §4 ranks three commitment sources, from zero-upstream-change to fully trustless.
- **It lands in the platform as one more program.** Isolated guest workspace, envelope module, params codec, golden vectors, instance deploys — the [add-a-program](../docs/build/add-a-program.md) path, seventeen known steps. The composition program (#63–#66) then makes every buzz workspace graph a composable source. And the scores have a standard road home: **NIP-85** (merged 2026-01) lets each instance publish its proven ranks back into Nostr as kind-30382 assertions — the first provider in the ecosystem whose assertions carry a proof (§6).

What this is *not*: a general Nostr indexer, a public-relay crawler, or a bridge for encrypted buzz content. §9 states the limits plainly.

---

## 2. What buzz is (recon summary, 2026-08-16)

Block's open-source, self-hostable team workspace ("a hive mind communication platform"), launched publicly 2026-07-21, Apache-2.0, Rust, ~27.6k stars, very active. Humans and AI agents (Claude Code, Codex, goose — harness-agnostic) share channels, threads, DMs, voice, canvases, git repos, and YAML workflows. Per the README: *"every message, reaction, workflow step, review approval, and git event is a signed event in one log. Same shape, same identity model, same audit trail, whether the author is a person or a process."*

Architecture facts that matter here (sources: `ARCHITECTURE.md`, `NOSTR.md`, `crates/buzz-core/src/kind.rs`):

- **`buzz-relay` is a real Nostr relay** (NIP-01 wire, NIP-42 auth, NIP-29 groups) and the single source of truth: no federation, no gossip, no public relays. Events live in Postgres; the `kind` integer is the only dispatch switch.
- **Members hold their own keys** — the relay never holds user keys. This is the decisive difference from atproto, where the PDS signs commits and typical users hold nothing: **a buzz event is user-key-signed, always.** Agents likewise: each agent has its own keypair, linked to an owner via kind 10100 profiles and NIP-OA delegations.
- **Three signer classes**, all BIP-340 over secp256k1:
  1. **user-signed** plaintext events — chat (9, 40002), forum (45001–45003), reactions (7), profiles (0), workflow definitions (30620), the whole NIP-34 git suite (patches 1617, PRs 1618/1619, issues 1621, status 1630–1633, repo announcements 30617/30618, projects 30621);
  2. **agent-signed** events, optionally carrying an in-event **NIP-OA `auth` tag** (verbatim-verified 2026-08-18): exactly four elements `["auth", owner_pk_hex, conditions, sig_hex]`, at most one per event (two or more ⇒ treat as having none), owner ≠ `event.pubkey` required; `sig` = the owner's BIP-340 signature over `SHA256("nostr:agent-auth:" ‖ event.pubkey_hex ‖ ":" ‖ conditions)`; `conditions` = `&`-joined clauses from a closed set — `kind=<dec 0–65535>`, `created_at<ts`, `created_at>ts` (ts 0–2³²−1) — canonical base-10, no whitespace, clause order signed as-is (verifiers MUST use the exact string, no normalization; empty string = unconstrained). The tag is a reusable capability: the same credential may cover many events, each checked against the conditions;
  3. **relay-signed** state — membership roster snapshots (13534) and deltas (8000/8001), group metadata (39000–39002), member-change notifications (44100/44101; client submission of these kinds is rejected).
- **A per-community audit hash chain** (`buzz-audit`; source-verified 2026-08-18): `SHA-256(community_id ‖ seq_be64 ‖ created_at ‖ action ‖ actor_pubkey ‖ object_id ‖ detail_canonical_json ‖ prev_hash)`, genesis `0x00…00`, `seq` monotonic from 1 per community, writes serialized by a per-community Postgres advisory lock, the community UUID folded into every hash ("a row lifted out of one community's chain can never verify inside another's — chain identity carries the tenant"). Eleven actions including **`EventCreated` for every stored event**, with `object_id` = the event id hex and `detail` = `{event_kind, channel_id}`. Formally modeled as `auditHeads[c]` in buzz's `MultiTenantRelay.tla`. Kind 48001 is a reserved constant with no event producer found — chain reads go through `AuditService::get_entries`/`verify_chain`.
- **Encrypted lanes exist and are out of scope for v1:** NIP-44 v2 covers DMs (gift-wrap 1059), agent memory (30174), per-turn agent cost metrics (44200), owner-self agent aggregates (30179). Everything else is plaintext-signed.
- **Availability is permissioned by design:** fail-closed allowlist + NIP-42 auth on reads; REQ history capped at 500 events/filter. A third party gets event bytes only through a member/API-token exporter. Verification is trustless once you hold bytes; *obtaining* bytes is the community's choice — which matches trustgraphs' instance model: the community deploying the instance is the same community operating the relay.

Signals per kind worth bridging: NIP-34 merge/status events, agent job lifecycle (43001–43006), forum votes (45002), and an explicit vouch kind we mint (36382) — plus, deferred at v1 (§12.3), workflow approvals (46030/46031) and reactions (7). Membership rosters (13534) define the node universe per instance.

---

## 3. What can be proven, in layers

| Layer | Statement provable in-guest | Machinery | Trust class |
|---|---|---|---|
| **L0 — event authenticity** | "pubkey P signed event E (kind, tags, content, created_at); id(E) is correct" | re-serialize NIP-01 array → sha256 → BIP-340 verify | trustless (user key) |
| **L1 — agent delegation** | "agent key A operated under owner O's delegation D, and E's kind/time fall inside D's conditions" | one extra sha256 preimage + BIP-340 verify of the NIP-OA tag; deterministic conditions parser | trustless (owner key) |
| **L2 — workspace state** | "the relay asserted roster R / group state G at seq s" | BIP-340 verify against the instance's pinned relay pubkey (a param) | relay-attested |
| **L3 — set completeness** | "these are *all* the eligible events of the workspace (or of identity X) up to head h, count n" | anchored head + in-guest chain re-fold (§4) | ranges relay-attested → trustless (§4 options) |
| **L4 — graph semantics** | "scores = compute(edge rules over L0–L3-verified events, params)" | the buzz program's deterministic edge rules + shared PageRank machinery | trustless given L0–L3 |

Two structures deserve special mention:

- **NIP-GS git signatures**: buzz signs git commits/tags with Nostr keys in the `gpg.x509.program` slot (JSON envelope `{v, pk, sig, t}` over the git object). "This npub authored this commit" is provable with **no relay data at all** — a future bridge from buzz identities into the contributions program's git-shaped world.
- **The audit chain**: beyond completeness, it is an ordering oracle — per-community `seq` gives the deterministic tiebreak that lane-2 reconciliation needs (the role `(timestamp, fold index)` plays in lane 1, and `(anchor fold index, createdAt, rkey)` plays in hypercerts). Kind 48001 is reserved for surfacing it but unproduced today; the chain is a table/API read.

---

## 4. Completeness: three commitment sources, ranked

The construction is the standard lane-2 decomposition — **global completeness = AnchorRegistry (on-chain, enumerable) × per-head completeness commitment (offchain, signed)** — with buzz supplying the per-head commitment in one of three ways:

### Option A — anchor the buzz audit-chain head (zero upstream changes)

The community's admitted relayer anchors `(nodeId = communityNodeId, envelopeKind = 2, head = audit chain head, count = seq, dataCommitment)` each epoch. The guest re-folds the witnessed audit entries to the head (the field order is documented and stable), maps entries to event ids, and requires every consumed event to appear in the chain. Omission by the prover then breaks the fold; omission by the *relay* remains possible (it writes the chain).

- Trust class: **relay-attested enumeration × user-signed events**. Strictly stronger than atproto's "PDS-attested everything" (content authenticity here is user-grade; only *enumeration* rides the relay).
- **Verified from source (2026-08-18) — Option A is viable.** `AuditAction::EventCreated` fires for every stored event (`handlers/event.rs::enqueue_event_created_audit`, called on `dispatch_persistent_event`'s *awaited* path — the handler returns only after the bounded-channel enqueue completes; capacity 1000, `.send().await`, "entries are never silently dropped — backpressure propagates" to ingestion). `object_id` carries the event id hex; `detail` carries `{event_kind, channel_id}`; both are hashed. The anchored `count` is the chain `seq`.
- **Two caveats, both fail-safe.** (1) `state.audit_tx` is an `Option` — a deployment can run auditless; the pilot must confirm audit is enabled. (2) Worker DB-write failures are logged, not retried, so rare chain gaps are possible; the guest rule "an event is consumable only if its id appears in the anchored chain segment" turns a gap into a deterministic exclusion (plus a `skippedDigest` entry) — never a soundness hole. Enqueue-before-OK plus epoch-granular anchoring makes write ordering a non-issue.

### Option B — a relay-signed event-set head (small upstream patch, Block-shaped)

Add to `buzz-relay` a periodic relay-signed addressable event (one per community): `content = {head, count}` where `head` folds the community's stored event ids in `(created_at, id)` order. This is envelope-0's chained-log discipline, published *by the relay about its own store*. Buzz's culture fits the ask — the repo carries TLA+/Tamarin specs and 16 in-house NIP drafts; an "event-set commitment" NIP is a natural upstream contribution, and it benefits every buzz auditor, not just us.

- Trust class: same as A (relay-attested enumeration), but the commitment is *purpose-built*: exact event-id coverage, no audit-entry↔event mapping ambiguity.

### Option C — per-identity self-committed heads (fully trustless, agents first)

Each member (or just each *agent*) maintains its own chained log over its own trust-relevant events — `h_i = sha256(domain_tag ‖ h_{i-1} ‖ event_id_i)` — and periodically publishes a replaceable **head event** (tags: `d` = instance domain, `head`, `count`), signed by the same key as everything else. The head anchors per-identity, exactly like an atproto repo head. Enumeration becomes attester-committed: the relay can no longer hide *your* edges; only you can (and the strictly-increasing anchored `count` catches rollbacks — the H-5 discipline).

- The UX burden that makes this awkward for humans **vanishes for agents**: head maintenance is a trivial agent behavior (a buzz workflow, even). Agents can be Option-C citizens from day one while humans ride Option A/B.
- Cost bonus: for a self-committed log, the head signature *transitively authorizes* every event in it (the same key signs both), so the guest can verify **one schnorr per attester** plus sha256 per event — the atproto amortization — instead of per-event signatures. For community-level commitments (A/B) the authors are many, so per-event schnorr is required.

**Decided (§12.1): A for the workspace lane + C for agents and the vouch lane at v1, with no upstream dependency.** B stays the clean upgrade once trustgraphs has proven its usefulness to Block — do not assume the PR lands. The source read (above) confirms A; **A′, a sidecar committer**, remains the fallback only for deployments running auditless — the instance's own exporter signs the event-set head under a pinned committer key; the same operator trust class as A (the community runs relay, exporter, and instance alike), still zero upstream changes, and B remains the upstreamed form of the same commitment. All variants are the same envelope with a different `commitmentKind` in the witness; the journal and contracts are identical. Rule Φ (carry-forward ≤k epochs, `skippedDigest`) applies unchanged when a head's data is withheld.

### On-chain fit (all options)

Already built, no contract changes:

- `AnchorRegistry.anchor(nodeId, envelopeKind=2, head, count, dataCommitment, headSignature)` — non-address node kinds skip the on-chain EIP-191 head signature; head authentication lives in envelope semantics (`AnchorRegistry.sol:182-184`), which is exactly where a BIP-340-signed head belongs. Strictly-increasing `count` per node is enforced at ingress.
- Node registration: `registerNode(nodeId, kind)` under `REGISTRAR_ROLE` — **node kind 2 = NOSTR pubkey, kind 3 = BUZZ_COMMUNITY** (kind 0 = address, 1 = DID; higher values open by design; the community node is the Option-A/B anchor subject and never scores). Registrar policy for a workspace instance is natural: *admit the npubs in the relay-signed roster (13534)* — membership is the eligibility credential. One nuance: 13534 sits in the replaceable range (10000–19999), so the relay serves only the *latest* roster — the witness archives the epoch-boundary snapshot it verified; roster history lives in our archive, not on the relay.
- Ingress capacity: the immutable `maxTotalInputs ≤ 200,000` combined-lane ceiling and admitted-relayer regime from [`ANCHOR_INGRESS.md`](./ANCHOR_INGRESS.md) apply as-is. One community head per epoch (Option A/B) is maximally frugal with anchor capacity; per-identity heads (Option C) spend one anchor per active member per epoch — the D2 open-set pricing question returns only if instances open registration beyond rosters.

---

## 5. Envelope 2 — the Nostr envelope, specified

Module: `packages/envelopes/src/nostr/` behind the same loose trait as its siblings ("given a head and witness bytes, either produce the complete, authenticated event set behind this head, or fail"). Mirroring the atproto module's six-step `verify()`:

```
verify(node_id, head, anchored_count, now, params, witness) -> Result<Vec<NostrEvent>, EnvelopeError>
  1. identity: nostr_node_id(&witness.pubkey_or_community) == node_id
  2. head recompute: fold the witnessed commitment (audit entries | event-id chain |
     self-log) and assert == anchored head; assert count == anchored_count   (CountMismatch)
  3. per event: canonical NIP-01 re-serialization from structured fields
     → sha256 → assert == witnessed id → id ∈ committed set
  4. signatures: BIP-340 verify per event (options A/B), or head-event only +
     pubkey == log owner (option C); relay-signed kinds verify against
     params.relay_pubkey; NIP-OA tags verify owner sig + conditions window
  5. per-(author, kind, subject) last-write-wins by (created_at, chain seq);
     replaceable/addressable kinds honor (pubkey, kind, d) replacement;
     kind-5 deletion requests tombstone the referenced ids
  6. emit events in deterministic (chain seq) order; every rejected event or
     withheld head lands in a closed skip-reason enum → skippedDigest
```

Design rules carried from the siblings, and the Nostr-specific deltas:

- **The guest never parses JSON it did not write.** The witness supplies structured events (`pubkey: [u8;32]`, `created_at: u64`, `kind: u32`, `tags: Vec<Vec<String>>`, `content: String`, `sig: [u8;64]`); the guest re-serializes the NIP-01 array `[0, pubkey_hex, created_at, kind, tags, content]` and hashes it. **Escaping follows the de-facto canonical form, not the spec prose:** NIP-01 says "all other characters must be included verbatim," but both reference implementations — `serde_json` (rust-nostr, hence buzz) and `JSON.stringify` (nostr-tools) — additionally emit `\u00XX` for ASCII control characters outside the seven named escapes, and escape tag strings identically to content. The guest serializer implements the serde_json semantics (byte-parity-gated against rust-nostr 0.44 on real buzz exports, adversarial control-byte cases included) and deterministically skips any event it cannot reproduce. Because the id binds every field, a witness cannot smuggle divergent content — the same trick as atproto's canonical-DRISL re-encode, minus CBOR entirely.
- **BIP-340 rides the existing patched `k256` fork — confirmed and measured.** The `patch-k256-13.4-sp1-*` diff patches the `schnorr` module explicitly (verify = tagged sha256 challenge + `lincomb` over the secp256k1 precompiles; x-only key load rides hint-accelerated field `sqrt`), and Succinct's own patch-testing suite proves a schnorr guest in CI. Measured here: **31,747 cycles / 56,521 PGU per verify**, 35× the unpatched path (05-spike-results §4). Landmine: the sp1-patches C `secp256k1` fork does *not* accelerate schnorr, so rust-nostr's own `Event::verify` (~1.1M cycles in-guest) is host-side-only; the guest uses patched `sha2` + `k256::schnorr` directly.
- **Timestamps are claims, not facts.** `created_at` is author-controlled; the envelope orders by it only *within* the committed chain, where the chain `seq` (Option A/B) or log index (Option C) is the authoritative tiebreak. The journal's observation time is the anchor's block timestamp, as everywhere in lane 2.
- **Revocation** = supersession: a newer event per LWW key (weight update, `weight=0`, status change 1630–1633), or a kind-5 deletion of a specific id, all *inside* the committed set. There is no out-of-band deletion oracle to consult — deliberate; the chain is the record.
- **Skip codes** extend the closed enum in the program crate (the hypercerts precedent: reasons 10–14): malformed event, unknown kind, sig-invalid, OA-window violation, LWW-superseded, deletion-tombstoned, roster-nonmember, oversize.

`nostr_node_id`: `keccak256(utf8("did:nostr:" ‖ lowercase_hex_pubkey))` — rides the existing DID-string convention (`keccak(did_bytes)`, as `did_node_id` does for `did:plc:…`), aligns with the W3C-registered **`did:nostr`** method draft (64-character lowercase hex x-only pubkey, never npub, no `0x` — we adopt the string convention only, not the draft's resolution machinery), and stays prefix-disjoint from every other preimage shape in the tree; the community node (Option A/B anchor subject) is `keccak256(utf8("buzz:community:" ‖ community_id))`. The in-tree footgun stands: node-id namespacing is by preimage shape, not domain tags — these two shapes collide with nothing existing, and the doc that adds a third should keep checking.

---

## 6. The buzz program — semantics sketch

The program: **`nostr-workspace`** (decided §12.7 — the design is not buzz-unique as the Nostr ecosystem develops, and the generic name sidesteps the Block-trademark question; core crate `packages/nostr-workspace-core`), shaped like hypercerts: lane-2-only (`EmptyLaneAccumulator` on lane 1), typed event→edge rules, params codec, journal v3, per-workspace instances.

### Edge rules (v1 shortlist — exact kinds from `crates/buzz-core/src/kind.rs`)

| Rule | Signal | Kinds | Edge | Gating |
|---|---|---|---|---|
| **V1 vouch** | explicit trust statement | minted kind **36382** (addressable; `d` = subject pubkey hex; NIP-85-adjacent mnemonic, verified unclaimed — §12 Q5; NIP-32 and NIP-58 ruled out by their own specs) | author → subject, weight from a 0–100 tag | user-signed; LWW per (author, subject); weight 0 revokes |
| **G1 merge** | PR/patch merged | 1631 (status-merged; verified builder: required `["e", <root>, "", "root"]` naming the statused PR/patch root, `q` applied-patch refs, `merge-commit`/`applied-as-commits` tags, merged-status-only) | merger → root author | **two-sided**: the 1631 AND its referenced root event both in the committed set; author = the root event's own `pubkey` (never `p` hint tags); merger ≠ author |
| **J1 agent job** | requested work delivered | 43001 request + 43004 result (constants verified — 43001–43006 = request/accepted/progress/result/cancel/error; **tag schema is client-defined today**: no relay-side validation, no Rust builder — S0 pins it from the web client) | requester → agent | **two-sided**: both parties' events present (the hypercerts ack-gating rule); defensively decoded, malformed ⇒ deterministic skip; OA-valid if agent-signed |
| **F1 forum vote** | content endorsement | 45002 | voter → post author | per-pair cap; low weight |
| W1 approval *(deferred — §12.3)* | workflow approval granted | 46030 grant command; 46011 lifecycle corroboration | approver → step actor | not load-bearing enough to carry v1 complexity |
| R1 reaction *(deferred — §12.3)* | lightweight appreciation | 7 | reactor → author | NIP-25 polarity ("+", "-", arbitrary emoji) is not a deterministic sentiment map — negative reactions must not mint positive edges; may return as literal-"+"-only |

Anti-gaming carried from hypercerts: self-edge exclusion, per-type LWW then types **sum** into the pair edge, per-pair caps for the cheap kinds (R1/F1), deterministic skips for malformed shapes. Weights are params (operational-timelock governed), including an **authorization-class multiplier** mirroring `pdsAttestedWeightFp`: edges whose enumeration is only relay-attested (Options A/B) can be discounted relative to self-committed ones (Option C) — a policy knob, not an architecture fork. Two scoping rules worth stating: an event counts only through presence in *this instance's* committed set (the same signed event cross-posted to two workspaces legitimately counts once in each — weights and caps are per-instance); and a params flag can zero out edges authored by members banned or timed out (9040–9043, relay-attested moderation state) as of the epoch boundary — proposed default off, since moderation already shapes the roster going forward.

### Identity and node classes

- **Member nodes**: `did:nostr` nodeIds (satellite by default). Score is theirs, visible and provable; on-chain claiming waits for a binding.
- **Agent nodes**: member nodes with a proven **NIP-OA owner link** — kept as *separate nodes* with the owner binding recorded (edge credit stays attributable to the agent; decided §12.4 — strictly separate at v1, owner aggregation remains a possible later params mode, never an identity change). This is the substrate the ERC-8004 reputation explorer can point at: agent scores backed by proven work events. (The Nostr ecosystem is converging here from the other side — two open NIPs PRs compete for an "Agent Reputation Attestations" kind, 30085; those are self-declared or provider-declared, and proof-backed assertions are the differentiator.)
- **Bound nodes**: npub ↔ ETH address, reusing the hypercerts `IdentityLink` EIP-712 verbatim (`LinkAttestation(string did, address evmAddress, …)` — the `did` field carries `did:nostr:<hex>`), transported as a buzz event authored by the npub (mutual consent: wallet signs the typed claim; the npub signs the event carrying it). Bound nodes get the **dual-domain leaves** (nodeId leaf + v1 address leaf), so `MerkleGovModule`/`MerkleFundDistributor` work unchanged.
- **Node universe** per instance = the relay-signed roster (13534) at the epoch boundary; registrar admits roster npubs (satellite registration gate: solved by membership).

### Linking an npub to an EVM address (the binding flow, concretely)

Reuse the hypercerts binding machinery verbatim (`packages/hypercerts-core/src/binding.rs`; digest derivation pinned three-way in [`offchain/05-spike-results.md`](./offchain/05-spike-results.md) §2.4):

1. **Wallet direction (EVM key consents).** The wallet signs the existing EIP-712 typed data — domain `{name: "IdentityLink", version: "1", chainId}` (deliberately no `verifyingContract`, no salt), struct `LinkAttestation(string did, address evmAddress, uint256 chainId, uint256 timestamp, uint256 nonce)` — with `did = "did:nostr:<64-hex pubkey>"`. The `did` field is a string; the struct, domain, and decimal-string parsing rules carry over unchanged.
2. **Nostr direction (npub consents).** The npub publishes a dedicated **addressable** binding event (a 3xxxx kind, number collision-checked against buzz's registry; `d` = the lowercase hex address, giving one live binding per address with native `(pubkey, kind, d)` LWW replacement). Content carries `{address, chainId, timestamp, nonce, signature}`. Buzz's own kind 24243 "identity binding" is *ephemeral* (2xxxx — never stored) and unsuitable as the persistent carrier.
3. **In-guest verification** (~59k cycles total, noise): the envelope has already schnorr-verified the carrier event (31.7k), which *is* the npub-side consent — the same key that authors edges signed the claim's transport. Then: recompute the EIP-712 digest → ecrecover (27.3k) → recovered address must equal both `message.evmAddress` and the event's claimed address; `message.did` must equal the did:nostr string of the carrier event's **author** pubkey; `chainId` must match the instance's chain. These are exactly the binding.rs checks with "record lives in the DID's repo" replaced by "event signed by the npub."
4. **Effect.** The node keeps its did:nostr nodeId; the address attaches as metadata and the node emits **dual-domain leaves** (nodeId leaf + v1 address leaf), so `MerkleGovModule` voting and `MerkleFundDistributor` claiming work unchanged, and the satellite→bound onboarding funnel holds: score accrued before the wallet existed is already the member's. Rebinding = replace the addressable event; unbinding = tombstone it.

Two notes. The consent story is *stronger* than atproto's: there, DID-side consent is "the record sits in a PDS-signed repo" (PDS-custodied keys); here the npub's own key signs the carrier directly. And agents normally should not bind — the owner binds their npub↔wallet and the agent stays linked via NIP-OA / kind 10100, so value flows to the owner's address; an agent-owned account via the ERC-8004 identity registry (its registration metadata naming the agent npub, counter-signed by an agent event) remains a later option.

### Params (sketch) and journal

Params: `community_id`, `relay_pubkey` (pins L2 statements; canonically the relay's NIP-11 **`self`** key — the key NIP-29 requires for 39000-series events — *not* NIP-11 `pubkey`, which is the admin contact; the pinned param is the root of trust and NIP-11 serves only as a TOFU cross-check, mismatch = hard failure), `commitment_kind` (A/B/C), kind-weight table, per-pair caps, `relayAttestedWeightFp`, `k` (rule-Φ staleness), epoch schedule, seed set (npub nodeIds, sorted, single-hash leaves per the hypercerts seed convention). Hash via a `NostrWorkspaceParamsCodec.sol` twin, 4-way golden-locked.

Journal: the 12-field v3 shape verbatim (`acc=0/leafCount=0` lane 1, `anchorAcc/anchorCount` lane 2, `paramsHash`, `outputRoot`, `ipfsHash`, `cidDigest`, `totalValue`, `skippedDigest`, `recipient`, `instanceDomain`). Zero contract changes; one new labeled `SP1JournalVerifier` per the deploy convention.

Score-program registry: `programId = keccak256("nostr-workspace")`, output domain `keccak256("trustgraphs.output.nostr-member.v1")` — new versioned domain, never shared with hypercerts DIDs or ERC-8004 agent keys (32-byte keys, different subjects — the add-a-program rule).

### Scores flow back: a proven NIP-85 provider

Nostr already standardized the *output* side of this design. **NIP-85 "Trusted Assertions"** (merged 2026-01) defines addressable kind-30382 events — `d` = subject pubkey, a `rank` tag normalized 0–100 — published by web-of-trust "service providers" under dedicated per-algorithm service keys and discovered through each user's kind-10040 provider list. Existing providers (nostr.band; Vertex serves the same need via DVMs and publicly critiques 30382's pull model) are trust-me APIs. After each proven epoch, the instance operator republishes the journal's scores as 30382 assertions under a per-(instance, program-version) service key, with tags carrying provenance (`instanceDomain`, output root, chain/tx reference). Every NIP-85-consuming client then renders buzz members' trustgraph ranks natively — and these are the only assertions in the ecosystem backed by a verifiable proof rather than a provider's word. Cost is trivial (event publishing, S4-adjacent); the loop closes: workspace events → proof → chain → back into Nostr.

### Composition is the distribution story

A workspace's buzz graph composes into any other trustgraph via **trust-compose** (#63–#66) with a governance-set source weight — "reputation earned shipping work in your team's workspace, blended into your DAO's graph at 20%." That, plus satellite-to-bound onboarding (score accrues before a wallet exists — the agent/member binds later and the score is already theirs), is the product loop.

---

## 7. Witness assembly and archival

`zk/prover/src/witness/nostr.rs` behind `--features witness-nostr`, mirroring the atproto fetcher:

1. Authenticate to the community relay (NIP-42; member/API token — the instance operator's own credentials).
2. Pull the epoch's events for the configured kinds (REQ paging under the 500-event cap) and the commitment — for Option A, the audit chain via `AuditService::get_entries` + `verify_chain` (a table/API read; 48001 is reserved but unproduced, and the pilot relay must run with audit enabled).
3. Assemble structured witnesses; **re-verify with the exact `envelopes::nostr` code the guest runs** (the house rule that catches witness bugs before proving).
4. Archive the bundle keyed by `(community_id, epoch, head)` — the availability mirror behind `dataCommitment` (IPFS CID pragmatically at v1, blob/DA upgrades per the parent doc).

Deliberate consequence of buzz's closed relays: **witness fetch requires community credentials**, so "anyone can re-prove" narrows to "any member (or anyone the community shares the archive with) can re-prove." The proof itself remains publicly verifiable; §9 records the honest asymmetry. Bundle publicity is a per-instance parameter (§12.6); the pilot instance runs member-scoped.

---

## 8. Cost model (measured 2026-08-16)

Measured on this stack (SP1 6.3.1, [`offchain/05-spike-results.md`](./offchain/05-spike-results.md) §§3–4; bins vendored at [`nostr/`](./nostr/)): **BIP-340 schnorr verify (patched `k256::schnorr`) = 31,747 cycles / 56,521 PGU; a complete Nostr event verification (NIP-01 serialize at ~400 B + sha256 id + schnorr) = 48,858 cycles / 75,696 PGU.** Unpatched both ops are the ~1.1M-cycle class — the patch is 24–35×. Reference rows: ecrecover 27,282 cyc / 50,203 PGU; sha256 3.41 cyc/B / 11.4 PGU/B (larger events add the byte rate). Third-party cross-check: CoW Protocol's multi-zkVM benchmark lands at ~65.6k cycles/sig for BIP340-style verify *plus* a Merkle-inclusion share on SP1 v5.2.4 — consistent. Nearest whole-guest analogue: the ERC-8004 completeness spike folded **16,384 × 256-B events in 192.3M cycles (~11.7k cycles/event, hashing-dominated)**.

| Scenario (epoch) | Events | Sig model | Cycles | PGU | $ at $0.1–1.0/B-PGU |
|---|---:|---|---:|---:|---:|
| Small team (A/B) | 5,000 | per-event schnorr | ~0.24B | ~0.38B | $0.04–0.38 |
| Active workspace (A/B) | 50,000 | per-event schnorr | ~2.4B | ~3.8B | $0.4–3.8 |
| Same, vouch lane only (C) | 2,000 events / 200 attesters | 1 schnorr/attester + hash/event | ~0.04B | ~0.07B | <$0.10 |
| NIP-OA overhead | per agent-signed event | +1 schnorr + ~100-B tagged hash | +32k | +57k | noise |

Rows carry no allowance for edge-rule decode; the atproto lesson says decode roughly doubles the hash-layer cost at small event sizes — even doubled, an active workspace's epoch is single-digit dollars. Everything sits far under the ~120B-cycle aggregation threshold; the network's 10⁹-PGU default only pinches the largest A/B scenarios, which batch by kind or move heavy kinds to Option-C logs. Re-measure on any patch-tag or SP1 major bump — the schnorr acceleration is source-evidenced and CI-tested upstream, but not docs-advertised.

---

## 9. What we cannot prove (and say so)

- **Enumeration honesty at Options A/B is relay-grade.** The buzz relay (= the community's own operator) could omit events from its chain before anchoring. Deterrents, not proofs: members' clients hold their own events and can publicly contradict a head (two signed statements); Option-C logs remove the exposure per-identity; the `relayAttestedWeightFp` discount prices the residual. This is the same honest line the atproto lane draws at "PDS-attested" — drawn one layer tighter here, since event *content* is always user-signed.
- **Timestamps are author-claims.** `created_at` is unauthenticated everywhere in Nostr; ordering authority comes from the committed chain and the anchor's block time. Score semantics must never lean on `created_at` beyond LWW-within-chain.
- **No global Nostr claims.** The proof speaks about one workspace's committed set — never "P has no other events elsewhere." Cross-workspace identity is additive (same npub, multiple instances, composed later).
- **Encrypted lanes stay dark in v1.** DMs (1059), agent memory (30174), per-turn cost metrics (44200) verify as envelopes but not contents. The Track-2 pattern (witness-side conversation keys, in-guest NIP-44 decrypt — ChaCha20+HMAC-SHA256, both cheap in-guest) would let an *owner* prove agent-cost statements ("this agent spent $X across N turns") — a genuinely novel primitive, deliberately deferred.
- **Public reproducibility is scoped by availability.** Closed relays mean re-proving needs the archived witness bundle; the community controls whether that archive is public. The SNARK's soundness is unaffected; the *re-prove race* deterrent (anyone re-proves a better root) weakens to members-and-archive-holders. State it in instance docs. Decided §12.6: per-instance parameter, pilot member-scoped — the pilot accepts this asymmetry deliberately.
- **Deletion is supersession, not erasure.** A kind-5 or moderation delete lands as a tombstone in later epochs; a proven historical root truthfully reports what was committed then. GDPR-shaped expectations belong at the archival layer (what the community publishes), not the proof layer.

---

## 10. Threat model delta (vs. the two-lane baseline)

| Element | Controlled by | Risk | Mitigation |
|---|---|---|---|
| Event authenticity | member/agent keys | key theft = forged edges | unchanged from every lane; NIP-OA windows bound agent-key blast radius |
| Enumeration (A/B) | community relay | omitted events → missing edges | member contradiction is public; Option-C upgrade; weight discount; rule Φ on withheld heads |
| Enumeration (C) | each attester | self-rollback of own log | strictly-increasing anchored `count` (H-5 discipline); withheld-newest = DROPPED, never resurrect |
| Relay-signed state (L2) | relay key | forged roster/membership | pinned `relay_pubkey` param (NIP-11 `self` as TOFU cross-check); roster is eligibility only, never edge authorship |
| NIP-OA delegation | owner key | over-broad conditions | in-guest window/kind enforcement; conditions grammar is closed |
| Anchor inclusion | admitted relayers | censorship of a community's head | multiple relayers; latency alerts (existing ANCHOR_INGRESS posture) |
| Witness availability | community archive | epoch staleness for that instance | availability-as-anchor-validity + rule Φ + `skippedDigest` (unchanged) |
| Sybil pressure | free npub creation | junk identities | roster-gated registration; seeds; composition weight at the consuming graph |

---

## 11. Build plan (each stage independently exitable)

**S0 — verification spike (days). Item (1) is already done (2026-08-16):** schnorr + full-event verify measured on our stack ([`nostr/`](./nostr/), 05-spike-results §4); the patched `k256::schnorr` module is the design, re-confirmed only on a patch-tag/SP1 bump. Remaining: (2) stand up buzz locally (Docker; a `buzz-conformance` crate exists upstream) and export real events; byte-parity the guest serializer against rust-nostr 0.44 on the export — **serde_json escaping semantics, adversarial control-byte cases included** (the §5 landmine). (3) ~~the Option-A question~~ — answered from source 2026-08-18 (§4: `EventCreated` covers every stored event, enqueue-before-OK; caveats recorded); residuals: confirm the pilot relay runs with audit enabled, and pin the J1 job-event tag schema from the web client. (4) Pin relay policy fine print (max event size, `created_at` drift — not located in the ingestion path yet; kind 24243's semantics also remain undocumented, harmless since it is ephemeral). Exit: serializer parity fixture committed; J1 schema pinned.

**S1 — envelope module + conformance guest.** `packages/envelopes/src/nostr/` (serializer, BIP-340, head folds for the chosen commitment kinds, NIP-OA, LWW/tombstones) + a `nostr-conformance` guest bin committing `(nodeId, head, eventCount, eventsDigest)` and panicking on any failure — the exact atproto-conformance pattern, proven against the S0 buzz fixture in-circuit. **Guest lives in a new isolated `zk/nostr-program/` workspace** so its `[patch.crates-io]` additions cannot rotate the five production vkeys.

**S2 — the nostr-workspace program.** `packages/nostr-workspace-core`: edge rules V1/G1/J1/F1 (§12.3), params + `params_hash`, journal v3, `compute()` on the generic rank/distribute machinery; golden vectors 4-way (`test/golden/nostr-workspace.json`), `NostrWorkspaceParamsCodec.sol` + golden test, TS recompute port. The platform claim says this touches zero pagerank-core semantic lines — hypercerts proved it.

**S3 — contracts + operator + instance.** Registrar flow for node kinds 2/3, labeled `SP1JournalVerifier`, `EmptyLaneAccumulator` + `AnchorRegistry` + reciprocal bind (the hypercerts 8-step runbook), `Program::NostrWorkspace` in operator-core, scheduler integration, InstanceRegistry row.

**S4 — witness + surfaces.** `witness-nostr` fetcher + archival (bundle publicity param, pilot member-scoped), indexer score-program row + anchor events, frontend instance page, `docs/build/nostr-workspace/{architecture,runbook}.md`, program-index row. Live exit: a real buzz workspace's epoch proven on anvil end-to-end (the M4-style e2e).

**S5 (parallel, external — all optional, none load-bearing).** Coordinate vouch kind 36382 against Block's registry; NIP-85 provider publication of proven scores (§6); the Option-B "event-set commitment" NIP proposal *after* trustgraphs has proven its usefulness (§12.1 — an offer, never a dependency); ERC-8004 explorer pointing at workspace-fed agent scores.

---

## 12. Decision record (Jake, 2026-08-18)

1. **Commitment source at v1: Option A + Option C, no upstream dependency.** Do not assume an upstream PR lands; B stays a future offer once trustgraphs has proven its usefulness to Block. v1 anchors the audit-chain head (A) for the workspace lane and self-committed logs (C) for agents and the vouch lane. *Resolved same day from source:* the audit chain covers every stored event (§4), so A stands; **A′, the sidecar committer** (§4) remains the fallback only for auditless deployments.
2. **Scope: the full nostr-workspace program**, not the vouch-only cut — the differentiating signals (merges, agent jobs) are the point.
3. **Edge rules at v1: V1, G1, J1, F1.** W1 (workflow approvals) deferred — not important enough to carry v1 complexity. R1 (reactions) deferred — NIP-25 polarity ("+", "-", arbitrary emoji) is semantically ambiguous; negative reactions must not mint positive edges; may return later as literal-"+"-only. Starting weights set at S2 with the dark-launch-discount posture.
4. **Agent credit: strictly separate nodes.** Owner aggregation remains a possible later params mode, never an identity change.
5. **Vouch carrier: mint kind 36382** (delegated pick). Verified unclaimed in the NIPs registry, all open kind-claiming PRs, and buzz's registry as of 2026-08-18; the mnemonic deliberately echoes NIP-85's 30382 — same `d`-tag convention and 0–100 scale — but first-person. NIP-32 self-disqualifies (labels are "not values", deliberately not replaceable); NIP-58 badges are immutable and value-less. Coordinate the number with Block at S5; upstream NIP proposal optional. Separately and uncontested: adopt NIP-85 30382 for *publishing* computed scores (§6).
6. **Archive publicity: a per-instance parameter; the pilot instance runs member-scoped** (deliberately accepting the §9 reproducibility asymmetry). Public bundles remain the recommended setting for instances that want the full re-prove race.
7. **Naming: program `nostr-workspace`** — the design is not buzz-unique as the Nostr ecosystem develops, and the generic name sidesteps the Block-trademark question. Core crate `packages/nostr-workspace-core`, guest `zk/nostr-program/`, `programId = keccak256("nostr-workspace")`, output domain `keccak256("trustgraphs.output.nostr-member.v1")`. This document keeps its buzz-specific name — it records the research provenance, like `HYPERCERTS_ATPROTO_PLAN.md`.

---

## Source index

- Recon (2026-08-16): [block/buzz](https://github.com/block/buzz) — [`ARCHITECTURE.md`](https://github.com/block/buzz/blob/main/ARCHITECTURE.md) · [`NOSTR.md`](https://github.com/block/buzz/blob/main/NOSTR.md) · [`crates/buzz-core/src/kind.rs`](https://github.com/block/buzz/blob/main/crates/buzz-core/src/kind.rs) · [`crates/buzz-sdk/src/builders.rs`](https://github.com/block/buzz/blob/main/crates/buzz-sdk/src/builders.rs) · [`crates/buzz-audit/src/hash.rs`](https://github.com/block/buzz/blob/main/crates/buzz-audit/src/hash.rs) · [`docs/nips/`](https://github.com/block/buzz/tree/main/docs/nips) (NIP-OA, NIP-AE, NIP-AM, NIP-AB, NIP-GS, NIP-IA, NIP-CW…) — launch coverage 2026-07-21/22 (cryptobriefing, TechTimes, tftc, OpenSourceForU)
- Nostr: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) (canonical serialization; see the §5 de-facto-form landmine) · [NIP-32](https://nips.nostr.com/32) · [BIP-340](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki) · [rust-nostr](https://github.com/nostrdevkit/nostr) (v0.44 is buzz's own serializer/verifier — host-side only for us)
- Buzz source verification (2026-08-18, exact bytes via raw.githubusercontent): `crates/buzz-audit/src/{action,entry,lib,service}.rs` (the `AuditAction` enum, per-community chain invariants, `get_entries`/`verify_chain`) · `crates/buzz-relay/src/handlers/event.rs` (`enqueue_event_created_audit`, awaited-path posture, actor-provenance tests) · `crates/buzz-relay/src/nip11.rs` (advertises the relay signing key as NIP-11 `self`; "NIP-43 events are verified against `self`") · `crates/buzz-sdk/src/builders.rs` (`build_git_status`, `build_workflow_approval`) · `crates/buzz-core/src/kind.rs` (job protocol 43001–43006) · [`docs/nips/NIP-OA.md`](https://github.com/block/buzz/blob/main/docs/nips/NIP-OA.md) (verbatim tag/grammar/preimage rules)
- Ecosystem sweep (2026-08-18): [NIP-85 Trusted Assertions](https://github.com/nostr-protocol/nips/blob/master/85.md) (kinds 30382–30384 + 10040 provider lists; merged 2026-01-22 via [PR #1534](https://github.com/nostr-protocol/nips/pull/1534)) · [Vertex, "Why We Don't Use NIP-85"](https://vertexlab.io/blog/dvms_vs_nip_85/) · agent-reputation kind claims [PR #2285](https://github.com/nostr-protocol/nips/pull/2285)/[#2320](https://github.com/nostr-protocol/nips/pull/2320) (30085) · [did:nostr draft](https://nostrcg.github.io/did-nostr/) + [W3C DID method registration](https://github.com/w3c/did-extensions/blob/main/methods/nostr.json) · [NIP-11 `self` field](https://github.com/nostr-protocol/nips/blob/master/11.md) / [NIP-29 relay-key rule](https://github.com/nostr-protocol/nips/blob/master/29.md)
- SP1 / measured evidence: [sp1-patches/elliptic-curves](https://github.com/sp1-patches/elliptic-curves) (`patch-k256-13.4-sp1-6.0.0`; the diff patches the schnorr module) · [sp1-patches/rust-secp256k1](https://github.com/sp1-patches/rust-secp256k1) (no schnorr acceleration — landmine) · [SP1 patch-testing schnorr guest](https://github.com/succinctlabs/sp1/blob/v6.2.0/patch-testing/k256/program/bin/schnorr_verify.rs) · [CoW multi-zkVM schnorr benchmark](https://github.com/cowprotocol/Zk-benchmark) · in-repo: [`nostr/`](./nostr/) bins + [`offchain/05-spike-results.md`](./offchain/05-spike-results.md) §4
- In-tree: [`OFFCHAIN_ATTESTATIONS_ZK.md`](./OFFCHAIN_ATTESTATIONS_ZK.md) · [`offchain/02-attestation-formats.md`](./offchain/02-attestation-formats.md) §6 · [`offchain/05-spike-results.md`](./offchain/05-spike-results.md) §3 · [`ANCHOR_INGRESS.md`](./ANCHOR_INGRESS.md) · [`HYPERCERTS_ATPROTO_PLAN.md`](./HYPERCERTS_ATPROTO_PLAN.md) · [`MULTI_PROGRAM_PLATFORM.md`](./MULTI_PROGRAM_PLATFORM.md) · [`TRUSTGRAPHS_COMPOSITION.md`](./TRUSTGRAPHS_COMPOSITION.md) · [`ERC8004_INPUT_COMPLETENESS.md`](./ERC8004_INPUT_COMPLETENESS.md) · [`docs/build/add-a-program.md`](../docs/build/add-a-program.md) · `AnchorRegistry.sol` · `packages/envelopes/src/atproto/` · `packages/hypercerts-core/src/binding.rs`
