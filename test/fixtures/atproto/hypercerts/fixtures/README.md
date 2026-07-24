# Hypercerts atproto fixture (M4 exit — TWO-SIDED, multi-repo)

A **synthetic but real** pair of atproto repos containing `@hypercerts-org/lexicon`
**v1.1.0** records, exported as CARv1 and verified by the M1 MST walker (`../walk`).
Regenerated **2026-07-14** for the M4 exit. Throwaway.

Unlike the `test/fixtures/atproto/repos/` snapshots (real Bluesky repos pulled from the relay),
these repos are **generated locally** by an in-process atproto network so we control the
record contents and can exercise the typed Hypercerts decode, the real EIP-712 `link.evm`
proof, and — new for M4 — the **two-sided cross-repo semantics** (§3/§5): the counterparty
facts (`badge.response`, `acknowledgement`) live in the **counterparty's own signed repo**,
which is exactly where the derive rules require them. The MST machinery both run through is
identical.

## What stood up

- `@atproto/dev-env` `TestNetworkNoAppView`: a **real `did:plc` PLC server**
  (`@did-plc/server`) + a **SQLite PDS** (`@atproto/pds`), both in-process. No did:web, no
  external services.
- Two accounts with repos: `alice.test` (**bound actor**, exported as `hypercerts.*`) and
  `bob.test` (**satellite / counterparty**, exported as `bob.*`).
- A third, purely self-asserted contributor DID `carol` (`did:plc:carol0000…`, **no repo**)
  exercises the "named-but-no-node" path — she is attributed but never acks, so her E4 share
  stays unboosted.

## Repo contents (GOAL M4)

**alice.test** — a **bound** actor (verified `link.evm`), so her edges carry full authority:

| collection | rkey | note |
|---|---|---|
| `app.certified.graph.follow` | (tid) | follow(bob) |
| `app.certified.badge.award` | (tid) | alice → bob (subject = DID); bob accepts in HIS repo |
| `org.hypercerts.claim.activity` | `reforestation-amazon-2024` | contributors [bob 0.6, carol 0.4] |
| `org.hypercerts.context.evaluation` | (tid) | of **bob's** activity, score 87.5/100 → clean cross-repo **E3** |
| `org.hypercerts.context.evaluation` | (tid) | of **her own** activity, score 90/100 → **self-edge**, inert but recorded |
| `app.certified.link.evm` | `self` | real EIP-712 binding → alice is a bound actor |

**bob.test** — a **satellite** actor (no binding → pdsAttested discount), holds the
counterparty facts:

| collection | rkey | note |
|---|---|---|
| `app.certified.badge.definition` | (tid) | the endorsement badge alice's award references |
| `org.hypercerts.claim.activity` | `bob-mangrove-2024` | contributors [alice 1.0] → alice gets an **E4** in-edge |
| `app.certified.badge.response` | (tid) | **accepted**, weight 0.85, to ALICE's award → boosts alice→bob badge |
| `org.hypercerts.context.acknowledgement` | (tid) | **acknowledged: true**, of ALICE's activity → boosts bob's E4 share vs carol's |

## Identities & commits (this generation run)

| field | alice (`hypercerts.*`) | bob (`bob.*`) |
|---|---|---|
| did | `did:plc:ss2ib2f37vegrihrkrfkrw55` | `did:plc:uz24xnaizz6bbw6lvrtvebja` |
| rev | `3mqn5id3y6k2q` | `3mqn5id26ks2q` |
| commit (CAR root) CID | `bafyreibfdlt7n2gc53wdwjresksxrf3ni5f5cts2hckadsidevls52shva` | `bafyreienjjdecqvpgbigdie6ktan362xvnkwwsmnpz6pbaqu2ebu2j5qym` |
| `#atproto` key | `zQN6ngQ3y576VKTmSJwWnzJwQqvyY98LvDZjRTMX4xFhCoUQeqrbcxdwqiVbZJSJH3QGUZexgcXoAqcEYkX14qJHL` (k256) | `zNupyPNck9Hs837f4Eyx6Q223uCAoK3W8o6izxGXVc9PefXn1XGTFkdZhc76kzVpK6rmsjcWMq4q5XCak8C5PpsFA` (k256) |
| records | 6 | 4 |
| CAR size | 4,483 bytes | 2,424 bytes |

