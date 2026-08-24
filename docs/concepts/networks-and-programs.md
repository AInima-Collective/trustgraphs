# Networks and programs

A **network** is one deployed Trustgraphs instance: its input commitments, parameters, authority,
proof history, and accepted outputs. A **program** is the deterministic computation that defines
what those inputs mean and how an output is produced.

Many networks can use the same program. They remain independent because each deployment has its
own contracts, checkpoints, parameters, governance, and instance-specific proof binding.

## Vouching is a program, not the platform definition

The standard `trust-graph` program interprets EAS attestations as weighted, revocable vouches and
produces address scores. It is the main supported creation path today. The broader architecture can
authenticate other record types and prove other computations.

For example, a contribution claim says that work happened, a response records whether a named
contributor accepts that attribution, and a valuation evaluates the work. None is a vouch. The
`contributions` program gives those records precise semantics, authenticates the parent network's
vouch history, and recomputes reputation and allocation together.

## Programs, consumers, and input extensions

| Component | Role | Input and result |
| --- | --- | --- |
| [Trust graph](../build/trust-graph.md) | Scoring program | EAS vouches → Ethereum-address scores |
| [Weighted prior](../build/weighted-prior.md) | Scoring program | Explicit prior + EAS vouches → Ethereum-address scores |
| [Contributions](../build/contributions.md) | Allocation program | Standard parent vouch history + contribution records → funding allocations |
| [Hypercerts](../build/hypercerts.md) | Scoring program | Anchored AT Protocol records → identity and address scores |
| [Nostr workspace](../build/nostr-workspace.md) | Scoring program | Anchored signed workspace events → scores |
| [Score composition](../build/composition.md) | Composition program | Accepted source score sets + allocation policy → composed allocation |
| [Signer sync](../build/signer-sync.md) | Selection program and Safe module | Standard vouch history + direct-vote activity + Safe state → owner set |
| [Off-chain EAS](../build/offchain-attestations.md) | Optional trust-graph input lane | Signed EAS records + anchored retained history → additional vouch edges |

Support is not identical across these rows:

- The self-service creation interface supports standard trust graphs, weighted-prior networks, and
  score compositions when their factories are configured on the selected chain.
- Contributions rounds and signer sync are attached workflows with narrower parent-network
  compatibility.
- Strict offchain EAS is an optional testnet input extension.
- Hypercerts and Nostr workspace instances currently require specialized deployment and witness
  operations rather than the general network wizard.

## What identifies a program

Every proof-producing program has a program identifier and a verification key. The registry records
the instance's program identity, and the snapshot's current verifier accepts only a proof for its
guest binary. A proof from another program cannot be substituted merely because its output also
uses a Merkle root.

The output domain matters too. An address reputation score, a contribution allocation, an
AT Protocol node score, and a Safe owner-set proposal are different claims even when their byte
encodings share building blocks.

Changing consensus behavior creates a new program version and verification key. Checkpoints pin
their parameters but not their verifier: a verifier rotation affects every later submission,
including an already-triggered, unproved checkpoint. Provenance-enabled factory deployments record
the verifier and program key used for each accepted output.

## What identifies a network

A network has a stable instance ID and a registered contract set. The registry lets indexers,
provers, and applications discover supported deployments without a hand-maintained allowlist. The
proof statement includes an instance domain derived from the snapshot contract and chain, so two
identically configured deployments cannot accept one another's proofs.

To deploy a supported network, see [Create a network](../build/create-a-network.md). To implement a
new deterministic computation, see [Add a scoring program](../build/add-a-program.md).
