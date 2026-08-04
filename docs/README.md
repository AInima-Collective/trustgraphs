# docs/ — operator documentation

How to set up, run, and operate TrustGraph today. Design provenance (the *why*) lives in
[`../research/`](../research/); superseded designs are in [`../research/archive/`](../research/archive/).

## By what you're trying to do

| I want to… | Read |
|---|---|
| understand what this is, without jargon | [`ELI5.md`](./ELI5.md) |
| get the toolchains installed and the guests built | [`SETUP.md`](./SETUP.md) |
| watch the whole thing run on a local chain | [`trust-graph/DEMO.md`](./trust-graph/DEMO.md) |
| know which programs exist, their vkeys and instances | [`PROGRAMS.md`](./PROGRAMS.md) |
| know exactly what the scores mean | [`ALGORITHM.md`](./ALGORITHM.md) |
| run the proving daemon | [`OPERATOR.md`](./OPERATOR.md) |
| deploy a program, or operate one by hand | that program's `RUNBOOK.md` — indexed in [`PROGRAMS.md`](./PROGRAMS.md) |
| exercise a program end to end locally | that program's `LOCAL_TESTING.md` — same index |
| deploy to a real chain | [`PRODUCTION.md`](./PRODUCTION.md) (no production network is live today) |
| know where a build departed from its plan | [`DEVIATIONS.md`](./DEVIATIONS.md) |

[`PROGRAMS.md`](./PROGRAMS.md) is the authoritative per-program index — status, vkey, deployed
instances, and every doc each program owns. It is deliberately the only place that list is
maintained. Each program directory has the same shape: `ARCHITECTURE.md` (what it is, pointer to
the research design), `RUNBOOK.md` (deploy + operate), and where applicable `LOCAL_TESTING.md`
(end-to-end walkthrough on a local chain).

## Related

- [`../research/`](../research/) — design documents (`ZK_ARCHITECTURE.md`, program plans,
  economics); the file of record for *why* the system is shaped this way
- [`../paper/`](../paper/) — the governance research paper (LaTeX)
- [`../test/golden/`](../test/golden/) — cross-language golden vectors, one file per program
