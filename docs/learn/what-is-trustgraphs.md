# What is trustgraphs?

Trustgraphs is a way to compute useful results from verifiable, relationship-shaped data without
asking everyone to trust the computer that did the work.

A community or application chooses the data, the rules, and the result it needs. Anyone can run
those rules. A zero-knowledge proof shows that the published result came from the committed inputs
and the agreed program.

## A trustgraph is not one particular social graph

The name describes a pattern, not a universal network or algorithm. A trustgraph has three parts:

1. **Verifiable inputs.** The source might be onchain attestations, signed social records, an
   anchored repository history, or the proven output of another network.
2. **A deterministic program.** Public rules turn those inputs into scores, allocations, or another
   result. The same inputs and rules always produce the same output.
3. **A proof and an output commitment.** The proof checks the computation. A compact onchain root
   lets an application verify an individual result without storing the full output onchain.

The proof establishes that the program ran correctly over the inputs it was designed to
authenticate. It does not decide whether the source data is meaningful or whether the community
chose good rules. Those remain part of the network's trust model.

## The main implementation today: vouching

The standard Trustgraphs network uses public Ethereum Attestation Service (EAS) attestations.
Members create weighted, revocable vouches between Ethereum accounts. Those vouches form a
directed graph, and a seeded PageRank-style program turns the graph into reputation scores.

This is the primary path supported by the network creation flow today, but vouching is one way to
produce a trustgraph, not its definition. [How vouch scoring works](./how-scoring-works.md) explains
the behavior and limits of that program.

## Other inputs and results

The same architecture can support programs with different semantics:

- A contributions round authenticates a parent network's vouch history alongside claims,
  responses, and peer evaluations. One proof recomputes reputation, uses it to weight the
  evaluations, and produces a funding allocation. A contribution claim or evaluation is not a
  vouch.
- AT Protocol or Nostr programs can authenticate signed records and define their own rules for
  turning those records into graph edges and scores.
- A composition can combine several proven score sets without merging their raw source data.
- A signer-selection program can recompute ranking from checkpointed vouches, combine it with
  direct-governance activity and current Safe state, and propose a Safe owner set.

These programs share proof infrastructure, but they do not all share the vouching model or the same
algorithm. Their source authentication and maturity also differ; each program's documentation
defines what its proof actually checks.

## Keep reading

- [How vouch scoring works](./how-scoring-works.md): the supported EAS vouching model, trusted
  seeds, and score flow.
- [Why you can trust the result](./proofs.md): what the proof guarantees and what it does not.
- [Architecture](../concepts/architecture.md): the general pipeline and the current onchain EAS
  implementation.
- [Networks and programs](../concepts/networks-and-programs.md): how inputs, computations, and
  output types vary.
- [Governance](./governance.md): who can change a deployed network's protected rules.
