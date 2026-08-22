# Research and design provenance

This directory records design exploration, measurements, decisions, and deviations that explain
why the shipped architecture looks the way it does. It is not the primary operator documentation;
current setup and runbooks live in [`docs/`](../docs/).

- Top-level topic documents capture accepted designs or active investigations.
- Topic directories contain executable references, fixtures, simulations, and benchmark results.
- [`DEVIATIONS.md`](./DEVIATIONS.md) records intentional differences between accepted designs and
  implementation.
- [`archive/`](./archive/) contains superseded work retained for provenance.
- [`audits/`](./audits/) contains dated review artifacts.
- [`plans/`](./plans/) contains active, scoped implementation plans that are not operator docs yet.

When a proposal becomes an operator-facing workflow, keep the rationale here and document the
supported procedure under `docs/build/`.
