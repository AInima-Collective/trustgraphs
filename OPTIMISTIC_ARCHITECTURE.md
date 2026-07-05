# Optimistic TrustGraph — A Bonded Challenge-Window Seam

**Status:** Design proposal / spec. Highly experimental, like the rest of TrustGraph.
**Scope:** How to replace WAVS as the *root producer* with a **bonded, permissionless proposer + fraud-challenge window**, **without** touching EAS, `MerkleSnapshot`'s storage/verification API, the Zodiac governance module, the distributor, or the frontend proof format.
**Picking a producer?** Start at [`PRODUCER_TRADEOFFS.md`](./PRODUCER_TRADEOFFS.md) for the WAVS / optimistic / ZK side-by-side and decision tree.
**Relationship to [`ZK_ARCHITECTURE.md`](./ZK_ARCHITECTURE.md):** Sibling design, same seam. Both replace the WAVS operator quorum with a trustless producer that writes through the *same* `_updateStateAtBlock` path. They share **Contract A (`AttestationAccumulator`) verbatim** and diverge only at Contract B: ZK gates the write on a SNARK (instant finality, no watcher); this gates it on a bond surviving a challenge window (delayed finality, needs a live honest watcher). The `ZK_ARCHITECTURE.md` §8 tradeoff — *"in the public case an optimistic producer buys nearly the same trust for far less effort"* — is this document. The two are not mutually exclusive: **the optimistic adjudicator seam can be upgraded to the ZK verifier without touching the accumulator, the proposer flow, or any consumer** (§7, Decision 4).

---

## 1. Executive summary

TrustGraph today gets its integrity from a **staked WAVS operator set**: operators compute Trust-Aware PageRank off-chain, an aggregator collects signatures, and `MerkleSnapshot.handleSignedEnvelope` writes the `{account → score}` root on-chain after `_serviceManager.validate(...)`. The guarantee is "an honest operator quorum computed this correctly."

Because TrustGraph's inputs (EAS attestations) are **public** and Trust-Aware PageRank is **deterministic**, *anyone* can re-derive the correct root from chain state. That is exactly the condition under which an **optimistic** producer works: a permissionless proposer posts `(root, bond)`; the claim is provisional; during a **challenge window** any honest party who recomputes a different root can dispute it and slash the proposer. If the window elapses unchallenged, the root finalizes and writes through the **same state path the WAVS handler used** — reusing every existing consumer, not a new store — with WAVS itself **removed** (§7, Decision 1). No operator set, no aggregator quorum, no SNARK.

Two pieces make this sound — and the **first is identical to the ZK design**:

1. **An input accumulator** in the EAS resolver, so the chain holds a trustless commitment to *exactly which edges existed* at snapshot time. Optimistic needs this **just as much as ZK**: without a chain-pinned input set, a proposer and a challenger can disagree about *which edges existed*, and the dispute becomes unresolvable ("you recomputed over a different graph"). The accumulator gives the proposer, every challenger, and the adjudicator **one canonical input set** to agree or disagree about. This is Contract A from `ZK_ARCHITECTURE.md` §3, unchanged.
2. **An optimistic seam** on `MerkleSnapshot` that gates a write on *"a bond survived a challenge window"* instead of an operator signature, binding the claim to (a) the accumulator's committed input set and (b) a governance-pinned parameter set — the same journal binding the ZK design proves, here *asserted* by the proposer and *checkable* by any challenger.

The design keeps the on-chain contract **dumb** and the canonical computation in **one place** — the same `packages/pagerank` guest, run off-chain by the proposer and by every challenger. The chain folds a raw event log, holds bonds, runs a timer, and adjudicates disputes. It never runs PageRank.

**The honest cost of "far less effort":** the effort saved is the zkVM port and per-snapshot proving. The effort *retained* is a real economic and liveness mechanism — bonds, a challenge window, an adjudicator, and the assumption that **at least one honest party is watching and will challenge in time**. §4.2 and §8 are unsparing about where that assumption bites.

---

## 2. Background: the current write path

Identical to `ZK_ARCHITECTURE.md` §2 — reproduced so this doc stands alone.

