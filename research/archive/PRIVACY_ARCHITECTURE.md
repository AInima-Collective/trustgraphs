# Private TrustGraph — A Privacy Architecture

**Status:** ⏸️ **Deferred (was Phase E of the offchain-attestations build plan).** Design proposal / research synthesis, highly experimental like the rest of TrustGraph.
**Scope:** How to take TrustGraph from "transparent by construction" to "private by construction" without throwing away the WAVS + EAS + Merkle architecture that already works.

---

## 1. Executive summary

TrustGraph today has a strong **integrity** boundary and **no confidentiality** boundary. Operator staking and an on-chain Merkle root guarantee that scores were computed correctly, but every input and output is public: who vouched for whom, the confidence weight on each vouch, the free-text comment, every per-account reputation score, and every governance vote. The frontend even ships the entire weighted graph to the browser to recompute PageRank client-side.

The hard constraint is structural: **Trust-Aware PageRank is a global function of the entire edge set.** It needs the whole weighted adjacency matrix in cleartext to run. But that graph — who trusts whom, and how much — is exactly the asset we want to protect. So the only real design lever is: *who is allowed to see the plaintext graph during computation, and for how long?*

This document proposes a layered architecture that:

1. **Confines the plaintext graph to a single, minimal, rotating trust domain** instead of broadcasting it to the public chain, the indexer, IPFS, and the browser.
2. **Encrypts attestations to a threshold-encryption committee key** so no individual party — not even one operator — can read the graph alone.
3. **Keeps every output verifiable** (Merkle root + correctness proof) so privacy does not cost us integrity.
4. **Makes consumption private**: prove "my reputation ≥ threshold" without revealing identity or score, and vote anonymously with reputation-weighted, coercion-resistant ballots.

The proposal leans on a capability TrustGraph's WAVS branch already has: **commonware threshold cryptography** (BLS12-381 DKG, threshold decryption, secret resharing) wired into an authenticated operator network with BFT consensus. That turns the historically hardest part of a private design — standing up and rotating a decryption committee — into an integration job rather than a from-scratch build.

This work is phased so that the **highest-value, lowest-risk fixes ship first** (close the public-graph leak; private reputation proofs) and the **research-grade pieces** (fully secret-shared PageRank) are scoped as spikes, not blockers.

---

## 2. Background: how TrustGraph works today

| Stage | Where | What happens |
|---|---|---|
| Attestation | EAS on-chain, schema `string comment, uint256 confidence` | "Alice vouches for Bob, confidence 0–100, with a comment." Plaintext, public, timestamped. |
| Indexing | Ponder indexer (`indexer/`) + `wavs-indexer` component | Edges and accounts re-served via an unauthenticated API (`indexer/src/api/network.ts` returns *all* accounts + edges in one call). |
| Computation | WAVS operators, `components/trust-graph/` (Rust→WASM), `packages/pagerank` | Builds the full in-memory adjacency matrix (`eas_pagerank.rs`), runs Trust-Aware PageRank (`graph_computer.rs`, ~100 data-dependent iterations with early-exit), produces `{account → score}`. |
| Commitment | `src/contracts/merkle/MerkleSnapshot.sol` | A 32-byte Merkle root is posted on-chain. Leaf = `keccak256(keccak256(abi.encode(account, value)))`. Historical snapshots retained. |
| Distribution | IPFS + `MerkleFundDistributor.sol` | The **full** `{account, score}` table + trusted-seed list is uploaded to IPFS in plaintext and re-indexed. Rewards claimed against the root. |
| Governance | `src/contracts/zodiac/MerkleGovModule.sol` | Vote weight = score proven by Merkle inclusion. `votes[proposalId][voter]` stored publicly; `VoteCast` emitted; calldata reveals the voter's exact score. |
| Consumption | `frontend/` | `usePageRankComputer.ts` recomputes PageRank in-browser — which only works because the whole weighted graph is shipped to the client. |

**Trust-Aware PageRank** (`docs/concepts/algorithm.md`): standard PageRank with trusted seed attestors that receive a weight multiplier and an initial-score boost, so trust flows from a curated root set and Sybil rings stay isolated.

---

## 3. Threat model

### 3.1 What we are protecting against

