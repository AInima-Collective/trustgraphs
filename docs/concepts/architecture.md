# Architecture

trustgraphs turns a community's vouches into provable reputation scores. Members vouch for each
other on-chain, anyone can compute the scores, and a zero-knowledge proof guarantees the scores
were computed correctly over the complete vouch history. This page walks the pipeline end to end
for a technical reader.

Nothing is deployed to production today; Ethereum mainnet is the target chain. Everything below
runs today on local and test deployments.

## The pipeline

```
  users
    │  create / revoke vouches (EAS attestations)
    ▼
  EAS (Ethereum Attestation Service)
    │  routes each attestation to the schema's resolver
    ▼
  EASIndexerResolver  ── emits index events for off-chain indexers
    │  folds every edge into the
    ▼
  AttestationAccumulator  (chained hash: acc, leafCount)
    │
    │  MerkleSnapshot.trigger() freezes a checkpoint  ←  epoch boundary
    ▼
  SP1 zkVM: anyone proves fixed-point Trust-Aware PageRank
  over the complete checkpointed input set
    │  proof + journal (the proof's public outputs)
    ▼
  MerkleSnapshot.submitProof
    ├─ SP1JournalVerifier: proof valid for this program's vkey?
    └─ stores the {account → score} merkle root
    │
    ├──────────────────┬─────────────────────┐
    ▼                  ▼                     ▼
  MerkleGovModule   MerkleFundDistributor   Ponder indexer API
  (score-weighted   (score-weighted         (apps and the
  voting on a Safe)  reward claims)          frontend)
```

## Step by step

### 1. Vouches live on EAS

A vouch is an attestation: a signed on-chain statement "account A vouches for account B". Users
create and revoke vouches directly against [EAS](https://attest.org) (Ethereum Attestation
Service), a public attestation contract. trustgraphs does not sit between you and your vouch;
there is no operator who can censor or reorder them.

### 2. Every edge is committed as it happens

Each network registers its vouch schema with a resolver, `EASIndexerResolver` (an EAS
`SchemaResolver`). EAS calls the resolver on every attestation and revocation for that schema.
The resolver does two things:

- **emits index events** so off-chain indexers can follow the graph, and
- **folds the edge into the `AttestationAccumulator`**: a running chained hash (`acc`) plus a
  count (`leafCount`) that commits to every edge, in order, that has ever passed through.

The chained hash is what makes the input set tamper-evident. You cannot remove an edge, insert
one retroactively, or reorder history without changing `acc`. The resolver is bound to exactly
one schema, so no foreign attestation can be smuggled into the fold.

### 3. An epoch checkpoint freezes the inputs

At an epoch boundary, anyone calls `MerkleSnapshot.trigger()`. This freezes the current
`(acc, leafCount)` as a numbered checkpoint and pins the scoring parameters in force at that
moment. Scores for that epoch are computed over exactly this frozen set, and never recomputed.
See [epochs and proofs](./epochs-and-proofs.md).

### 4. Anyone proves the scores

A prover (a hosted daemon, a community member, anyone) reconstructs the checkpoint's edge set
from public chain data and runs Trust-Aware PageRank inside the
[SP1 zkVM](https://docs.succinct.xyz/), a virtual machine that produces a zero-knowledge proof
of correct execution. The guest program:

- re-folds every edge and asserts it reproduces the checkpointed `acc` and `leafCount`, which
  proves the **complete** vouch history was used, nothing omitted;
- asserts its parameters hash to the checkpoint's pinned params hash;
- runs the fixed-point algorithm (integer arithmetic only, so every machine gets identical
  bytes) and commits the resulting `{account → score}` merkle root in its journal.

The algorithm itself is described in the [algorithm spec](./algorithm.md).

### 5. On-chain verification stores the root

`MerkleSnapshot.submitProof` rebuilds the expected journal digest from chain-pinned data (the
checkpoint's accumulator values, the pinned params hash, its own address and chain id) and hands
the proof to `SP1JournalVerifier`, which checks it against the program's verification key (the
vkey, a fingerprint of the exact guest binary). Only a valid proof over the exact frozen inputs
can write the root. Submission is permissionless: it does not matter who submits, because the
proof cannot lie. Details of every check are in
[epochs and proofs](./epochs-and-proofs.md).

### 6. Consumers read the proven root

Everything downstream reads the stored `{account → score}` merkle root:

- **`MerkleGovModule`**, a Zodiac module on a [Safe](https://safe.global): members vote with
  their score as voting power, proven by a merkle inclusion proof against the root.
- **`MerkleFundDistributor`**: score-weighted reward distributions; each account claims its
  share with a merkle proof.
- **The Ponder indexer API**: an off-chain indexer that reads the contracts' events directly
  and serves the graph, scores, and history to the frontend and to any app.

## One algorithm, four implementations, zero drift

The canonical algorithm and all byte encodings live in one Rust crate,
`packages/pagerank-core`. It is compiled into the SP1 guest (`zk/program`) and the host CLI
(`zk/prover`), and ported to TypeScript for the browser (`frontend/lib/pagerank`), so the
frontend can preview scores with the same math the proof enforces. Golden vectors in
`test/golden/` pin all implementations (native Rust, SP1 guest, Solidity tests, TypeScript) to
byte-identical outputs; a change that breaks parity fails CI. See
[golden vectors](../verify/golden-vectors.md).

## What you trust, and what you do not

You do not trust any operator to compute honestly: the proof enforces the math, and the
accumulator enforces the inputs. What remains is governance: the authority that can rotate the
verifier (which vkey defines "correct") and the scoring parameters, held behind timelocked
roles. The full trust surface and design rationale are in
[`research/ZK_ARCHITECTURE.md`](../../research/ZK_ARCHITECTURE.md).

## Going deeper

- [Networks and programs](./networks-and-programs.md): how one codebase serves many
  communities and several proven computations.
- [Epochs and proofs](./epochs-and-proofs.md): checkpoints, the journal, and what
  `submitProof` verifies.
- [The algorithm](./algorithm.md): Trust-Aware PageRank and why it resists Sybil attacks.
- [Build docs](../build/): stand up a network, integrate scores, run a prover.
- [Golden vectors](../verify/golden-vectors.md): check cross-language parity yourself.
