# docs/ — trustgraphs product documentation

User-facing documentation for trustgraphs, organized shallow-to-deep. This tree is the source
the in-app `/docs` pages render from; the filesystem layout is the sitemap.

Design provenance (the *why*) lives in [`../research/`](../research/); superseded designs are in
[`../research/archive/`](../research/archive/). Historical build records (deviations, audits, lab
measurements) also live in `research/` — they are not product documentation.

## Sections

- [`learn/`](./learn/) — what trustgraphs is and why it works, for anyone. No jargon, no code.
  Start at [`what-is-trustgraphs.md`](./learn/what-is-trustgraphs.md).
- [`concepts/`](./concepts/) — how the system fits together, for readers who want the mechanics:
  the [architecture](./concepts/architecture.md), [networks and programs](./concepts/networks-and-programs.md),
  [epochs and proofs](./concepts/epochs-and-proofs.md), and the full
  [algorithm spec](./concepts/algorithm.md).
- [`build/`](./build/) — for developers. Leads with [creating a network](./build/create-a-network.md)
  and [integrating scores](./build/integrate-scores.md); the advanced pages
  ([run a prover](./build/run-a-prover.md), [run an agent](./build/run-an-agent.md),
  [production](./build/production.md), [add a program](./build/add-a-program.md)) and the
  per-program directories
  (`trust-graph/`, `weighted-prior/`, `composition/`, `signer-sync/`, `hypercerts/`,
  `contributions/`) cover operating the
  machinery yourself.
- [`verify/`](./verify/) — check the work: [reproduce an epoch from public data](./verify/reproduce-an-epoch.md),
  [golden vectors and cross-language parity](./verify/golden-vectors.md), and
  [addresses and vkeys](./verify/addresses-and-vkeys.md).

## By what you're trying to do

| I want to… | Read |
|---|---|
| understand what this is, without jargon | [`learn/what-is-trustgraphs.md`](./learn/what-is-trustgraphs.md) |
| see how scores are computed and proven | [`learn/how-scoring-works.md`](./learn/how-scoring-works.md) · [`concepts/algorithm.md`](./concepts/algorithm.md) |
| stand up a trust network for my community | [`build/create-a-network.md`](./build/create-a-network.md) |
| understand or rotate a weighted prior | [`build/weighted-prior/architecture.md`](./build/weighted-prior/architecture.md) · [`runbook.md`](./build/weighted-prior/runbook.md) |
| create or rotate a score composition | [`build/composition/architecture.md`](./build/composition/architecture.md) · [`runbook.md`](./build/composition/runbook.md) |
| read scores from my app or contract | [`build/integrate-scores.md`](./build/integrate-scores.md) |
| run everything locally, end to end | [`build/setup.md`](./build/setup.md) → [`build/quickstart.md`](./build/quickstart.md) |
| run the proving daemon | [`build/run-a-prover.md`](./build/run-a-prover.md) |
| delegate upkeep, voting, or human-signed EAS relay | [`build/run-an-agent.md`](./build/run-an-agent.md) |
| deploy to a real chain | [`build/production.md`](./build/production.md) |
| check the system's claims for myself | [`verify/`](./verify/) |

[`concepts/networks-and-programs.md`](./concepts/networks-and-programs.md) is the authoritative
per-program index — status, vkey, deployed instances, and every doc each program owns. It is
deliberately the only place that list is maintained.

## Related

- [`../research/`](../research/) — design documents (`ZK_ARCHITECTURE.md`, program plans,
  economics); the file of record for *why* the system is shaped this way
- [`../paper/`](../paper/) — the governance research paper (LaTeX)
- [`../test/golden/`](../test/golden/) — cross-language golden vectors, one file per program
