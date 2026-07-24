# Deviations

Build-time deviations from the normative plans
([`GOAL.md`](../GOAL.md), [`research/OFFCHAIN_ATTESTATIONS_ZK.md`](../research/OFFCHAIN_ATTESTATIONS_ZK.md),
[`research/MULTI_PROGRAM_PLATFORM.md`](../research/MULTI_PROGRAM_PLATFORM.md),
[`research/HYPERCERTS_ATPROTO_PLAN.md`](../research/HYPERCERTS_ATPROTO_PLAN.md)), per GOAL.md ground
rule 1: what changed, why, and which plan section it touches. No silent divergence.

| # | Date | Plan section | What | Why |
|---|---|---|---|---|
| 1 | 2026-07-14 | GOAL.md M0 exit ("both existing programs prove e2e on anvil through the new CLI") | The M0 e2e (`test/e2e/run.sh`, on-chain stage) proves both programs via the new CLI with `SP1_PROVER=mock` and submits through the **real** `SP1JournalVerifier` → `MerkleSnapshot.submitProof` / `SignerSyncZkModule.submitSignerProof` paths, with the SNARK check stubbed at a `MockSP1Gateway` at the `ISP1Verifier` seam. Groth16-real proving was NOT run at M0 exit. | The build box has ~11 GiB RAM (local Groth16 needs 16–32 GiB per LOCAL_TESTING.md) and no prover-network key. Everything M0 changed — CLI, journal binding, vkey pinning, proof-blob encode/decode, contract wiring — is exercised; the SNARK itself is unchanged v1 SP1 machinery. A real-proof e2e rides on M1's live prover-network request (GOAL M1) and M2's rehearsed deploy. |
| 2 | 2026-07-14 | HYPERCERTS_ATPROTO_PLAN §2 (collection table) / §4 | The real `@hypercerts-org/lexicon` v1.1.0 shapes differ from the plan's table: `link.evm` is nested (`proof.message` + `proof.signature`, top-level `address`; key type `any`), `evaluation.subject` and `.score` are OPTIONAL (required: evaluators/summary/createdAt), DID references are `{did:"…"}` wrapper objects, `activity.contributors[].contributorIdentity` is a union with the DID at `.identity`, and `contributors`/`contributionWeight`/`badge.response.weight` are all optional. EIP-712 domain for `link.evm` lives in the lexicon's tests, not the schema JSON (`IdentityLink` v1, no verifyingContract/salt). | Measured against the pinned lexicon at M1 (research/offchain/05-spike-results.md §2). M4's `hypercerts-core` decode + E3/E4 skip rules must follow the real shapes; the plan doc's table stands as written history, this entry is the correction of record. Also for the partner brief: a stock PDS rejects `validate:true` for these NSIDs — records land unvalidated, so guest-side deterministic skip rules (§3.5) are the ONLY shape enforcement. |
| 3 | 2026-07-14 | OFFCHAIN_ATTESTATIONS_ZK §4.2 (envelope 0: "subtract the on-chain revokeOffchain deletion set — chain-complete for free") | Envelope-0 revocation is **in-log**: the chained log carries typed entries (attest/revoke) and the deletion set's completeness is inherited from the signed head. The on-chain `EAS.revokeOffchain` channel is NOT consumed by the guest in v1. | There is no sound way to bind the on-chain deletion set into the proven statement as designed: the guest cannot read chain state, the journal is frozen at 10 fields, and an unbound witness-supplied deletion set would let a prover include revoked edges (a soundness hole, not a liveness one). The two mechanisms that would bind it — an Ethereum storage-proof witness against a checkpointed block hash, or a permissionless on-chain revocation-mirror folded into an accumulator — are both deliberate future events (journal/checkpoint change or new contract). In-log revocation matches the atproto envelope's revocation-by-absence and costs attesters nothing (append one entry, re-sign the head). |
| 4 | 2026-07-23 | GOAL.md (contributions) Interface freeze — Params layout | The contributions `paramsHash` includes `trustDecayFp` (slot 8), though GOAL.md's IF shorthand list of mirrored rep params omits it. 21 fields total, frozen in `docs/contributions/INTERFACES.md` §3. | Stage-1 rep is `pagerank-core`'s algorithm unmodified ("import, don't fork"), and `RankConfig` requires a decay value. A pinned param beats a hardcoded constant; omitting it would make stage-1 a different algorithm than the trust program's. CONTRIBUTION_FUNDING.md §4 ("PageRank params") is satisfied either way. |
| 6 | 2026-07-24 | GOAL.md (cleanup) M2 — Localism Fund removal | The indexer's offchain drizzle migrations were **squashed to a fresh 0000 baseline** instead of appending a `DROP TABLE localism_fund_application` migration on top of the 0001–0007 history. | The GOAL only lists the schema-file edits; the migration files still carried the table (and its name) forward forever. With no production deployment (decision 3) and local ponder DBs being throwaway docker volumes, a clean baseline removes the last localism artifact from the tree. Anyone with an old local offchain schema drops/recreates the `ponder` database once. |
| 5 | 2026-07-23 | GOAL.md (contributions) M1 property list / CONTRIBUTION_FUNDING §5.1 | The padding property is stated as "contributor-list padding never increases any outsider's payout"; the M1 fuzz suite produced a counterexample to every set-level formulation of it and it was replaced by two provable properties: (a) padding a fully-consented claim never increases the padded set's combined take, and (b) with burned consent mass (rejected/unaccepted shares) an accepting padded-in address can recapture value, but the set's take never exceeds the claim's **full-consent ceiling**. §5.1 of the research doc now carries the sharpened statement. | Under relative distribution, shrinking one claim's realized consent mass necessarily grows every other claim's take (and vice versa), so "no outsider payout increases" is unattainable as stated. The recapture path is not a mint — it is bounded by the value raters assigned to the claim — and rejection still strictly reduces the claim's take versus consenting. Tests: `padding_a_fully_consented_claim_never_mints`, `padding_recapture_never_exceeds_the_full_consent_ceiling`. |

