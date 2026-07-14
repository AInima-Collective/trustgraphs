# Multi-Program Platform — One Seam, Many Graphs

**Status:** Planning, 2026-07-14. Execution spec: [`/GOAL.md`](../GOAL.md) (milestone M0 realizes this document).
**Scope:** How to reorganize the repo so it supports **multiple SP1 programs and provers** — the existing trust-graph root producer, the signer-sync program, and the incoming Hypercerts/AT-Protocol program ([`HYPERCERTS_ATPROTO_PLAN.md`](./HYPERCERTS_ATPROTO_PLAN.md)) — without weakening the four-way byte-parity discipline that makes v1 sound.
**Relationship to [`ZK_ARCHITECTURE.md`](./ZK_ARCHITECTURE.md) / [`SIGNER_SYNC_ZK_PLAN.md`](./SIGNER_SYNC_ZK_PLAN.md) / [`OFFCHAIN_ATTESTATIONS_ZK.md`](./OFFCHAIN_ATTESTATIONS_ZK.md):** nothing in those designs changes. This document is about *packaging*: where code lives, what is shared, what is per-program, and how each additional graph pays only for its own semantics.

---

## 1. Vocabulary: program vs. instance

Two axes get conflated when we say "support multiple zk programs":

- A **program** = one guest binary + the core-crate semantics it compiles + one journal shape + one params schema. Today: `trust-graph` (root producer) and `signer-sync`. Next: `hypercerts` (AT-proto graph).
- An **instance** = one *deployment* of a program: a chain + a contract set (snapshot, verifier, accumulator/registry) + a params set + an indexer/frontend view. The same program can run as many instances (e.g. a Hypercerts instance on Optimism and a community instance elsewhere) with zero code changes.

The reorg target: **adding a program costs a core crate + a guest bin + prover subcommands + golden vectors; adding an instance costs only a deployment.** Everything below serves that line.

## 2. What is already multi-program (don't rebuild it)

The signer-sync build quietly proved most of the pattern. Inventory of what generalizes as-is:

| Piece | Why it already generalizes |
|---|---|
| `SP1TrustGraphVerifier` | Journal-agnostic: checks `keccak256(publicValues) == journalDigest`, delegates to the SP1 gateway with an immutable per-program `programVKey`. A new program = a new instance with a new vkey. (Rename to `SP1JournalVerifier.sol` for honesty — optional polish, new deployments only.) |
| `IZkVerifier` seam | `verify(bytes proof, bytes32 journalDigest)` — the consumer decides the journal shape; the verifier doesn't care. |
| Guest packaging | `zk/program` is already a **multi-bin crate** (`trustgraph-program` + `trustgraph-signer-program`); `zk/prover/build.rs`'s single `sp1_build::build_program("../program")` builds every bin. A third program = a third `[[bin]]`. |
| `AttestationAccumulator` | The chained-hash fold is the input-commitment primitive for *any* lane-1 feed; `AnchorRegistry` (offchain design §4.1) is the same fold one level up for lane 2. |
| `DeployZkVerifier.s.sol` | Already parametrized `run(gateway, vkey, outLabel)` — root and signer verifiers coexist via labels. Third label = third verifier. |
| `SignerSyncZkModule` | The template for a program-specific consumer: own verifier, own journal, own `submit*Proof`, shared inputs. |

What does **not** generalize today: `MerkleSnapshot`'s hardcoded 7-field journal, the PageRank-specific interior of `pagerank-core`, the single `test/golden/vectors.json`, the indexer's single-deployment config, `frontend/lib/pagerank` as a monolithic port, the absence of any zk task-runner plumbing, and docs whose "the program" phrasing assumes there is one. Those are the six work surfaces below.

## 3. Rust workspace layout

Target (root `Cargo.toml` workspace stays `packages/*`; `zk/program` + `zk/prover` stay detached):

