# Dossier: Pinning Off-chain Input Sets for ZK Proofs — Input Completeness & Censorship Resistance

**Status:** Source dossier (substrate for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md); see [`/GOAL.md`](../../GOAL.md)).

> Source research for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md). Compiled 2026-07-10. All prices/gas figures are point-in-time and volatile; sources noted inline. Synthesis is marked "Analysis."

---

## 0. Framing: two different guarantees, don't conflate them

Everything below sorts into two distinct properties:

- **Inclusion pin** — "this data existed and was committed by time T." Timestamps, per-user anchors, blob KZG commitments all give this.
- **Completeness commitment** — "this is *all* the data in the eligible set; the prover cannot omit any of it." The current chained-keccak EAS resolver gives this for free because every write appends to one accumulator. Almost nothing off-chain gives this natively; you must construct it as *"the input set is exactly the finite set of anchored heads in registry R as of block N, and each anchored head is itself a complete commitment to that identity's edges."*

That decomposition — a **global completeness commitment over per-identity completeness commitments** — is the load-bearing move in every workable design below. AT Protocol repos are unusually good per-identity commitments: a repo commit is a signature over a single MST root CID covering the *entire* repo, with a monotonic `rev` and a `prevData` link to the previous root ([atproto.com/specs/repository](https://atproto.com/specs/repository)). Anchoring one 32-byte value pins a user's whole attestation set; the remaining problem is only the global set of heads.

---

## 1. The anchoring pattern

### Mechanics and gas

Minimal anchor = one storage write or one event carrying a 32-byte head (AT proto commit CID / MST root, or a merkle root of the user's signed attestations):

- **SSTORE to a fresh slot:** 22,100 gas; rewriting the same slot per epoch: 5,000 gas (warm, non-zero→non-zero) — per-epoch re-anchoring is cheap after the first write.
- **Event-only anchor (LOG1, 32-byte data):** ~1,400 gas plus 21,000 base tx. Events can't be read by contracts, but the prover/indexer reads them fine; if the guest needs the anchor set, commit it via an in-contract accumulator instead (see §7).
- **At 2026 fee levels this is near-free.** Mainnet averages have been well under 1 gwei through H1 2026 (0.05–0.5 gwei readings; simple transfers ~$0.01–0.25) — [CoinLaw gas stats](https://coinlaw.io/ethereum-gas-fees-statistics/), [Etherscan gas tracker](https://etherscan.io/gastracker). L2 transactions run $0.001–$0.05 ([l2fees.info](https://l2fees.info/)). A ~45k-gas anchor tx is sub-cent on an L2 and low single-digit cents on mainnet. **Uncertainty:** mainnet basefee is spiky; budget for 10–50× excursions.

**Batch anchoring via merkle roots:** the canonical prior art is **Ceramic's Anchor Service (CAS)** — nodes submit stream-commit anchor requests, the service builds one merkle tree over the batch and lands a single root in one Ethereum tx; each stream inherits the anchor via a merkle path ([CIP-69 Batched Anchor Data Structure](https://cips.ceramic.network/CIPs/cip-69), [CIP-110 Anchor Contract](https://cips.ceramic.network/CIPs/cip-110), [ceramic-anchor-service](https://github.com/ceramicnetwork/ceramic-anchor-service)). Amortized cost per user → dust. EAS does the same for off-chain attestation UIDs (§4). Ceramic's issue tracker also documents a real gotcha: from the on-chain root alone you *cannot enumerate* what was anchored ([js-ceramic #1967](https://github.com/ceramicnetwork/js-ceramic/issues/1967)) — batch anchors need an off-chain availability story for the tree itself, or the anchor is an inclusion pin you can't turn into a completeness commitment. If you batch, emit/publish the full leaf list (calldata, blob, or DA layer) alongside the root.

### Sponsorship

- **ERC-4337 paymasters:** app-sponsored anchors, ~20–60% gas overhead over an EOA tx due to EntryPoint validation ([eco.com gas sponsorship 2026](https://eco.com/support/en/articles/15254045-gas-sponsorship-2026-how-apps-sponsor-user-fees), [Openfort technical dive](https://www.openfort.io/blog/technical-dive-gas-sponsorship)). Overhead is fine given the base cost is tiny.
- **EIP-7702** (live since Pectra, May 2025): an EOA delegates to contract code for a tx; a sponsor pays gas while the user's key still authorizes the anchor. Lighter than 4337 for "existing EOA occasionally anchors 32 bytes" ([thirdweb AA 2026 guide](https://blog.thirdweb.com/account-abstraction-in-2026-how-eip-7702-and-erc-4337-are-transforming-ethereum-wallets-for-developers/)).

### Who anchors — Analysis

| Anchorer | Trust assumption | Failure mode |
|---|---|---|
| **User (self-anchor)** | None beyond L1 liveness | User apathy → sparse graph; needs sponsorship UX |
| **PDS** | PDS includes all its users honestly | PDS omits a user (censorship) or anchors a stale head |
| **Relayer/aggregator** | Relayer honest-or-bonded | Same as PDS, plus one central chokepoint |

The clean composition: **default = PDS/relayer batch-anchors (cheap, no user UX), escape hatch = user can always self-anchor directly, and the registry rule is "latest-`rev` head per DID wins regardless of who posted it."** Because AT proto heads are *user-signed* (by the account's signing key), an anchorer can only censor (omit) or delay — it can never forge a head. That reduces the aggregator to a courier, and self-anchoring is a complete censorship escape (see §3). Anchor freshness matters: require the anchored commit's `rev`/signature to verify inside the guest, and take the max-`rev` valid head if a user is anchored twice in an epoch. Equivocation (user signs two competing heads) is resolved by the anchor itself: the on-chain registry picks one canonical head per epoch — this is genuinely a feature; the chain is your fork-choice for user repos.

---

## 2. Data-availability layers as attestation carriers

### EIP-4844 blobs

- Capacity post-Fusaka (Dec 2025): BPO forks raised blob target/max to 14/21 as of BPO2 (Jan 7, 2026), roadmap toward 48/block mid-2026 ([ethereum.org Fusaka](https://ethereum.org/roadmap/fusaka/), [EIP-7892 explainer](https://dev.to/codebyankita/eip-7892-the-upgrade-that-makes-ethereums-blob-scaling-actually-scalable-49hf)).
- Cost: blob basefee has historically sat at ~1 wei outside spikes; total cost is dominated by the type-3 tx's execution gas — roughly **$0.10–3.00 per 128 KB blob** ([ethresear.ch minimum blob base fees](https://ethresear.ch/t/understanding-minimum-blob-base-fees/20489), [Gate Learn summary](https://www.gate.com/learn/articles/understanding-minimum-blob-base-fees/4351)). EIP-7918 (in Fusaka) puts a reserve price under blob fees, so expect the ~1-wei era to end as throughput grows ([EIP-7918](https://eips.ethereum.org/EIPS/eip-7918)). One secondary source pegs effective blob DA at ~$20.56/MB vs Celestia $0.81/MB ([BlockEden, Jan 2026](https://blockeden.xyz/blog/2026/01/16/celestia-blob-economics-data-availability-rollup-costs/)) — **treat as order-of-magnitude only**; it's fee-regime dependent.
- **Retention:** consensus nodes prune blobs after 4096 epochs ≈ **18 days** ([EIP-4844 retention analysis](https://chainscorelabs.com/blog/the-ethereum-roadmap-merge-surge-verge/proto-danksharding/blob-retention-rules-introduced-by-eip-4844)). The KZG commitment (versioned hash) persists forever in headers/history; the data does not.

**What 18-day expiry means for reproving — Analysis.** A blob gives a *permanent binding commitment* and a *temporary availability guarantee*. If the guest proves "these edges hash to versioned-hash H" (via KZG opening or a proof of equivalence between the KZG commitment and the guest's own commitment — the standard trick rollups use), the *soundness* of any proof generated later never degrades: nobody can substitute different data under H. What degrades is **liveness**: if all copies of the blob vanish after 18 days and you need to *re*-prove from genesis edges, you can't. Consequences:

1. Prove each epoch *within* the retention window and make proofs **incremental** (fold previous epoch's proven state + new blob data), so old blobs are never needed again.
2. Keep an archival mirror (indexer, IPFS, or paid archives). This reintroduces a *weak* withholding surface — but only against re-proving history, never against forging it, and *anyone* who watched the gossip can keep a copy. This is the same posture every rollup already takes ([Consensys Dencun part 5](https://consensys.io/blog/ethereum-evolved-dencun-upgrade-part-5-eip-4844)).

### Celestia + Blobstream

- **SP1 Blobstream** (built on the same SP1 stack TrustGraph already uses) posts ZK-proven Celestia header commitments to Ethereum; live on Mainnet, Arbitrum One, Base; ~280k gas per header-range update, amortized across all users of the bridge ([succinctlabs/sp1-blobstream](https://github.com/succinctlabs/sp1-blobstream), [Succinct blog](https://blog.succinct.xyz/celestia-sp1/), [Celestia docs](https://docs.celestia.org/how-to-guides/blobstream)).
- Cost ~$0.81/MB (same caveat as above). L2BEAT tracks the trust profile ([l2beat.com/data-availability/projects/celestia/blobstream](https://l2beat.com/data-availability/projects/celestia/blobstream)).
- **The underrated feature for this exact problem: namespace completeness proofs.** Celestia's Namespaced Merkle Tree supports proofs that a given set of shares is *all* the data in a namespace for a block (and absence proofs). So the design "all attestation batches are posted to namespace X; guest verifies, against the Blobstream-committed data root, a *complete* namespace proof for every block in the epoch range" gives **DA-level completeness**: the prover provably cannot omit any attestation that made it into the namespace. This is stronger than Ethereum blobs, where nothing ties "all relevant blobs" together — you'd need your own on-chain index of blob hashes. **Uncertainty:** verifying NMT completeness proofs for a whole epoch inside an SP1 guest is real cycle cost; benchmark before committing.
- Residual censorship moves to Celestia validators (who could refuse to include a PayForBlobs tx) — mitigated by Celestia's own CR properties, but it's a new trust layer to document.

### EigenDA

10× price cut announced; ~$730/yr for 100 MB/day (≈ $0.02/MB) and a free tier (1.28 KiB/s, 12 months) ([EigenDA pricing post](https://blog.eigencloud.xyz/eigenda-updated-pricing/), [docs](https://docs.eigencloud.xyz/eigenda/core-concepts/overview)). DA certificates are aggregated BLS attestations verified by a Verifier contract on Ethereum. Cheapest option, but availability rests on EigenLayer operator honesty (cryptoeconomic, not sampling-based), and no namespace-completeness analogue was found — you'd still need your own index of certificates. For an attestation graph whose raw data is a few MB/epoch, **cost is not the bottleneck; completeness semantics are** — which favors blobs-with-onchain-index or Celestia namespaces over EigenDA.

---

## 3. Censorship/omission analysis of "graph = all anchored heads at block N"

The rule "input set = every head anchored in registry R as of block N" converts omission-by-prover into omission-at-anchor-time. Who can prevent an anchor from landing?

**(a) Self-anchoring.** Censoring a user = censoring their L1 transaction. That's Ethereum-grade CR: today it means "some builder eventually includes you" (weak-but-real; OFAC-filtering builders exist), and it strengthens further when FOCIL (EIP-7805, fork-choice inclusion lists) ships — note FOCIL was **bumped from Glamsterdam to Hegotá**; Glamsterdam (H2 2026 target) headlines ePBS + BALs instead ([ethdaily](https://ethdaily.io/841), [ethereum.org/roadmap/glamsterdam](https://ethereum.org/roadmap/glamsterdam/), [EF Checkpoint #9](https://blog.ethereum.org/2026/04/10/checkpoint-9)). Self-anchoring is the gold standard; its weakness is participation cost/UX, not censorship.

**(b) Aggregator-anchored with force-inclusion escape hatch.** Direct port of rollup CR machinery: Arbitrum's delayed inbox lets anyone submit on L1 and call `forceInclude` after 24h if the sequencer ignores it ([Arbitrum tx lifecycle](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/transaction-lifecycle)); OP Stack's `OptimismPortal` deposits play the same role with a ~12h sequencing-window guarantee ([Gate Learn on forced inclusion](https://www.gate.com/learn/articles/how-do-censorship-resistant-transactions-work-in-ethereum-rollups/3211)). As of April 2026 every major L2 still runs a centralized sequencer and leans entirely on these hatches ([L2BEAT/sekuba, Apr 2026](https://medium.com/l2beat/decentralised-sequencing-4441edf5852a)); known practical limits: delay windows, gas-spike griefing, and hatch UX ([Gate Learn, limitations](https://www.gate.com/learn/articles/practical-limitations-on-forced-inclusion-mechanisms-for-censorship-resistance/4246)). **Translation to TrustGraph:** the aggregator posts batch roots; the registry contract *also* accepts direct per-user anchors (this *is* the force-inclusion queue — simpler than rollups because anchors are unordered set-inserts, no sequencing semantics, so you don't even need a delay: direct anchors are just always valid). The design collapses to (a)-with-cheap-default.
- **Based sequencing** (Taiko: L1 validators sequence, currently via three whitelisted preconf operators — Nethermind, Chainbound, Gattaca — [taiko.xyz](https://taiko.xyz/)) and **shared sequencers** (Espresso mainnet launched Feb 2026, ~6s finality, integrations across Arbitrum/Polygon orbits — [Blockworks](https://blockworks.co/news/espresso-shared-sequencers-funding-a16z)) are answers to *ordering* censorship. Anchors are order-independent, so this machinery is overkill; cite it as prior art for why order-independence makes the problem strictly easier.

**(c) Keeper/oracle-anchored.** A keeper scrapes PDSes/relays and anchors heads. Worst CR class: the keeper is a single omission point, omission is *not attributable* (was the head withheld or censored?), and a fraud exit can't prove a negative ("keeper saw head X and skipped it" is generally unprovable — same epistemic wall as §5). Only acceptable with (b)'s direct-anchor fallback, at which point the keeper is just a convenience relayer.

**Analysis — residual omission vector even in (a):** the *proof submitter* chooses block N. If anchoring is spread over time, a malicious prover picks the epoch boundary to exclude late anchors. Fix: epoch boundaries fixed by the contract (e.g., every 50,400 blocks), not chosen by the prover, and the guest proves against registry state exactly at the boundary. Second vector: **griefing by junk anchors** (bloat the set to blow up proving cost). Fix: registry gated by the identity set (§6) plus per-DID one-head-per-epoch semantics; per-head cost to the prover is then bounded by registry size.

---

## 4. Timestamping services

- **EAS timestamping:** the EAS contract's `timestamp(bytes32)` / `multiTimestamp` record `block.timestamp` against arbitrary 32-byte values; the SDK merkle-batches many off-chain attestation UIDs into one root so one bytes32 write timestamps unbounded data ([EAS timestamping tutorial](https://github.com/ethereum-attestation-service/eas-docs-site/blob/main/docs/tutorials/timestamping-attestations.md), [off-chain attestations doc](https://github.com/ethereum-attestation-service/eas-docs-site/blob/main/docs/easscan/offchain.md)). Gas ≈ one SSTORE + base tx (~43k). Since TrustGraph is already an EAS shop, this is the lowest-friction anchor primitive: anchor = `timestamp(atprotoCommitCid)` — you inherit EAS's deployed contracts and indexer tooling on every chain you care about.
- **OpenTimestamps:** calendar servers aggregate hashes into a merkle tree and commit the root to Bitcoin; free, but confirmation latency is hours and verification requires the `.ots` proof path ([opentimestamps.org](https://opentimestamps.org/) — from prior knowledge; site not re-fetched, low risk of drift).

**Analysis — the sharp edge:** timestamps are **inclusion pins, not completeness commitments**. A timestamp proves "this batch existed by T"; it does not prevent a prover from ignoring a timestamped batch, and nothing enumerates "all batches." To get completeness from timestamps you must add an on-chain enumerable index (registry mapping, event log defined as canonical, or an accumulator over timestamp calls — i.e., §7). Where timestamps *do* pull real weight: **ordering and freshness** — proving an attestation predates epoch N's boundary, and preventing back-dating of edges (an edge only counts for epoch N if its containing head/batch was pinned before N's boundary). That kills retroactive graph manipulation ("mint 1,000 old-looking edges right before the epoch closes").

---

## 5. Liveness and data withholding

**The impossibility:** you cannot cryptographically prove non-availability to a third party (the "fisherman's dilemma" — an unavailability claim is unverifiable because the accused can release the data the moment a challenge appears; see [Celestia's data-withholding glossary](https://celestia.org/glossary/data-withholding-attack/) and Al-Bassam/Sonnino/Buterin, *Fraud and Data Availability Proofs*, arXiv:1809.09044 — the latter cited from prior knowledge). So "skip-with-proof-of-unavailability" is out; handling is economic/protocol-level. Prior art:

- **Validiums/StarkEx:** withheld data ⇒ users can't build merkle proofs ⇒ funds frozen, not stolen. Mitigations: a Data Availability Committee must sign every state update attesting it *holds* the data (custody attestation before the state root is accepted), plus a freeze-and-escape regime — if withholding is detected the system freezes and users exit against the last state whose data they hold; post-grace-period recovery logic can move frozen assets ([Gluchowski, zkRollup vs Validium](https://medium.com/matter-labs/zkrollup-vs-validium-starkex-5614e38bc263), [ethereum.org validium](https://ethereum.org/developers/docs/scaling/validium/)).
- **Plasma:** exit games — users always exit with the last data they personally possess; mass-exit is the degradation mode ([ethereum.org plasma](https://ethereum.org/developers/docs/scaling/plasma/)).
- **zkSync-family pubdata discussions:** state-diff publication to L1 is precisely what lets anyone reconstruct state — validium modes give this up and accept the freeze risk ([ZKsync pubdata docs](https://docs.zksync.io/zksync-protocol/era-vm/contracts/handling-pubdata)).

**Analysis — mapping to TrustGraph.** Key structural difference: in a validium, withholding freezes *everyone*; here a user who anchors head H and withholds the repo data blocks only *the global proof* — unless the protocol pre-commits to a degradation rule. The essential fix is to make withholding **locally punishable, globally harmless**:

1. **Carry-forward:** if the data behind DID d's anchored head is unavailable at proving time, the prover uses d's **last proven state** (the edge set from d's most recent head whose data was available). Crucially the rule must be *deterministic and provable*: the guest proves "for d I used head from epoch k < N, and here is d's anchor history showing which head I used." The part that can't be proven — "epoch N's data was actually unavailable" — is exactly the fisherman gap, so the rule must be *incentive-shaped*, not truth-shaped: using an older head can only be done with the anchor record visible on-chain, so a prover who maliciously "carries forward" an available head is publicly detectable by anyone holding the data, even if not slashable in-protocol. Consider allowing a *challenge*: anyone can submit the missing data on-chain/to DA within a window, forcing a re-prove that includes it.
2. **Exclusion after k epochs:** heads stale for k consecutive epochs drop out of the graph (edges *from* d stop counting; edges *to* d from live users still can). Bounds how long a withholder can freeload on old reputation, and mirrors validator inactivity-leak logic.
3. **Availability-before-anchor (DAC-style):** strongest option — an anchor is only *valid* if accompanied by proof the data was published (blob versioned hash in the same tx, Celestia namespace inclusion via Blobstream, or a bonded PDS's custody signature). This is the StarkEx move: convert "anchored but withheld" from a proving-time crisis into an anchor-time invalidity. **Recommended default**: anchor = (head CID, pointer/commitment to published data), and the guest refuses heads without a verifiable data commitment. Withholding then can't happen for *validly anchored* heads at all — the residual risk is only archival (post-18-day blob expiry), handled by incremental proving (§2).
4. Whatever you pick, the degradation rule must be **inside the proven statement** ("root == PageRank(E) where E is derived from the registry by rule Φ, including carry-forward/exclusion decisions"), or the prover regains discretion and you've reopened the omission hole.

---

## 6. Set-membership registries (defining the graph domain)

Prior art for "on-chain set of identities + per-identity epoch data":

- **Semaphore v4:** on-chain group = LeanIMT (Poseidon incremental merkle tree) of identity commitments; contracts expose group roots for proof verification ([docs.semaphore.pse.dev](https://docs.semaphore.pse.dev/), [contracts](https://docs.semaphore.pse.dev/technical-reference/contracts)). The relevant pattern: **the contract maintains the tree incrementally, so the current root is a completeness commitment to the whole membership set** — a ZK guest takes one root as public input and the prover can't omit members. Directly reusable for a DID registry.
- **Proof of Humanity / proof-of-personhood registries:** curated on-chain human registries with challenge periods; used as Semaphore group feeders ([semaphore docs on PoH integration](https://docs.semaphore.pse.dev/)). Relevant for sybil-gating who may join the graph domain.
- **Beacon-chain validator registry:** deposit contract maintains an incremental merkle root of all deposits; activation/exit *queues* rate-limit set churn. The queue idea is worth stealing: rate-limited joins bound epoch-over-epoch proving-cost growth and blunt sybil-flooding.
- **ERC-8004 identity/agent registries** are a natural fit for "who is in the graph": agentId-indexed on-chain identity records; the TrustGraph registry could key anchors by ERC-8004 agentId instead of raw addresses.

**Analysis:** registry + per-epoch head anchor is the right factorization: registry churn is slow (append-mostly, incremental-merkle-friendly), head churn is fast (one bytes32/DID/epoch). Define the proven input domain as *registry root at block N* × *anchor map at block N*, both maintained on-chain as accumulator/tree so both are single public inputs.

---

## 7. Hybrid two-lane designs (mixed-provenance inputs)

Rollups are exactly this pattern, in production for years — an L1-native lane and an operator-supplied lane bound into one proof:

- **zkSync Era:** L1→L2 priority operations enter an on-chain **priority queue**; each committed batch carries `priorityOperationsHash` (rolling keccak chain, same shape as the EAS accumulator). At `executeBatches` the contract pops the queue and requires the rolling hash to match; that hash sits inside `StoredBlockInfo`/the batch commitment that is the circuit's public input — so the proof is only accepted if it consumed *exactly* the L1-lane inputs, while L2 txs are bound via the pubdata commitment in the same public-input struct ([ZKsync L1→L2 ops docs](https://docs.zksync.io/zksync-protocol/contracts/handling-l1-l2-ops), [code4rena zkSync docs mirror](https://github.com/code-423n4/2023-10-zksync/blob/main/docs/Smart%20contract%20Section/Handling%20L1%E2%86%92L2%20ops%20on%20zkSync.md)).
- **OP Stack:** derivation pipeline mandates deposits (from L1 `OptimismPortal` events) be included at the start of each L1-origin's first L2 block; batch data supplies the rest. Binding is via the derivation rules that fault/validity proofs check.
- The general recipe: **each lane gets its own commitment; the verifier contract independently knows/recomputes the on-chain lane's commitment; both are fields of one public-input struct; the proof is rejected unless both match.** Neither lane can be dropped or padded.

**Analysis — concrete TrustGraph shape.** Lane 1 already exists. Add lane 2 symmetrically:

```
PublicInput {
  onchainAccumulator,   // existing chained keccak from EAS resolver (contract recomputes)
  anchorSetCommitment,  // registry contract's own accumulator/IMT root over
                        //   (did, headCid, dataCommitment, epoch) at fixed block N
  prevStateRoot,        // for incremental folding / carry-forward
  scoresRoot            // output
}
```

The registry contract maintains `anchorSetCommitment` itself (chained keccak on each anchor call — literally reusing the resolver pattern — or a LeanIMT). Then *both* lanes are contract-attested, the prover supplies only witnesses, and completeness of the off-chain lane reduces to §1/§3 anchor-time censorship analysis plus §5 withholding rules. The guest folds: verify each anchored head's signature and `rev` monotonicity, verify each head's data against its `dataCommitment` (blob equivalence proof / Celestia namespace proof / raw merkle root), extract edges, apply rule Φ (carry-forward/exclusion), run PageRank, emit `scoresRoot`.

---

## Bottom line / recommendation sketch (Analysis)

1. **Registry + per-DID head anchoring with an on-chain accumulator over anchors** is the sound core: it reproduces the current accumulator's completeness guarantee one level up, at ~5–22k gas per user-epoch (pennies), batchable via Ceramic-style merkle anchors with a mandatory published leaf list.
2. **Anyone may anchor any user's signed head; latest valid `rev` wins.** Aggregator/PDS anchoring is the cheap default; permissionless direct anchoring *is* the force-inclusion hatch — no delay machinery needed because anchors are unordered.
3. **Make anchors carry a data commitment and treat data publication as an anchor-validity condition** (blobs for cheap Ethereum-native publication; Celestia namespace + SP1 Blobstream for DA-level completeness proofs in the same SP1 ecosystem). Prove incrementally within the 18-day blob window so expiry only ever threatens archival replay, never soundness.
4. **Encode the degradation rule (carry-forward, k-epoch exclusion) inside the proven statement.** Unprovable unavailability is unavoidable; unaccountable prover discretion is not.

Main open risks: proving-cost growth with registry size (griefing via junk identities — gate via ERC-8004/PoP and rate-limited joins); Celestia NMT-completeness verification cost inside SP1 (needs benchmarking); blob fee-regime change post-EIP-7918; and all per-MB DA prices above being volatile secondary-source snapshots.

Sources: [ethereum.org/roadmap/fusaka](https://ethereum.org/roadmap/fusaka/) · [EIP-7918](https://eips.ethereum.org/EIPS/eip-7918) · [ethresear.ch min blob fees](https://ethresear.ch/t/understanding-minimum-blob-base-fees/20489) · [Chainscore blob retention](https://chainscorelabs.com/blog/the-ethereum-roadmap-merge-surge-verge/proto-danksharding/blob-retention-rules-introduced-by-eip-4844) · [Consensys Dencun pt5](https://consensys.io/blog/ethereum-evolved-dencun-upgrade-part-5-eip-4844) · [sp1-blobstream](https://github.com/succinctlabs/sp1-blobstream) · [Succinct blog](https://blog.succinct.xyz/celestia-sp1/) · [Celestia Blobstream docs](https://docs.celestia.org/how-to-guides/blobstream) · [L2BEAT Celestia](https://l2beat.com/data-availability/projects/celestia/blobstream) · [BlockEden DA economics](https://blockeden.xyz/blog/2026/01/16/celestia-blob-economics-data-availability-rollup-costs/) · [EigenDA pricing](https://blog.eigencloud.xyz/eigenda-updated-pricing/) · [EigenDA docs](https://docs.eigencloud.xyz/eigenda/core-concepts/overview) · [EAS timestamping](https://github.com/ethereum-attestation-service/eas-docs-site/blob/main/docs/tutorials/timestamping-attestations.md) · [EAS offchain](https://github.com/ethereum-attestation-service/eas-docs-site/blob/main/docs/easscan/offchain.md) · [Arbitrum tx lifecycle](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/transaction-lifecycle) · [Gate Learn forced inclusion](https://www.gate.com/learn/articles/how-do-censorship-resistant-transactions-work-in-ethereum-rollups/3211) · [Gate Learn FI limitations](https://www.gate.com/learn/articles/practical-limitations-on-forced-inclusion-mechanisms-for-censorship-resistance/4246) · [L2BEAT decentralised sequencing](https://medium.com/l2beat/decentralised-sequencing-4441edf5852a) · [taiko.xyz](https://taiko.xyz/) · [Blockworks Espresso](https://blockworks.co/news/espresso-shared-sequencers-funding-a16z) · [ethdaily FOCIL](https://ethdaily.io/841) · [ethereum.org Glamsterdam](https://ethereum.org/roadmap/glamsterdam/) · [EF Checkpoint #9](https://blog.ethereum.org/2026/04/10/checkpoint-9) · [Celestia data-withholding glossary](https://celestia.org/glossary/data-withholding-attack/) · [Gluchowski zkRollup vs Validium](https://medium.com/matter-labs/zkrollup-vs-validium-starkex-5614e38bc263) · [ethereum.org validium](https://ethereum.org/developers/docs/scaling/validium/) · [ethereum.org plasma](https://ethereum.org/developers/docs/scaling/plasma/) · [ZKsync L1→L2 ops](https://docs.zksync.io/zksync-protocol/contracts/handling-l1-l2-ops) · [ZKsync pubdata](https://docs.zksync.io/zksync-protocol/era-vm/contracts/handling-pubdata) · [Ceramic CIP-69](https://cips.ceramic.network/CIPs/cip-69) · [Ceramic CIP-110](https://cips.ceramic.network/CIPs/cip-110) · [ceramic-anchor-service](https://github.com/ceramicnetwork/ceramic-anchor-service) · [js-ceramic #1967](https://github.com/ceramicnetwork/js-ceramic/issues/1967) · [Semaphore docs](https://docs.semaphore.pse.dev/) · [Semaphore contracts](https://docs.semaphore.pse.dev/technical-reference/contracts) · [atproto repository spec](https://atproto.com/specs/repository) · [eco.com gas sponsorship](https://eco.com/support/en/articles/15254045-gas-sponsorship-2026-how-apps-sponsor-user-fees) · [thirdweb AA 2026](https://blog.thirdweb.com/account-abstraction-in-2026-how-eip-7702-and-erc-4337-are-transforming-ethereum-wallets-for-developers/) · [CoinLaw gas stats](https://coinlaw.io/ethereum-gas-fees-statistics/) · [l2fees.info](https://l2fees.info/)
