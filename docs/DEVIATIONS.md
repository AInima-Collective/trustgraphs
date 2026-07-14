# Deviations

Build-time deviations from the normative plans
([`GOAL.md`](../GOAL.md), [`research/OFFCHAIN_ATTESTATIONS_ZK.md`](../research/OFFCHAIN_ATTESTATIONS_ZK.md),
[`research/MULTI_PROGRAM_PLATFORM.md`](../research/MULTI_PROGRAM_PLATFORM.md),
[`research/HYPERCERTS_ATPROTO_PLAN.md`](../research/HYPERCERTS_ATPROTO_PLAN.md)), per GOAL.md ground
rule 1: what changed, why, and which plan section it touches. No silent divergence.

| # | Date | Plan section | What | Why |
|---|---|---|---|---|
| 1 | 2026-07-14 | GOAL.md M0 exit ("both existing programs prove e2e on anvil through the new CLI") | The M0 e2e (`test/e2e/run.sh`, on-chain stage) proves both programs via the new CLI with `SP1_PROVER=mock` and submits through the **real** `SP1JournalVerifier` → `MerkleSnapshot.submitProof` / `SignerSyncZkModule.submitSignerProof` paths, with the SNARK check stubbed at a `MockSP1Gateway` at the `ISP1Verifier` seam. Groth16-real proving was NOT run at M0 exit. | The build box has ~11 GiB RAM (local Groth16 needs 16–32 GiB per LOCAL_TESTING.md) and no prover-network key. Everything M0 changed — CLI, journal binding, vkey pinning, proof-blob encode/decode, contract wiring — is exercised; the SNARK itself is unchanged v1 SP1 machinery. A real-proof e2e rides on M1's live prover-network request (GOAL M1) and M2's rehearsed deploy. |

Notes that are **not** deviations, recorded for context:

- Executor-only prover commands (`execute`, `vkey`, `paramshash`) default to `SP1_PROVER=mock` in
  `taskfile/zk.yml` and `test/e2e/run.sh`: the default cpu backend eagerly allocates the ~5 GiB CPU
  prover machine these commands never use, OOM-killing small boxes/CI runners. The executor and the
  guest==native byte-assert are identical under mock; `prove` respects the caller's `SP1_PROVER`.
- M0 re-derived vkeys (ELF layout changed under the refactor; semantics didn't — golden vectors are
  byte-identical to pre-reorg). Recorded in [`PROGRAMS.md`](./PROGRAMS.md); rotation of the live stack
  is batched to M2 per GOAL.md ground rule 7.
