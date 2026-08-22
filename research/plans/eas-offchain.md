# GOAL — Off-chain EAS attestations, without weakening the on-chain lane

> **Status (2026-08-20): PLANNED.** The cryptographic core exists as envelope 0 / lane 2, but the
> normal factory, hosted operator, storage path, indexer, and product deliberately leave it dormant.
> This goal turns that prototype into an opt-in, production-shaped feature on testnet. Mainnet
> enablement is a separate decision after the soak and audit gates at the end of this file.

Let a member create and revoke a Trustgraphs vouch by signing with their wallet, without sending an
EAS transaction or paying gas, while the resulting score root remains a proof over a complete,
authenticated, availability-bound input set.

The existing on-chain EAS lane remains the default and remains byte-for-byte compatible. A hybrid
network accepts both sources and reconciles them deterministically. A lane-1-only network must not
deploy, index, fetch, price, or prove any off-chain machinery.

---

## Decision record

- **D1 — Additive hybrid creation.** Keep `TrustgraphsFactory.createInstance` and its
  `InstanceCreated` event unchanged. Add a separate hybrid creation entry point and an additive
  discovery event. Existing callers and on-chain-only instances retain their present behavior.
- **D2 — One explicit support profile.** The first release supports EAS off-chain **version 2**, an
  Ethereum **EOA** signer, the instance's canonical vouch schema, `expirationTime = 0`,
  `revocable = true`, `refUID = 0`, and a nonzero random salt. Unsupported shapes fail before an
  anchor transaction and fail again in the guest. Payloads are public and durably replicated;
  “off-chain” means gasless creation, not private or erasable data.
- **D3 — Trustgraphs revocation is in-log.** A signed `REVOKE(uid)` log entry is the only proven
  off-chain revocation in this release. The canonical on-chain `EAS.revokeOffchain` mapping is not
  consumed. The app and docs must say this plainly and must never imply that the two mechanisms are
  interchangeable.
- **D4 — Strict availability, not prover-selected degradation.** For envelope 0, every node's
  newest anchored head must have a valid bundle. Missing, malformed, or mismatched data makes the
  checkpoint unprovable; a prover may not selectively drop a node and land a different root.
  Admitted relayers pin and read back data redundantly before anchoring, making availability an
  ingress obligation. `skippedDigest` remains in journal v3 for other programs but is zero for a
  valid Trustgraphs envelope-0 proof.
- **D5 — Content-addressed payload is consensus input.** `dataCommitment` is the SHA-256 digest of a
  frozen canonical `Envelope0PayloadV1` byte encoding. Its CID is CIDv1/raw/sha2-256, derivable from
  that digest. The payload contains the log and EAS attestations, but not the head-authorization
  signature: the owner computes the payload digest first and then signs it. The guest hashes the
  exact payload bytes and checks the anchor commitment before parsing them.
- **D6 — The head signature is instance-bound.** Replace the prototype's portable EIP-191 head
  signature with the exact EIP-712 `Anchor` message in clarification 5. Its domain binds `chainId`
  and the specific registry; its struct binds the node, schema, envelope kind, previous head, new
  head, count, and `dataCommitment`. A relayer cannot move a head across instances, fork the
  registry's recorded predecessor, or substitute where its bytes live.
- **D7 — Bounded hidden work.** Capacity, operator cycle estimation, and proving-vault pricing count
  the entries inside the latest envelope-0 log in addition to lane-1 leaves and anchor records. Each
  envelope entry is charged a frozen conservative work-unit multiplier measured from the
  all-attestation case; one anchor may not hide unbounded signature work.
- **D8 — No silent companion-program mismatch.** Hybrid creation cannot enable signer-sync, and a
  hybrid parent cannot start a contributions round through the supported contract or UI, until those
  programs bind and consume lane 2. Weighted trustgraphs remains lane-1-only. These combinations
  fail closed and are labelled, not merely omitted from documentation.
- **D9 — Testnet first, feature off by default.** Ship behind explicit frontend, relayer, and
  operator configuration. Testnet enablement requires two independently keyed relayers and two
  independent durable storage/read paths. Mainnet remains disabled through this goal.

---

## Outcome

When this goal is complete:

1. A network creator can opt into a hybrid standard trustgraph. The factory deploys and binds one
   envelope-0-only `EasOffchainAnchorRegistry`, derives the exact EAS domain from the configured EAS
   contract, publishes every address needed by indexers and operators, and leaves all authority
   with the instance admin.
