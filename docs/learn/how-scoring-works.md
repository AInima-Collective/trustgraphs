# How vouch scoring works

This page describes the standard EAS trust-graph program. It is one concrete Trustgraphs program,
not a rule that every trustgraph must use.

New here? Start with [What is trustgraphs?](./what-is-trustgraphs.md)

## Vouching creates the graph

A vouch is one Ethereum account publicly expressing trust in another, with a weight attached. In
the standard program, vouches are recorded as Ethereum Attestation Service attestations. The
signer can replace or revoke a vouch, and the next checkpoint reconciles that history into the
active graph.

Every active vouch is a directed, weighted edge. The weight controls how the sender divides their
outgoing influence; it does not grant score by itself.

## Trusted starting accounts anchor the result

Simply counting incoming vouches would make fake-account farms cheap. Instead, the standard
program starts from accounts the community selected when it created the network. Starting
influence is split equally between those accounts; a weighted-prior network uses an explicit
allocation instead.

Influence then moves along vouch edges using a deterministic PageRank-style recurrence. A vouch
from an account with substantial score can carry more influence than many vouches from accounts
with none. Influence also decays with directed distance from the starting set according to the
network's governed parameters.

## Reachability is the Sybil boundary

An account that cannot be reached from a starting account through active vouches receives zero
score. A disconnected ring of fake accounts can add as many internal vouches as it wants without
changing the scores of reachable accounts.

This is resistance, not a proof that every scored account is genuine. If a trusted member vouches
into a malicious cluster, influence can enter it. Seed selection, member judgment, and governance
therefore remain important.

Lowering the starting accounts' reserved share does not open a baseline for disconnected
accounts. The remainder is divided only among reachable non-starting accounts; the reachability
gate still applies.

## Scores are published as a verifiable set

Publishing every score in contract storage would be expensive. Instead, the program publishes a
Merkle root: a compact commitment that changes if any output entry changes. The accompanying score
file contains the entries, and an individual entry comes with a Merkle proof showing that it
belongs to the accepted root.

Contracts and applications can verify an account's score against that root without trusting the
server that returned it.

## Scores advance in epochs

Scores refresh in rounds called **epochs**. A checkpoint freezes the committed input state and the
parameters for that round. A prover reconstructs the vouches, runs the program, publishes the
output, and submits a proof. Vouches created or revoked after the checkpoint affect a later epoch.

Accepted historical results are not recalculated. Governance can change parameters for later
checkpoints or rotate the verifier used by later proof submissions. A verifier rotation can affect
an already-triggered checkpoint that has not yet been proved, but it does not rewrite an accepted
root.

## What the scores can do

A score root can support:

- trust-weighted voting, where voting power comes from a proposal-pinned score checkpoint;
- reward distribution, where each account proves its share against the root; and
- applications that need a verifiable reputation signal.

The same vouch history can also be one input to another program. For example, the contributions
program recomputes the canonical reputation scores inside its own proof, uses them to weight peer
evaluations, and produces a funding allocation. The contribution records are a separate input with
different meaning; they are not re-labelled vouches.

Next: [Why you can trust the result](./proofs.md). For the exact recurrence and rounding rules, see
the [vouch scoring algorithm](../concepts/algorithm.md).