Notes that are **not** deviations, recorded for context:

- Executor-only prover commands (`execute`, `vkey`, `paramshash`) default to `SP1_PROVER=mock` in
  `taskfile/zk.yml` and `test/e2e/run.sh`: the default cpu backend eagerly allocates the ~5 GiB CPU
  prover machine these commands never use, OOM-killing small boxes/CI runners. The executor and the
  guest==native byte-assert are identical under mock; `prove` respects the caller's `SP1_PROVER`.
- M0 re-derived vkeys (ELF layout changed under the refactor; semantics didn't — golden vectors are
  byte-identical to pre-reorg). Recorded in [`PROGRAMS.md`](./PROGRAMS.md); rotation of the live stack
  is batched to M2 per GOAL.md ground rule 7.
- Contributions slot-A wiring is a **read-only mirror**, resolving CONTRIBUTION_FUNDING.md §3's
  stated open question ("whether the contrib snapshot reads the trust accumulator's existing
  checkpoints or pushes its own — two snapshots triggering one accumulator needs a look"): the
  contrib `MerkleSnapshot`'s `accumulator` is a `TrustAccumulatorMirror` whose `checkpoint()`
  READS the trust accumulator's live `(acc, leafCount)` and freezes it into the mirror's own
  checkpoint array — nothing is ever pushed into the trust accumulator, so the two instances'
  trigger cadences cannot race and the trust instance's checkpoint ids stay its own. The mirror
  deliberately has NO `NoNewInputs` guard (a quiet vouch graph must not wedge contrib round
  triggers; spam is bounded by the contrib snapshot's `epochLength` gate). The proven input
  commitment is unchanged — `acc` already commits to the full ordered edge log.
- The contributions schema strings are REGISTERED in the canonical comma-no-space form
  (`string title,bytes32 contentHash,…` — the house schema-string format every existing network
  entry uses and the config field parser consumes); `docs/contributions/INTERFACES.md` §1's
  comma-space rendering is table presentation, not wire format. The golden vectors bind schema
  UIDs as opaque placeholders, so nothing golden depends on the string spelling.