2. A member can create, replace, and revoke a vouch from the normal vouch UI using wallet signature
   prompts only. A relayer validates and durably stores the bundle before paying for the anchor.
   First use does not require a separate self-registration transaction.
3. Any prover can reconstruct a hybrid checkpoint from chain events plus content-addressed bundles,
   verify the same bytes in the guest, merge both lanes, and submit a real SP1 proof through the
   normal `MerkleSnapshot` path.
4. A malicious prover cannot omit an available member, select an older head, replay a lower count,
   swap a bundle commitment, future-date an off-chain edge, or make a revoked off-chain edge reveal
   an older on-chain edge.
5. The indexer and frontend show every edge's provenance (`on-chain EAS` or `off-chain EAS`), the
   anchored head and CID, relay/storage health, and the correct revocation action.
6. Turning the feature off gives the existing product: the same factory selector, event, params
   hash, accumulator fold, reconciliation result, journal bytes, output root, APIs, and UI actions
   for an on-chain-only fixture. The trust-graph program vkey may rotate because guest code changes;
   lane-1 semantics and journal v3 do not.

---

## Normative baseline

- Two-lane architecture: [`research/OFFCHAIN_ATTESTATIONS_ZK.md`](research/OFFCHAIN_ATTESTATIONS_ZK.md),
  as corrected by [`research/DEVIATIONS.md`](research/DEVIATIONS.md), especially deviation 3.
- Relayer admission and capacity:
  [`research/ANCHOR_INGRESS.md`](research/ANCHOR_INGRESS.md).
- Current envelope verifier: `crates/envelopes/src/eas_offchain.rs`.
- Current lane-2 reconciliation: `crates/pagerank-core/src/lane2.rs` and
  `crates/pagerank-core/src/reconcile.rs`.
- On-chain completeness lane: `EASIndexerResolver` / `AttestationAccumulator`; their leaf format is
  frozen and is not changed by this goal.
- Checkpoint and proof gate: `contracts/src/merkle/MerkleSnapshot.sol`; journal v3 remains the
  12-word public interface.
- Official wire-format oracle: the pinned `@ethereum-attestation-service/eas-sdk`. A checked-in
  fixture generated by the official SDK is normative; the internal generator is not its own
  compatibility oracle.
- Every consensus-interface correction is recorded in `research/DEVIATIONS.md` before dependent
  work lands.

---

## Supported envelope-0 profile

This table is the release contract. “EAS off-chain support” in product copy means exactly this
profile, not every historical EAS package or every optional EAS service.

| Field / behavior | Required rule |
|---|---|
| EAS version | `2` only |
| EIP-712 domain | `name = "EAS Attestation"`, `version = EAS.version()`, configured chain id, configured EAS verifying contract; factory-derived and params-pinned |
| Signer | 65-byte canonical secp256k1 EOA signature; recovered signer equals log owner; low-S enforced |
| Schema | Exactly the hybrid instance's canonical `string comment,uint256 confidence` schema UID |
| Recipient / data | Same address and ABI payload interpreted by lane 1; zero recipient rejected |
| `time` | Signed Unix time, not later than the block timestamp of the anchor that first commits that log entry |
| `expirationTime` | Must be zero; wall-clock expiration is not claimed without checkpoint-time binding |
| `revocable` | Must be true |
| `refUID` | Must be zero |
| `salt` | Nonzero 32-byte random value; UID reproduced byte-for-byte from the official v2 SDK rule |
| Completeness | Full append-only per-owner log re-folds to the signed and anchored head at exactly the signed count |
| Revocation | An in-log revoke entry names a prior UID and emits a canonical revoke mutation into cross-lane reconciliation |
| Availability | Latest payload bytes hash to `dataCommitment`; no valid payload means no valid proof |
| Envelope kind | `0` only in a standard hybrid Trustgraphs registry |

Legacy/v1 EAS packages, EIP-1271/EIP-6492 wallets, nonzero expiration, canonical
`EAS.revokeOffchain`, references, and additional envelope kinds are rejected rather than
best-effort interpreted.

---

## Non-negotiable invariants

1. **Lane 1 is unchanged.** No edit to the EAS resolver's attest/revoke acceptance, accumulator leaf
   ABI, fold order, schema string, or lane-1 reconstruction semantics. The existing
   `createInstance` ABI and `InstanceCreated` event stay unchanged.
2. **Empty lane means the existing zero lane.** On-chain-only inputs still produce
   `anchorAcc = 0`, `anchorCount = 0`, and `skippedDigest = 0` in the existing journal-v3 field
   order.
