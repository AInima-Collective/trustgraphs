# Architecture

Trustgraphs is proof infrastructure for computations over verifiable graph data. It does not
require every network to use Ethereum vouches or PageRank. Each program defines its own source
records, authentication rules, deterministic computation, and output type.

This page starts with that shared architecture, then follows the standard onchain EAS vouch
program end to end.

## The shared pipeline

```text
  source records
  signed statements, onchain events, anchored histories, or proven roots
        │
        ▼
  authentication and input commitment
  verifies origin and commits to the input history the program must cover
        │
        ▼
  checkpoint
  freezes input commitments and parameters for one epoch
        │
        ▼
  deterministic program in the SP1 zkVM
  authenticates the witness, applies the rules, and commits the output
        │
        ▼
  proof + public journal
        │
        ▼
  onchain verifier
  checks the proof with the verifier active at submission and stores the output root
        │
        ▼
  applications
  verify scores, allocations, or another program-specific result
```

The program is responsible for the meaning of every arrow. A signature can authenticate who made
a record, but not whether the record is true. An anchored head can prevent a prover from choosing
an older convenient history, but only if the source adapter defines and verifies that history.
The proof establishes those published rules; it does not create meaning that the program did not
specify.

## Current flagship: onchain EAS vouches

The standard network creation path uses public, revocable Ethereum Attestation Service (EAS)
vouches and a seeded PageRank-style scoring program.

```text
  members create or revoke EAS vouches
        │
        ▼
  EASIndexerResolver
  emits index events and folds every accepted record
        │
        ▼
  AttestationAccumulator
  running commitment: acc + leafCount
        │
        ▼
  MerkleSnapshot.trigger()
  freezes a checkpoint and its scoring parameters
        │
        ▼
  trust-graph program in SP1
  reconciles vouches, computes scores, and builds the output Merkle root
        │
        ▼
  MerkleSnapshot.submitProof()
  verifies the journal against the checkpoint and program verification key
        │
        ▼
  accepted score root
  governance, distributions, the indexer, and applications
```

### EAS records the member action

A vouch is a signed EAS attestation from one Ethereum account to another. Members submit and revoke
these records against EAS; the Trustgraphs prover is not an intermediary in that action. The
network's schema determines which attestations belong to the graph and where the vouch weight is
encoded.

### The resolver commits every accepted record

Each standard network binds its schema to an `EASIndexerResolver`. When EAS processes an
attestation or revocation, the resolver emits index events and folds the record into an
`AttestationAccumulator`: an ordered chained hash (`acc`) and record count (`leafCount`).

Changing, removing, inserting, or reordering a folded record changes that commitment. This is the
lane-1 completeness boundary for the standard program. Networks configured for strict offchain
EAS inputs also have a second, separately checkpointed anchor lane with its own authentication and
staleness rules.

### A checkpoint fixes one proof statement

`MerkleSnapshot.trigger()` records the current input commitments and pins the active parameter
hash for a numbered checkpoint. Later records belong to a later checkpoint. A later governance
change cannot alter the parameters attached to a checkpoint already in flight.

### Anyone can compute and prove

A prover reconstructs the checkpoint witness and runs the `trust-graph` program in the
[SP1 zkVM](https://docs.succinct.xyz/). The guest:

- reproduces the input commitments and counts;
- authenticates and reconciles the records under the program's rules;
- checks the pinned parameter hash;
- runs deterministic fixed-point scoring; and
- commits the score Merkle root, canonical output-file digest, and other public bindings in its
  journal.

The prover can choose when to do the work, but cannot produce a valid proof for different inputs or
different scoring rules.

### The contract uses the current verifier

`MerkleSnapshot.submitProof()` rebuilds the expected journal digest from checkpointed state and
the claimed outputs. It then snapshots the network's current verifier for that transaction. The
verifier checks the proof against its program verification key.

Inputs and parameters are pinned at trigger; the verifier deliberately is not. A verifier rotation
therefore changes which guest can prove an already-triggered but still-unproved checkpoint. This
supports emergency replacement of a compromised verifier, but it makes verifier authority part of
the network's trust model. The statement is also bound to the snapshot contract and chain, so a
proof for another network cannot be replayed merely because its inputs happen to look similar.

A valid submission stores the score root and output metadata. The full score set is published
outside contract storage; Merkle proofs connect individual entries back to the accepted root.

### Consumers choose how to use the root

The standard governed deployment can use accepted scores for trust-weighted Safe proposals and an
optional shared-fund distribution. The indexer serves score files, Merkle proofs, graph history,
and network metadata to the frontend and other applications. A separate application can verify an
entry directly against the snapshot root without trusting the indexer.

## Programs with different data semantics

Other programs reuse parts of the pipeline without pretending their records are vouches:

- **Contributions** authenticates a standard parent network's checkpointed vouch history plus
  contribution claims, responses, and peer valuations. Its proof recomputes reputation before
  weighting valuations and producing allocations.
- **Hypercerts** verifies anchored AT Protocol repository records and applies explicit
  record-to-edge rules before scoring.
- **Nostr workspace** verifies signed events, membership, identity, replacement, and deletion rules
  against an anchored witness package.
- **Score composition** captures complete accepted outputs from source networks and combines them
  under a committed allocation policy.
- **Signer sync** recomputes canonical trust scores from checkpointed onchain vouches, then combines
  them with direct-vote activity and current Safe state to derive an owner set. It does not consume
  or change the source network's published score root.

These programs have different completeness and availability assumptions. Sharing SP1 and a Merkle
output format does not make their trust models interchangeable.

## Consensus code and reproducibility

Each proof-producing program has canonical deterministic code compiled into its SP1 guest. The
verification key identifies that exact guest binary. Native host code reconstructs witnesses and
recomputes outputs; browser implementations exist where the application needs previews or local
verification. Golden vectors pin consensus encodings and expected outputs across implementations.

Changing consensus behavior creates a new program version and verification key. Governance can
adopt a new verifier, and that verifier applies to later submissions, including any checkpoint
already triggered but not yet proved. Factory deployments with provenance enabled record the
accepted verifier address, code hash, program key, and parameter hash with each accepted
checkpoint. Previously accepted roots and their recorded provenance are not rewritten.

## What remains in the trust model

The proof removes the need to trust the scoring operator, not every dependency in the system.
Users still need to evaluate:

- whether the source authentication and completeness rules match the data source;
- whether source records and published output files remain available;
- whether the program's semantics and parameters fit the decision being made;
- who can change protected settings or the accepted verification key; and
- the security of the chain, contracts, zkVM, and cryptography.

Continue with [Networks and programs](./networks-and-programs.md), [Epochs and
proofs](./epochs-and-proofs.md), or the standard [vouch scoring algorithm](./algorithm.md).
