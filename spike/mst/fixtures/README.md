# MST spike fixtures

Real atproto repo snapshots + PLC audit logs for the M1 Phase-A MST-verification
spike. Throwaway. Fetched **2026-07-14T15:58:44Z**.

CARs fetched via the relay `getRepo` (302 → PDS host, followed with `curl -L`):

    https://bsky.network/xrpc/com.atproto.sync.getRepo?did=<did>

PLC audit logs from `https://plc.directory/<did>/log/audit`.
DIDs resolved from handles via `public.api.bsky.app …resolveHandle`.

| name | handle | did | PDS | rev | data (MST root) CID | records | CAR size | atproto key curve |
|---|---|---|---|---|---|---|---|---|
| atproto | atproto.com | did:plc:ewvi7nxzyoun6zhxrhs64oiz | enoki.us-east.host.bsky.network | 3mqksqbxzrq2w | bafyreih5bjgvei23g7cmqeabk3e7oog7utnw2vxcrjsbflwihdoo7mtboy | 1651 | 708 KB | k256 |
| jay | jay.bsky.team | did:plc:oky5czdrnfjpqslsw2a5iclo | (bsky.network) | 3mqf4dt7sga2e | bafyreig433h4ejcnilxw2mtmguwqgy6writv3j5oqewou5gihv2u2rtt2m | 40256 | 14.5 MB | k256 |
| pfrazee | pfrazee.com | did:plc:ragtjsm2j2vknwkz3zp4oxrd | (bsky.network) | 3mqmk5ym7k62d | bafyreigvu5nyrck7c3nguqgfnkor4gmj6rdfbt35wzrdl7c2iskssc7cri | 203964 | 78 MB | k256 |

All three accounts are Bluesky-PDS-hosted and use **k256** (secp256k1) `#atproto`
signing keys — typical for bsky.network accounts. p256 (NIST P-256) is the other
blessed curve; no live p256 fixture was found, so the p256 signature path is
exercised by a self-generated deterministic test vector in the Rust crate
(`verify::tests::p256_vector`).

## Files per account

- `<name>.car` — CARv1 repo snapshot (commit + all MST nodes + all records).
- `<name>.plc.json` — full PLC audit log (hash-chained op list, oldest→newest).
- `<name>.records.tsv` — **ground truth** `key \t value-CID` from `goat repo ls`,
  `LC_ALL=C sort`ed. Used for byte-level parity assertion against the Rust walker.
- `<name>.commit.txt` — `goat repo inspect` output (version/did/data/prev/rev).

Ground truth produced with indigo `goat` v0.2.3 (`github.com/bluesky-social/goat`;
note: `goat` graduated out of the `indigo/cmd/goat` path — install from its own repo).