3. **The newest signed count and its history are mandatory.** A lower-count head is never
   consumable, even if its bytes are available and the newest bytes are not. The newest payload's
   prefix at every earlier anchored count must reproduce that earlier anchored head, so an owner
   cannot rewrite an already-anchored log without an explicit revoke. Exact re-anchors and count
   regressions cannot spend registry capacity.
4. **No omission discretion.** For envelope 0, the guest either verifies the newest complete bundle
   for every anchored address node or aborts. There is no accepted `CARRIED` or `DROPPED` result.
5. **Bytes, head, and owner agree.** Payload digest, log fold, entry count, per-edge signatures,
   head-authorization signature, node id, schema, chain, EAS address, and registry address are
   checked as one statement.
6. **Revocation cannot resurrect another lane.** The guest returns ordered attest and revoke
   mutations, not merely the latest live off-chain set. Reconciliation sees the revoke and retains
   its existing “never fall back to an older edge” rule across both lanes.
7. **Work is bounded on-chain.** The registry enforces
   `lane1LeafCount + anchorRecordCount + latestEnvelope0EntryCount * E0_ENTRY_WORK_UNITS <=
   maxTotalInputs` with checked arithmetic. `E0_ENTRY_WORK_UNITS` is frozen conservatively from M0
   measurements because an off-chain EAS signature costs more than an accumulator fold. Per-bundle
   byte and entry limits are also hard guest constants and relayer checks.
8. **Relayers affect availability, never meaning.** They may refuse inclusion, but cannot forge an
   edge, change a head, substitute a CID, replay a stale count, or register an address without its
   signature. At least two independently keyed relayers are required operationally.
9. **Pin before anchor.** A relayer submits `anchor()` only after the exact bundle succeeds on the
   configured minimum number of independent storage targets and reads back byte-identically from
   each required target.
10. **Unknown is failure.** Unknown envelope kind/version, unsupported wallet type, malformed ABI,
    invalid signature, non-canonical bundle, missing bytes, oversized work, inconsistent indexer
    data, and unsupported feature combinations fail closed with a specific observable reason.
11. **No secret keys in clients or artifacts.** Wallets sign through their provider. Relayer keys
    stay server-side; logs and metrics never include keys, signatures beyond public protocol data,
    pinning credentials, or RPC credentials.

---

## Implementation clarifications

These are part of the goal, not optional cleanup.

### 1. The payload is a frozen binary protocol

M0 specifies `Envelope0PayloadV1` before changing the guest or UI. It has a magic/version prefix,
fixed integer widths, explicit lengths, one owner, the ordered log entries, and the complete v2
attestation records required by attest entries. Decoding rejects trailing bytes, duplicate attest
UIDs, revoke-before-attest, count mismatches, oversized lengths, and non-canonical integer/signature
forms.

`dataCommitment = sha256(payloadBytes)`. The matching locator is the deterministic CIDv1/raw
sha2-256 encoding already used for score blobs. Only after computing that commitment does the owner
sign the separate typed head authorization that binds it. `anchor()` receives that signature and
emits it with the anchor record; the guest receives the raw payload bytes plus the matching anchor
authorization, checks both, and then decodes. This ordering deliberately avoids a circular
“signature commits to the hash of bytes containing the signature” format. A host-side check alone
is not a proof.

The payload and authorization get Rust, TypeScript, Solidity-test, and official-SDK golden vectors.
JSON may be exported for debugging but is never the anchored representation. Elsewhere in this goal,
“bundle” is convenient product/transport shorthand for the content-addressed payload plus its
on-chain authorization metadata; only `Envelope0PayloadV1` bytes are hashed into the CID.

### 2. The current “live set only” result is wrong for a hybrid graph

The prototype removes a revoked UID before returning lane-2 edges. If an older lane-1 vouch exists
for the same pair, removing the lane-2 edge lets that older on-chain vouch reappear. Envelope 0 must
instead return the authenticated ordered mutations represented by the log. A revoke mutation uses
the original attestation's owner, recipient, UID, and data, and takes effect at the timestamp of the
anchor that first commits that revoke entry. The shared reconciliation state machine then clears
only the current UID and never resurrects an older vouch.

The guest derives an entry's first-commit timestamp from the earliest anchor whose signed count
covers that entry. While re-folding the newest payload, it also checks that the prefix head at every
earlier anchored count equals the head recorded at that count. A higher-count fork is therefore not
an append-only log and aborts the proof.

Adversarial tests cover on-chain → off-chain replacement → off-chain revoke, off-chain → on-chain
replacement → old off-chain revoke, same-second ties, repeated pairs, and mixed fold order.

