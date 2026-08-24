# Vouch scoring algorithm

This page specifies the seeded PageRank-style algorithm used by the standard EAS vouch program.
It is not the definition of every Trustgraphs program. Contributions, score compositions, and
other data sources have their own input semantics and may produce different kinds of output.

## Goal and limits

The algorithm turns a directed graph of weighted vouches into a fixed pool of reputation points.
It is designed so a disconnected cluster of accounts cannot create standing merely by vouching
for itself.

That property is narrower than “solving Sybil resistance.” The network still relies on its
starting accounts and scored members to judge their outgoing vouches. If a trusted path enters a
malicious cluster, influence can follow it.

## Inputs

After attestations and revocations are reconciled, the scoring input contains:

- a set of directed edges from attester to recipient;
- a non-negative weight for each active edge;
- the trusted starting accounts;
- the share of starting influence reserved for those accounts;
- a damping factor and a per-hop trust-decay factor;
- a convergence tolerance and maximum iteration count; and
- the fixed output pool to distribute.

The standard program gives every starting account an equal part of the reserved starting share.
The weighted-prior program is separate: it uses a committed account-and-weight allocation as a
persistent personalized prior and follows its own mass-conserving recurrence. That algorithm is
not specified on this page.

## Reachability gate

The program first finds every account reachable from a starting account by following active,
positive-weight vouches. Accounts outside that set remain at zero throughout scoring. Their edges
do not affect reachable accounts, and normalization does not assign them rounding remainder.

This makes the boundary easy to state: a disconnected component has no influence until a directed
path from the trusted starting set reaches it.

## Initial distribution

Let `S` be the fixed-point precision scale and `t` the configured starting share.

```text
initial(i) =
  t / number_of_starts                       when i is a starting account
  (S - t) / number_of_reachable_non_starts  when i is reachable and not a start
  0                                          otherwise
```

The creation flow defaults to reserving the full share for the starting accounts. If governance
lowers that share, only reachable non-starting accounts divide the remainder; disconnected
accounts still receive zero.

## Iterative score flow

For each eligible sender `j`, the program divides its outgoing influence in proportion to its
edge weights. Multiplying all of one sender's weights by the same amount does not change that
division.

Ignoring fixed-point rounding for readability, each iteration is:

```text
next(i) = (1 - d) × initial(i)
        + d × Σ current(j) × edge_share(j, i) × distance_decay(j)
```

where:

- `d` is the damping factor;
- `edge_share(j, i)` is the weight from `j` to `i` divided by `j`'s total eligible outgoing
  weight; and
- `distance_decay(j)` is the configured trust-decay factor raised to the shortest directed
  distance from a starting account to `j`.

Self-vouches and zero-weight edges do not carry influence. A sender outside the reachable set has
zero distance factor and contributes nothing.

The program stops when the largest score change is below the configured tolerance or when it
reaches the maximum iteration count. It then normalizes the reachable result to the precision
scale and converts it into the configured whole-number point pool. Deterministic account ordering
assigns any rounding remainder.

## Determinism

Consensus arithmetic uses integers scaled by `10^18`; it does not use floating point. Records,
nodes, and output entries have canonical ordering, so the same reconciled graph and parameters
produce the same bytes on every machine.

The canonical Rust implementation is compiled into the SP1 guest and used by the native prover.
The browser implementation is checked against the same golden vectors. The proof binds the exact
input commitments, parameter hash, output root, and output-file digest; the snapshot's current
verifier determines which guest verification key is accepted at submission.

## What changes a score

A future score can change when:

- a member creates, replaces, or revokes a vouch;
- governance changes a starting account or scoring parameter;
- a weighted network activates a new prior; or
- governance adopts a verifier for a new program version.

Input and parameter changes apply through new checkpoints. A verifier rotation applies immediately
to later submissions, even for an already-triggered checkpoint. Neither path rewrites an accepted
historical output.

For the checkpoint and proof statement, see [Epochs and proofs](./epochs-and-proofs.md). For a
plain-language walkthrough, see [How vouch scoring works](../learn/how-scoring-works.md).
