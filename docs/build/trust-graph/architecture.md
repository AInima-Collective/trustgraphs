# trust-graph — architecture

`trust-graph` is the root-producer program, the one every trustgraphs network runs. Once per
epoch it computes fixed-point Trust-Aware PageRank over a community's vouch attestations and
proves that computation in the SP1 zkVM, so the `{account → score}` merkle root that lands
on-chain is checked by a contract rather than taken on trust from an operator. Producing and
submitting the proof is permissionless: anyone may run the loop, and `submitProof` does not care
who called it.

**Inputs.** Members attest trust edges directly against EAS using the instance's vouching schema
(`string comment, uint256 confidence`). The instance's `EASIndexerResolver` folds every
attestation and revocation into an on-chain `AttestationAccumulator`, a chained hash over the
ordered edge log. A permissionless `trigger()` freezes a checkpoint `(acc, leafCount)`; the
prover reconstructs the exact edge set from the `EdgeFolded` logs (`crates/input-exporter`)
and the guest re-folds it to the checkpointed accumulator, so input completeness is proven, not
assumed. The guest replays those records in `(block timestamp, fold index)` order: an attestation
replaces the current vouch for its `(attester, recipient)` pair, and a revocation clears the pair
only if it names that current vouch's UID. Clearing a pair never falls back to an older vouch; a
later attestation can explicitly reactivate it. Scoring parameters are governance-pinned as
`paramsHash`. An instance can also wire a second, off-chain input lane (an `AnchorRegistry` of
signed attestation logs); an absent lane commits as the zero accumulator.

**What the journal commits.** The guest (`zk/program`, bin `trustgraph-program`) runs
`pagerank-core::compute` and commits the ABI-encoded journal tuple as its public values: both
lanes' input commitments, `paramsHash`, the `outputRoot` over `(address, value)` leaves, the
canonical score blob's sha256 and CID, `totalValue`, `skippedDigest`, the bounty `recipient`,
and the `instanceDomain` that binds the proof to one snapshot on one chain.
`MerkleSnapshot.submitProof` rebuilds that digest from its own checkpointed storage, hands the
proof to the `SP1JournalVerifier` pinned to this program's verification key, and reverts on any
mismatch.

**Who consumes the output.** Governance (`MerkleGovModule` on the community Safe) weights votes
by proven scores; `MerkleFundDistributor` splits reward pools by them; the
[`signer-sync`](../signer-sync/architecture.md) program derives the Safe owner set from the same
inputs; the [`contributions`](../contributions/architecture.md) program reads the same vouch
graph (through a mirror) as its reputation input; and the frontend and indexer render the member
roster from the blob pinned at the committed CID.

The canonical algorithm and every byte encoding live in `crates/pagerank-core` (which
re-exports the shared `crates/zk-core` primitives) and are proven byte-identical across native
Rust, the SP1 guest, the Solidity golden tests, and the frontend TS port.

The design of record is
[`research/ZK_ARCHITECTURE.md`](../../../research/ZK_ARCHITECTURE.md).

> **Journal note.** The research doc describes v1's 7-field journal. All new instances use the
> two-lane journal (empty-lane-as-zero-accumulator; see
> [`research/MULTI_PROGRAM_PLATFORM.md`](../../../research/MULTI_PROGRAM_PLATFORM.md) §4), now at
> **v3** with the bounty `recipient` and `instanceDomain` fields appended
> ([`networks-and-programs.md`](../../concepts/networks-and-programs.md)).

To operate the program, see [`runbook.md`](./runbook.md); to exercise it end to end locally,
[`local-testing.md`](./local-testing.md).
