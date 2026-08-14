# ERC-8004 identity enrichment runbook

This is a presentation-only vertical slice. ERC-8004 owner, verified-wallet, URI, document, and
endpoint data never enter the vouch fold, PageRank inputs, Merkle tree, proof, or journal.

## Pinned Optimism provenance

- Official source: `erc-8004/erc-8004-contracts` commit
  `68fc6765761a10fb26f0692df21c8a6f9d12b1be`.
- Official full Identity ABI SHA-256:
  `cdb8e30f41a56ed53421126dab87551ff2a178b8463646f69f75bc5dc9620564`.
- Allowlisted chain: Optimism (`eip155:10`).
- Proxy: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.
- First code / source block: `147514947`; deployment transaction
  `0x8239a11f367b65e4e6644cdc5fd9710846a0e07336274cc94b7b9f71bf2764a8`.
- Initial implementation: `0xcb7af40c0be4fb92e183942b6dbb6b14a888f067`, version `1.0.0`.
- Observed implementation from block `147514960`:
  `0x7274e874ca62410a93bd8bf61c69d8045e399c02`, version `2.0.0`; upgrade transaction
  `0x36d10ecdf9b408620aa6cb111f26264267cde3f5898397db19bd91251184848b`.
- Observed/expected proxy owner:
  `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`.

Ponder backfills `Upgraded` and `OwnershipTransferred`, stores their ordered history, and logs a
high-severity message if a later Optimism implementation or owner differs from this reviewed
snapshot. A change remains visible instead of silently inheriting the pinned trust assumption.

## Local lifecycle fixture

Deploy the event-compatible test fixture to Anvil, set
`ERC8004_IDENTITY_REGISTRY_ADDRESS_31337` to its address, and start the indexer from or before its
deployment block. The fixture exposes `register`, URI update, wallet set/unset, and transfer with
the reference wallet-clear-before-transfer log order. The Foundry test registers two agents and
exercises wallet unset and transfer; the indexer reducer test replays the matching two-agent event
shape in canonical `(blockNumber, transactionIndex, logIndex)` order.

## Metadata worker

Run `pnpm --dir indexer metadata:erc8004:watch` (the production Compose file runs this service).
The event handler only records URI versions. The separate bounded worker permits HTTPS, IPFS, and
base64 JSON data URIs; pins each HTTPS connection to a validated public DNS answer; revalidates
redirect destinations; applies time, redirect, byte, and JSON content-type limits; validates the
qualified registration backreference; sanitizes presentation fields; and stores the exact SHA-256
content hash and timestamped endpoint observations. Valid immutable IPFS/data documents are fetched
once. HTTPS documents and failed observations are retried periodically.

Availability is not identity or safety evidence. APIs and the agent page retain mutable-content,
failure, and reachability labels, while on-chain identity remains usable when fetching fails.
