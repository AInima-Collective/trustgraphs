# TypeScript packages

This directory contains every pnpm workspace in the repository. Applications and deployable
services live here too: they are still versioned JavaScript/TypeScript packages, so a separate
`apps/` hierarchy would add another classification without improving ownership.

| Package | Responsibility |
|---|---|
| [`frontend/`](./frontend/) | Next.js web application and browser-side verification |
| [`indexer/`](./indexer/) | Ponder indexer and query API |
| [`eas-offchain-client/`](./eas-offchain-client/) | Browser-compatible EAS offchain signing and bundle client |
| [`eas-offchain-relay/`](./eas-offchain-relay/) | Reference relay for validating, storing, and anchoring EAS offchain bundles |

Install and operate the workspaces from the repository root:

```sh
pnpm install
pnpm --filter trustgraphs-frontend dev
pnpm --filter trustgraphs-indexer dev
pnpm --recursive --if-present typecheck
pnpm --recursive --if-present test
```

Package-specific setup and commands are documented in each package's README and `package.json`.
