# Trustgraphs documentation

This directory contains the Markdown published at `/docs`. Each public page should help an
external reader understand, use, integrate, or verify trustgraphs.

Internal plans, deployment records, test procedures, audits, and operational checklists belong in
[`research/`](../research/) rather than this directory. Detailed material moved out of the public
site during the documentation cleanup is under
[`research/operations/`](../research/operations/).

## Sections

- [Learn](./learn/) introduces the Trustgraphs model, the standard vouching use case, proofs, and
  governance.
- [Concepts](./concepts/) explains the shared architecture, program boundaries, epochs, and the
  standard vouch scoring algorithm.
- [Build](./build/) covers network creation, score integration, local setup, operations, and one
  overview for each specialized program.
- [Verify](./verify/) explains how to reproduce and check published results.

The route manifest lives in
[`packages/frontend/lib/docs/manifest.ts`](../packages/frontend/lib/docs/manifest.ts). A source
test requires every Markdown page in this directory, except this README, to appear exactly once in
that manifest.

## Editorial standard

Public pages should:

- address the reader directly and explain why a feature matters before implementation details;
- use one canonical explanation instead of repeating the same background across pages;
- avoid milestone names, internal phases, handoff notes, acceptance checklists, and planning status;
- link to source or internal engineering records only when a reader needs deeper implementation
  detail; and
- distinguish current product behavior from proposals or experimental work.