### 3. Rule Phi is not an envelope-0 launch policy

The current `CARRIED` branch is effectively unreachable after the max-signed-count replay fix, and
accepting `DROPPED` gives a permissionless prover discretion to omit a member even when the member's
CID is available. Envelope 0 therefore becomes strict. The existing skip fields and behavior remain
available to other program guests; Trustgraphs envelope-0 proofs commit zero skips.

Availability failures are operational holds: do not spend on a proof, identify the missing CID,
retry every configured reader, and page the relayers/storage operators. Recovery is re-pinning the
identical bytes. A different bundle requires a new owner-signed higher-count head.

### 4. Stable logs do not expire merely because nobody changed them

`lane2MaxHeadAge` is not a freshness requirement for this profile. A valid, available latest head
remains active until an owner advances it. Hybrid creation pins this existing params field to zero;
the guest interprets zero as “no head-age expiry.” Nonzero values are rejected for envelope 0 in
this release. This avoids periodic no-op anchors and keeps quiet networks free.

Because wall-clock expiration would require a checkpoint-pinned time in the proof statement,
`expirationTime` must be zero. The guest still rejects an attestation whose signed `time` is after
its committing anchor timestamp. Supporting expiry later requires an explicit journal/checkpoint
design, not the latest arbitrary anchor as a clock.

### 5. The owner signs the availability claim

The new typed head authorization is verified both at ingress and in the guest. Its exact type is:

```text
EIP712Domain(
  name = "Trustgraphs Offchain Head",
  version = "2",
  chainId,
  verifyingContract = EasOffchainAnchorRegistry
)
Anchor(
  bytes32 nodeId,
  uint8 envelopeKind,
  bytes32 schemaUid,
  bytes32 previousHead,
  bytes32 head,
  uint64 count,
  bytes32 dataCommitment
)
```

The signer is recovered, `nodeId` must equal `keccak256(abi.encode(signer))`, and `previousHead`
must equal the registry's stored latest head for that node (zero on first use). First-anchor
registration occurs atomically when that node does not yet exist. A separate user-paid `register()`
transaction is not part of the normal flow.

The factory uses a new `EasOffchainAnchorRegistry` implementing the existing snapshot-facing
`IAnchorRegistry` reads plus work accounting. It accepts only envelope kind 0 and pins the instance
schema UID. The existing general `AnchorRegistry` ABI and semantics used by hypercerts/nostr stay
unchanged; shared folding/capacity code may be extracted only with golden proof that their behavior
did not move.

### 6. Capacity and pricing use work, not just anchors

For each address node, the registry stores the latest signed count, head, and data commitment. It
additionally tracks the aggregate latest envelope-0 entry count and exposes a `workCount` equal to
anchor-fold work plus current entry count times the frozen `E0_ENTRY_WORK_UNITS`. Replacing a head
adds only the count delta at that multiplier; checked arithmetic and the immutable combined cap run
before the fold. The stored latest tuple also makes relay retries independently idempotent rather
than dependent on an indexer's view. Every entry is priced as the more expensive attest case because
the registry cannot inspect the payload to distinguish attest from revoke.

`MerkleSnapshot` records a separate `checkpointWorkCount` without changing the existing
`anchorCheckpoints` getter or journal. The operator uses it for cycle refusal. `ProvingVault` uses it
for the same fee-band boundary, with a legacy fallback to `anchorCount` for registries that do not
expose work. Cross-language tests pin exact agreement at 1,000, 20,000, and 200,000 work units.

Per-node and per-bundle limits prevent one admitted update from consuming the instance's remaining
budget unexpectedly. The relay reports the projected work and refuses before pinning or spending
gas when the update would breach a limit.

### 7. The factory path is additive

`createInstance(CreateArgs)` remains the on-chain-only path. A new hybrid entry point accepts the
same `CreateArgs` plus an `OffchainEasConfig` containing the immutable work cap and a bounded list of
initial relayer addresses; callers still submit all derived params fields as zero. Testnet product
creation requires at least two distinct nonzero relayers. The instance admin receives role
administration and can rotate that set later; the factory and deployer retain no role. The factory:

1. deploys the same resolver and canonical schema;
2. derives the EAS v2 domain from its immutable EAS contract, `EAS.version()`, and `block.chainid`;
3. fills the one accepted domain and zero head-age policy into params;
4. deploys an envelope-0-only bounded registry through an inert deployer;
5. deploys the normal snapshot, sets and reciprocally binds the registry before checkpoint zero;
6. installs the same controller, roles, governance, distributor, and directory record; and
7. emits the unchanged `InstanceCreated` plus `OffchainEasLaneCreated(instanceId, registry,
   domainSeparator, maxTotalInputs)`.

