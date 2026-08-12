# signer-sync — architecture

`signer-sync` keeps a community Safe's owner set in sync with its trust graph. It is a second
SP1 program that proves the deterministic top-N selection of Safe owners from the same vouch
graph the [`trust-graph`](../trust-graph/architecture.md) root producer scores, so the proven
score root and the proven signer set are consistent by construction: same inputs, same params,
same deterministic algorithm.

**Inputs.** The same `AttestationAccumulator` checkpoint and governance-pinned `paramsHash` as
the trust-graph instance it follows, plus a selection rule (`topN`, `minThreshold`,
`targetThresholdBps`) pinned separately as `selectionParamsHash`. The guest re-runs the
canonical PageRank over the checkpointed edges and then applies the selection deterministically
(`pagerank-core::signer::compute_signers`).

**What the journal commits.** The signer journal is its own tuple, distinct from the root
producer's: the checkpoint's `(acc, leafCount)`, `paramsHash`, `selectionParamsHash`, and the
outputs `signerSetRoot` (the commitment to the selected owner set) and `targetThreshold`. The
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