```
packages/
  zk-core/            # NEW — shared, program-agnostic, no_std-friendly:
                      #   words.rs   (word_u256/u64/u32/u8/addr encoders)
                      #   fold.rs    (chained-hash accumulate/fold — lane-1 AND anchor-lane re-fold)
                      #   merkle.rs  (OZ StandardMerkleTree root, hash_pair, output leaves)
                      #   fixed.rs   (mul_div 512-bit, fp_mul, fp_div)
                      #   cid.rs     (canonical JSON blob + CIDv1-raw)
                      #   journal.rs (the "hand-rolled static-ABI tuple + keccak digest" discipline)
  envelopes/          # NEW — lane-2 envelope trait + implementations (offchain design §4.2):
                      #   traits.rs        ("head + witness bytes → complete authenticated edge set, or fail")
                      #   eas_offchain.rs  (envelope 0: chained log head, EIP-712 ecrecover, revokeOffchain set)
                      #   atproto/         (envelope 1: cbor.rs, commit.rs, mst.rs, plc.rs, carset.rs)
  pagerank-core/      # SLIMS — keeps pagerank.rs, reconcile.rs, distribute.rs, compute.rs, signer.rs,
                      #   the trust-graph Params/Journal/encodings; re-exports zk-core so the public
                      #   API survives; golden vectors unchanged
  hypercerts-core/    # NEW — record→edge mapping, weight normalization, hypercerts Params/Journal
                      #   (see HYPERCERTS_ATPROTO_PLAN.md §3); depends on zk-core + envelopes
zk/
  program/            # one crate, one [[bin]] per program:
                      #   main.rs (trust-graph) · signer.rs · hypercerts.rs
  prover/             # one host CLI, clap-structured:  prover <program> <command>
                      #   src/programs/{trust_graph,signer,hypercerts}.rs
                      #   src/witness/{eas.rs, atproto.rs}   ← host-only fetch/archival (see §7)
```

Design rules carried over unchanged: **no floats, `BTreeMap` only, no non-deterministic iteration** in anything a guest compiles; every encoding golden-tested in four languages.

Two decisions worth stating explicitly:

- **One `envelopes` crate, not one crate per substrate.** The trait is small and the implementations share the CBOR/hashing substrate; module boundaries suffice. If Farcaster/Nostr envelopes ever land, they are modules too.
- **Guest bins stay in one crate.** Separate guest crates would isolate lockfiles, but `[patch.crates-io]` entries (sha2/k256/p256 patched crates) apply crate-wide anyway, and the bins are 25-line shells. **Consequence to plan around:** adding the p256/k256 patches for the hypercerts bin changes the *compiled ELFs of the existing bins* → the root and signer vkeys rotate at the next deploy. Vkey rotation is the established constitutional-timelock path (deploy new verifier instance, repoint); batch it once at M2 rather than dribbling it.

## 4. Contracts: the reuse matrix

