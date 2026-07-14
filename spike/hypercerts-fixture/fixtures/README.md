# Hypercerts atproto fixture (GOAL.md M1, last fixture)

A **synthetic but real** atproto repo containing `@hypercerts-org/lexicon` **v1.1.0**
records for all seven HYPERCERTS_ATPROTO_PLAN §2 collections, exported as a CARv1
and verified by the existing `spike/mst` walker. Generated **2026-07-14**. Throwaway.

Unlike the `spike/mst/fixtures/` snapshots (real Bluesky repos pulled from the
relay), this repo is **generated locally** by an in-process atproto network so we
control the record contents and can exercise the typed Hypercerts decode + the
real EIP-712 `link.evm` proof. The MST machinery it runs through is identical.

## What stood up

- `@atproto/dev-env` **v0.5.31** `TestNetworkNoAppView`: a **real `did:plc` PLC
  server** (`@did-plc/server`) + a **SQLite PDS** (`@atproto/pds` **v0.5.17**),
  both in-process. No did:web, no external services.
- Two accounts: `alice.test` (**primary**, the exported repo) and `bob.test`
  (**peer**, referenced by follow / badge / contributor edges). A third, purely
  self-asserted contributor DID (`did:plc:zzzz…`, no repo) exercises the
  "named-but-no-node" path.

## Primary repo (this fixture)

| field | value |
|---|---|
| did | `did:plc:y4terqrp7vrlvxyxlnnyjmvs` |
| rev | `3mqmmjg7jcs2k` |
| commit (CAR root) CID | `bafyreia6obygtkat3yn3jr4k37wgxd2qt6zxwd3ici5khmikwri6ccrdve` |
| data (MST root) CID | `bafyreidqtudr74n7yo527ldth3dfd7qoj2ndzx5lr7sza7fin223qndeli` |
| commit version | 3 |
| `#atproto` key | `did:key:zQ3shkNUqVV4ZEvLoBHdAMu3kmJ7NHuonsf1s2txykCHyYrfY` (**k256**) |
| records | 7 (one per §2 collection) |
| CAR blocks | 15 = 1 commit + 7 MST nodes + 7 records |
| CAR size | 4,759 bytes |
| lexicon | `@hypercerts-org/lexicon` v1.1.0 (pinned; HEAD at tag `v1.1.0`) |

The exact DID / rev / CIDs above are specific to *this* generation run and change
on every regenerate (the PLC signing key and rkeys are random).

## Files

- `hypercerts.car` — CARv1 export via `com.atproto.sync.getRepo` against the local
  PDS (commit + all MST nodes + all records).
- `hypercerts.plc.json` — the PLC audit log from the **local** PLC server
  (`GET {plc}/{did}/log/audit`). One signed genesis `plc_operation` (`prev:null`,
  2 rotation keys); `operation.verificationMethods.atproto` is the `#atproto`
  `did:key` used to verify the commit signature — same shape as the
  `spike/mst/fixtures` PLC logs.
- `hypercerts.records.tsv` — ground-truth `collection/rkey \t valueCID`, taken from
  the PDS's own `applyWrites`/`listRecords` responses (the PDS *is* the source of
  truth for the MST it built). The walker asserts byte-level parity against this.
- `meta.json` — full generation record: DIDs, rev, strongRef CIDs per record, the
  lexicon-validation probe result, and the complete EIP-712 material (domain,
  types, message, signature, and the **throwaway** EVM private key used to sign).

## Regenerate

```
cd ../gen && npm install          # @atproto/dev-env, @atproto/api, viem, …
node gen.mjs                       # writes all files in this dir
cd ../walk && cargo build --release
./target/release/hypercerts-fixture-walk ../fixtures
```

## PLC-verification caveat

The DID is a genuine `did:plc` with a **real, hash-chained, signed** audit log —
but served by the **local dev PLC**, not `plc.directory`. So the audit log
exercises the PLC chain-verification logic (genesis-hash == DID suffix, signed
genesis op, rotation-key set) yet is **not anchored in the public directory**.
That is acceptable for this fixture: the record/MST/commit/EIP-712 legs are the
point; a production witness would feed a plc.directory (or our mirror) audit log
of the same shape.
