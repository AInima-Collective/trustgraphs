# Networks and programs

A **network** is what a community deploys: its own vouch graph, its own scores, its own
governance, running on its own set of contracts. When you [create a network](../build/create-a-network.md),
you get an isolated deployment; your community's vouches never mix with anyone else's.

Under the hood, trustgraphs is a platform of zero-knowledge-proven graph computations, and
"network" maps onto two internal axes that are worth keeping apart:

- A **program** is one proven computation: one guest binary (the code that runs inside the
  zkVM), one journal shape (its public outputs), and one parameter schema. Each program has its
  own verification key (vkey) and its own golden-vector family. The flagship program is
  **trust-graph**, the vouch-based scorer described in [the architecture](./architecture.md);
  the others below reuse the same proving machinery for different computations.
- An **instance** is one deployment of a program: a chain, a contract set (snapshot and
  verifier, accumulator or registry), a parameter set, and an indexer/frontend view. The same
  program can run as many instances as there are communities, with zero code changes.

So a community's network is an _instance_ of the trust-graph _program_ (plus any companion
programs it enables). Adding a program costs code, proofs, and vectors; adding an instance
costs only a deployment. The design rationale is in
[`research/MULTI_PROGRAM_PLATFORM.md`](../../research/MULTI_PROGRAM_PLATFORM.md).

## Program index

This table is the authoritative list of programs: status, vkey, docs, and instances.

| Program                                                  | Status               | vkey                                                                                                        | Docs                                                                                                                                                                                                                  | Instances                                                                                               |
| -------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **trust-graph** (root producer)                          | **Built**            | `0x005c236fe2e6157bd911925c2faefcae4d903e229dee2fc0ef555763dd31c496` (journal v3)                           | [architecture](../build/trust-graph/architecture.md) · [runbook](../build/trust-graph/runbook.md)                                                                                                                     | no production deployment yet; Ethereum mainnet is the target (see [production](../build/production.md)) |
| **trust-graph-weighted** (weighted-prior root producer)  | **Built**            | `0x00f0f5e01928bfa9f530392ff7b9cab1efae6ec513eb156cb44d15f5a37b0ed2` (journal v3; detached SP1 6.3.1 guest) | [contract architecture](../build/weighted-prior/architecture.md) · [rotation/recovery runbook](../build/weighted-prior/runbook.md)                                                                                    | no production deployment yet; factory address is optional indexer configuration                         |
| **trust-compose** (captured final-distribution composer) | **Built**            | `0x002781fb8a17a5586cec2eb47f891d9d292b25f9547e8f0a0309b67efb82d641` (journal v3; detached SP1 6.3.1 guest) | [contract architecture](../build/composition/architecture.md) · [rotation/recovery runbook](../build/composition/runbook.md) · [implementation and measurements](../../research/composition/README.md) · [accepted design](../../research/TRUSTGRAPHS_COMPOSITION.md) | no production deployment yet                                                                            |
| **signer-sync** (Safe owner rotation)                    | **Built**            | `0x00ae498beaea90c508eb3462169d6c516e864672fcadf135bb8a36f5b3ce51f0` (its own `SignerJournal` shape)        | [architecture](../build/signer-sync/architecture.md) · [runbook](../build/signer-sync/runbook.md)                                                                                                                     | consumer `SignerSyncZkModule` on the trust-graph instance (reuses its accumulator + `paramsHash`)       |
| **hypercerts** (AT-proto graph)                          | **Built**            | `0x00b22def0bde6796acb3442691deb78056393de318e658aead32b38dbb425346` (journal v3; SP1 6.3.1)                | [architecture](../build/hypercerts/architecture.md) · [runbook](../build/hypercerts/runbook.md)                                                                                                                       | pilot on Ethereum mainnet planned (Sepolia rehearsal first)                                             |
| **contributions** (rep-weighted funding split)           | **Built**            | `0x00ad63b643bf1af6995e0fd21e444db6d9b831375b601f951c1666f2e1a7231d` (journal v3; SP1 6.3.1)                | [architecture](../build/contributions/architecture.md) · [runbook](../build/contributions/runbook.md) · [interfaces](../build/contributions/interfaces.md) · [local testing](../build/contributions/local-testing.md) | local anvil dev (full round proven + paid out, wei-exact vs the golden fixture)                         |

**A note on vkeys.** A vkey identifies one exact guest binary. It rotates on any change to that
guest's code or a shared crate it depends on, and even on toolchain changes, so deployment
vkeys must be derived on the pinned toolchain (measurements:
[`research/VKEY_NOTES.md`](../../research/VKEY_NOTES.md); re-derive with
`task zk:vkey PROGRAM=…`).

## Layout

Where each piece lives in the repository:

- `packages/zk-core` — shared, program-agnostic byte encodings (words/fold/merkle/fixed/cid/journal),
  the single source of truth for the primitives; every program's core crate re-exports it.
- `packages/pagerank-core` — trust-graph + signer semantics and their Params/Journal encodings.
- `packages/weighted-prior-core` and `zk/weighted-program` — isolated weighted-prior semantics and
  guest, kept outside the legacy guest dependency graph.
- `packages/composition-core` and `zk/composition-program` — isolated source-aware Hamilton
  composition semantics and guest, likewise kept outside every legacy guest dependency graph.
- `zk/program` — one multi-bin guest crate: every program's zkVM binary, built together.
- `zk/prover` — one host CLI (`trustgraph-prover`) with a subcommand group per program.
- `test/golden/<program>.json` — one golden-vector file per program, enforcing four-way parity
  (native Rust / SP1 guest / Solidity / TypeScript). Exception: signer-sync shares
  `trust-graph.json`, since it reads the same attestation feed.
- `docs/build/<program>/` — how to operate each program (runbooks, params, addresses);
  [`research/`](../../research/) holds the design provenance.

Want to add a program of your own? See [add a program](../build/add-a-program.md). To stand up
another instance of an existing program, see [create a network](../build/create-a-network.md):
it is only a deployment, no Rust, no guest, no vectors.