The governed wrapper gets an additive hybrid entry point. It rejects signer-sync configuration for
a hybrid instance. Factory/deployer inertness, one-shot binding, event ordering, EIP-170 headroom,
and schema-squatting adoption receive the same tests as the existing path.

### 8. Relay and storage are a public protocol, not one privileged website

Build one shared validation library and a reference stateless HTTP relay that can be deployed by
independent operators. The request carries public bundle bytes and the desired registry; it carries
no private key. Before anchoring, each relay independently verifies:

- supported chain, registry, envelope kind, EAS domain, and schema;
- canonical bundle bytes, digest/CID, log fold/count, all EAS signatures, and typed head signature;
- current on-chain count, node identity, rate limits, bundle limits, and projected global work;
- successful pin and byte-identical readback from the configured storage quorum; and
- an `eth_call` simulation of the exact anchor transaction.

Retries are idempotent. If another relay lands the same count first, the loser reports success once
chain state matches the requested head and commitment; it must not create another anchor. A forked
same-count bundle is a visible conflict and requires the client to sync the canonical anchored
bundle and reapply the user's intended mutation at a higher count.

The testnet deployment minimum is two different transaction keys and two storage systems with
independent credentials and read URLs. Running two processes with one key or one backing pin is not
independence.

### 9. Product language preserves the revocation boundary

The UI calls these “off-chain EAS vouches stored and anchored by Trustgraphs.” It does not say they
are registered on EAS or that EASScan's off-chain revoke button controls them. Edge detail shows
source, signer, schema, UID, signed time, anchor transaction, log count, bundle CID, and current
availability verification.

The revoke action dispatches by provenance: on-chain edges keep the current EAS revoke transaction;
off-chain edges append and sign a Trustgraphs log revoke. Import and developer documentation warn
that calling canonical `EAS.revokeOffchain` alone has no effect on a Trustgraphs proof.

### 10. Companion programs are blocked, not accidentally divergent

Signer-sync's journal does not bind lane 2, contributions reputation mirrors only lane 1, and the
weighted exporter rejects an anchor registry. This goal does not rotate those three programs.
Instead:

- hybrid governed creation rejects a nonempty signer-sync configuration, and the signer-sync
  deployer/module rejects a snapshot whose anchor registry is nonzero;
- `ContributionsFactory` rejects a hybrid parent, and the UI explains the same boundary before a
  transaction is built;
- weighted creation offers no off-chain toggle; and
- settings explain why these features are unavailable and link to a follow-up design item.

Existing on-chain-only networks retain all three features unchanged.

---

## Scope

**In:** envelope-0 protocol and golden corpus; strict guest semantics; cross-lane revocation fix;
payload commitment; domain-bound typed head; EOA auto-registration; work-aware registry cap, snapshot,
operator, and vault pricing; additive base/governed factory paths; wallet create/revoke/recovery UX;
reference multi-relay endpoint; redundant IPFS-compatible publication and retrieval; hosted operator
fetch/cache/preflight; dynamic indexer discovery and verified bundle ingestion; provenance and health
UI; local and real-proof e2e; testnet deployment, monitoring, chaos drills, soak, and audit.

**Out:** EAS legacy/v1 imports; smart-contract/counterfactual wallets; nonzero expiration;
`refUID`; canonical `EAS.revokeOffchain` storage proofs or mirror; permissionless force inclusion;
privacy/encrypted bundles; atproto/nostr/hypercerts changes; signer-sync lane 2; contributions lane 2;
weighted lane 2; log compaction/reset; mainnet deployment. Each is either rejected on input or
blocked as a feature combination; none is silently approximated.

---

## Execution map

| Milestone | Deliverable | Depends on |
|---|---|---|
| M0 | Protocol freeze and threat-model closure | — |
| M1 | Canonical bundle, verifier, and hybrid reconciliation | M0 |
| M2 | Work-bounded registry, snapshot accounting, pricing, and additive factories | M0; integrates M1 goldens |
| M3 | Wallet client, durable storage, and independently deployable relay | M1, M2 |
| M4 | Operator retrieval/preflight and indexer audit surface | M1–M3 |
| M5 | Product UX and browser verification/parity | M1–M4 |
| M6 | Full-system assurance and testnet rollout | M1–M5 |

---

## M0 — Freeze the protocol before extending it