| Stage | Where | What happens |
|---|---|---|
| Attestation | EAS, schema `string comment, uint256 confidence` | "Alice vouches for Bob." Public, timestamped. Resolver (`EASIndexerResolver.onAttest`) emits index events. |
| Trigger | `MerkleSnapshot.trigger()` | Emits `MerklerTrigger(triggerId)`; WAVS wakes the component. |
| Computation | WAVS operators, `components/trust-graph/` → `packages/pagerank` | `f64` Trust-Aware PageRank, `max_iterations` with `max_delta < tolerance` early-exit (`graph_computer.rs:290`); output quantized to `u64` at `1e6` (`graph_computer.rs:325`). |
| Commitment | `MerkleSnapshot.handleSignedEnvelope` → `_updateState` | `_serviceManager.validate(...)`, then writes `MerkleState{root, ipfsHash, ipfsHashCid, totalValue}`. Leaf = `keccak256(keccak256(abi.encode(account, value)))` (`MerkleSnapshot.sol:129`). |
| Consumption | `MerkleGovModule`, distributor, frontend | Merkle inclusion against `states[...]`. Historical snapshots retained. |

**The seam already exists.** `_updateState` (`MerkleSnapshot.sol:76`) is the single writer. Today one producer feeds it — the WAVS handler. We **replace** that producer with a bond-gated one. WAVS is removed, not run beside it.

```
   _updateStateAtBlock()  ◄─────  finalize()   ← bond survived challenge window   (sole producer)
   (single writer)                    ▲
                                      │ propose → [challenge window] → (dispute?) → finalize / slash
   removed:  handleSignedEnvelope · IWavsServiceHandler · _serviceManager   ← WAVS operator path
```

Cutting WAVS entirely rather than dual-writing is deliberate and load-bearing, for the **same reason as the ZK design**: the two producers disagree on the last bit. Even setting aside fixed-point vs `f64`, `_updateState` overrides state per block (`MerkleSnapshot.sol:82-96`), so a WAVS write and an optimistic write into the same block-slot would let the committed root flip with write order. It is one producer or the other — never both. See §7, Decision 1.

---

## 3. Contract A — `AttestationAccumulator` (shared with ZK, unchanged)

**This is `ZK_ARCHITECTURE.md` §3 verbatim.** The input commitment is not a ZK-specific artifact — it is what makes *any* off-chain producer's inputs trustless. Under optimism it plays a slightly different role (a **dispute referent** rather than a proof input), but the contract, the folding, the checkpointing, and the one-accumulator invariant are identical. Summarized here; see the ZK doc for the full rationale in §3.1–§3.3.

```solidity
abstract contract AttestationAccumulator {
    bytes32 public acc;        // acc_i = keccak256(abi.encode(acc_{i-1}, leaf_i)); acc_0 = 0
    uint64  public leafCount;

    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    Checkpoint[] public checkpoints;

    event EdgeFolded(uint64 indexed index, bytes32 leaf, bytes32 acc);
    event InputsCheckpointed(uint256 indexed id, bytes32 acc, uint64 leafCount);

    // kind: 0 = attest, 1 = revoke
    function _fold(uint8 kind, address attester, address recipient, bytes32 uid, bytes32 dataHash) internal {
        bytes32 leaf = keccak256(abi.encode(kind, attester, recipient, uid, block.timestamp, dataHash));
        acc = keccak256(abi.encode(acc, leaf));
        emit EdgeFolded(leafCount++, leaf, acc);
    }

    function _checkpoint() internal returns (uint256 id) {
        id = checkpoints.length;
        checkpoints.push(Checkpoint(acc, leafCount, uint64(block.number)));
        emit InputsCheckpointed(id, acc, leafCount);
    }
}
```

Wired into the single feeding resolver (`EASIndexerResolver`, `DeployNetwork.s.sol:102`) with two added `_fold` lines in `onAttest`/`onRevoke`; `_checkpoint()` is called from `MerkleSnapshot.trigger()`. All reconstruction (dedup, last-write-wins, self-loop exclusion, weight caps) happens **inside the canonical computation**, not on-chain — so the accumulator cannot disagree with the compute logic. The **one-accumulator-per-checkpoint invariant** (§3.2 of the ZK doc) applies unchanged: one resolver = one ordered log = one `acc`; do not copy the mix-in into a second live feeder.