| Contract | Multi-program answer |
|---|---|
| `SP1TrustGraphVerifier` → `SP1JournalVerifier` | **Reuse bytecode, deploy per program.** Immutable vkey per instance; same gateway. |
| `MerkleSnapshot` | **One codebase on journal v2; deploy per instance.** See below — the load-bearing decision. |
| `AttestationAccumulator` (+ resolvers) | Reuse as-is for any instance with a lane-1 EAS feed. One accumulator per instance (the §3.2 invariant: one checkpoint freezes one `acc`). |
| `AnchorRegistry` (new, offchain design §4.1) | **Per instance.** Each graph owns its anchor log — sharing one registry across graphs would couple their epoch schedules and registration gates for no benefit. |
| `MerkleGovModule` / `MerkleFundDistributor` | Per instance, optional. The Hypercerts instance launches score-only (no gov, no distributor) — consumers are Hypercerts' own systems reading the proven root. |
| `InstanceRegistry` (new, tiny) | **One per chain.** `instance → (program, snapshot, verifier, registry/accumulator, paramsHash)` behind the operational timelock, so any frontend/indexer discovers deployments on-chain instead of via `deployment_summary.json`. Decided 2026-07-14: build it (lands with M2's contract work). |
| `SignerSyncZkModule` | Untouched; trust-graph-instance-specific. |
| `ParamsCodec` | Becomes per-program: `ParamsCodec` (trust-graph) + `HypercertsParamsCodec`, each golden-locked to its crate's `params_hash`. |

**The `MerkleSnapshot` journal decision.** The offchain design (§4.3) grows the journal 7→10 fields (`+ anchorAcc, anchorCount, skippedDigest`). Rather than forking a per-program snapshot contract, make journal v2 the **uniform shape for every instance**, with an empty lane encoded as the zero accumulator:

- lane-1-only instance (today's trust graph, pre-lane-2): `anchorAcc = 0, anchorCount = 0, skippedDigest = keccak("")`-equivalent — guest asserts the empty fold.
- lane-2-only instance (Hypercerts, no EAS feed): `acc = 0, leafCount = 0`.
- hybrid: both live.

One code path, one `submitProof` signature, one golden-vector family for the journal envelope; per-program variation lives entirely in `paramsHash` (which pins the program's own params schema) and the vkey. The guest, not the contract, decides what an empty lane means — the contract just binds checkpointed storage into the digest, exactly as today.

Migration note — **resolved 2026-07-14: no backwards compatibility.** The live trust-graph deployment stays frozen on journal v1 and is never migrated; every deployment from M2 onward (including any future trust-graph redeploy) is a fresh journal-v2 instance. The codebase carries exactly one journal shape (v2) — no v1 code path, no compatibility shims. Leaf format per the offchain design §5: `keccak(nodeId, value)` domain for unified nodes, with bound nodes also emitted under the v1 address-leaf domain so address-keyed consumers work unchanged.

## 5. Indexer

Ponder already indexes N contracts from `deployment_summary.json`; the gap is that it assumes one instance and no lane 2. Plan:

- **Instance dimension.** `deployment_summary.json` gains an `instances` map (`trust-graph`, `hypercerts`, …) each with its contract set; `ponder.config.ts` iterates it. Tables gain an `instanceId` column (cheap now, painful later).
- **Lane-2 tables:** `anchor` (nodeId, envelopeKind, head, dataCommitment, epoch, foldIndex), `offchainEdge` (decoded lane-2 edges, per instance), `nodeBinding` (DID ↔ address), `skippedNode` (rule-Φ audit trail from `skippedDigest` preimages).
- **The indexer becomes the availability mirror** (offchain design §7): it archives CAR blocks / attestation blobs keyed by `(did, rev)` at observation time — old atproto commits are *not re-servable*, so this archival is a soundness-adjacent duty, not a convenience. Storage is content-addressed; the Ponder Postgres holds pointers, the blob store holds bytes.
- New handlers: `AnchorRegistry` events, plus a firehose/PLC-mirror sidecar (§7) that is *not* a Ponder handler (it consumes atproto, not a chain) but writes into the same Postgres.

## 6. Frontend

- Extract `frontend/lib/zk-core/` (TS twins of `packages/zk-core`: words, fixed, merkle, cid, fold, journal discipline). `lib/pagerank` keeps the trust-graph program semantics and re-exports the shared pieces.
- Per-program semantic ports only where **browser recompute** is a product requirement. For the trust-graph instance it is (that's the v1 trust story). For the Hypercerts instance v1, we deliberately ship a **reduced parity tier**: the browser re-derives PageRank + root from the indexer-served, envelope-verified edge set and checks it against the on-chain journal (root, accumulators, `skippedDigest`) — but does **not** re-verify MST walks/PLC logs in TS. Full envelope verification in the browser is a later, separately-scoped port; say so in the docs rather than implying parity we don't have.
- Routes gain an instance scope (`/g/[instance]/...`); the existing routes alias to the trust-graph instance.

## 7. Provers and witness assembly

`zk/prover` is restructured from hand-rolled `args[1]` dispatch to clap subcommand groups, one per program, sharing the proof-writing plumbing (`abi.encode(publicValues, seal)`, blob export, local verify):

```
prover trust-graph {vkey|paramshash|execute|prove}
prover signer      {vkey|selectionparamshash|execute|prove}
prover hypercerts  {vkey|paramshash|fetch|execute|prove}
```

The genuinely new host-side subsystem is **witness assembly** for lane 2 (`src/witness/`): firehose/`getRepo` fetch, CAR archival, PLC-mirror client, revokeOffchain event reads, blob/IPFS retrieval. It is heavy-dependency, host-only code — feature-gate it (`witness-atproto`) so `prove`-only builds stay lean. The `fetch` subcommand materializes a self-contained witness bundle on disk; `execute`/`prove` consume the bundle, so proving is reproducible offline and the bundle is what the indexer archives.

## 8. Golden vectors and parity at N programs

The four-way parity harness (native Rust / SP1 guest / Solidity / TS) is the crown jewel; scale it by splitting per program instead of growing one file:

```
test/golden/trust-graph.json   (root + signer vectors — the current vectors.json, renamed)
test/golden/hypercerts.json
```

- Each core crate owns an `export_golden` example writing its file.
- `test/unit/GoldenVectors.t.sol` splits into per-program test contracts reading their own file.
- Each program's TS port gets its own `golden.test.ts`.
- The prover's `execute` command retains the guest==native byte-assert per program.
- Task plumbing (new `taskfile/zk.yml`): `task zk:vectors PROGRAM=…`, `zk:vkey`, `zk:execute`, `zk:prove`, and a `zk:parity` aggregate that CI runs for every program on every PR touching `packages/` or `zk/`.

Rule, unchanged in spirit from CLAUDE.md: **an encoding change without a regenerated vector file in the same PR is a CI failure**, now enforced per program.

## 9. Documentation organization

Answer to "how best to organize documentation for each example": one directory per program, one index, research stays research.

```
docs/
  PROGRAMS.md                    # the index: program → status → vkey → docs → instances
  trust-graph/                   # RUNBOOK.md (moved from zk/RUNBOOK.md; zk/RUNBOOK.md becomes a pointer),
                                 # ARCHITECTURE.md → pointer to research/ZK_ARCHITECTURE.md
  signer-sync/                   # RUNBOOK section split out; pointer to research/SIGNER_SYNC_ZK_PLAN.md
  hypercerts/                    # ARCHITECTURE.md → pointer to research/HYPERCERTS_ATPROTO_PLAN.md,
                                 # RUNBOOK.md, GRAPH_SEMANTICS.md, LEXICONS.md (pinned @hypercerts-org/lexicon version)
research/                        # unchanged — design provenance, each doc gets a Status: banner
                                 # (proposed / implemented-by / superseded-by) so readers can tell
                                 # spec from history
```

Conventions: `research/` holds *why* (design docs, dossiers, tradeoffs — immutable once implemented, banner updated); `docs/<program>/` holds *how to operate it today* (runbooks, params, addresses — living documents). Fix the stale `CLAUDE.md` links (it cites `ZK_ARCHITECTURE.md`/`SIGNER_SYNC_ZK_PLAN.md` as top-level; they live in `research/`), and add the program index to `README.md`.

## 10. Migration sequencing

Ordered so nothing breaks between steps; this is GOAL.md milestone M0 plus the M2 flag:

1. Extract `packages/zk-core` (move + re-export; `pagerank-core` API unchanged). Regenerate nothing — encodings must come out byte-identical, proven by the *existing* vectors still passing.
2. Split golden vectors per program; split the Solidity/TS golden tests; add `taskfile/zk.yml` + CI parity job.
3. Restructure `zk/prover` to clap program groups (behavior-preserving).
4. Docs reorg (§9) incl. `PROGRAMS.md` and CLAUDE.md link fixes.
5. Contract polish: `SP1JournalVerifier` rename — clean rename, no alias (no backwards compatibility per the 2026-07-14 decisions; the frozen v1 deployment keeps its already-deployed bytecode regardless).
6. **Not in M0:** journal v2 (`MerkleSnapshot`), `AnchorRegistry`, `envelopes` crate — those land with lane 2 (GOAL M2), because shipping journal v2 without a lane-2 producer would force a pointless instance migration.

Exit criterion for the whole reorg: **all four parity layers green, vectors byte-identical to pre-reorg, both existing programs prove end-to-end on anvil via the new CLI.** Vkeys will differ (ELF layout changes under refactor even when semantics don't) — re-derive, record in `docs/PROGRAMS.md`, and treat redeployment as part of the next scheduled rotation, not an emergency.

## 11. Open questions — resolved 2026-07-14 (Jake)

1. **Journal v2 migration:** no migration, no backwards compatibility. The live Optimism trust-graph instance stays frozen on v1; all new deployments are v2. The codebase drops v1 the moment v2 lands.
2. **Monorepo:** stays. Publishing `zk-core`/`envelopes` as crates is premature; revisit at the second external instance.
3. **`InstanceRegistry`:** yes — build it (see §4 matrix; lands with M2's contract work).