Alice's `link.evm` binds `did:plc:ss2ib2f37vegrihrkrfkrw55` ↔ EVM address
`0xD030e52949a1D6BC7D00a2040268410eE3AFd65A` (throwaway key in `meta.json`).

The exact DIDs / revs / CIDs / EVM address / keys above are specific to *this* generation
run and change on every regenerate (the PLC signing keys and rkeys are random). The Rust
tests that pin them (below) must be re-pinned when the fixture is regenerated.

## Files

- `hypercerts.car` / `bob.car` — CARv1 export per repo via `com.atproto.sync.getRepo`
  (commit + all MST nodes + all records).
- `hypercerts.plc.json` / `bob.plc.json` — the PLC audit log per repo from the **local** PLC
  server (`GET {plc}/{did}/log/audit`). One signed genesis `plc_operation` (`prev:null`, 2
  rotation keys); `operation.verificationMethods.atproto` is the `#atproto` `did:key` used to
  verify that repo's commit signature.
- `hypercerts.records.tsv` / `bob.records.tsv` — ground-truth `collection/rkey \t valueCID`
  per repo, taken from the PDS's own `applyWrites`/`listRecords` responses. The walker asserts
  byte-level parity against these.
- `meta.json` — full generation record: both DIDs + carol, per-repo rev/head/counts/records,
  the lexicon-validation probe result, and the complete EIP-712 material (domain, types,
  message, signature, and the **throwaway** EVM private key used to sign).

## What consumes this fixture (re-pin on regenerate)

- `test/fixtures/atproto/hypercerts/walk` — the MST/commit/parity/EIP-712 walker (see below).
- `packages/envelopes/tests/atproto_real.rs` — `hypercerts_seeded_repo_verifies_all_collections`
  (pins alice's record count = 6).
- `packages/hypercerts-core/src/records.rs` — `all_fixture_records_decode` (count = 6, field values).
- `packages/hypercerts-core/src/binding.rs` — `fixture_binding_recovers` (alice DID + EVM address).
- `packages/hypercerts-core/tests/compute_fixture.rs` — single-repo pipeline (alice DID/BOB DID/address).
- `packages/hypercerts-core/tests/two_sided_fixture.rs` — **multi-repo** pipeline over BOTH
  CARs (both DIDs + carol + the two fixed activity rkeys + EVM address).

## Regenerate

```
cd ../gen && CI=true pnpm install   # @atproto/dev-env, @atproto/api, viem, …
node gen.mjs                         # writes hypercerts.* + bob.* + meta.json in this dir
cd ../walk && cargo build --release
./target/release/hypercerts-fixture-walk ../fixtures            # walks alice (hypercerts.*)
# to walk bob, stage his files under the walker's expected names:
#   mkdir -p /tmp/bobwalk && cp bob.car /tmp/bobwalk/hypercerts.car \
#     && cp bob.plc.json /tmp/bobwalk/hypercerts.plc.json \
#     && cp bob.records.tsv /tmp/bobwalk/hypercerts.records.tsv
#   ./target/release/hypercerts-fixture-walk /tmp/bobwalk
```

Then re-pin the DIDs / EVM address / record counts in the Rust consumers listed above (the
new ground truth is in `meta.json`).

> **Note:** `pnpm install` in the `gen/` workspace dir can prune the repo-root `node_modules`;
> run `CI=true pnpm install` at the repo root afterwards to restore forge deps.

## PLC-verification caveat

Each DID is a genuine `did:plc` with a **real, hash-chained, signed** audit log — but served
by the **local dev PLC**, not `plc.directory`. So the audit logs exercise the PLC
chain-verification logic (genesis-hash == DID suffix, signed genesis op, rotation-key set)
yet are **not anchored in the public directory**. That is acceptable for this fixture: the
record/MST/commit/EIP-712 legs are the point; a production witness would feed a plc.directory
(or our mirror) audit log of the same shape.
