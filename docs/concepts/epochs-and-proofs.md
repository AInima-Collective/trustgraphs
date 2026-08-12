# Epochs and proofs

Scores in trustgraphs are not updated continuously. They advance in rounds called epochs: the
vouch set is frozen at a checkpoint, anyone proves the scores over exactly that frozen set, and
the proven result is recorded for good. This page explains the round structure, what the proof's
public outputs (the journal) contain, and what the contract checks before accepting a proof.

Nothing is deployed to production today; Ethereum mainnet is the target chain.

## What an epoch is

An epoch is one scoring round. Anyone calls `MerkleSnapshot.trigger()`, which freezes the
current state of the vouch history as a numbered **checkpoint**: the accumulator's chained hash
(`acc`), its edge count (`leafCount`), and the block number. The trigger also pins the scoring
parameters in force at that moment, so a later parameter change never affects a round already
in flight.

Three properties follow:

- **The input set is frozen.** Scores for checkpoint N are computed over exactly the vouches
  that existed when N was frozen. Vouches created afterwards belong to the next round.
- **Boundaries are not prover-chosen.** A network can set a fixed epoch length in blocks; when
  it does, `trigger()` only fires after the boundary has passed, and it refuses to mint a
  checkpoint when nothing has changed since the last one.
- **Past rounds are never recalculated.** Each proven result is filed at its checkpoint's
  freeze block, and checkpoints apply monotonically: an older checkpoint's proof can never
  overwrite a newer one. "Score as of block N" stays honest forever, even though proving is
  permissionless, delayed, and possibly racy.

## Input completeness: why nothing can be left out

Every vouch and revocation is folded, as it happens, into an on-chain chained hash (the
`AttestationAccumulator`). The checkpoint pins that hash. Inside the zkVM, the guest program
re-folds the entire edge list it was given and asserts the result equals the checkpointed
`acc` and `leafCount`. A prover who omits an edge, invents one, or reorders history produces a
different hash, and the proof simply does not verify. Completeness is proven, not audited.

## The journal: the proof's public outputs

A zero-knowledge proof shows that a program ran correctly, and the **journal** is what that
program publicly committed while running. It is the entire interface between the guest and the
chain. The trust-graph journal (version 3, defined in `packages/pagerank-core` with field order
frozen) contains twelve fields:

| Field | What it commits |
|---|---|
| `acc`, `leafCount` | the vouch accumulator at the checkpoint (input completeness, lane 1) |
| `anchorAcc`, `anchorCount` | the second input lane's accumulator at the checkpoint; zeros for a vouch-only network |
| `paramsHash` | hash of the exact scoring parameters used |
| `outputRoot` | the `{account → score}` merkle root: the result |
| `ipfsHash`, `cidDigest` | digest of the canonical scored data blob, and the hash of the IPFS CID string that points at it, so a valid proof cannot ship a CID that resolves to different data |
| `totalValue` | the sum of all scores |
| `skippedDigest` | commitment to any deterministically skipped second-lane records; zero when nothing was skipped |
| `recipient` | the bounty payee the prover named; zero means no bounty |
| `instanceDomain` | which deployment this proof is for, derived from the contract address and chain id |

The checkpoint's block number is deliberately not in the journal: the contract reads it from
its own checkpoint storage, so the guest never needs to be told about chain state it cannot
verify.

## What submitProof checks

`MerkleSnapshot.submitProof(checkpointId, outputRoot, ipfsHash, ipfsHashCid, totalValue,
skippedDigest, recipient, proof)` is permissionless. Before writing anything it:

1. **Enforces monotonicity.** The checkpoint must be newer than the last applied one.
2. **Loads the frozen inputs.** The checkpoint's `(acc, leafCount)` and second-lane values
   come from chain-pinned storage, never from the caller.
3. **Loads the pinned parameters.** The params hash pinned at this checkpoint's trigger, not
   whatever is current; an unpinned checkpoint is rejected.
4. **Rebuilds the journal digest** from all twelve fields: the chain-pinned inputs and params,
   the caller's claimed outputs, the `recipient` argument, and an `instanceDomain` the contract
   derives from its own address and chain id. The last two are what a submitter cannot forge: a
   proof naming payee A cannot be replayed naming payee B, and a proof for one deployment
   cannot land on another.
5. **Verifies the proof.** `SP1JournalVerifier` checks that the proof's public values hash to
   exactly this digest, then that the SP1 proof is valid for the program's verification key
   (the vkey, which identifies one exact guest binary).
6. **Records the result.** The root is filed at the checkpoint's input-freeze block, the
   checkpoint's bounty recipient is recorded, and registered consumer hooks are notified.

If any step fails, the transaction reverts and nothing changes. If all succeed, the root is as
trustworthy as the guest program and parameters that governance pinned; no honesty assumption
about the prover remains.

## See also

- [Architecture](./architecture.md): where epochs sit in the full pipeline.
- [The algorithm](./algorithm.md): what is actually computed each round.
- [Networks and programs](./networks-and-programs.md): vkeys and how one proof system serves
  many deployments.
- [Run a prover](../build/run-a-prover.md): produce these proofs yourself.
- [Reproduce an epoch](../verify/reproduce-an-epoch.md): check a round from public data.