> **Why optimism still pays for the fold.** It is tempting to think optimism can skip the accumulator because "the challenger can just read the same events the proposer did." It can't, safely: without a chain-pinned `(acc, leafCount)` freezing *which* events count as of *which* block, "the input set" is a matter of opinion, and a proposer disputed on a stale or padded edge set has a defensible story. The accumulator turns "which edges existed" from a disputable claim into a **single on-chain fact** both sides are bound to. This is the load-bearing shared substrate the ZK doc's §8 alludes to: **you build Contract A regardless of which producer you pick**, which is also why migrating optimistic → ZK later is cheap.

The total order for last-write-wins tie-breaks is `(block.timestamp, fold index)` — the accumulator's `leafCount` is the tie-break index. The proposer, every challenger, and the browser recompute must all agree on this order, exactly as in the ZK design (`ZK_ARCHITECTURE.md` §3.3, §8).

---

## 4. Contract B — the optimistic seam on `MerkleSnapshot`

Where ZK gates the write on `zkVerifier.verify(proof, journal)`, optimism gates it on *"a bond was posted, a window elapsed, and no successful challenge landed."* The journal — the complete ABI between the claim and the canonical computation — is **the same tuple**; the difference is it is *asserted* by the proposer and *checkable* by anyone, rather than proven in a SNARK.

```solidity
// added to MerkleSnapshot
IAdjudicator public adjudicator;   // decides a dispute; see §4.2. Seam-swappable to a ZK verifier.
bytes32 public paramsHash;         // keccak(damping, tolerance, maxIters, seedSetRoot, totalPool, weightCaps, precisionScale)  (operational)
uint256 public lastAppliedCheckpoint;
uint256 public challengeWindow;    // seconds; operational param
uint256 public proposerBond;       // wei; operational param
uint256 public challengerBond;     // wei; operational param

enum Status { None, Proposed, Challenged, Finalized, Rejected }

struct Claim {
    address  proposer;
    bytes32  journal;      // keccak256 over the same tuple the ZK guest commits to
    bytes32  outputRoot;
    bytes32  ipfsHash;
    uint256  totalValue;
    uint64   proposedAt;   // block.timestamp at proposal
    Status   status;
    address  challenger;   // set once challenged
}
mapping(uint256 => Claim) public claims;   // checkpointId → claim

// ---- 1. propose (permissionless, bonded) ------------------------------------
function proposeRoot(
    uint256 checkpointId,
    bytes32 outputRoot,
    bytes32 ipfsHash,
    string calldata ipfsHashCid,
    uint256 totalValue
) external payable {
    require(checkpointId > lastAppliedCheckpoint, "stale");
    require(claims[checkpointId].status == Status.None, "exists");
    require(msg.value == proposerBond, "bond");
    Checkpoint memory c = checkpoints[checkpointId];

    // Same tuple the ZK journal binds (ZK_ARCHITECTURE.md §4). Here it is a *claim*, not a proof —
    // its correctness is what the challenge window tests.
    bytes32 journal = keccak256(abi.encode(
        c.acc, c.leafCount,                 // which inputs   (chain-pinned)
        paramsHash,                         // which params   (governance-pinned)
        outputRoot, ipfsHash,               // scored tree + canonical-blob digest
        keccak256(bytes(ipfsHashCid)),      // ...and the CID string that points at that blob
        totalValue                          // summed points
    ));
    claims[checkpointId] = Claim(msg.sender, journal, outputRoot, ipfsHash, totalValue,
                                 uint64(block.timestamp), Status.Proposed, address(0));
    emit RootProposed(checkpointId, msg.sender, outputRoot, journal);
}

// ---- 2a. finalize (no challenge, window elapsed) ----------------------------
function finalize(uint256 checkpointId, string calldata ipfsHashCid) external {
    Claim storage cl = claims[checkpointId];
    require(cl.status == Status.Proposed, "not open");
    require(block.timestamp >= cl.proposedAt + challengeWindow, "window open");
    require(checkpointId == lastAppliedCheckpoint + 1, "out of order"); // see §4.3
    require(keccak256(bytes(ipfsHashCid)) == _cidDigestOf(cl.journal), "cid"); // rebind CID string

    cl.status = Status.Finalized;
    lastAppliedCheckpoint = checkpointId;
    (bool ok,) = cl.proposer.call{value: proposerBond}(""); require(ok, "refund");

    Checkpoint memory c = checkpoints[checkpointId];
    // File at the checkpoint's INPUT-FREEZE block, not the finalize block (ZK Decision 6).
    _updateStateAtBlock(c.blockNumber, cl.outputRoot, cl.ipfsHash, ipfsHashCid, cl.totalValue);
    emit MerkleRootUpdated(cl.outputRoot, cl.ipfsHash, ipfsHashCid, cl.totalValue);
}

// ---- 2b. challenge (permissionless, bonded) ---------------------------------
function challenge(uint256 checkpointId) external payable {
    Claim storage cl = claims[checkpointId];
    require(cl.status == Status.Proposed, "not open");
    require(block.timestamp < cl.proposedAt + challengeWindow, "window closed");
    require(msg.value == challengerBond, "bond");
    cl.status = Status.Challenged;
    cl.challenger = msg.sender;
    emit RootChallenged(checkpointId, msg.sender);
    // resolution is a separate call so the adjudicator mechanism is pluggable (§4.2)
}
```

