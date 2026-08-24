# Why you can trust the result

Most scoring systems ask you to trust whoever runs the computer. Trustgraphs separates the person
or service that performs a computation from the evidence that the result is correct.

## The proof checks a specific claim

Each Trustgraphs program defines an exact statement:

- which input commitments it accepts;
- how source records are authenticated and reconciled;
- which parameters apply and which verifier currently defines the accepted program; and
- how the output is encoded.

When a prover submits a result, it also submits a zero-knowledge proof that the program accepted by
the network's current verifier produced that result from inputs matching the checkpoint. The
verifier checks the proof against its program verification key. A different result, input set,
guest, or network does not produce the same valid proof.

The checkpoint pins inputs and parameters, not the verifier. If governance rotates the verifier
before submission, the new verifier also governs checkpoints that were already triggered but not
yet proved. Provenance-enabled deployments record which verifier and program key accepted each
landed result.

The rules use deterministic integer arithmetic, so independent provers reproduce the same output
bytes from the same input.

## Completeness depends on the input source

A correct computation over a selectively chosen input set would still be misleading. Each program
therefore needs a way to bind the proof to the inputs it claims to cover.

For the standard onchain EAS vouch program, the schema resolver folds every accepted attestation
and revocation into a running onchain commitment. The checkpoint freezes that commitment and its
record count. The guest reconstructs the fold, so omitting, inventing, or reordering a record makes
the proof fail.

Other programs use different evidence. An offchain source may verify signed records against an
anchored head and explicit history rules. A composition captures the accepted roots and complete
published outputs of its source networks. The program documentation must say what “complete” means
for that source; the proof system does not supply that definition on its own.

## Zero knowledge is not the same as privacy

Zero-knowledge technology makes a large computation cheap to verify and can keep witness data out
of the proof's public outputs. It does not automatically make a Trustgraphs network private.

The standard onchain EAS implementation uses public vouches and publishes its score set, so its
proof is primarily a correctness and compression tool. A program over restricted source data can
avoid publishing that source through the proof, but its witness collection, output publication,
and data-availability model still determine what is private.

## What the proof does not establish

A valid proof establishes faithful execution of the program accepted by the submission-time
verifier. It does not establish that:

- a signed claim is true or socially useful;
- a starting account made good judgments;
- the scoring rules are fair for a particular decision;
- governance chose the right parameters or program version; or
- private or offchain source data will remain available to future independent provers.

Those are visible trust assumptions rather than hidden operator discretion.

## No trusted scoring operator

Proof submission is permissionless. The verifier does not care who ran the program; it accepts a
result only when the proof matches the network's frozen inputs and parameters and the current
verifier's program key.
For the public onchain EAS path, another prover can reconstruct the input from chain history and
produce the same result if the usual operator disappears.

The published output file still matters for discovering every score, while an account that already
has its value and Merkle proof can verify membership against the onchain root. Source and output
availability are operational requirements, not reasons to trust the scorer's arithmetic.

For the contract-level statement, read [Epochs and proofs](../concepts/epochs-and-proofs.md). To
check a public EAS epoch yourself, [reproduce an epoch](../verify/reproduce-an-epoch.md).