- Write `research/EAS_OFFCHAIN_SUPPORT.md` as the concise design of record, incorporating the
  decisions and invariants in this goal and superseding stale envelope-0/Rule-Phi prose elsewhere.
- Specify `Envelope0PayloadV1` byte-for-byte, its size/count limits, SHA-256 commitment, CID
  derivation, log/head rules, EIP-712 head domain and struct, signature normalization, and error
  taxonomy.
- Generate an EAS v2 fixture with the pinned official SDK and independently reproduce its typed
  digest and UID in Rust and TypeScript. Include negative fixtures for v1, wrong EAS address,
  wrong chain, wrong schema, future time, expiry, ref UID, zero salt, high-S, bad head domain,
  changed `dataCommitment`, and trailing bundle bytes.
- Fix numeric limits from measured SP1 cycles and bundle sizes, including worst-case all-attest and
  all-revoke logs. Record the relationship among guest hard limits, registry work cap, operator
  cycle limit, and vault bands.
- Update `research/DEVIATIONS.md` for strict envelope availability, in-log-only revocation, typed
  head v2, zero head age, and work-aware capacity.

**Exit:** the protocol document and four-language golden fixture are reviewed; no implementation
has to choose an unspecified byte, limit, signature domain, failure policy, or revocation meaning.

## M1 — Make the core statement correct

- Replace JSON witness ingestion in the consensus path with raw canonical payload bytes and verify
  `sha256(bytes) == dataCommitment` in the guest.
- Verify the supported profile exactly and return ordered authenticated mutations, including revoke
  mutations, rather than a pruned live set.
- Make envelope 0 strict: newest max-count head per node is required; missing/invalid data aborts;
  every earlier anchor must match the corresponding prefix of the newest log; stale-count,
  same-count, and higher-count fork attempts fail; no carried/dropped result is accepted.
- Enforce future-time rejection against the committing anchor timestamp and reject all nonzero
  expiration values. Define and test same-second cross-lane tie order.
- Keep journal-v3 encoding unchanged. Regenerate the trust-graph program vkey and only the golden
  material whose guest identity legitimately changes.
- Preserve byte-identical lane-1 params hash, accumulator, journal bytes, score blob, output root,
  and total value for the frozen on-chain-only fixture.

**Exit:** official SDK positive fixture verifies; every negative fixture fails at the intended rule;
hybrid replacement/revocation never resurrects an older lane; lane-1 compatibility fixture is
byte-identical except for the recorded program vkey.

## M2 — Bound and manufacture the hybrid lane

- Add `EasOffchainAnchorRegistry` with an immutable allowed-envelope profile, the new typed head,
  atomic address auto-registration, stored/checked previous head, owner-signed content commitment,
  checked count deltas, aggregate envelope-0 entries, per-node limits, and combined work-cap
  enforcement.
- Expose `workCount`; add `MerkleSnapshot.checkpointWorkCount(checkpointId)` as an additive mapping
  and event while keeping `anchorCheckpoints` and journal v3 unchanged.
- Teach operator sizing and `ProvingVault` pricing to use checkpointed work with a safe legacy
  fallback. Pin their agreement at every band and refusal boundary.
- Add an inert registry deployer and the additive base/governed hybrid factory entry points and
  discovery event from clarification 7. Derive the one valid domain on-chain; callers cannot choose
  arbitrary separators.
- Keep the legacy base/governed creation routes unchanged and explicitly reject signer-sync on the
  hybrid route. Update deploy scripts/config generation for the new verifier and factory artifacts.
- Test unauthorized ingress, cross-instance/chain replay, commitment substitution, first-anchor
  registration, stale/same-count anchors, count jumps, cap edges, compromised-relayer exhaustion,
  reciprocal binding, role handoff, factory/deployer inertness, event discovery order, and EIP-170
  headroom.

**Exit:** a hybrid instance is created and fully wired in one transaction; an on-chain-only instance
created through the old selector is indistinguishable from today's instance; no accepted sequence
can exceed the published work boundary.

## M3 — Signing, persistence, and relay

- Build a shared TypeScript payload/signing library around the official EAS SDK. Wallet UX creates
  cryptographically random salts, signs the EAS v2 attestation, builds and hashes the next canonical
  payload, and then signs the typed head authorization without exposing a raw key.
- Add sync-before-edit, local encrypted draft/recovery storage, bundle export/import, deterministic
  conflict detection, and “reload canonical head and reapply” recovery for concurrent tabs or
  competing relays.