`_updateStateAtBlock(uint256 blockNumber, …)` is the same refactor the ZK design introduces (`ZK_ARCHITECTURE.md` §4): `_updateState` with its keying block lifted to a parameter, so a claim files at the checkpoint's freeze block rather than the finalize block. `_cidDigestOf(journal)` recovers the CID digest the proposer committed, so `finalize`/`propose` cannot pair a valid data digest with a misdirecting CID string — the same binding the ZK journal enforces, checked here at finalize time.

### 4.1 The happy path is genuinely cheap

When nobody challenges — the expected case for an honest proposer computing a public, re-derivable function — the entire cost is:

- **Propose:** one `SSTORE`-heavy struct write + hold a bond. No SNARK, no verifier, no proving.
- **Wait:** `challengeWindow` seconds of wall-clock. No compute.
- **Finalize:** one status flip, one bond refund, one `_updateStateAtBlock`.

There is **no zkVM, no proving network, no ~250–300k-gas Groth16 verify**. That is the "far less effort" the ZK doc concedes. The proposer still runs the canonical `packages/pagerank` off-chain to *get* the root, but so does WAVS today — that cost is unchanged. What's deleted relative to ZK is the entire proving stack.

### 4.2 The crux — dispute resolution

**This is the whole game, and it is where optimism's honesty lives.** A challenge asserts "the proposed root ≠ `PageRank(checkpoint inputs, params)`." Someone or something must **decide who is right**, on-chain, with the bonds as stakes. There is no cheap universal answer; there is a spectrum, and the choice sets the trust model. Behind a single `IAdjudicator` seam:

```solidity
interface IAdjudicator {
    // returns true if the PROPOSER's journal is correct, false if the CHALLENGER wins.
    function adjudicate(uint256 checkpointId, bytes32 proposerJournal, bytes calldata evidence)
        external returns (bool proposerWins);
}
```

Three implementations, weakest-to-build → strongest-guarantee:

| Adjudicator | How it decides | Trust retained | Build cost |
|---|---|---|---|
| **A. Council** (recommended bootstrap) | On challenge, the constitutional multisig re-runs the canonical guest off-chain over the chain-pinned `(acc, leafCount)` and rules. `adjudicate` is a timelocked multisig call. | "The council is honest **on dispute**." Invoked only when a challenge fires, not every snapshot. | **Low.** A multisig + a documented off-chain runbook. |
| **B. ZK fraud proof** | Challenger (or proposer) submits a SNARK of the correct root; on-chain verify decides. `IAdjudicator` wraps `IZkVerifier`. | **None** beyond governance-set guest+params — identical to `ZK_ARCHITECTURE.md`. | **High** — this *is* the ZK stack, but built later and run only on dispute (§7, Decision 4). |
| **C. Interactive bisection** | Proposer & challenger bisect the execution trace to one instruction the chain executes (Arbitrum-style). | None beyond guest+params. | **Very high** — a one-step-executor VM for the guest. Not recommended for this team/scale. |

Why a naïve "just re-run PageRank on-chain" is absent: PageRank is **global** — every score depends on every edge over ~`iters` rounds — so you cannot cheaply re-execute it or dispute a single leaf in the EVM. Localizing the disagreement requires bisection (C) or offloading the verdict to a SNARK (B) or a human council (A). There is no fourth option that is both cheap and trustless; that is the fundamental tax optimism pays versus ZK in exchange for skipping proving on the happy path.