- **Social-graph deanonymization.** A public trust graph is a labeled social network. Off-the-shelf graph analysis reveals communities, central actors, and real-world relationships, even under pseudonyms.
- **Retaliation.** Attributable negative or low-confidence vouches let targets retaliate, which destroys signal quality — people stop giving honest negative signal.
- **Coercion and vote-buying.** Public votes are on-chain-verifiable receipts. That is the precondition for bribery markets and coercion; a voter can *prove* how they voted.
- **Reputation profiling.** An exact, public, per-identity score is a permanent dossier attached to an address and everything that address ever does.
- **Targeted attack on seeds.** Named trusted seeds are named targets (bribery, coercion, key theft, legal pressure).

### 3.2 What must remain public for the system to function

- The **Merkle root** of scores (for verifiable governance/rewards).
- *Some* checkable aggregate or proof that the computation was done correctly.
- Enough structure for **Sybil resistance** to still work (we must be able to count/weight without seeing identities).

### 3.3 Trust boundaries today vs. target

| | Today | Target |
|---|---|---|
| Who sees full plaintext graph | WAVS operators, indexer, IPFS, **and the browser** | A single minimal, rotating compute domain — and ideally no one |
| Who can decrypt inputs | n/a (plaintext) | Only a **threshold quorum** of operators, never one alone |
| Integrity guarantee | operator quorum + Merkle root | unchanged (+ optional zkVM proof) |
| Confidentiality guarantee | **none** | threshold-cryptographic + economic |

---

## 4. Design principles

1. **Separate the two security goals.** Today's design protects *computational integrity*. We are adding *confidentiality* without weakening integrity. Never make one the sole guarantor of the other (in particular, never use a TEE as the only integrity mechanism — keep the operator quorum).
2. **Minimize the plaintext-graph blast radius.** The graph should be cleartext in as few places, for as short a time, under as distributed a trust assumption as possible.
3. **Privacy must stay verifiable.** Every private output ships with a proof (Merkle inclusion, zk proof, or quorum attestation). Privacy is not an excuse for "trust me."
4. **Prefer crypto + economic security over hardware trust** where practical. This is the Interfold/Enclave thesis, and it is reinforced by 2026 TEE attestation breaks (TEE.Fail). Use TEEs as a pragmatic accelerator, not the root of trust.
5. **Reuse what exists.** Keep EAS, the WAVS operator/aggregator pipeline, `MerkleSnapshot`, the Zodiac governance module, and `packages/pagerank`. Add encryption, a committee, and proofs around them.
6. **Ship the cheap wins first.** Closing the public-graph leak and adding private reputation proofs require no exotic crypto and deliver most of the real-world privacy benefit.

---

## 5. The core architectural decision

Everything reduces to one question: **where does the plaintext graph live during the PageRank computation?** There are exactly three answers, and the research evaluated all three.

| Model | Who sees the graph | Mechanism | 2026 verdict |
|---|---|---|---|
| **A. Confidential compute domain** | one enclave, or one quorum-authorized operator | TEE, or threshold-decrypt-to-one-prover | **Recommended baseline.** Near-native speed, modest change, real privacy from the public/indexer/browser. |
| **B. Nobody (encrypted end-to-end)** | no one | FHE or secret-shared MPC | FHE: **impractical** for iterative PageRank (division, data-dependent early-exit, 3–6 orders of magnitude slowdown). MPC: best *pure-crypto* fit, now has a transport (commonware), but still minutes-to-hours and round-heavy. **Research spike.** |
| **C. Prover sees it, public gets a proof** | a prover | ZK / zkVM | Proves correctness + thresholds; does **not** hide the graph from the prover. **Complementary**, not a standalone privacy answer. |

The recommended architecture is **Model A as the baseline, hardened by commonware threshold cryptography for input/output privacy, with Model C layered on for verifiability, and Model B kept as a forward-looking research path.** The reason A wins as a baseline: it is the only option that gives real, shippable privacy at usable performance, and commonware lets us make its trust assumption *distributed* (quorum-gated decryption, rotating committee) rather than "trust one operator."

### Why commonware changes the calculus

The earlier blocker against any MPC/threshold design was *"WAVS has no operator-to-operator round-synchronized networking."* The commonware branch removes that for the threshold-crypto class specifically. It natively provides:

- **`commonware-cryptography`** — BLS12-381, **Joint-Feldman DKG** (`dkg/feldman_desmedt.rs`), **threshold signatures**, and **threshold encryption** (batch/threshold encryption constructions; one-round "golden" DKG).
- **`commonware-reshare`** — reshare a threshold secret across epochs → **committee rotation** without re-running setup.
- **`commonware-consensus`** — Byzantine ordering, incl. Threshold Simplex.
- **`commonware-p2p` / `-broadcast` / `-collector`** — authenticated, encrypted channels, reliable dissemination, quorum collection.

