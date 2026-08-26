# ERC-8004 raw Reputation Registry explorer runbook

> **Historical chain-10 experiment.** Optimism is not a supported Trustgraphs target, and the
> Sepolia production indexer does not configure an ERC-8004 registry. The generic handlers and
> local fixture remain available for research; the observation below is retained as evidence only.

This integration is a provenance-preserving event explorer. It does not average feedback, select
reviewers, produce a global reputation score, validate responses, or feed any TrustGraph root,
proof, score, or edge. The official `tag1` and `tag2` strings are exposed as `tag` and `unit` for
filtering, while the API also returns the original field aliases. Both remain exact strings.

## Pinned historical source

The completed experiment indexed the official Optimism singleton without an address override.

| Field | Pinned observation |
| --- | --- |
| Chain | Optimism, chain ID `10` |
| Reputation proxy | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Identity binding | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Source block / deployment transaction | `147514948` / `0x816c7d9c81d547b1abeee4d88c8adfcb85621d03f9eb3872dffb564901db9b4e` |
| Initial implementation / version | `0xcb7af40c0be4fb92e183942b6dbb6b14a888f067` / `1.0.0` |
| Current implementation | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` from block `147514964` |
| Upgrade transaction / version | `0x5ab93d715ecaf91bc37ddf2dde0ffa95876cb065f8cc613b2d90772cc9a93e36` / `2.0.0` |
| Implementation code hash | `0x38602de97f1bd86f0a4729f7f3c0a78b1d27892e6eb581272cce5504a68fd00b` |
| Expected proxy owner | `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603` |
| Official source commit | `68fc6765761a10fb26f0692df21c8a6f9d12b1be` |
| Full ABI SHA-256 | `867b7975a5f2f9fee38c4a148a84471b141f4de91409ccc0c6bebe3df4f04001` |

The reviewed ABI remains in `packages/indexer/abis/erc8004ReputationRegistry.ts`; the observation
and experiment inputs remain under `research/erc8004-reputation/`. They are not production
configuration.

## State and attribution rules

`NewFeedback`, `FeedbackRevoked`, and `ResponseAppended` are replayed in
`(blockNumber, transactionIndex, logIndex)` order. The creation row retains the signed `int128`
value, decimals, exact tags, endpoint, document pointer/hash, transaction hash, block hash, and log
position. Revocation changes only the current active flag and appends an event; it never deletes the
creation. Responses are append-only statements by unrestricted responders and never validate or
erase the feedback.

Reviewer attribution uses only `verified_wallet` history strictly before the feedback log. It never
uses the target owner, current wallet, registration document, or advertised service metadata.
Exactly one active relation produces `attributed`; zero produces `unattributed`; more than one
produces `ambiguous` with every candidate and the relation-event evidence. Wallet rotations later in
the same transaction or block cannot rewrite earlier feedback.

## API and UI

`GET /erc8004/feedback` is a stable keyset-paginated bulk route. Supported exact filters are:

- `agent` — qualified key `agent:eip155:<chainId>:<identityRegistry>:<agentId>`;
- `reviewer` — EVM address;
- `tag` and `unit` — exact strings (`tag1` and `tag2` respectively);
- `revoked=all|active|revoked`;
- `fromBlock`, `toBlock`, `limit` (1–100), and the opaque returned `cursor`.

The route performs one feedback query and bulk queries for all responses, registry provenance, and
latest descriptor observations. The agent page uses that route once per page; it does not issue a
request per feedback or response. UI labels deliberately say raw signal, exact policy, historical
attribution, mutable external descriptor, response, and revocation—not score, truth, validation, or
proof quality.

## Descriptor sidecar

Chain ingestion never performs a network fetch. Run the independent process after applying the
offchain Drizzle migrations:

```bash
pnpm --dir packages/indexer db:migrate
pnpm --dir packages/indexer metadata:erc8004:watch
```

The sidecar consumes both `/erc8004/metadata-tasks` and
`/erc8004/feedback-metadata-tasks`. Feedback and response JSON share the identity fetcher's network
boundary: HTTPS only, DNS rebinding/private-address rejection, independently checked redirects,
five-second timeout, three redirects, JSON content type, and a 256 KiB byte limit. IPFS and bounded
base64 JSON data URIs are supported. Non-zero on-chain hashes are checked as KECCAK-256 over the
exact bytes. A feedback JSON must match its Identity Registry, agent ID, client address, signed
value, decimals, and any supplied tag/endpoint fields. Response JSON has no normative ERC schema;
only exact bytes, hash status, and a bounded JSON object are recorded.

Failures (`blocked`, `oversized`, `unavailable`, `invalid`, hash mismatch, or backreference mismatch)
are append-only observations and do not stall Ponder. Successful immutable content is fetched once;
mutable HTTPS and failures are retried after the configured refresh interval. The explorer always
separates the on-chain pointer from this external observation.

## Local fixture and recovery

Deploy `ERC8004IdentityRegistryFixture` and `ERC8004ReputationRegistryFixture`, then set both values
before starting Ponder at or before their deployment block:

```bash
ERC8004_IDENTITY_REGISTRY_ADDRESS_31337=0x...
ERC8004_REPUTATION_REGISTRY_ADDRESS_31337=0x...
PONDER_START_BLOCK=<deployment-block>
```

The Solidity fixture covers two tag/unit policies, a response, a revocation, and feedback on either
side of a verified-wallet rotation. The TypeScript replay reverses fixture arrival order and proves
canonical replay plus event-block `attributed`, `unattributed`, and `ambiguous` outcomes.

Ponder tables are derived entirely from the allowlisted chain logs. For recovery, restore a healthy
archive RPC, discard the affected Ponder schema if necessary, and replay from source block
`147514948`; do not patch current feedback or attribution rows by hand. Offchain descriptor rows are
availability observations: reapply migrations and rerun the sidecar to rebuild them. Preserve old
observations when diagnosing mutable-content changes or hash/backreference failures.
