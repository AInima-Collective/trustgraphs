# Offchain Attestations, ZK-Proven — Extending the Trustless Seam Beyond the Chain

**Status:** 📐 **Normative, in execution** ([`/GOAL.md`](../GOAL.md)). Grounded in four source dossiers (see Appendix A); numbers marked *(soft)* die at the Phase-A spike (GOAL.md M1) or become measured facts.
**Scope:** How TrustGraph's attestations can live in decentralized offchain stores — AT Protocol (Bluesky) repos first among them — while the `{account → score}` merkle root stays a permissionless SP1 zero-knowledge proof, soundness intact.
**Relationship to [`ZK_ARCHITECTURE.md`](./ZK_ARCHITECTURE.md):** v1 built the guest → journal → `submitProof` seam for *on-chain* inputs, with `AttestationAccumulator` supplying input completeness. This document changes exactly one load-bearing thing: **who commits to input completeness, and how**. The guest pipeline, journal discipline, verifier gate, `MerkleSnapshot` write path, and consumer contracts all survive.
**Relationship to [`PRIVACY_ARCHITECTURE.md`](./PRIVACY_ARCHITECTURE.md):** this is a two-track document. Track 1 (the bulk) is the *public* offchain lane. Track 2 (§9) shows exactly which pieces change under encryption, mapping onto the privacy roadmap's Layer 1 — and confirms the offchain move is a *prerequisite improvement* for privacy, not a detour.

---

## 1. Executive summary

