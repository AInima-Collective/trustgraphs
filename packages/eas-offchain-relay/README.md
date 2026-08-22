# EAS offchain anchor relay

This is the standalone reference relay for strict Trustgraphs envelope kind `0`. It accepts a
`TrustgraphsEasOffchainBundleV1` at `POST /v1/anchors`, validates the complete payload and both
typed-signature layers, stores and reads back the exact bytes from an IPFS block quorum, simulates
the exact registry call, then submits it with a dedicated `ANCHORER_ROLE` key.

The response deliberately excludes a transaction hash so an original submitter, a retry, and the
loser of a relay race return the same canonical result. `409` responses use `action: "reload"` and
include the current public count, head, and commitment. Clients reload that canonical payload and
reapply their signed draft operations with `applyOperations`.

## Deploy

Build from the repository root:

```sh
docker build -f packages/eas-offchain-relay/Dockerfile -t trustgraphs/eas-offchain-relay .
docker run --read-only --tmpfs /tmp --env-file relay.env -p 8787:8787 trustgraphs/eas-offchain-relay
```

Copy `.env.example` to a secret-managed environment file. `IPFS_TARGETS_JSON` must name at least
two independent Kubo-compatible HTTP APIs; `STORAGE_QUORUM` is at least two. The relay uses
`block/put` with the raw codec and SHA-256, requests a pin, recomputes the CID locally, and checks a
byte-exact `block/get` before any transaction. Configure persistent IPFS repositories and retain
pins indefinitely: the relay has no delete or garbage-collection path, and every historical bundle
is required for proof replay.

Grant the address derived from `RELAYER_PRIVATE_KEY` the registry's `ANCHORER_ROLE`. Use a dedicated
key with only enough native token for anchoring. Do not inject a user wallet key. Deploy a second
relay with a different relayer key and different IPFS targets; both may safely receive the same
bundle. Each deployment stores it first, one transaction lands, and the other recognizes the exact
live count/head/commitment as idempotent success.

## Operations

- `GET /healthz` is process liveness. A submission also verifies chain ID, registry, schema, EAS
  address/version, both onchain domain separators, live node state, projected work, storage, and
  transaction simulation.
- `GET /metrics` binds the deployment to its public chain ID, registry, relayer address, EAS
  address/version, and schema, then reports target/quorum counts, newest anchor count, exact storage
  successes, validation failures, work/capacity, and relayer entry lag. It does not expose payloads,
  signatures, private keys, storage names, credentials, or endpoint URLs. The dark-deploy audit uses
  these immutable public fields to prove that relay A and relay B are actually backed by the two
  expected `ANCHORER_ROLE` addresses; liveness alone is not sufficient.
- Set `ALLOWED_NODE_IDS` to comma-separated node IDs for a private relay. Empty means public.
- Set `ALLOWED_ORIGINS` for browsers; non-browser requests without `Origin` are still accepted.
- Apply an additional distributed rate limit at the edge when running multiple replicas. The
  process also enforces a per-node minute window, JSON body limit, consensus payload limit, and
  2,048-entry node limit. Compressed request bodies are rejected, so an edge proxy cannot turn a
  small declared upload into a decompression bomb inside the relay.
- Logs contain request ID, route, status, error code, and public node ID only. Bodies, payloads,
  signatures, storage authorization headers, RPC credentials, and the relayer key are never logged.
- Back up IPFS repositories and monitor pinned-block replication. Losing old bundles makes historic
  proof regeneration unavailable even though the onchain commitment remains intact.

Run `pnpm --filter @trustgraphs/eas-offchain-relay test` for the two-deployment race and conflict
suite.
