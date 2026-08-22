# Contracts

This directory owns the complete Foundry codebase and the TypeScript deployment helpers that act
on it.

| Path | Responsibility |
|---|---|
| `src/` | Production Solidity contracts and interfaces |
| `test/` | Solidity unit, integration, fixture, and golden-vector tests |
| `script/` | Foundry deployment, migration, seeding, and research scripts |
| `deploy/` | TypeScript deployment orchestration and configuration helpers |

Foundry remains configured at the repository root so the usual commands do not need a directory
change:

```sh
forge build
forge test
forge fmt --check
```

Cross-language fixtures and golden vectors consumed by these tests live in [`tests/`](../tests/).
Deployment outputs are local generated state under `.docker/`, `broadcast/`, and `out/`; they are
not source files.
