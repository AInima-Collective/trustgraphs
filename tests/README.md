# Shared tests and fixtures

This directory contains test assets that cross codebase boundaries. Tests owned by one language
stay with that codebase: Solidity tests are in [`contracts/test/`](../contracts/test/), Rust tests
are beside their crates, and TypeScript tests are beside their packages.

| Path | Responsibility |
|---|---|
| `e2e/` | End-to-end scripts spanning contracts, prover, indexer, and frontend |
| `fixtures/` | Shared protocol and interoperability fixtures |
| `golden/` | Canonical cross-language input/output vectors |

Golden vectors are consensus-sensitive. If an encoding changes, regenerate the relevant vector
and verify every consumer in the same change. See
[`docs/verify/golden-vectors.md`](../docs/verify/golden-vectors.md).
