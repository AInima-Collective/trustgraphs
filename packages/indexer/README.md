# Trustgraphs indexer

The Ponder indexer follows deployed Trustgraphs contracts, derives queryable state, and serves the
API consumed by the frontend.

From the repository root:

```sh
pnpm install
pnpm --filter trustgraphs-indexer dev
pnpm --filter trustgraphs-indexer test
pnpm --filter trustgraphs-indexer typecheck
```

Copy [`.env.example`](./.env.example) to `.env.local` when running commands directly. The package
links the selected root `config/networks.<environment>.json` before starting; local development
normally uses the generated `config/networks.development.json`.

The frontend is the sibling [`frontend`](../frontend/) package. Keep shared public data contracts
explicit, and update both consumers when an indexed schema changes.