- Build the reference relay protocol and server implementation from clarification 8, including
  chain/schema/registry allowlists, request and per-node rate limits, body limits, simulations,
  idempotency, structured errors, and secret-safe logs.
- Publish to at least two configurable IPFS-compatible targets, verify exact readback, derive the CID
  locally, and anchor only after the storage quorum succeeds. Preserve every anchored bundle for
  historical checkpoint reproduction; garbage collection is disabled for this corpus.
- Provide a standalone deployment/runbook so a second operator can run the relay without the
  Trustgraphs frontend or prover.

**Exit:** two clean relay deployments with different keys and backing stores race the same request
idempotently; one anchor lands, both return the same canonical result, and the bundle is retrievable
byte-identically through both independent read paths.

## M4 — The prover and indexer can recover the public statement

- Extend `input-exporter` with CID derivation, multi-gateway fetch, bounded parallelism, cache,
  exact-byte commitment checks, and strict latest-head assembly. Manual `--envelope0-log` remains a
  fixture/debug option, never the hosted source of truth.
- Extend the hosted operator catalog and handlers to discover every factory-created registry,
  preflight all current bundles before triggering, reconstruct the checkpoint after finality, use
  checkpointed work for cycle/budget decisions, and hold with a specific alert instead of proving
  when availability fails.
- Reuse the operator's multi-target publication/retry discipline; add metrics for newest anchored
  count, bundle fetch latency, storage quorum, validation failure, work/cap utilization, relayer lag,
  and unprovable checkpoint age.
- Make the indexer discover hybrid registries from the factory event, index registrations/anchors,
  retrieve and verify canonical bundles independently, and materialize edge provenance and bundle
  health. Never trust relay or prover annotations without reproducing digest/head/signature checks.
- Add APIs for network lane configuration, node head/history, verified current mutations, CID
  health, and work utilization. Reorg handling removes/rebuilds derived bundle state consistently
  with anchor events.

**Exit:** a newly created hybrid instance requires no manifest edit or manual witness path; an
independent operator and the indexer reconstruct the same input from chain + CIDs; losing either
one storage target does not interrupt proving.

## M5 — Put the supported boundary in the product

- Add an opt-in “gasless off-chain vouches” choice to standard network creation. On-chain-only stays
  the default. Review names the relayer/storage trust boundary, immutable work cap, EOA limitation,
  initial relayer set, in-log revocation, public/retained payload, and incompatible add-ons before
  signature/transaction.
- Add off-chain create/replace/revoke to the existing vouch surfaces. Show the exact signed fields
  before the wallet prompt, relay/pin/anchor progress after it, and a recoverable bundle export.
- Dispatch edit and revoke by provenance; retain the current on-chain EAS transaction flow without
  changed labels or defaults. Mixed-lane edge history explains which mutation currently wins.
- Show the verification/audit fields from outcome 5 and actionable unavailable/conflict/cap errors.
  Do not present relay acceptance as final until the anchor is finalized and the indexed bundle
  independently verifies.
- Extend browser recomputation for the supported envelope profile: fetch exact CIDs, verify digest,
  signatures, head/count, and mixed-lane reconciliation before comparing the computed root. A
  reduced mode may display indexed results, but must label that it did not independently verify.
- Block signer-sync and contributions actions for hybrid networks with an explanation; weighted
  creation remains unchanged.

**Exit:** create hybrid network → sign vouch → anchor → prove → render → revoke → prove is usable
from the app with no CLI and no user-paid attestation transaction; the unchanged on-chain journey
passes its existing screenshots and interaction tests.

## M6 — Prove it, break it, and soak it on testnet

- Extend the local two-lane e2e to use the official-SDK bundle, content-addressed fetch, reference
  relay, dynamic factory discovery, strict availability, mixed-lane revoke, indexer APIs, and app
  flow. Keep mock proving for fast CI but add a scheduled real Groth16 run through the configured
  SP1 prover/gateway and submit it to the real snapshot verifier.
- Run adversarial suites for malformed/truncated/oversized bundles, zip/body bombs, signature
  malleability, wrong domains, future time, replay/forks, relayer races, RPC reorgs, IPFS corruption,
  partial pin success, missing all readers, stale caches, cap overflow, and malicious-prover
  attempted omission.
- Deploy the new verifier/factories/relay set on the selected testnet with the feature hidden. Verify
  roles, domains, vkeys, caps, independent keys/storage, source-code verification, metrics, alerts,
  backups, and recovery exports before admitting users.