Today every trust edge costs a transaction, requires an Ethereum wallet, and lives forever in public calldata. Moving attestations offchain buys three things: **free attesting** (a vouch is a signed record, not a tx), **reach** (Bluesky's userbase can participate through data they already control), and **a better substrate for privacy** (an edge that never touches the chain is easier to encrypt than one burned into calldata).

The obstacle is not signatures, storage, or proving cost — the research killed all three as concerns. The obstacle is the one property the chain gave us for free: **input completeness**. `root == PageRank(E)` is worthless if the prover chooses `E`. The v1 accumulator pins `E` because every edge passes through one resolver; an offchain edge passes through nothing we control.

The resolution is a decomposition the AT Protocol makes natural:

> **Global completeness = an on-chain registry of anchored per-identity heads × per-identity completeness of each head.**

An atproto repo commit is already a signed merkle commitment to the *entire* repo — anchoring one 32-byte head pins a user's complete attestation set, and the MST's canonical structure lets the guest prove it enumerated the *whole* vouch collection with nothing omitted. An EAS-offchain attester can produce the same shape by signing a chained head over their attestation log. What remains is only the global set of heads, and that is a solved on-chain problem: an `AnchorRegistry` that folds `(node, head, epoch)` into a chained-hash accumulator — the exact `AttestationAccumulator` pattern from v1, lifted one level up. Both lanes (on-chain EAS edges, offchain anchored heads) then bind into one journal, the way zkSync binds its L1 priority queue (a rolling keccak chain, same primitive) alongside L2 pubdata in one proof.

Feasibility, from the dossiers: verifying 1,000 EIP-712 signatures in-guest adds ~0.23B cycles ≈ **cents and single-digit minutes** on the prover network *(soft)*; the atproto path (one commit signature per attester + SHA-256 MST walk) is ~5–10× cheaper than per-record signatures and caches per-repo sub-proofs under SP1 recursion so steady-state cost tracks *churn*, not corpus. No prior art exists for atproto verification inside a zkVM, and no shipping system anywhere ZK-proves a graph computation over offchain attestations — this is unoccupied ground.

The genuinely new failure mode is **withholding**: on-chain data cannot be hidden from a prover; an anchored-but-unavailable repo can stall the epoch. §7 handles it with an availability-as-anchor-validity default plus a deterministic in-circuit degradation rule, because the fisherman's dilemma makes "proof of unavailability" impossible — the rule must be incentive-shaped, not truth-shaped.

**Recommendation in one line:** build the **two-lane (hybrid) input commitment** with the EAS-offchain envelope first and the atproto envelope second, model identity as a **unified node set with an optional ETH↔DID binding** (two node classes), and treat "offchain-first" as a later *policy* choice the same machinery already supports — not a different architecture.

---

## 2. The problem: completeness leaves the chain

Two properties get conflated when people say "commit to the data":

- **Inclusion pin** — "this datum existed by time T." Timestamps, anchors, blob commitments all give this. Cheap, and *not enough*: a prover can ignore a pinned datum.
- **Completeness commitment** — "this is *all* the data in the eligible set." This is what the v1 accumulator provides, and what makes omission impossible: the guest must rehash every leaf to reproduce `acc`.

Nothing offchain gives global completeness natively. Per-identity, exactly three substrates give a real completeness commitment (dossier 2, §9): **atproto repos** (signed canonical MST over the whole repo), **Farcaster Snapchain** (BFT total order — but now single-operator Neynar, with storage-rent eviction), and **self-signed chained logs** (an attester signs `head_i = H(head_{i-1}, att_i)` — the discipline we impose on EAS-offchain attesters below). Nostr has none; Ceramic is decommissioned; IPFS/Arweave pin but don't enumerate.

So the construction is forced, and it is the right one:

```
      the graph's input set at epoch N
   =  every head anchored in AnchorRegistry as of the epoch-N boundary   (on-chain, enumerable, chain-complete)
   ×  each head's own completeness commitment                             (signed MST root / signed chained log)
```

Omission-by-prover becomes omission-at-anchor-time, which §6 shows collapses to L1 censorship resistance — the strongest guarantee available to anyone.

---

## 3. What each substrate contributes

| | Gives us | Denies us | Verdict |
|---|---|---|---|
| **EAS offchain (EIP-712 v2)** | secp256k1 envelope (SP1 precompile), exact UID rules, **on-chain `revokeOffchain` registry** (deletion set, chain-complete), **on-chain `timestamp()` batching** (freshness pins), mature tooling | any availability/enumeration layer (explicitly BYO); UID does not bind attester — leaf must bind `(attester, uid)` | **Lane-2 envelope #1.** Smallest delta from v1; identity = ETH address, so governance/rewards consume unchanged. |
| **AT Protocol repo** | per-repo completeness (canonical MST, contiguous collection range, absence proofs first-class), one commit sig per attester (k256/p256 low-S over SHA-256 dag-cbor), did:plc key binding verifiable from the audit log, free revocation (delete the record), self-hostable PDS, custom lexicons | **user-held keys** (the PDS signs commits; Bluesky even shares rotation keys across accounts), append-only history (trace-free deletion, `prev = null`, equivocation possible), global enumeration, private records (not in 2026) | **Lane-2 envelope #2.** The reach play. Edges are "DID-bound, PDS-attested" unless the record embeds a user signature (§5). Anchor-time capture + CAR archival is mandatory — old commits are not re-servable. |
| **Farcaster / Nostr / Ceramic** | (Snapchain: real completeness; Nostr: schnorr-secp envelope; Ceramic: —) | Neynar single-operator + eviction / no completeness at all / decommissioned | **Not substrates.** Prior art only. The envelope abstraction (§4.2) leaves the door open. |
| **W3C VCs** | interop at the boundary (eIDAS wallets, Passport-style stamps) | RDF canonicalization in-guest is an adversarial-parsing liability; no secp256k1 suite; BBS still a CR draft | **Accept at the boundary, re-issue as native edges. Never the native envelope.** |

Two ecosystem facts worth internalizing: EAS remains tokenless, actively maintained, and predeployed on every OP Stack chain — a safe dependency; and every venture-backed data layer we evaluated either pivoted (Sign, Ceramic) or got acquired into a single operator (Farcaster). Bluesky/atproto is the exception trending the right way (PLC directory moving to an independent Swiss association, IETF ATP WG chartered March 2026), but the design below still treats every offchain store as *replaceable*: the registry and guest care about envelope proofs, not brands.

---

## 4. Target architecture (Track 1: public)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LANE 1 — on-chain (unchanged v1)                                             │
│   EAS attest/revoke → EASIndexerResolver._fold → (acc, leafCount)            │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│ LANE 2 — offchain                                                            │
│   attester signs edges into a self-committed set:                            │
│     • EAS-offchain envelope: EIP-712 attestations + signed chained log head  │
│     • atproto envelope:      vouch records in repo, PDS-signed commit head   │
│   anyone posts the head:  AnchorRegistry.anchor(nodeId, head, dataCommitment)│
│     → anchorAcc' = keccak(anchorAcc, anchorLeaf)      (same fold as v1)      │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                     MerkleSnapshot.trigger() checkpoints BOTH
                     (acc, leafCount, anchorAcc, anchorCount, block)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ SP1 GUEST (extended)                                                         │
│   1. rehash lane 1 → assert acc                                    (as v1)   │
│   2. rehash lane 2 anchor log → assert anchorAcc; resolve one                │
│      canonical head per node (max rev, ≤ epoch boundary)                     │
│   3. per head: verify envelope                                               │
│        EAS-offchain: ecrecover each EIP-712 edge; check revokeOffchain set   │
│        atproto:      PLC log → signing key → commit sig → MST range walk     │
│                      → complete vouch collection → decode records            │
│   4. apply degradation rule Φ (carry-forward / k-epoch exclusion)  (§7)      │
│   5. merge lanes → reconcile (timestamp, fold index) → fixed-point PageRank  │
│   6. journal: (acc, leafCount, anchorAcc, anchorCount, paramsHash,           │
│                outputRoot, ipfsHash, cidDigest, totalValue, skippedDigest)   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ▼
              MerkleSnapshot.submitProof → _updateStateAtBlock   (as v1)
              MerkleGovModule / MerkleFundDistributor / frontend (unchanged)
```

### 4.1 Contract — `AnchorRegistry`

The v1 insight was "the chain folds a raw log; the guest owns all semantics." That survives verbatim, one level up. The registry does **not** verify head signatures, does not parse envelopes, does not resolve which head wins — it folds an ordered log of anchor claims, and the guest deterministically reconciles them (invalid-signature anchors are provably skippable; the newest valid `rev` wins). On-chain signature checks would cost p256 verification in the EVM and buy nothing the guest doesn't already prove.

```solidity
contract AnchorRegistry {
    bytes32 public anchorAcc;      // same fold: keccak(abi.encode(prev, leaf)), acc_0 = 0
    uint64  public anchorCount;

    // nodeId: keccak of the canonical node identity (address or DID string, per §5)
    // envelopeKind: 0 = EAS-offchain chained log, 1 = atproto repo commit, ...
    // head: the per-identity completeness commitment (log head / commit CID digest)
    // dataCommitment: where the data behind the head verifiably lives (§7) —
    //                 blob versioned hash, Celestia namespace commitment, or merkle root
    function anchor(bytes32 nodeId, uint8 envelopeKind, bytes32 head, bytes32 dataCommitment) external {
        require(registered[nodeId], "unregistered");
        bytes32 leaf = keccak256(abi.encode(
            nodeId, envelopeKind, head, dataCommitment, block.timestamp));
        anchorAcc = keccak256(abi.encode(anchorAcc, leaf));
        emit HeadAnchored(anchorCount++, nodeId, envelopeKind, head, dataCommitment);
    }

    // registration gates junk-anchor griefing (proving cost scales with anchor count);
    // ETH nodes: a tx from the address. DID nodes: binding proof or bond (§5, open Q4).
    function register(bytes32 nodeId, uint8 kind, bytes calldata bindingProof) external { ... }
}
```

Anchor semantics, distilled from the censorship analysis (dossier 4 §1/§3):

- **Anyone may anchor anyone's head.** Heads are self-certifying (signed by the attester's log key or the DID's PDS), so a third-party anchorer can only *relay*, never forge. An aggregator/PDS batch-anchoring for its users is the cheap default; **permissionless direct anchoring is the force-inclusion hatch** — and because anchors are unordered set-inserts, no delay machinery is needed. Censoring a self-anchoring user means censoring their L1 transaction.
- **Epoch boundaries are contract-fixed** (block-height schedule), never prover-chosen — otherwise the proof submitter picks the boundary that excludes late anchors. `trigger()` checkpoints both accumulators at the boundary, exactly as it checkpoints `acc` today.
- **Equivocation is resolved by the chain.** If a user (or their PDS) signs two competing heads, the registry's fold order + max-`rev` rule pick one canonically. The chain becomes the fork-choice rule for user repos — a feature, since atproto itself has none.
- Cost: one fold per anchor (~8–12k gas, the v1 number) — sub-cent on an L2, pennies on mainnet at 2026 fee levels *(soft)*. EIP-7702/4337 sponsorship makes user self-anchoring gasless from the user's perspective.

### 4.2 The envelope abstraction

The guest sees lane 2 as a list of `(nodeId, envelopeKind, head, dataCommitment)` plus witnesses, and each envelope kind implements one trait: *"given a head and witness bytes, either produce the complete, authenticated edge set behind this head, or fail."*

**Envelope 0 — EAS-offchain chained log.** The attester maintains an append-only log of their own EIP-712 v2 attestations and signs the running head `h_i = keccak(h_{i-1}, uid_i)`. The guest: verify the head signature (1 ecrecover), then per edge verify the EIP-712 signature (ecrecover; the leaf binds `(attester, uid)` since the offchain UID alone doesn't bind the attester), decode `(recipient, confidence)` from the same schema as v1, and subtract the **on-chain `revokeOffchain` deletion set** (read from the EAS contract's events, chain-complete for free). Identity = the recovered Ethereum address; downstream consumption unchanged.
*Why per-edge signatures here but not in atproto:* an EAS-offchain log has no PDS; the only authority is the attester's key, so every edge carries it. Cost is fine: ~225k cycles/signature *(soft)* means 1k edges ≈ cents.

**Envelope 1 — atproto repo commit.** The guest runs the pipeline dossier 1 §9 specifies: CBOR-decode the commit (SHA-256 → claimed CID), verify the commit signature (k256 or p256, low-S), verify the signing key against the **did:plc audit log chain** (in-circuit — same primitives, <10 ops typical; bindings younger than the 72h nullification window treated as provisional), then the **MST range walk** over the vouch collection's contiguous key range, enforcing canonical-structure invariants and failing closed on any missing block — which yields the *complete* record set, revocations included by absence. Decode each `app.<ns>.trust.vouch` record → edges.
The lexicon is greenfield (no vouch NSID exists in the ecosystem): `{subject: did-or-caip10, weight: 0..100, createdAt, sig?: ethSignature}` — the optional embedded EIP-712 signature upgrades an edge from *PDS-attested* to *user-signed* and doubles as binding evidence (§5).

Farcaster/Nostr envelopes are possible later behind the same trait; nothing else in the system would change.

### 4.3 Guest, journal, verifier changes

- **Journal** grows from 7 to ~10 fields: `+ anchorAcc, anchorCount, skippedDigest` (the last commits the set of `(nodeId, reason)` pairs rule Φ skipped or carried forward, making prover discretion publicly auditable). `MerkleSnapshot.submitProof` binds the new fields from checkpoint storage exactly as it binds `acc/leafCount` today; golden vectors regenerate across Solidity/Rust/TS as usual.
- **Reconciliation** already runs on the total order `(timestamp, fold index)`; lane-2 edges enter with their record timestamps and the anchor fold index as tie-break, so cross-lane determinism follows the existing rule rather than needing a new one. Same-account edges across lanes (an address that attests on-chain *and* offchain) reconcile by the same last-write-wins the guest applies within a lane.
- **Cycle budget** *(soft, pre-spike)*: at the current ~1k-account scale, lane-2 verification adds ~0.2–0.5B cycles — under a dollar and minutes on the prover network, versus the current guest's 1.8M cycles. At 100k edges: ~$5–90 and under an hour, still one monolithic proof (SP1 guidance: aggregation only past ~120B cycles). When scale or latency demands it, the atproto envelope moves to **per-repo compressed sub-proofs** (`verify_sp1_proof` aggregation, public values `(did, keyDigest, rev, edgesDigest)`), cached until a repo's `rev` changes — steady-state proving ∝ churn. Sub-proofs are permissionless too; attesters can even prove their own repos.

---

## 5. Identity: who is a node?

The question the offchain move forces: PageRank nodes are addresses today, and `MerkleGovModule`/`MerkleFundDistributor` consume address-keyed leaves. DIDs don't fit that slot — and the custody research says a DID isn't even a *key* the user holds: typical Bluesky accounts are fully PDS-custodied (the PDS signs commits; Bluesky operates shared rotation keys). Three models, honestly compared:

| | **A — ETH addresses only** | **B — DIDs as first-class nodes** | **C — Unified nodes + binding registry** |
|---|---|---|---|
| What a node is | an address; atproto is mere storage for EIP-712 blobs | a DID; addresses are one profile field | a `nodeId` that MAY have an address and MAY have a DID, bound bidirectionally |
| Edge authorization | always user-key-signed | PDS-attested (user-signed only for self-custodians) | per-edge: user-signed where a binding exists, PDS-attested otherwise |
| Reach | wallet holders only — the Bluesky user *cannot participate* without one | full atmosphere | full atmosphere; wallet needed only to *consume* on-chain |
| Governance/rewards | unchanged | broken — needs a DID→address hop anyway, reinvented at claim time | unchanged for bound nodes; unbound nodes hold score but can't claim until they bind |
| Leaf format | unchanged | new leaf domain, all consumers churn | `keccak(nodeId, value)` leaves; bound nodes also get the v1 address leaf |
| Sybil surface | unchanged | DID creation is free — seeds/weights must carry more | same as B for unbound nodes; registration gate + seed weighting mitigate |
| Delta from v1 | smallest | largest | medium, and strictly additive |

**Recommendation: C, with two node classes.**

- **Bound nodes** — an ETH address, optionally bound to a DID. Binding = the Farcaster-verification pattern, already prototyped in the atmosphere (stephancill's `org.chainagnostic.verification` lexicon): the wallet signs an EIP-712 claim naming the DID; the record lives in the DID's repo (DID-side consent via the signed commit that contains it); the guest verifies both directions. Bound nodes attest via either lane, and their repo vouches count as **user-authorized** when records embed the wallet signature.
- **Satellite nodes** — DID-only, no wallet. Their vouches are **PDS-attested**: real signal (same trust as believing Bluesky serves the right data — for social-graph purposes, substantial), but a weaker authorization class. They receive scores (visible, usable off-chain, provable via the merkle root) but cannot vote or claim rewards until they bind — at which point their accumulated score is already theirs, a clean onboarding funnel.
- **The weight knob, not a validity bit:** params gain a `pdsAttestedWeightFp` multiplier (0 disables satellite edges entirely), governance-tunable through the existing operational-timelock `paramsHash` path. Authorization strength becomes a continuous policy question instead of an architectural fork — which is exactly where a judgment call this contested belongs.
- did:web nodes: excluded from satellite status (no auditable key history — a silent key swap is indistinguishable from rotation); acceptable only as bound nodes where the wallet signature carries the authorization.

Model A remains the fallback if satellite-node sybil pressure proves unmanageable — it's C with registration restricted to addresses, so nothing is thrown away.

---

## 6. Input model: hybrid vs offchain-first

| | **Status quo (lane 1 only)** | **Hybrid (two lanes)** | **Offchain-first (lane 2 only)** |
|---|---|---|---|
| Cost per edge | a tx per attest (~$0.001–0.01 L2) | user's choice per edge | ~0; one anchor per identity-epoch |
| Reach | wallet holders | wallet holders + atmosphere | atmosphere (wallet optional) |
| Completeness | resolver fold (chain-perfect) | fold + anchor registry | anchor registry only |
| Withholding risk | none — calldata can't hide | lane 2 only, rule Φ | everything rides on rule Φ |
| Instant edge finality | yes | lane 1 yes, lane 2 at epoch anchor | epoch-granular only |
| Migration | — | additive; v1 untouched | breaks lane 1 attesters; big-bang cutover |
| Privacy fit | worst (plaintext calldata) | good (sensitive edges go offchain) | best-and-worst: no calldata, but atproto firehose is *more* public than calldata in practice |

**Recommendation: build the hybrid; treat offchain-first as a policy configuration, not an architecture.** The deciding observations:

1. **Offchain-first is the hybrid with lane 1 empty.** The guest code, registry, journal, and verifier are identical; "offchain-first" is achieved by governance later declaring lane 1 closed (or by fee pressure making it organically empty). Building "offchain-first" directly saves nothing and burns the v1 lane that already works.
2. **Lane 1 is the liveness anchor.** It has no withholding mode and no epoch granularity; keeping it means the graph can never be *fully* stalled by offchain unavailability games.
3. This mirrors the zkSync precedent exactly: nobody designs a rollup with only the L2 lane; the L1-native lane is what makes the mixed proof honest.

The v1 doc's optimistic-vs-ZK caveat resolves decisively here, in ZK's favor: an optimistic producer *cannot* extend to lane 2 even in the public case, because watchers can only recompute what they can enumerate — and lane-2 enumeration is itself part of the proven statement. The offchain move retroactively justifies the ZK choice.

---

## 7. Withholding: the genuinely new failure mode

On-chain inputs cannot be withheld from a prover. An anchored head can be — the PDS is down, the user deleted their repo, the data was never published. The fisherman's dilemma makes this *cryptographically unresolvable* (an unavailability claim is unfalsifiable: the accused releases the data the moment anyone challenges), so the design must make withholding **locally punishable and globally harmless**:

1. **Availability-as-anchor-validity (default).** An anchor carries a `dataCommitment` proving the data was *published*, not just hashed: an EIP-4844 blob versioned hash (guest binds via proof-of-equivalence; blob expiry after ~18 days threatens only archival replay, not soundness — prove each epoch inside the window and fold forward), a Celestia namespace commitment via SP1 Blobstream (namespace *completeness* proofs are uniquely strong here, and it's the same SP1 stack — benchmark NMT verification cost first), or, pragmatically for v1, an IPFS CID with the indexer + prover as pinning archival mirrors. This is the StarkEx move: "anchored but withheld" becomes "invalidly anchored," a non-event.
2. **Rule Φ, in-circuit.** For each registered node the guest consumes the newest anchored head whose data the prover supplied, **provided it is at most k epochs stale**; older than k, the node's out-edges drop (in-edges from live nodes still count — reputation *received* survives your PDS dying; reputation *given* requires showing up). Every skip/carry-forward lands in `skippedDigest`, so a prover that "couldn't find" available data is publicly contradicted by anyone who holds it — detection, plus a re-prove race (any better proof for the same checkpoint supersedes via the normal permissionless path), stands in for slashing.
3. **What must never happen:** the degradation rule living outside the proven statement. The moment the prover chooses freely which heads to include, the omission hole reopens and the whole registry construction is theater.

---

## 8. Trust surface (delta from v1)

| Element | Controlled by | Risk | Mitigation |
|---|---|---|---|
| `anchorAcc` fold | nobody (deterministic) | none | — |
| Anchor inclusion | permissionless | L1 censorship only | self-anchor hatch; sponsored anchors |
| Head authenticity | attester key / PDS key | PDS forges satellite edges | user-signed class for bound nodes; `pdsAttestedWeightFp`; PDS forgery is publicly provable (two signed heads) and socially catastrophic for the PDS |
| did:plc → key binding | plc.directory (availability/ordering only; ops are self-certifying) | stale/omitted log view | run a PLC mirror (streaming API live since Jan 2026); commit mirror head; 72h-provisional rule; Swiss-association transfer reduces this over time |
| Data availability | whoever published per `dataCommitment` | epoch staleness for that node only | §7: availability-gated anchors + rule Φ + archival mirrors |
| Epoch boundary | contract schedule | none (not prover-chosen) | — |
| `paramsHash` (now incl. `pdsAttestedWeightFp`, k, envelope set) | operational timelock | weight-games via satellite discount | existing two-tier timelock governance |

Honest one-liner, updated from v1: trust moves from *"governance set the guest + params honestly, and the SNARK did the rest"* to the same, **plus** *"the data behind each anchored head stayed available (else that node degrades deterministically), and plc.directory didn't equivocate about DID keys (mitigated by mirroring)."* Nothing about score correctness weakens; what's new is per-node liveness sensitivity.

---

## 9. Track 2: the privacy extension

The offchain move is not itself a privacy move — an atproto firehose record is *more* observable than L2 calldata, and EAS-offchain blobs on IPFS are public. But it strictly improves the privacy roadmap's starting position, and the seam holds exactly as `ZK_ARCHITECTURE.md` promised: **under encryption, only the guest's input-decoding step changes.** Anchors, accumulators, journal, verifier, write path — identical, because they commit to bytes, and ciphertext is bytes.

What changes per layer of [`PRIVACY_ARCHITECTURE.md`](./PRIVACY_ARCHITECTURE.md):

- **Layer 1 (encrypted attestations) gets easier.** The vouch record's `weight` (and optionally `subject`) become ciphertext under the committee threshold key, with the Noir/in-guest validity proof attached — as a *record field*, no EAS schema-resolver gymnastics, no calldata. The heaviest Layer-0 item from the privacy doc ("stop broadcasting the plaintext graph on-chain") is subsumed: lane-2 edges never touch the chain at all. Interim, committee-free option: the EAS private-data pattern (merkle-ized fields) hides weights from the public while the prover still sees them — weaker, shippable now.
- **Layer 2 (who decrypts) is unchanged** — the committee/TEE/threshold-decrypt decision is orthogonal to where ciphertexts are stored. One improvement: the prover domain fetches ciphertexts from PDSes/DA instead of from public chain state, so the *public* never holds the ciphertext corpus to attack later (a real harvest-now-decrypt-later reduction).
- **The anonymity limit stands.** The attester's identity is load-bearing for PageRank (rank flows along *outgoing* edges), so the compute domain still learns who anchored which edges. Satellite/bound node classes don't change this.
- **New metadata leak to record honestly:** the anchor registry publicly reveals *who participates and how often their head moves* — participation and cadence, even with fully encrypted payloads. Mitigations: batch anchoring through an aggregator (hides individuals inside batches — the tree's leaf list can itself be published encrypted), fixed-cadence re-anchoring regardless of activity (padding), and never anchoring per-edge.
- **Do not wait for atproto "permissioned data."** The 2026 roadmap says it's access-controlled TLS-gated storage, not E2EE, and probably not MST-provable — useless for us on both axes. Encrypted payloads inside public records is the right pattern indefinitely.

Net: Track 2 = Track 1 + ciphertext payloads + validity proofs + the committee from the privacy roadmap's Phase 2. No contract in this document changes.

---

## 10. Phased roadmap

| Phase | Deliverable | Depends on | Retires the risk |
|---|---|---|---|
| **A — spike (days)** | Empirical SP1 numbers on v6.3.1: patched ecrecover + p256 cycles, PGU multiplier, one live network-price observation; MST walk prototype against `indigo`'s test vectors; draft vouch + binding lexicons | — | every *(soft)* number in this doc |
| **B — offchain lane, EAS envelope** | `AnchorRegistry` + checkpoint wiring + journal v2 (golden vectors); guest: chained-log envelope, ecrecover-in-guest, `revokeOffchain` deletion set, rule Φ + `skippedDigest`; indexer/frontend read lane 2 | A | proves the two-lane seam end-to-end with zero atproto dependencies |
| **C — atproto envelope** | MST range walk + dag-cbor decode in-guest; PLC audit-log verification + self-run mirror; vouch lexicon published; binding registry + two node classes + `pdsAttestedWeightFp`; CAR archival in indexer | B | reach; the novel-ground implementation |
| **D — scale & hardening** | Per-repo compressed sub-proofs + aggregation guest (churn-proportional proving); blob/Blobstream `dataCommitment` upgrade from IPFS-pragmatic; anchor sponsorship UX | C | proving cost at 10⁴–10⁵ nodes; withholding hardening |
| **E — privacy track** | Encrypted payload fields + validity proofs in both envelopes; committee integration per `PRIVACY_ARCHITECTURE.md` Phase 2; anchor-cadence padding | B (not C) | the reason this research started |

Phases B and C are each independently shippable and independently valuable: B alone gives gas-free attesting to existing users; C alone gives Bluesky reach. E deliberately depends only on B — privacy does not have to wait for atproto.

---

## 11. Open questions (Jake-decisions)

1. **Which chain hosts the registry?** Anchor economics scream L2 (sub-cent), but v1's contracts and the EAS revocation registry live where they live; cross-chain anchor reads would drag a bridge assumption into the proof. Cleanest: registry co-located with `MerkleSnapshot`.
2. **k (staleness horizon) and epoch length.** Social parameters, not technical ones: how long may a dormant Bluesky account keep influencing scores from its last anchored state?
3. **`pdsAttestedWeightFp` starting value.** 0 (satellite edges dark-launched, graph unaffected) vs. a modest discount (~0.25–0.5) that makes satellite participation meaningful from day one. Recommend dark-launch, then govern upward with data.
4. **Satellite registration gate.** Free DID registration invites junk-anchor griefing (proving cost scales with registry size); options: small bond, allowlist-of-PDSes bootstrap, or require one inbound edge from a bound node ("invited-by"). The last is thematically perfect for a trust graph.
5. **Lexicon namespace** — which domain publishes `*.trust.vouch` and the binding lexicon; whether to converge with `org.chainagnostic.verification` rather than mint our own binding format.
6. **Prover incentive for the heavier guest** — the v1 "optional bounty from the pool" question returns with real numbers attached (dollars, not cents, at scale).

---

## Appendix A — source dossiers

Full research with citations and confidence flags, compiled 2026-07-10:

- [`offchain/01-atproto-provability.md`](./offchain/01-atproto-provability.md) — MST/commit/DID internals, per-repo completeness proof mechanics, custody, mutability, 2026 ecosystem status
- [`offchain/02-attestation-formats.md`](./offchain/02-attestation-formats.md) — EAS offchain/EIP-712 exact formats, revocation/timestamping, VC/Farcaster/Nostr/Ceramic evaluations, identity-binding prior art, competitive landscape
- [`offchain/03-sp1-feasibility.md`](./offchain/03-sp1-feasibility.md) — SP1 v6.3.1 precompiles, cycle/PGU/dollar cost models, recursion/aggregation, in-guest vs out-of-guest signature verification
- [`offchain/04-input-completeness.md`](./offchain/04-input-completeness.md) — anchoring patterns, DA layers, censorship analysis, withholding/fisherman's dilemma, mixed-provenance proof prior art

## Appendix B — files this design touches

- new `src/contracts/registry/AnchorRegistry.sol` — anchor fold + registration + checkpoint hook
- `src/contracts/merkle/MerkleSnapshot.sol` — checkpoint gains `(anchorAcc, anchorCount)`; `submitProof` binds journal v2
- `packages/pagerank-core` — envelope traits, `reconcile.rs` cross-lane order, `encode.rs` journal v2 + anchor leaf, rule Φ; golden vectors regenerate (Solidity + TS)
- `zk/program` — lane-2 verification (patched `k256`/`p256`/`sha2`, `serde_ipld_dagcbor` or hand-rolled MST parser); later a per-repo sub-proof binary
- `zk/prover` — witness assembly: firehose/PDS fetch, CAR archival, PLC mirror client, blob/IPFS retrieval
- `indexer/` — anchor events, offchain-edge ingestion, CAR + attestation-blob archival (the availability mirror)
- `frontend/lib/pagerank` — TS port of lane-2 reconciliation for the local recompute; binding + vouch UX
- new lexicons: `<ns>.trust.vouch`, binding record (or adopt `org.chainagnostic.verification`)