This is precisely the "Distributed Threshold Cryptography" pillar of Interfold's E3 — and it is already integrated with the staked operator set. Standing up a decryption committee, the historically hardest part of a private coordination system, becomes configuration + integration.

> **Important distinction.** Commonware gives us *threshold cryptography MPC* (DKG, threshold decryption/signing) natively. It does **not** ship a general *secret-shared arithmetic* engine (BGW/SPDZ) that would compute PageRank itself over shares — though it provides the exact substrate (Shamir + Feldman VSS math, p2p, collector, consensus) one would build that on. Full secret-shared PageRank therefore stays a research spike (§8, Phase 4), not part of the baseline.

---

## 6. Target architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. ENCRYPTED ATTESTATION                                                      │
│                                                                              │
│  Attester ── encrypt(recipient?, weight) under committee PK ──┐              │
│           └─ Noir validity proof: well-formed, weight∈[0,100],  │             │
│              attester eligible, recipient set member           │             │
│                                                                 ▼            │
│            EAS attestation carries CIPHERTEXT + PROOF, not plaintext edge     │
└────────────────────────────────────────────────────────────────────────────┘
                                     │  (on-chain verifier checks proof)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. CONFIDENTIAL COMPUTE DOMAIN  (the only place the graph is cleartext)       │
│                                                                              │
│  commonware committee (= WAVS operators) threshold-decrypts the edge set     │
│  to the compute step:                                                         │
│     • Baseline:  inside a TEE enclave on the operator(s)                      │
│     • Or:        to ONE quorum-authorized "computing operator"               │
│     • Future:    never decrypted — secret-shared MPC (Phase 4)               │
│                                                                              │
│  Runs existing packages/pagerank → {account → score}                          │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 3. VERIFIABLE COMMITMENT                                                      │
│                                                                              │
│  • Merkle root (keccak) → MerkleSnapshot.sol            (unchanged)           │
│  • Parallel POSEIDON tree of {account, score}           (ZK-friendly)         │
│  • Integrity proof:                                                           │
│       - baseline: operator quorum BFT-attests the root                        │
│       - optional: zkVM (RISC Zero / SP1) proof root == PageRank(edges)        │
│  • IPFS dump is ENCRYPTED (per-user keys), not plaintext                      │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 4. PRIVATE CONSUMPTION                                                        │
│                                                                              │
│  Reputation: Noir proof "score ≥ T" via Poseidon Merkle inclusion +          │
│              address control + nullifier  (reveals nothing else)             │
│  Governance: anonymous, reputation-weighted, coercion-resistant ballots      │
│              (Semaphore/MACI), votes threshold-encrypted, only the TALLY      │
│              is threshold-decrypted                                           │
│  Scores:     each user can decrypt only their own score                       │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Layer 1 — Encrypted attestations

**Goal:** the public chain, indexer, IPFS, and browser never see a plaintext edge.

- Define a new EAS schema whose sensitive fields are **ciphertext** encrypted to the committee's threshold public key (from DKG). At minimum encrypt `confidence`; ideally encrypt the recipient too (see §7 on the anonymity limit).
- The attester attaches a **Noir validity proof**: the ciphertext is well-formed, `weight ∈ [0,100]`, the attester is eligible, and the recipient is a member of the recipient set. An on-chain verifier (extend `OffchainAttestationVerifier` / a resolver in `src/contracts/eas/resolvers/`) admits only valid attestations.
- Reuse EAS **private data / offchain attestation** mechanisms so the on-chain footprint is a commitment, not the data.

This single layer closes the worst leak (S1 social graph, S2 retaliation) regardless of how computation is done downstream.

### 6.2 Layer 2 — Confidential compute domain

**Goal:** confine plaintext to one minimal, rotating, quorum-gated domain.

- A **commonware threshold committee** is established by DKG over the operator set; the private key is never reconstructed at one place. Decryption of the edge set requires a **quorum**, so no single operator can read the graph unilaterally.
- The committee threshold-decrypts the edge set **into the compute step**:
  - **Baseline (recommended first):** the operator runs `packages/pagerank` **inside a TEE enclave** (SGX/TDX/Nitro). Inputs are decrypted only inside the enclave; the enclave emits scores + a remote-attestation quote the aggregator verifies. Use **heterogeneous enclaves across operators** and keep the quorum for integrity, so one vendor break ≠ total break.
  - **Pure-crypto alternative:** threshold-decrypt to **one quorum-authorized "computing operator"** that is trusted-for-confidentiality only (1-of-1 confidentiality), with integrity still enforced by the quorum + commitment + (optionally) a zkVM proof. This avoids hardware trust entirely at the cost of a single-operator confidentiality assumption per epoch — mitigated by rotating the role via `commonware-reshare`.
