# Epochs and proofs

Trustgraphs outputs advance in rounds called **epochs**. A checkpoint freezes the input
commitments and parameters for one round, a prover runs the program accepted by the verifier active
at submission, and the result is recorded without rewriting earlier rounds.

The lifecycle is shared across several programs. The exact witness and meaning of each commitment
remain program-specific; this page uses the standard trust-graph journal where field-level detail
is needed.

## What a checkpoint freezes

Anyone can call `MerkleSnapshot.trigger()` when the network is eligible for another checkpoint.
The checkpoint records the primary input accumulator and count, any configured second-lane
commitment, the block number, and the active parameter hash.

Three properties follow:

- **The proof statement is fixed.** Records accepted after checkpoint N belong to a later round.
  A parameter change after the trigger cannot alter N.
- **The prover does not choose the scheduled boundary.** With a nonzero epoch length, the cadence
  is anchored when that setting takes effect. A late trigger consumes the boundary that became due
  rather than shifting every future boundary. The checkpoint still records the actual freeze
  block.
- **Accepted history is monotonic.** A proof for an older checkpoint cannot overwrite a newer
  accepted output. On provenance-enabled deployments, the accepted result records the verifier,
  verifier code hash, program key, and pinned parameters used when it landed.

The verifier is deliberately not frozen by `trigger()`. Governance can rotate it before a proof
is submitted, including for a checkpoint already in flight.

The snapshot rejects a new checkpoint when the committed input state has not changed.

## How input completeness is proven

“Use every input” only has meaning after a program defines the input history it authenticates.

In the standard onchain EAS program, every accepted attestation and revocation is folded into an
`AttestationAccumulator`. The checkpoint pins its chained hash (`acc`) and record count
(`leafCount`). Inside the zkVM, the guest re-folds the complete ordered record list. Omitting,
inventing, changing, or reordering a record produces a different commitment and an invalid proof.

A strict offchain EAS lane uses a separate anchor accumulator and deterministic rules for signed
retained histories. Programs over AT Protocol, Nostr, contribution records, or captured source
roots define different witnesses and completeness rules. The common verifier checks the journal;
the guest program defines what the committed inputs mean.

## The journal

A zero-knowledge proof establishes that a program ran correctly. The **journal** contains the
program's public outputs and bindings; it is the interface the onchain contract verifies.

The standard trust-graph journal v3 contains twelve fields:

| Field | What it commits |
| --- | --- |
| `acc`, `leafCount` | Primary input accumulator and count at the checkpoint |
| `anchorAcc`, `anchorCount` | Optional second-lane accumulator and count; zero for a lane-1-only network |
| `paramsHash` | Exact parameters pinned for this checkpoint |
| `outputRoot` | Merkle root of the program output; address scores for the standard trust graph |
| `ipfsHash`, `cidDigest` | Digest of the canonical output blob and hash of the CID string naming it |
| `totalValue` | Sum of the output values |
| `skippedDigest` | Commitment to deterministic second-lane skip decisions; zero when none apply |
| `recipient` | Proving-bounty recipient named by the proof; zero means no recipient |
| `instanceDomain` | Snapshot contract and chain for which the proof was produced |

The checkpoint block number is not supplied by the guest. The snapshot contract already stores it
and uses its own state when filing the accepted result.

Other programs may give `outputRoot`, the two input lanes, and `skippedDigest` different
program-defined semantics. A shared field shape is not evidence that the source records mean the
same thing.

## What proof submission checks

`MerkleSnapshot.submitProof(...)` is permissionless. Before accepting a result, the contract:

1. requires a checkpoint newer than the last applied checkpoint;
2. loads the frozen accumulator values and counts from contract storage;
3. loads the parameter hash pinned when that checkpoint was triggered;
4. rebuilds the expected journal digest using those values, the claimed output metadata, the
   bounty recipient, and an instance domain derived from its own address and chain;
5. snapshots the current verifier, asks it to check the proof against its program verification key,
   and
6. records the result, its verifier provenance when enabled, and notifies registered consumer
   hooks.

The recipient binding prevents a copied submission from redirecting the proving payment. The
instance binding prevents a valid proof for one snapshot or chain from being replayed against
another.

If any check fails, the transaction reverts. If all checks pass, consumers can rely on the output
being produced by the guest accepted by the submission-time verifier over the pinned commitments
and parameters. They do not need to trust the prover's honesty, but they still need to evaluate
verifier governance, the program, and its data-availability assumptions.

See [Architecture](./architecture.md) for the full pipeline, [Vouch scoring
algorithm](./algorithm.md) for the standard computation, and [Reproduce an
epoch](../verify/reproduce-an-epoch.md) for an independent check of a public EAS result.
