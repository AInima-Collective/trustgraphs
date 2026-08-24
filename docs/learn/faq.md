# Questions

Start with [What is trustgraphs?](./what-is-trustgraphs.md) for the distinction between the
platform and its standard EAS vouching program.

## Basics

**Is every trustgraph a vouching network?**
No. Vouching is the main supported implementation today: EAS vouches become graph edges and a
seeded PageRank-style program produces reputation scores. Other programs can authenticate
different records and produce allocations, composed scores, or other verifiable results.

**What makes source data verifiable?**
That depends on the program. An Ethereum transaction and EAS attestation have chain history and a
signer. An offchain event may have a signature and an anchored history commitment. A proven source
root has its own program and checkpoint. The program must define exactly what it authenticates; a
zero-knowledge proof does not make an unsupported claim trustworthy.

**What is an attestation?**
An attestation is a signed statement encoded under a schema. The standard vouch program uses
Ethereum Attestation Service attestations, but a vouch is only one possible attestation type.
Contribution claims, responses, and valuations also use attestations without meaning “I trust this
account.”

**How often do outputs update?**
Networks advance in epochs. Each checkpoint freezes the input commitments and parameters for one
round, and an accepted proof records the next output. The cadence is network-specific, and a
settled historical round is not recalculated.

## Vouch scoring and gaming

**Who picks the starting accounts?**
For a standard vouch network, the creator supplies the initial set and the creation flow gives
them equal starting shares. A weighted-prior network accepts an explicit allocation instead. The
standard network's DAO governs future changes; a weighted network uses either its DAO or its
wallet admin, depending on the authority chosen at creation. The starting set or prior is a visible
part of the network's trust model.

**Why do disconnected bot armies receive zero?**
The standard algorithm only scores accounts reachable from the starting set through active
vouches. A disconnected ring can add internal edges without gaining influence or changing the
reachable scores. Lowering the reserved starting share divides the remainder among reachable
non-starting accounts; it does not remove the reachability gate.

**Can the algorithm tell whether every account is a real person?**
No. It limits what a disconnected cluster can do, but it does not prove personhood or good
judgment. A trusted member can vouch carelessly, collude, or accept an incentive. The proof shows
that the published algorithm was followed; it does not make the social inputs wise.

## Proofs and privacy

**What does the zero-knowledge proof establish?**
It shows that the program accepted by the network's verifier at submission produced the committed
output from a witness matching the checkpointed inputs and parameters. Checkpoints do not pin the
verifier, so verifier governance remains part of the trust model. The exact statement also depends
on the program and its source adapter.

**Does zero knowledge make the graph private?**
Not automatically. Standard onchain EAS vouches and their published scores are public. A program
can keep restricted witness data out of its public journal, but collection, storage, publication,
and future availability still need a separate privacy design.

**How do you know a prover did not leave a record out?**
For standard onchain EAS networks, the resolver commits every accepted attestation and revocation
to an ordered accumulator. The guest must reproduce the checkpointed commitment and count. Other
programs use their own anchored-history or source-capture rules and must document what completeness
means for them.

## Running a network

**Who can create a network?**
Anyone can use an available factory. The standard wizard creates the network and its governed DAO
Safe in one transaction; no project-maintained allowlist approves new instances.

**Who controls it after creation?**
The standard vouching wizard makes a DAO Safe the network admin. Members govern protected changes
through delayed, score-weighted proposals. The creator is not a direct admin, although the
governed factory gives the creator a slow and visible recovery role. Weighted and composition
workspaces can instead create wallet-owned instances. See [Governance](./governance.md).

**What does it cost?**
Creation and onchain inputs cost transaction fees. Proving also costs compute, output publication,
and submission gas. A network can fund a proving vault, or a community can operate a prover without
a bounty.

**Do I have to run a server?**
Not necessarily. Proof submission is permissionless, so a compatible operator can serve the
network. Run independent infrastructure when availability matters or no operator has agreed to
cover the work. Offchain or restricted sources can add witness-retention responsibilities that a
public onchain EAS network does not have.

**Can another application use the output?**
Yes. Address-based score and allocation programs publish output files, while contracts and apps
can verify an individual value and Merkle proof against the accepted onchain root. Programs with a
different output domain document their own leaf encoding and integration path.

## Status

**Is this ready for production?**
Trustgraphs is still pre-production. Review the contracts, program semantics, deployment
configuration, source availability, and governance assumptions before using an output for a
decision with material consequences.

**Has it been audited?**
Not by an outside firm. Use a network only for decisions whose failure you can tolerate.

**Where are the technical details?**
Read [Architecture](../concepts/architecture.md), [Networks and
programs](../concepts/networks-and-programs.md), and [Epochs and
proofs](../concepts/epochs-and-proofs.md). The [vouch scoring algorithm](../concepts/algorithm.md)
covers the standard EAS computation specifically.
