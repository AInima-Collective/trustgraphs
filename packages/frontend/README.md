# Trustgraphs frontend

The Next.js frontend lets users explore trustgraphs, create attestations, manage program
instances, and independently recompute or verify published results in the browser.

From the repository root:

```sh
pnpm install
pnpm --filter trustgraphs-frontend dev
pnpm --filter trustgraphs-frontend test
pnpm --filter trustgraphs-frontend lint
```

Copy [`.env.example`](./.env.example) to `.env.local` when running the app directly. The normal
`dev` command does this automatically when the file is missing, links the selected root network
configuration, and generates the contract bindings. The indexer schema is sourced from the sibling
[`indexer`](../indexer/) package.

Product and operator documentation lives under [`docs/`](../../docs/); implementation-specific
notes remain beside the relevant frontend code.