**Recommendation: ship with A, seam-designed for B.** The council adjudicator is honest-on-dispute, cheap, and — critically — the challenge window means it is *never invoked as long as proposers are honest and watchers are present*. When/if the ZK guest gets built for the privacy roadmap anyway, drop it behind the same `IAdjudicator.adjudicate` and the trust model upgrades from "honest council on dispute" to "fully trustless" **without touching the accumulator, the proposer flow, the bonds, or any consumer** (§7, Decision 4). This is the concrete migration path between the two sibling docs.

> **The council is a real trust concession — name it.** Adjudicator A means the strong claim "operator-free, trustless" is **not** true for the bootstrap deployment; the accurate claim is "trustless on the happy path, honest-council-adjudicated on dispute." That is still strictly better than today's *always-on* operator quorum (trust is invoked only on the rare dispute, not every snapshot), but it is weaker than ZK, and the doc must not pretend otherwise. If that concession is unacceptable, you are choosing between building B/C now or building the ZK design directly — at which point ZK's instant finality makes it the better buy.

### 4.3 Economic and timing parameters

- **`challengeWindow`.** The load-bearing latency knob. Too short and an honest watcher can be censored/outraced; too long and every snapshot's finality (and therefore governance's fresh scores) lags by that window. Start ~24–72h, an *operational* param under the short timelock. This is the finality cost ZK does not pay.
- **`proposerBond` / `challengerBond`.** Sized so (a) a dishonest proposal is unprofitable — bond ≥ the value extractable from a wrong root over one window — and (b) frivolous challenges are unprofitable. Loser's bond pays the winner (and, under adjudicator A, the council's gas + a fee). Griefing math both ways; see §8.
- **Sequential finalization.** Variable challenge windows and disputes mean checkpoints can *finish* out of order (checkpoint N+1 unchallenged while N is disputed). But `_updateStateAtBlock` files at each checkpoint's freeze block, and the `states[...]` binary-search invariant needs **ascending** freeze blocks. So finalize **strictly in `checkpointId` order** (`require(checkpointId == lastAppliedCheckpoint + 1)`): N+1 waits for N to finalize or reject. This is a genuine new wrinkle optimism introduces that ZK's near-instant application mostly sidesteps — a disputed early checkpoint stalls the queue behind it. Mitigations: keep windows short; allow a rejected checkpoint to be *re-proposed* promptly so the queue drains (§7, Decision 3).

### 4.4 IPFS

Identical to `ZK_ARCHITECTURE.md` §4.2, minus the proof. `ipfsHash` (data digest) and `keccak256(bytes(ipfsHashCid))` (CID string) are both bound in the claim's journal and re-checked at finalize, so a finalized claim cannot ship a digest that matches the data alongside a CID that resolves elsewhere. But here that binding is **only as good as the challenge**: a proposer *could* post a journal whose `ipfsHash` does not match the scored data, and it is a challenger's job to catch it within the window. Availability (someone actually pinning) is a liveness assumption identical to today. Net: optimism makes the data-integrity guarantee *challengeable* rather than *proven* — one notch weaker than ZK, same as everything else here.

---

## 5. End-to-end lifecycle

```
1. Users attest / revoke on EAS
      → resolver._fold(...) advances (acc, leafCount)                      [every tx, ~10k gas]

2. Anyone calls MerkleSnapshot.trigger()
      → _checkpoint() freezes (acc, leafCount, block) as checkpoint N       [snapshot inputs]

3. A permissionless proposer:
      - reads all leaves up to checkpoint N (events + EAS getAttestation)
      - runs the canonical packages/pagerank guest → (outputRoot, ipfsHash, totalValue)
      - pins the {account, score} JSON to IPFS
      - proposeRoot(N, ...) + posts proposerBond                            [NO proof]

4. Challenge window (challengeWindow seconds):
      - every honest watcher re-derives the root from the SAME checkpoint N inputs
      - match → stay silent;  mismatch → challenge(N) + challengerBond → adjudicator rules (§4.2)

5a. No challenge, window elapsed, N == lastAppliedCheckpoint + 1:
      → finalize(N) → refund proposer → _updateStateAtBlock(checkpoint N's block, ...)  [filed at freeze block]

5b. Challenged:
      → adjudicator.adjudicate(...) → loser's bond slashed to winner
      → proposer wins: proceed to finalize;  challenger wins: claim Rejected, re-open for re-proposal

6. Governance / rewards / frontend read states[...] as before               [unchanged]
```