- Enable an opt-in cohort and soak for at least 14 days and at least 20 successfully proven hybrid
  checkpoints. During the soak, deliberately fail each relay, each storage target, the primary RPC,
  and one packages/indexer/prover process independently; execute conflict recovery and re-pin drills.
- Measure cycles, proof latency/cost, bundle growth, anchor gas, failure rates, and cap utilization by
  band. Re-tune only within the frozen safety envelope; a wire-format or semantic change returns to
  M0 and rotates the vkey explicitly.
- Obtain an independent review focused on bundle parsing, EAS/UID compatibility, head/domain
  separation, work accounting, cross-lane reconciliation, relay abuse, and operator omission. No
  open critical/high finding; medium findings have fixes or explicit accepted-risk records.
- Update architecture, runbooks, threat model, production checklist, program/vkey index, API docs,
  recovery procedures, and user-facing help from measured reality.

**Exit:** the rollout gates below are evidenced in a testnet report. Mainnet remains disabled until
a separate go/no-go decision consumes that report.

---

## Verification matrix

| Check | Required evidence |
|---|---|
| Lane-1 non-regression | Existing on-chain EAS unit/integration/UI suites plus frozen fixture equality for params hash, acc/count, journal bytes, root, blob, and total value |
| Official EAS compatibility | Fixture generated by pinned official SDK verifies in Rust/guest/TypeScript; UID and typed digest byte equality |
| Bundle consensus | Rust/TypeScript encoders and guest decoder share positive/negative goldens; exact SHA-256/CID equality; non-canonical forms rejected |
| Cross-lane semantics | Replacement/revoke/tie/property tests over mixed event order; no older-edge resurrection |
| Registry security | Forge fuzz/invariant suite for role, signature domain, registration, monotonic count, work accounting, capacity, binding, and relayer compromise |
| Pricing agreement | Registry/snapshot/operator/vault agree on work and band boundaries; oversized work is both unpriced and refused |
| Availability | Two-target pin/readback; single-target/RPC/process loss succeeds; total loss holds and alerts without producing a proof |
| Relay behavior | Auth/rate/body limits, simulation, idempotent race, fork conflict, secret-redaction, and reorg tests |
| Operator/indexer | Dynamic discovery, finality/reorg, CID cache corruption, independent verification, historical reproduction, and health APIs |
| Product | Wallet-only off-chain create/replace/revoke/recover; provenance dispatch; unsupported-combination guards; unchanged on-chain flow |
| ZK e2e | Fast mock CI plus at least one real Groth16 proof submitted through the deployed testnet verifier for a mixed-lane checkpoint |
| Operational readiness | Two relayers, two storage systems, monitoring/alerts, cap dashboard, key rotation, backup/re-pin/conflict runbooks, completed chaos drills |
| Security review | Independent report with no unresolved critical/high finding and accepted-risk records for remaining mediums |

---

## Testnet rollout gates

1. **Dark deploy:** contracts, verifier, indexer sources, operator readers, relays, and storage are
   deployed; frontend creation remains hidden. Domain/vkey/role/cap verification is published.
2. **Internal canary:** team-owned nodes exercise mixed on-chain/off-chain replacement and revoke,
   relay races, real proving, single-dependency failures, bundle export/import, and re-pin recovery.
3. **Opt-in cohort:** feature flag opens only for named test networks. Dashboards expose work, cap,
   availability, proof latency, and relay inclusion lag. Unsupported companion features remain
   blocked.
4. **Soak complete:** at least 14 days and 20 hybrid checkpoints, all chaos drills complete, no
   unexplained root mismatch, no lost anchored bundle, and no unresolved critical/high finding.
5. **Mainnet decision:** a new recorded decision chooses whether to enable, extend the profile, or
   continue testing. This goal does not make that choice implicitly.

---

## Done when

1. Every M0–M6 exit condition and verification-matrix row has recorded evidence.
2. A stranger can create an opt-in hybrid standard network and complete the full off-chain
   vouch/revoke/prove/audit journey from the app without a private-key CLI or user-paid EAS
   transaction.
3. Any independent prover can recover the same strict input from chain events and deterministic
   CIDs; selective omission cannot produce an accepted envelope-0 root.
4. Work and cost remain inside the same published bound at registry ingress, checkpoint, operator
   admission, and vault pricing.
5. The frozen lane-1 fixture and existing on-chain UX are unchanged apart from the explicitly
   recorded trust-graph program-vkey rotation.
6. Testnet has passed the dark, canary, cohort, soak, chaos, real-proof, and security-review gates;
   mainnet remains explicitly disabled pending its separate decision.
