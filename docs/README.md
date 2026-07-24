# docs/ — operator documentation

How to set up, run, and operate TrustGraph today. Design provenance (the *why*) lives in
[`../research/`](../research/); superseded designs are in [`../research/archive/`](../research/archive/).

## Start here

- [`../README.md`](../README.md) — what TrustGraph is, quickstart
- [`ELI5.md`](./ELI5.md) — plain-language explanation
- [`ALGORITHM.md`](./ALGORITHM.md) — the Trust-Aware PageRank specification
- [`PROGRAMS.md`](./PROGRAMS.md) — **the program index**: every SP1 program, its status, vkey, and instances
- [`SETUP.md`](./SETUP.md) — system requirements and toolchain install
- [`PRODUCTION.md`](./PRODUCTION.md) — production deployment notes (no production network is live today)
- [`DEVIATIONS.md`](./DEVIATIONS.md) — the deviation log: where builds departed from their plans, and why

## Per-program guides

Each program directory has the same shape: `ARCHITECTURE.md` (what it is, pointer to the
research design), `RUNBOOK.md` (deploy + operate), and where applicable `LOCAL_TESTING.md`
(end-to-end walkthrough on a local chain).

| Program | Guides |
|---|---|
| trust-graph | [architecture](./trust-graph/ARCHITECTURE.md) · [runbook](./trust-graph/RUNBOOK.md) · [local testing](./trust-graph/LOCAL_TESTING.md) |
| signer-sync | [architecture](./signer-sync/ARCHITECTURE.md) · [runbook](./signer-sync/RUNBOOK.md) |
| hypercerts | [architecture](./hypercerts/ARCHITECTURE.md) · [runbook](./hypercerts/RUNBOOK.md) · [local testing](./hypercerts/LOCAL_TESTING.md) · [reproduce](./hypercerts/REPRODUCE.md) · [partner brief](./hypercerts/PARTNER_BRIEF.md) |
| contributions | [architecture](./contributions/ARCHITECTURE.md) · [runbook](./contributions/RUNBOOK.md) · [local testing](./contributions/LOCAL_TESTING.md) · [interfaces](./contributions/INTERFACES.md) · [audits](./contributions/audits/) |

## Related

- [`../research/`](../research/) — design documents (`ZK_ARCHITECTURE.md`, program plans,
  economics); the file of record for *why* the system is shaped this way
- [`../paper/`](../paper/) — the governance research paper (LaTeX)
- [`../test/golden/`](../test/golden/) — cross-language golden vectors, one file per program