WAVS is gone: `finalize` is the only producer, so there is no writer contention. `lastAppliedCheckpoint` + sequential finalization (§4.3) guard ordering; results file at each checkpoint's freeze block (step 2), so historical `states[...]` line up with input time rather than proposal/finalize time — identical to ZK's Decision 6.

The visible difference from the ZK lifecycle is **step 4**: a live window in which the guarantee depends on *someone honest actually watching and recomputing*. That watcher replaces the SNARK. Everything else is the same seam.

---

## 6. Trust surface

| Element | Controlled by | Risk if abused | Mitigation |
|---|---|---|---|
| `acc` folding | Nobody — deterministic in resolver | none; pure function | — (shared with ZK) |
| Input completeness | The chained hash | none; both sides bound to one `(acc, leafCount)` | dispute referent |
| Root correctness (happy path) | Proposer bond + **honest watcher** | wrong root finalizes **iff no one challenges in time** | bond, challenge window, ≥1 live honest watcher |
| Dispute verdict | **Adjudicator** (council / ZK / bisection) | wrong party slashed | choice of adjudicator = choice of trust (§4.2) |
| `paramsHash` (esp. `seedSetRoot`) | **Operational** authority | favorable seeds/damping | short timelock, governance, event-logged (shared with ZK) |
| `challengeWindow` / bonds | **Operational** authority | too-short window / too-small bond weakens security | short timelock; sized per §4.3 |
| IPFS availability | Whoever pins | liveness only | bounty / multiple pinners (shared with ZK) |
| Proposer liveness | Permissionless | no root gets posted | anyone can propose; optional bounty |
| **Watcher liveness** | Permissionless | **wrong root finalizes unchallenged** | ≥1 honest, funded, un-censored watcher — *the* optimistic assumption |

The honest one-line summary: this seam **moves trust from "an honest operator quorum computed it" (always) to "governance set the guest + params, AND at least one honest party is watching each window (and the adjudicator is honest, if it comes to that)."** Versus ZK, it trades the SNARK for a live-watcher-plus-window assumption and, in the bootstrap adjudicator, a council-on-dispute. Versus WAVS, trust is invoked *on dispute* rather than *every snapshot*. Every "shared with ZK" row is trustless identically in both designs.

---

## 7. Resolved design decisions

### Decision 1 — WAVS coexistence → **complete replacement, not parallel**

Same conclusion and same reasoning as `ZK_ARCHITECTURE.md` Decision 5. Dual-writing WAVS and the optimistic producer into the same per-block state slot is unsound: `_updateState` overrides per block, so the committed root would flip with write order, and the two producers need not agree on the last bit. Cut WAVS at the seam — remove `IWavsServiceHandler`, `_serviceManager`, `handleSignedEnvelope`; `finalize` becomes the sole producer, and `trigger()` becomes the checkpoint function (its `MerklerTrigger` wake-event is now redundant — proposers watch `InputsCheckpointed` — and can be dropped). Validate the canonical guest **off-chain** before the cutover (§8).

### Decision 2 — `paramsHash` authority → **operational timelock**; add `challengeWindow`/bonds as operational params

