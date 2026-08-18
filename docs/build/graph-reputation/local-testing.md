# Test graph reputation locally

Run the independent fixed-point cores and the indexer tests:

```bash
cargo test -p graph-reputation-core
pnpm --dir indexer test
```

The Rust and TypeScript tests consume `test/golden/graph-reputation.json`. The vectors freeze the
disconnected-cartel zero result, the 10% trusted-ingress 16.3225% result, exact node scores,
residuals, and both canonical commitments.

Run frontend checks and a production build:

```bash
pnpm --dir frontend test
pnpm --dir frontend lint
pnpm --dir frontend build
```

With the local contracts and indexer running, open `/graph-reputation`, choose one to eight live
roots from a single registry, confirm the scope hash, and compute. Stop if the UI reports RPC,
history, rotation, or deterministic-bound failure; a missing result is the intended fail-closed
behavior.
