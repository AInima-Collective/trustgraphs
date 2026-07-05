# TrustGraph Root Producers — Tradeoffs & Which To Pick

**What this is.** TrustGraph's `{account → score}` merkle root has to be produced by *something* off-chain (PageRank doesn't run in the EVM) and committed on-chain through `MerkleSnapshot`. This doc compares the three producers side-by-side so you can pick without reading both full specs. The two replacement designs are:

- **[`ZK_ARCHITECTURE.md`](./ZK_ARCHITECTURE.md)** — a SNARK of correct PageRank gates the write.
- **[`OPTIMISTIC_ARCHITECTURE.md`](./OPTIMISTIC_ARCHITECTURE.md)** — a bond surviving a challenge window gates the write.

…and the incumbent:

- **WAVS** — a staked operator quorum signs the root (what ships today; see `CLAUDE.md`).

**The one thing to internalize first:** all three feed the *same* `_updateStateAtBlock` writer and reuse *every* existing consumer (governance, distributor, frontend) with zero client changes. Both replacements also share **Contract A (`AttestationAccumulator`)** and the **journal tuple** verbatim — the input commitment is producer-agnostic. **You build the accumulator regardless of which you pick**, which is what makes migrating between them cheap rather than a rewrite.

---

## The decision in one breath

- **Privacy on the roadmap?** → **ZK.** Optimism *cannot* extend to encrypted inputs (watchers have nothing to recompute), so private TrustGraph forces ZK. This dominates every other axis.
- **Public forever, latency-tolerant, want to ship cheap?** → **Optimistic** (council adjudicator), keeping the `IAdjudicator`→`IZkVerifier` upgrade seam.
- **Need instant finality with no live-watcher assumption, and can pay for proving?** → **ZK.**
- **Already shipped, no capacity to change the trust model right now?** → **WAVS**, but know its trust is invoked *every snapshot*, not just on dispute.

---

## Side-by-side matrix

| Axis | **WAVS** (today) | **Optimistic** (bond + window) | **ZK** (SNARK) |
|---|---|---|---|
| **Core guarantee** | "An honest operator quorum computed this." | "A bond survived a window with no honest challenger disputing." | "A SNARK proves `root == PageRank(pinned inputs, params)`." |
| **When trust is invoked** | **Every snapshot** | **Only on dispute** (rare) | **Never** (beyond governance-set guest+params) |
| **Finality** | Fast (quorum sign) | **Delayed** by `challengeWindow` (~24–72h) + any dispute | **Instant** (verify-and-write) |
| **Liveness assumption** | Honest operator quorum online | ≥1 honest, funded, un-censored **watcher** per window | A prover exists (permissionless, no honesty needed) |
| **Bonded capital** | Operator stake | Proposer + challenger bonds | None |
| **On-chain cost / write** | Signature validate | Struct write + timer + refund (cheap) | ~250–300k gas Groth16 verify |
| **Off-chain cost** | Operators run PageRank | Proposer runs PageRank (+ watchers recompute) | Prover runs PageRank **in zkVM** (proving) |
| **Build cost** | Shipped | **Low** (council adjudicator) → High (ZK adjudicator) | **High** (zkVM guest + verifier) |
| **Privacy-ready?** | No | **No — hard blocker** | **Yes — the reason to build it** |
| **Fixed-point port needed?** | No (runs `f64` today) | Recommended; **mandatory** if ZK adjudicator adopted | **Yes — the headline work item** |
| **Trust concession, stated plainly** | Always-on operator honesty | Honest-council-**on-dispute** (bootstrap); a live watcher must exist | Governance honestly set guest + params |
| **Worst-case failure** | Quorum colludes → bad root, always | No watcher challenges in time → bad root finalizes | Guest/params bug reaches prod (timelock is last defense) |

---

## What's shared vs. what differs

**Shared by both replacements (build once):**
- Contract A — `AttestationAccumulator` (chained running hash in the resolver, checkpointing on `trigger()`)
- The journal tuple: `(acc, leafCount, paramsHash, outputRoot, ipfsHash, keccak256(cid), totalValue)`
- `_updateState` → `_updateStateAtBlock(blockNumber, …)` refactor (file at the checkpoint **freeze block**, not submit/finalize block)
- Removal of WAVS at the seam (`IWavsServiceHandler`, `_serviceManager`, `handleSignedEnvelope`)
- The fixed-point guest + `usePageRankComputer.ts` reconciliation
- The one-accumulator-per-checkpoint invariant; last-write-wins tie-break by total order `(timestamp, fold index)`

**The only real divergence — the write gate:**

```
WAVS:        root ──▶ _serviceManager.validate(sigs) ──────────────▶ write
OPTIMISTIC:  root ──▶ propose+bond ─▶ [challenge window] ─▶ finalize ▶ write   (dispute → IAdjudicator)
ZK:          root ──▶ zkVerifier.verify(proof, journal) ───────────▶ write
```

Because the divergence is one interface, **optimistic → ZK is an `IAdjudicator`→`IZkVerifier` swap plus the guest**, not a rewrite. That's the migration path, not a fork.

---

## Decision tree

```
Is privacy (encrypted attestations) on the roadmap — ever?
│
├─ YES ──────────────────────────────────────────────▶ ZK
│         (optimism can't recompute encrypted inputs; this dominates)
│
└─ NO → Public inputs forever.
        │
        Can you tolerate ~24–72h finality + running a live honest watcher?
        │
        ├─ NO (need instant finality / no watcher) ───▶ ZK
        │
        └─ YES →
                Is "honest council settles disputes" acceptable at launch?
                │
                ├─ YES ──────────────────────────────▶ OPTIMISTIC (council adjudicator)
                │         keep IAdjudicator→IZkVerifier seam open
                │
                └─ NO (want fully trustless now) →
                        The trustless optimistic adjudicator IS the ZK stack.
                        So the honest comparison is ZK-on-dispute vs. plain ZK,
                        and plain ZK wins on finality ────────────────────────▶ ZK
```

The recurring lesson in that tree: **the moment you demand full trustlessness *now*, optimism collapses into ZK** (its only trustless adjudicators are a ZK fraud proof or interactive bisection, both ~ZK-cost). Optimism's genuine niche is *"public forever, latency-OK, ship cheap with an honest-council fallback, upgrade to ZK later if needed."* Outside that niche, ZK is the answer.

---

## Recommended path

1. **If privacy is real** — build ZK now. It's the substrate the privacy roadmap needs anyway; don't build optimism first and throw it away.
2. **If public-only and shipping speed matters** — build the **shared substrate** (accumulator, journal, freeze-block filing, fixed-point guest) + the **optimistic seam with a council adjudicator**, and run a first-party watcher. This is the cheapest sound launch.
3. **Either way** — design the write gate behind its interface (`IAdjudicator` / `IZkVerifier`) so the trust model is upgradable without touching inputs, consumers, or the frontend.

Whatever you pick, cut WAVS at the seam rather than running it in parallel — dual-writing into the same per-block state slot is unsound in both designs (`ZK_ARCHITECTURE.md` Decision 5, `OPTIMISTIC_ARCHITECTURE.md` Decision 1).