`paramsHash` carries the same two-tier logic as the ZK doc (`ZK_ARCHITECTURE.md` Decision 1), minus the constitutional `imageId` tier — there is no guest image on-chain in the council-adjudicator bootstrap (the guest lives in the off-chain runbook the council follows). The **constitutional tier reappears the moment you adopt adjudicator B** (the ZK verifier's `imageId`/`zkVerifier` become the long-timelock knobs). `challengeWindow`, `proposerBond`, `challengerBond`, and the `adjudicator` address are operational, short-timelock, governance-set. **`adjudicator` swaps should arguably be constitutional** — replacing the court is as powerful as replacing the guest — so gate it behind the long timelock even in the bootstrap.

> Same circularity caveat as ZK: governance power derives from scores, which derive from `paramsHash`. Timelock + a diverse, slowly-rotating seed set are mitigations, not a cure.

### Decision 3 — a rejected checkpoint → **re-proposable, does not skip**

When a challenge succeeds, the checkpoint is `Rejected`, not skipped — its inputs are still valid and *some* correct root exists for it. Allow immediate re-proposal (by anyone, including the winning challenger, who is now the best-informed party) so the sequential-finalization queue (§4.3) drains. Do **not** advance `lastAppliedCheckpoint` past a rejected checkpoint, or you punch a hole in the `states[...]` history at that freeze block. A checkpoint that is *repeatedly* proposed-and-rejected is a signal of a guest/param disagreement or a griefing war — escalate to governance, don't auto-skip.

### Decision 4 — adjudicator → **council now, ZK-verifier seam for later** (the migration path to `ZK_ARCHITECTURE.md`)

The `IAdjudicator` seam (§4.2) is the deliberate hinge between the two sibling designs. Ship adjudicator A (council) for a cheap, operator-free-on-the-happy-path launch. The accumulator, proposer flow, bonds, window, filing logic, and **every downstream consumer** are already exactly what the ZK design uses. Adopting ZK later is then not a rewrite but an **adjudicator swap** — `IAdjudicator.adjudicate` delegates to `IZkVerifier.verify` — plus building the guest (which the privacy roadmap wants regardless). This is why "build the accumulator regardless" (§3) matters: it makes optimism→ZK a one-contract migration, not a fork. Conversely, if instant finality or the no-watcher property is needed *at launch*, skip straight to `ZK_ARCHITECTURE.md`.

### Decision 5 — accumulator primitive → **chained hash now** (shared with ZK)

Identical to `ZK_ARCHITECTURE.md` Decision 3. Whole-set re-derivation touches every leaf regardless; an incremental Merkle tree only earns its keep if a future consumer needs succinct inclusion proofs. Keep the chained hash behind the `AttestationAccumulator` interface; the swap touches neither the proposer nor the adjudicator.

### Decision 6 — result filing block → **checkpoint freeze block** (shared with ZK)

Identical to `ZK_ARCHITECTURE.md` Decision 6, and *more* necessary here: optimism delays finality by a full challenge window (plus any dispute), so the finalize-time block is an even more meaningless label for the snapshot than the ZK submit-time block. File at `c.blockNumber`. Combined with sequential finalization (§4.3), `stateBlocks` stays ascending and the binary-search invariant holds.

---

## 8. Honest tradeoffs and open questions

- **The live-watcher assumption is the whole risk.** Optimism is only as safe as the claim "≥1 honest party recomputes each snapshot and can land a challenge before the window closes." That party must be (a) *present* — someone is actually running a watcher, (b) *funded* — has gas + `challengerBond` ready, and (c) *un-censored* — cannot be reorg'd/griefed out of the window. ZK assumes **none** of this. This is the precise thing you are buying with the ZK proving stack, and the precise thing you are saving by not building it. Fund and run at least one first-party watcher; do not assume "someone will."
- **Finality latency is a governance cost, not just a UX one.** Every snapshot's scores are provisional for `challengeWindow`. If governance reads fresh scores to weight a live vote, either it waits out the window or it votes on not-yet-final weights. Confirm proposals reference a *finalized* checkpoint/state index. ZK's instant finality avoids this entirely.
- **The bootstrap is not trustless — it is honest-council-on-dispute.** Restated from §4.2 because it is the easiest thing to oversell. With adjudicator A, a dispute is settled by a multisig. That is a real trusted party, invoked rarely but decisively. Only adjudicator B/C removes it, and B/C cost roughly what the ZK design costs (B *is* it). Decide with eyes open: if the council is unacceptable, the honest comparison is optimism-with-ZK-adjudicator vs. plain ZK — and plain ZK wins on finality.
- **Griefing runs both directions.** A wealthy adversary can spam frivolous challenges to stall finalization (each forces an adjudication and delays the queue via §4.3) — challenger bonds and slashing must make this net-negative. Symmetrically, an under-bonded proposer can post garbage to grief honest watchers into spending gas. Bond sizing (§4.3) is a real economic design task, not a constant; get it reviewed.
- **Determinism still matters, but less urgently than under ZK.** Honest watchers must not *accidentally* disagree with an honest proposer, or they'll file false challenges. Under adjudicator A running one agreed binary, "canonical" can be "whatever the reference binary outputs," so the `f64`-in-WASM cross-platform nondeterminism (`graph_computer.rs`) is tolerable *if every watcher runs that exact binary* — but that is fragile, and the moment you adopt adjudicator B the **fixed-point port becomes mandatory** (a SNARK cannot prove `f64`-in-WASM reproducibly). Recommendation: do the fixed-point port anyway (it also fixes the browser-recompute divergence in `usePageRankComputer.ts`), so honest watchers agree bit-for-bit and the ZK upgrade path stays open. This is the same work item the ZK doc calls its headline (`ZK_ARCHITECTURE.md` §8) — shared, not saved.
- **Last-write-wins ties are ordering, not rounding.** Identical to `ZK_ARCHITECTURE.md` §8. Same-block attestations share `block.timestamp`; the tie-break must be fold index, and every watcher's recompute plus the browser must use the total order `(timestamp, fold index)`, or honest parties diverge and file spurious challenges.
- **Validating the cutover.** Same as the ZK doc: removing WAVS means no on-chain A/B, so before flipping, run the canonical guest off-chain over historical checkpoints and diff against WAVS's output (bounded, explainable deltas), then testnet. Under optimism the challenge window is itself a *production* safety net the ZK design lacks — a bad first proposal is catchable — but do not lean on it as the primary validation.
- **Metadata leakage** (attestation count, timing, node set) is public by construction, identical to ZK — and note optimism *cannot* proceed to the privacy roadmap at all: a challenge-window model over *encrypted* inputs has no way for watchers to recompute, so **private TrustGraph forces ZK**. Optimism is a public-only design; if privacy is on the roadmap, optimism is at best a bootstrap you will replace.

---

## 9. Recommendation

If TrustGraph will stay **permanently public** and can tolerate **challenge-window finality latency**, build the optimistic seam: **resolver accumulator → checkpoint on `trigger()` → permissionless bonded `proposeRoot` → challenge window → `finalize` / council-adjudicated dispute → `_updateStateAtBlock`**, cutting WAVS at the seam (Decision 1). Ship with the **council adjudicator** behind the `IAdjudicator` seam for a cheap, no-proving launch, and run at least one first-party honest watcher — that watcher, not a SNARK, is what makes it sound.

Design every shared piece — the accumulator, the journal tuple, freeze-block filing, the fixed-point guest — **identically to `ZK_ARCHITECTURE.md`**, so the day privacy or instant finality is needed, adopting ZK is an `IAdjudicator` → `IZkVerifier` swap plus the guest, not a rewrite.

**Choose this over ZK when:** public forever, latency-tolerant, and you want to ship without the proving stack.
**Choose ZK over this when:** privacy is on the roadmap (it *forces* ZK — §8), or you need instant finality, or the honest-council-on-dispute concession is unacceptable.

---

## Appendix — files this design touches

- `src/contracts/eas/resolvers/EASIndexerResolver.sol` — add `AttestationAccumulator` mix-in + two `_fold` lines (**identical to ZK**; the single schema resolver that feeds the graph, per the §3 one-accumulator invariant)
- `src/contracts/merkle/MerkleSnapshot.sol` — add `proposeRoot`/`challenge`/`finalize`, `Claim` storage, `adjudicator`/`paramsHash`/`lastAppliedCheckpoint`/`challengeWindow`/bonds, `_checkpoint()` in `trigger()`; refactor `_updateState` → `_updateStateAtBlock(blockNumber, …)` (**identical refactor to ZK**); **remove** `IWavsServiceHandler`, `_serviceManager`, `handleSignedEnvelope`
- `src/interfaces/merkle/IMerkleSnapshot.sol` — add `InputsCheckpointed`, `Checkpoint`, `RootProposed`/`RootChallenged`/`RootFinalized` events, proposal/challenge errors
- new `IAdjudicator` + **council adjudicator** (multisig) deployment; seam-swappable to the ZK verifier (Decision 4)
- `packages/pagerank/`, `components/trust-graph/src/` — fixed-point guest (separate scope; **shared with ZK**, mandatory once adjudicator B is adopted, recommended regardless — §8)
- `frontend/hooks/usePageRankComputer.ts` — reconcile to the guest's fixed-point output; also the basis for a watcher (**shared with ZK**)
- governance: an operational `TimelockController` for `paramsHash`/window/bonds; a long-timelock (constitutional) gate on the `adjudicator` address
- **new off-chain component: a watcher** — recomputes each checkpoint and challenges on mismatch. Has no ZK analog; it is the liveness backbone of this design (§8)