- The computation itself is **unchanged** — this is the point. `packages/pagerank` runs as-is; we changed *who can see its inputs*, not the algorithm.

### 6.3 Layer 3 — Verifiable commitment

**Goal:** privacy without losing integrity.

- Keep `MerkleSnapshot.sol` and the keccak root for on-chain compatibility.
- Additionally emit a **Poseidon** Merkle tree of `{account, score}` from `components/trust-graph` — keccak is expensive in ZK circuits, Poseidon is the ZK-friendly substrate Layer 4 needs.
- Integrity proof, in increasing order of strength:
  1. **Operator quorum BFT-attestation** of the root (commonware Threshold Simplex) — cheap, available now.
  2. **zkVM proof** (RISC Zero / SP1): `packages/pagerank` ports near-drop-in into a zkVM guest, producing a succinct proof that `root == PageRank(committed encrypted edges)`. This makes scores *trustless* (Model C) and composes with either compute baseline.
- **Encrypt the IPFS dump.** Replace the plaintext `{account, score}` upload (`trust-graph/src/lib.rs`) with per-user-encrypted entries so each user can read only their own score. Stop logging edges and seeds.

### 6.4 Layer 4 — Private consumption

**Goal:** use reputation without revealing it.

- **Private reputation proofs.** A Noir circuit proves Merkle inclusion in the Poseidon tree + `score ≥ threshold` + control of the address, with public inputs `{root, threshold, nullifierHash}`. The verifier checks `root` against `MerkleSnapshot` state (historical snapshots map cleanly to "score as of proposal block"). Nothing about identity or exact score leaks. "Top-quantile" reduces to publishing the cutoff score (note: this leaks the distribution's cutoff).
- **Private governance.** Replace the public `votes` mapping in `MerkleGovModule` with anonymous, reputation-weighted ballots: Semaphore over a Poseidon identity tree with **nullifiers** replacing `hasVoted` (one vote per member, unlinkable), and **bucketed weights** so the score is not revealed exactly. Ballots are **threshold-encrypted** to the committee; only the **final tally** is threshold-decrypted. For full coercion resistance, MACI with score-as-voice-credits (requires a coordinator — a known tradeoff). This is exactly the Interfold/CRISP pattern, now backed by commonware's threshold decryption.
- **Personal score access.** Each user can decrypt their own score from the encrypted IPFS entry; the public sees only the root.

---

## 7. The anonymity limit (stated honestly)

PageRank propagates rank along a node's **outgoing** edges, so the **attester identity is load-bearing** — the algorithm must know whose rank flows where. This bounds what is achievable:

- We **can** hide the *weight* of a vouch, hide edges from the *public* (encrypt to the committee), and hide *scores*.
- We **cannot** have *fully anonymous attesters* (an edge whose tail is unknown even to the compute domain) **and** a publicly verifiable PageRank, without full secret-shared MPC or FHE. A truly tailless edge is one PageRank cannot place.
- So in the baseline, the **compute domain learns the edges** (that is its job); the public, indexer, browser, and every non-quorum party do not. That is a large, real privacy gain — it just is not "nobody ever knows." Closing that last gap is Phase 4.

---

## 8. Phased roadmap

| Phase | Deliverable | Crypto | Effort | Closes |
|---|---|---|---|---|
| **0. Stop the bleeding** | Encrypt attestations (EAS private data), authenticate the indexer, stop shipping the full graph to the browser, encrypt the IPFS dump, stop logging edges/seeds | none exotic | days–weeks | S1 social graph, S2 retaliation |
| **1. Private outputs** | Poseidon score tree + Noir "score ≥ T" proofs + nullifier-based anonymous, weight-bucketed governance | ZK (Noir/Semaphore) | weeks | S3 votes, S4 score↔identity |
| **2. Committee + threshold decryption** | commonware DKG over operators; attestations encrypted to committee key; quorum-gated decryption; reshare-based rotation; threshold-decrypt only tallies/scores | threshold BLS (commonware) | weeks–months | distributes the confidentiality trust; enables Interfold-style private tallies |
| **3. Confidential compute + trustless scores** | TEE-run PageRank (heterogeneous enclaves) and/or zkVM proof of correct PageRank | TEE + zkVM | months | operator-sees-plaintext (to enclave); integrity becomes trustless |
| **4. Research spike: end-to-end private compute** | BGW-style secret-shared PageRank over commonware-math + p2p + collector; feasibility at N≈1k | MPC | research | the last gap in §7 — graph hidden from everyone |

**Phase 0 + 1 deliver most of the real-world privacy benefit** (the social graph and vote secrecy) with no exotic cryptography and no change to PageRank. They should ship first and independently.

---

## 9. Honest tradeoffs and open questions

- **Threshold trust assumption flips one property.** Today, one honest operator suffices for correctness. Adding threshold *confidentiality* means an honest *threshold* is required to keep the graph secret (a dishonest quorum could collude to decrypt). This is the standard, accepted tradeoff of threshold systems; rotation (`reshare`) and a large, diverse operator set mitigate it.
- **TEE vs. pure crypto.** TEE is fast and runs the current code unchanged, but 2026 attestation breaks (TEE.Fail) mean it must not be the sole root of trust. The pure-crypto alternative (threshold-decrypt-to-one-prover) avoids hardware trust at the cost of a per-epoch single-operator confidentiality assumption. Both are defensible; the committee + rotation makes either tolerable. Decide based on appetite for hardware trust.
- **FHE is out for the graph computation.** Confirmed impractical for iterative PageRank in 2026; the only peer-reviewed "secure PageRank that runs" chose MPC. Borrow Interfold's E3 *packaging* (encrypt → prove eligibility → threshold-decrypt result) for the additive parts (votes, tallies), not for the graph itself.
- **Full secret-shared MPC PageRank** has a transport now (commonware) but not an engine, and the performance wall (2–4 orders of magnitude, round-heavy) is real. Scope Phase 4 as "can we do N≈1k in tolerable time?" before committing.
- **ZK costs.** In-circuit keccak is expensive — the parallel Poseidon tree is the mitigation. zkVM proving has latency/cost; quantile proofs leak the cutoff.
- **Quantifying leakage.** Even with hidden edges, the *number* of attestations, timing, and the public node set leak metadata. Decide whether those need padding/batching.
- **Seed privacy.** Trusted seeds are still privileged; consider whether the seed set itself should be committed-but-hidden.

---

## 10. Recommendation

Build the baseline as **encrypted attestations → quorum-gated confidential compute → verifiable Merkle/Poseidon commitment → ZK private consumption**, using **commonware threshold cryptography** as the committee/decryption backbone and the **existing WAVS + EAS + Merkle pipeline** as the skeleton.

Sequence it so the cheap, high-impact work lands first: **Phase 0 (close the public-graph leak) and Phase 1 (private reputation proofs + private voting)** give TrustGraph genuine privacy with off-the-shelf tooling and no change to PageRank. Layer in the **commonware threshold committee (Phase 2)** to distribute confidentiality and unlock Interfold-style private tallies, then **TEE/zkVM (Phase 3)** for confidential, trustless computation. Treat **end-to-end secret-shared PageRank (Phase 4)** as a research spike that the commonware substrate now makes investigable for the first time.

---

## Appendix A — Source research

This synthesis is backed by four grounded research reports (in the working scratchpad):

- `privacy-01-threat-model.md` — full data inventory, leak severity ranking, trust boundaries
- `privacy-02-fhe-e3.md` — FHE/Interfold-E3 feasibility (and why faithful FHE PageRank is impractical)
- `privacy-03-zk.md` — ZK reputation proofs, anonymous attestations, the anonymity limit, zkVM stack
- `privacy-04-tee-mpc.md` — TEE on WAVS operators, MPC feasibility, TEE.Fail caveat

## Appendix B — Key files this design touches

- `src/contracts/eas/` — `WavsAttester`, `OffchainAttestationVerifier`, `SchemaRegistrar`, resolvers (encrypted schema + validity-proof verifier)
- `components/trust-graph/src/` — `eas_pagerank.rs`, `lib.rs` (decrypt-in-domain, Poseidon tree, encrypted IPFS)
- `packages/pagerank/` — unchanged compute core; candidate zkVM guest / TEE payload
- `src/contracts/merkle/MerkleSnapshot.sol` — root substrate, historical snapshots
- `src/contracts/zodiac/MerkleGovModule.sol` — replace public votes with anonymous, weighted, threshold-encrypted ballots
- `indexer/src/api/network.ts` + `frontend/hooks/usePageRankComputer.ts` — stop serving/recomputing the full plaintext graph
- commonware (`cryptography`/`reshare`/`consensus`/`p2p`) — DKG, threshold decryption, committee rotation, transport
</content>
</invoke>
