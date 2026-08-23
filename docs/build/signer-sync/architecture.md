# signer-sync — architecture

`signer-sync` keeps a community Safe's owner set in sync with its trust graph. It is a second
SP1 program that proves the deterministic top-N selection of Safe owners from the same vouch
graph the [`trust-graph`](../trust-graph/architecture.md) root producer scores, so the proven
score root and the proven signer set are consistent by construction: same inputs, same params,
same deterministic algorithm.

**Inputs.** The same `AttestationAccumulator` checkpoint and governance-pinned `paramsHash` as
the trust-graph instance it follows, plus a selection rule (`topN`, `minThreshold`,
`targetThresholdBps`, `maxInactiveBlocks`, `minActivityWitnesses`) pinned separately as
`selectionParamsHash`. The guest re-runs the canonical PageRank over the checkpointed edges and
then applies the selection deterministically (`pagerank-core::signer::compute_signers`).

**The authenticated activity fact.** Activity means that the account directly cast its own vote
against a proposal-pinned Merkle proof in the instance's `MerkleGovModule`. `proposeWithVote`, a
direct `castVote`, and a principal overriding its delegate count; delegation and a periodic
heartbeat do not. Every such fact is folded into `activityAccumulator` and immediately
checkpointed. The voter supplies the fact by sending the vote. Anyone can reconstruct it from
events and refresh the checkpoint block without changing anybody's last-activity block.

An RPC or operator can withhold logs from one prover, and a block producer can delay a vote
transaction. Neither can produce a valid incomplete proof: the guest reconstructs the complete
ordered hash chain, while `SignerSyncZkModule` compares the proven checkpoint with the activity
source's live accumulator and count. Another RPC or prover can supply the same public history.

**Freshness and absence.** An account is active when its latest authenticated direct vote is no
more than `maxInactiveBlocks` before the activity checkpoint. The checkpoint itself must still be
within that window when submitted. With no activity checkpoint, stale activity, or fewer than two
distinct authenticated witnesses, the deterministic result is the Safe's exact current owner set
and threshold: absence means **no change**, never “assume dead.” The operator detects that result
before its spend intent and does not buy a no-op proof.

For the first rotation, the witnesses must be fresh scored members. Thereafter at least two must
be current Safe owners. This is the safety/liveness boundary: one account cannot activate removals,
while two live owners in a five-owner Safe can remove three inactive owners and admit lower-ranked
active members. Production deployment also enforces `minThreshold >= 2`.

**What the journal commits.** The signer journal is its own tuple, distinct from the root
producer's: the score checkpoint, selection hash, activity checkpoint, whether a rotation has
previously landed, and the Safe's pre-rotation owner root and threshold, followed by the outputs
`signerSetRoot` and `targetThreshold`. Binding the pre-state prevents a proof built for one owner
set from replacing a different live set. The
program carries its own guest bin (`trustgraph-signer-program`), its own verification key, and
its own `SP1JournalVerifier` instance; `MerkleSnapshot` is untouched.

**Who consumes the output.** `SignerSyncZkModule`, a Zodiac module enabled on the Safe. Its
permissionless `submitSignerProof` rebuilds the journal digest from chain-pinned state, verifies
the proof, then diffs the proven owner set against the Safe's live owner list on-chain and
applies the adds, removals, and swaps, preserving `1 ≤ threshold ≤ ownerCount` at every
intermediate step.

The design of record is
[`research/SIGNER_SYNC_ZK_PLAN.md`](../../../research/SIGNER_SYNC_ZK_PLAN.md).

To operate the program, see [`runbook.md`](./runbook.md); the end-to-end local walkthrough that
exercises signer-sync alongside the root loop is
[`../trust-graph/local-testing.md`](../trust-graph/local-testing.md).
