# trust-graph — Architecture

The design lives in [`../../research/ZK_ARCHITECTURE.md`](../../research/ZK_ARCHITECTURE.md).

`trust-graph` is the root-producer program: a permissionless SP1 zero-knowledge proof of correct
fixed-point Trust-Aware PageRank over EAS attestations, committing the `{account → score}` merkle root
on-chain via `MerkleSnapshot.submitProof` (verified by `SP1JournalVerifier`) with input completeness
pinned by the on-chain `AttestationAccumulator`. The canonical algorithm and every byte encoding live
in `packages/pagerank-core` (which re-exports the shared `packages/zk-core` primitives) and are proven
byte-identical across native Rust, the SP1 guest (`zk/program`), Solidity golden tests, and the
frontend TS port.

> **Journal note.** The research doc describes v1's 7-field journal. All new instances use the
> two-lane journal (empty-lane-as-zero-accumulator; see
> [`../../research/MULTI_PROGRAM_PLATFORM.md`](../../research/MULTI_PROGRAM_PLATFORM.md) §4), now at
> **v3** with the bounty `recipient` and `instanceDomain` fields appended
> ([`../PROGRAMS.md`](../PROGRAMS.md)).

To operate the program, see [`RUNBOOK.md`](./RUNBOOK.md).
