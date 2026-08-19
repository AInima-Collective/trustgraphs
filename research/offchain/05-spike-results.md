# Phase-A spike results (the offchain build plan's M1)

Measured facts that retire the "soft" numbers in the OFFCHAIN/HYPERCERTS plans.
Each section is owned by one spike track. Append, do not clobber.

- **MST / repo-verification track** (§1-2) - owner: MST spike, 2026-07-14.
- **SP1 crypto / cost track** (§3) - owner: crypto spike, 2026-07-14: measured cycles + PGU
  for patched ecrecover / p256 / keccak / sha256 on SP1 6.3.1. Prover-network clearing
  price NOT measured (needs `NETWORK_PRIVATE_KEY` - pending Jake).
- **Nostr / BIP340 schnorr track** (§4) - owner: buzz/nostr spike, 2026-08-16: measured
  schnorr verify + full Nostr event verify on the same stack; bins vendored at
  `research/nostr/`.

---

## 1. MST / repo verification (2026-07-14)

Prototype: `spike/mst/` (throwaway native Rust crate, own workspace). Validates the
per-repo verification pipeline of HYPERCERTS_ATPROTO_PLAN §5 / dossier 01 §§4-5
against real `getRepo` CARs and cross-checks every enumerated record against
indigo's Go implementation.

### 1.1 Fixtures

Real repo snapshots pulled 2026-07-14T15:58Z via the relay `getRepo`
(`bsky.network` 302-redirects to the PDS host; follow with `curl -L`), plus each
DID's full PLC audit log. Ground truth = indigo `goat repo ls` (`goat` v0.2.3).
See `spike/mst/fixtures/README.md`.

| repo | did | records | CAR blocks | CAR size | MST nodes | records/node | curve |
|---|---|---:|---:|---:|---:|---:|---|
| atproto.com | did:plc:ewvi7nxzyoun6zhxrhs64oiz | 1,651 | 2,110 | 708 KB | 458 | 3.60 | k256 |
| jay.bsky.team | did:plc:oky5czdrnfjpqslsw2a5iclo | 40,256 | 50,905 | 14.5 MB | 10,649 | 3.78 | k256 |
| pfrazee.com | did:plc:ragtjsm2j2vknwkz3zp4oxrd | 203,964 | 258,414 | 78 MB | 54,449 | 3.75 | k256 |

`blocks == 1 commit + MST nodes + records` exactly for every repo (atproto:
1 + 458 + 1651 = 2110). CAR carries the commit, every MST node, every record, and
nothing else. Records-per-node 3.6-3.8 empirically confirms the dossier's
"expected fanout 4" (§1).

### 1.2 Parity vs indigo (byte-level)

**EXACT on all three repos.** The Rust full walk enumerated the identical
`{key -> value CID}` set as `goat repo ls` for every repo: same count, same keys,
same CID strings (base32). Commit fields (`did`, `version=3`, `rev`, `data` root
CID) match `goat repo inspect`. Zero divergences.

### 1.3 Commit signature verification

All three commits: signature VERIFIED. Path: decode commit block (DRISL), strip
`sig`, re-encode canonically, SHA-256, ECDSA verify of the 64-byte compact `r‖s`
against the `#atproto` `did:key` taken from the last non-nullified PLC op, low-S
enforced. All three fixtures are **k256** (secp256k1), typical for
bsky.network-hosted accounts. The **p256** path (multikey `0x80 0x24` prefix,
NIST P-256) is implemented and exercised by a self-generated deterministic vector
(`verify::tests::p256_vector`), since no live p256 account was in the sample.

Dossier 01's ⚠️ on `sig` wire format is now **resolved against real data**: `sig`
is a CBOR byte string holding 64-byte compact `r‖s` (not DER), low-S, verifies
cleanly. Use 64-byte compact + low-S as the wire rule.

### 1.4 Invariants enforced by the walker

Full walk (`mst::Walker`), all fail-closed:

1. **Content addressing** - CAR parse recomputes SHA-256 for every sha2-256 block
   and rejects any CID/content mismatch.
2. **Block presence** - any MST node or record CID referenced but absent from the
   CAR aborts the walk (fail-closed); record blocks additionally checked present.
3. **Strictly ascending keys** - globally across the whole in-order traversal and
   within each node.
4. **Prefix compression correctness** - reconstructed `key = prev[..p] ‖ k`; `p`
   must equal the actual longest-common-prefix with the previous key (non-canonical
   `p` rejected), first entry `p==0`, `p <= prev.len()`.
5. **Layer rule** - `layer(key) = floor(clz256(sha256(key)) / 2)`; all entry keys in
   a node share one layer; each child subtree's layer is strictly less than its
   parent's.
6. **Entry/subtree interleave** - enforced structurally by in-order descent
   (`l`, then each `(entry, t)`), combined with the global ascending check.
7. **Canonical DRISL form** - separate pass re-encodes each node via
   `serde_ipld_dagcbor::to_vec` and asserts byte-identity with the stored block:
   **all nodes exact** (458/458, 500/500 sampled, 500/500). This is what lets us
   recompute the unsigned-commit signing payload by re-encoding.

**Range walk** over `app.bsky.graph.follow/` (range `["<nsid>/", "<nsid>0")`, since
`'/'`+1 == `'0'`): descends only subtrees whose key interval intersects the range,
collects only in-range keys. Completeness cross-checked against the full walk
filtered by the same prefix: **matches exactly** (atproto 21, jay 4000, pfrazee 655).

### 1.5 Wall-times (native, release, single-thread, arm64)

| repo | CAR parse + content-address | full MST walk | follow/ range walk |
|---|---:|---:|---:|
| atproto (1.6k) | 10 ms | 3.3 ms | 0.06 ms |
| jay (40k) | 195 ms | 93 ms | 8 ms |
| pfrazee (204k) | 973 ms | 668 ms | 3 ms |

Full pipeline (parse + sig + walk + parity) on the 204k-record repo is ~1.7 s
native. These are host-side witness-assembly costs, not in-guest costs; the zkVM
cycle budget is the separate crypto-track measurement.

### 1.6 Parser benchmark: serde_ipld_dagcbor v0.6.4 vs hand-rolled

Per-node decode, same MST-node blocks, warm cache:

| repo | serde_ipld_dagcbor | hand-rolled | ratio |
|---|---:|---:|---:|
| atproto | 1,197 ns | 1,114 ns | 1.08x |
| jay | 1,924 ns | 2,034 ns | 0.95x |
| pfrazee | 2,510 ns | 2,415 ns | 1.04x |

**Native decode is a wash** (within ~8% either direction; the hand-rolled decoder
is a minimal MST-schema-only CBOR reader). A first, cold run showed serde
faster/slower by up to 1.7x, which was pure warmup noise, hence the warm numbers
above. Native wall-time gives **no decisive parser signal**.

### 1.7 Tamper tests (fail-closed)

On atproto.car, targeting a mid-tree MST node:

- **Flip one byte in a node block** - rejected two ways: (a) CAR content-address
  check rejects on re-parse (`CID/content mismatch`); (b) if injected post-parse,
  the walk fails on the referenced CID (decode error / block no longer resolvable).
  No path accepts tampered bytes.
- **Drop a node block** - walk aborts `FAIL-CLOSED: MST block <cid> missing`.

### 1.8 Parser recommendation: **GO with `serde_ipld_dagcbor` v0.6.4**

Reasoning:
- Byte-exact parity with indigo on 246k real records across three repos, including
  full canonical round-trip (decode+re-encode == stored bytes). It is correct and
  canonical, which is the property that matters for a soundness proof.
- Native decode is at parity with a hand-rolled reader, so the maintenance and
  audit-surface cost of a bespoke CBOR parser buys nothing on the host.
- `serde_ipld_dagcbor` also gives us the canonical **encoder**, which we need to
  reconstruct the unsigned-commit signing payload; a hand-rolled decoder would
  still need a matching canonical encoder.

**Caveat / open decision for M3:** this is a *native* verdict. The real driver for
the in-guest parser is **SP1 cycle count**, not native ns. Keep the hand-rolled
MST-node reader in the back pocket as the fallback the plan already names, and take
one cycle-count measurement of both inside the guest before freezing the M3 choice.
Nothing here forces a bespoke parser; the presumption is now serde unless in-guest
cycles say otherwise.

### 1.9 What remains for M3 conformance

This spike validated the happy path + basic tamper on real Bluesky repos. M3 still
needs, per the build plan's M3 exit:

- **indigo test-vector suite** - run against indigo's own repo/MST conformance
  vectors (structure, absence proofs, boundary fencing), not just live CARs.
- **Absence / non-existence proofs** - `getRecord`-style proofs that a key is *not*
  present (degenerate range); not exercised here.
- **Equivocation pairs** - two signed heads at overlapping `rev` for one DID;
  detection logic (firehose `prevData` induction) is unbuilt.
- **Boundary fencing** - adversarial nodes where an out-of-range fence key sits
  immediately beside the range edge; verify the range walk neither over- nor
  under-collects. (Current range walk matches the full-walk filter on real data,
  but real repos are not adversarial.)
- **Layer-skip precision** - the walker enforces child-layer `<` parent-layer, not
  the exact "no illegal skip / empty-intermediate-node" rule. Tighten and test
  against crafted vectors.
- **p256 on a live repo** - find or seed a p256 (self-hosted PDS) account; only the
  synthetic vector is covered today.
- **PLC audit-log chain verification** - this spike used only the *last* op's
  `#atproto` key. M3 must verify the full chain (genesis hash == DID suffix, each op
  signed by a predecessor rotation key, nullification/72h rules).

**Separate follow-up (not blocking M1):** the **Hypercerts-record fixture** - a PDS
(theirs or a local one) seeded with `@hypercerts-org/lexicon` v1.1.0 records - so the
§2 collection set and §3 edge decode run against real typed records. The MST
machinery is record-type-agnostic and already proven; this is a lexicon/decode
exercise, tracked for M3/M4.

### 1.10 Spec surprises vs dossier 01

- **getRepo is a 302 to the PDS host.** The relay URL in the dossier redirects to
  e.g. `enoki.us-east.host.bsky.network`; must follow redirects (or hit the PDS
  directly). Operational, not a protocol change.
- **`goat` moved out of indigo.** It now lives at `github.com/bluesky-social/goat`
  (not `indigo/cmd/goat`), and indigo `main` now requires Go >= 1.26. Tooling note
  for the M3 conformance harness.
- **k256 dominates.** All three sampled bsky.network accounts use k256; p256 is
  likely only on self-hosted PDSes. Confirms dossier "k256 default."
- **64-byte compact `sig` confirmed** on real commits (dossier flag resolved).
- **`serde_ipld_dagcbor` emits spec-canonical DRISL** (round-trip byte-identity on
  every MST node and every commit). Good: recomputing the signing payload by
  re-encoding is safe.
- **Fanout ~4 and `blocks = commit + nodes + records` confirmed** empirically. No
  surprises in repo composition.

---

## 2. Hypercerts fixture (2026-07-14)

The last M1 fixture: a **real atproto repo of `@hypercerts-org/lexicon` v1.1.0
records** for all seven HYPERCERTS_ATPROTO_PLAN §2 collections, exported as a CAR
and run through the *same* `spike/mst` walker. Where §1 proved the MST machinery on
real Bluesky repos, this proves the **typed Hypercerts records decode and the
`link.evm` EIP-712 proof verify** end-to-end through that machinery.

Prototype: `spike/hypercerts-fixture/` (`gen/` TS generator, `walk/` Rust driver
that `#[path]`-includes `spike/mst/src/{car,mst,verify}.rs` verbatim — the walker is
byte-for-byte the one §1 validated against indigo).

### 2.1 What was stood up

`@atproto/dev-env` v0.5.31 `TestNetworkNoAppView` in-process: a **real `did:plc`
PLC server** (`@did-plc/server`) + a **SQLite PDS** (`@atproto/pds` v0.5.17). Two
accounts (`alice.test` = exported primary, `bob.test` = referenced peer) + one
self-asserted contributor DID with no repo. Records written via
`com.atproto.repo.applyWrites`, CAR exported via `com.atproto.sync.getRepo`, PLC
audit log via `GET {plc}/{did}/log/audit`. Lexicon pin verified: the local
`@hypercerts-org/lexicon` checkout is at git tag **`v1.1.0`** (`package.json`
1.1.0), so the schemas used are exactly the pinned release.

**PLC leg is real but local.** The DID has a genuine signed, hash-chained audit log
(single genesis `plc_operation`, `prev:null`, 2 rotation keys, `verificationMethods.
atproto` = the commit key) — but served by the **dev PLC, not `plc.directory`**. It
exercises the chain-verification shape (genesis-hash == DID suffix, signed op) yet
is not publicly anchored; a production witness feeds a plc.directory/mirror log of
the same shape. Acceptable for this fixture — the record/MST/commit/EIP-712 legs are
the point.

### 2.2 Lexicon-validation behavior (partner-brief note)

The PDS **rejects** `applyWrites` with `validate:true` for these collections:
`Unknown lexicon type: app.certified.graph.follow`. A stock PDS bundles only the
`app.bsky`/`com.atproto`/… lexicons; the Hypercerts NSIDs are unknown to it, so
**validated writes fail** and the records are written with **`validate:false`**
(unvalidated dag-cbor — the atproto default for unknown lexicons). Implication for
the partner: unless their PDS ships the `@hypercerts-org/lexicon` set (or clients
pre-validate), record shape is **not enforced server-side**. This is *fine for our
soundness model* — the guest re-derives everything from the commit-signed bytes and
applies §3.5 deterministic skip rules; it never trusts server-side validation. But
the partner brief should state that malformed records can and will land on-chain in
repos and must be handled by skip rules, not assumed away.

### 2.3 Fixture composition + walker results (all green)

7 records, one per §2 collection; CAR = **15 blocks = 1 commit + 7 MST nodes + 7
records** (the §1 `blocks = commit + nodes + records` identity holds), 4,759 bytes.

- **CAR content-addressing**: every block's SHA-256 CID recomputed and matched.
- **Commit signature**: VERIFIED — **k256**, low-S, 64-byte compact `r‖s` over
  SHA-256 of the re-encoded unsigned commit, against the PLC `#atproto` `did:key`.
  Same path as §1.3; the PDS-signed commit is a valid completeness commitment.
- **Full MST walk**: 7 records across 7 nodes; **parity EXACT** vs the PDS's own
  `applyWrites`/`listRecords` `{collection/rkey → valueCID}` table (same count, same
  keys, same base32 CIDs). Records round-trip the real MST.
- **Range walks**: one contiguous `["<nsid>/", "<nsid>0")` range per §2 collection —
  all seven return exactly their record and match the full-walk-filtered set. The
  seven-range multi-walk of plan §5.4 works on typed data.
- **Typed decode**: every record dag-cbor-decoded and its load-bearing §2 fields
  printed — `graph.follow.subject`, `badge.award.{badge.cid, subject.did}`,
  `badge.response.{response=accepted, weight="0.85"}`, `evaluation.{subject.cid,
  score{min:"0",max:"100",value:"87.5"}, evaluators[]}`, `activity.contributors[]`
  (`did:0.6`, `did:0.4`), `acknowledgement.{subject.cid, acknowledged:true}`,
  `link.evm.*`. The `evaluation.subject.cid` and `acknowledgement.subject.cid` both
  resolve to the **exact** `activity` record CID — strongRefs are content-verifiable
  as plan §5.6 requires.

### 2.4 EIP-712 `link.evm` derivation (pinned for M4's in-guest verify)

A fresh EVM key signed the `app.certified.link.evm#eip712Message`. Domain/types are
taken **verbatim from the lexicon's own `tests/validate-link-evm.test.ts`** (the
lexicon JSON does *not* carry the domain; the test is the spec):

- **Domain** (note: **no `verifyingContract`, no `salt`**):
  `EIP712Domain(string name,string version,uint256 chainId)` with
  `name="IdentityLink"`, `version="1"`, `chainId` = the message chainId (10 /
  Optimism in this fixture).
- **Struct**:
  `LinkAttestation(string did,address evmAddress,uint256 chainId,uint256 timestamp,uint256 nonce)`.
- `domainSeparator = keccak256( keccak256(domainType) ‖ keccak256("IdentityLink") ‖ keccak256("1") ‖ uint256(chainId) )`.
- `structHash = keccak256( keccak256(structType) ‖ keccak256(bytes(did)) ‖ leftpad32(evmAddress) ‖ uint256(chainId) ‖ uint256(timestamp) ‖ uint256(nonce) )`
  — the string `did` and address are hashed/padded per EIP-712; `chainId/timestamp/
  nonce` are the **decimal strings** from the record parsed to uint256.
- `digest = keccak256( 0x19 0x01 ‖ domainSeparator ‖ structHash )`.
- Signature is a 65-byte `r‖s‖v` (v∈{27,28}); `ecrecover(digest, r,s,v-27)` →
  uncompressed pubkey → `keccak256(pubkey[1..])[12..]` = address.

For this fixture: `domainSeparator = 0xdceda264808ae503dfc5a1a6796c290974950b98aa857
8547aebb7fd38335064`, `digest = 0x05ef50ff81b10fefc5a3c362f31a58e8dc7e2610651a43f9c
db0992521e8dc12`, recovered address `= 0x24dF77757394DFDf84f47b6C55df431C9c78A7b9`
= the record's `address`.

**Three-way agreement on the derivation:** viem (generator) ↔ hand-written Rust
keccak+k256 ecrecover in the walker (host-side, *outside* the guest) ↔ `foundry
cast wallet sign --data` (`eth_signTypedData_v4`) all produce the **byte-identical**
signature `0x4986adce…eb04d1b`. This is the exact digest construction M4's in-guest
verification must reproduce (patched keccak256 + patched `ecrecover`). The walker
also enforces the two cheap consistency checks M4 needs: `message.evmAddress` ==
top-level `address`, and `message.did` == repo owner (DID-side consent via the
signed commit).

### 2.5 Schema surprises vs HYPERCERTS_ATPROTO_PLAN §2/§4

The §2 field table is directionally right but several load-bearing fields sit
differently than the table implies. Each is a decode-path detail M3/M4 must encode:

1. **`link.evm` is nested, not flat.** §2/§4 write `eip712Message{did,evmAddress,
   chainId,timestamp,nonce} + signature` as if top-level. The real record is
   `{address, proof:{$type:"…#eip712Proof", signature, message:{$type:"…#eip712Message",
   …}}, createdAt}` — the message + signature live under **`proof`** (an open union),
   and the record has a **top-level `address`** that must equal `message.evmAddress`.
   Record key is **`any`** (fixture uses rkey `self`), not a TID.
2. **`evaluation.subject` and `evaluation.score` are OPTIONAL.** Required is
   `["evaluators","summary","createdAt"]` — *not* `subject`, *not* `score`. So a
   valid evaluation can carry **no subject** (no E3 target) and **no score** (E3
   weight undefined). Edge E3 must treat a missing `subject`/`score` as a
   deterministic skip, not an error. §3.5's skip list should name this explicitly.
3. **`evaluators[]` items are objects, not bare DIDs.** Each is
   `app.certified.defs#did` = `{did:"…"}`, not a string. (v1 ignores them beyond the
   author anyway per §3.4, but the decoder must expect the object shape.)
4. **`activity.contributors[].contributorIdentity` is a union**, `#contributorIdentity`
   `{identity:"<string>"}` **or** a strongRef to a `contributorInformation` record —
   so the DID lives at `contributors[i].contributorIdentity.identity` (a free string
   that *may* be a DID), not a typed DID field. §3.4's "non-DID `contributorIdentity`
   → skip" rule applies to the inner `identity` string; the strongRef variant is a
   second shape to resolve. `contributionWeight` is **optional** (a contributor may
   have none → E4 share undefined for that entry).
5. **`activity.contributors` itself is optional** (required set is `["title",
   "shortDescription","createdAt"]`). An activity with no contributors is a valid
   score sink with zero E4 out-edges.
6. **`badge.award.subject` is `app.certified.defs#did` (`{did:"…"}`) OR strongRef** —
   the DID variant is an object, and the `badge` field is a strongRef to a
   `badge.definition` (an **8th** record type, outside the seven walked collections,
   that E2's `allowedIssuers` check in §3.3 must resolve cross-repo).
7. **`badge.response.weight` is optional** and a free **string** ("0.85" here) — the
   §3.2 E2 "clamp to [0,1]" parser must handle absence and arbitrary decimal strings
   via the §3.5 grammar.

None of these change the graph design; they are decode-shape corrections for the
guest's narrow-schema parser and the §3.5 skip list. The consuming-app-normalizes,
numbers-are-strings, open-vocabulary facts from §2 all held.

### 2.6 What this leaves for M3/M4

- **M3 (conformance):** this fixture is happy-path typed data on a 15-block repo; it
  does not add adversarial MST vectors, absence proofs, or full PLC-chain
  verification (still only the last op's key, as in §1.9). The dev PLC gives a real
  but single-op, non-directory log — a multi-op rotation/nullification fixture is
  still owed. The seven-range multi-walk is validated on non-adversarial data;
  boundary-fencing against crafted fence keys remains a §1.9 item.
- **M4 (in-guest semantics):** the EIP-712 digest above is frozen — port it to the
  guest with patched keccak256 + `ecrecover` and it will match. The seven decode
  shapes in §2.5 define the narrow-schema record parser; the optional-field skips
  (evaluation subject/score, contributor identity/weight) must fold into
  `skippedDigest`. Cross-repo strongRef resolution is demonstrated (subject.cid ==
  activity.cid) but only intra-repo here; the `badge.definition` `allowedIssuers`
  cross-repo resolve and the `badge.response`/`acknowledgement` two-sided
  back-reference (§5.6) still need a multi-repo fixture.
- **Partner ask reinforced:** §2.2's server-side non-validation means the
  §9 "lexicon change protocol" and record-shape expectations should be stated
  plainly — malformed/partial records are a *when*, not an *if*, and the guest's
  skip rules are the only enforcement.

---

## 3. SP1 crypto costs, MEASURED (2026-07-14)

Prototype: `spike/crypto/` (throwaway; `guest/` = one crate with six `[[bin]]`s +
`[patch.crates-io]`, `guest-nopatch/` = same sources without patches, `host/` = executor CLI).
Replaces the estimate rows of dossier 03 §1 with executor-measured numbers.

**Environment:** SP1 **v6.3.1** (cargo-prove `8252c29 2026-06-25`, succinct toolchain,
target `riscv64im-succinct-zkvm-elf`), `sp1-zkvm =6.3.1` / `sp1-sdk =6.3.1` (blocking),
`SP1_PROVER=mock` (execute-only; gas calculation runs in the executor and is
backend-independent), linux/arm64 host. Cycles = `report.total_instruction_count()`;
PGU = `report.gas()` (the SDK's normalized Prover Gas Units, `Some` because
`calculate_gas` defaults to true - this is the figure the network bills).

**Patch tags used** (all exact tags from dossier 03 §1; every one exists - note the
*repo* names differ from the crate names):

| crate | repo | tag |
|---|---|---|
| sha2 | `github.com/sp1-patches/RustCrypto-hashes` | `patch-sha2-0.10.9-sp1-6.0.0` |
| tiny-keccak | `github.com/sp1-patches/tiny-keccak` | `patch-2.0.2-sp1-6.0.0` |
| k256 | `github.com/sp1-patches/elliptic-curves` | `patch-k256-13.4-sp1-6.0.0` |
| p256 | `github.com/sp1-patches/elliptic-curves` | `patch-p256-13.2-sp1-6.0.0` |

**Reproduce:** `cd spike/crypto/host && SP1_PROVER=mock PATH="$HOME/.sp1/bin:$PATH" cargo run --release`
(grep `RESULT,<label>,<cycles>,<pgu>`).

### 3.1 Method

Every guest bin reads its inputs via `sp1_zkvm::io` and commits a digest/accumulator of the
results, so work cannot be optimized away. All numbers below are **marginal**:

- Signature ops: `(N=100 run - N=1 run) / 99` with 100 distinct host-generated signatures
  (k256 `VerifyingKey::recover_from_prehash` with `RecoveryId` = the Ethereum ecrecover path;
  p256 `verify_prehash` over low-S signatures). This cancels boot + fixed setup. Cross-check:
  the N=1-minus-noop marginal for ecrecover is 28.1k cycles, within 3% of the per-op figure.
- Hashes: `(hash bin - memfill bin)` at the same buffer size, where `bench-memfill` fills the
  identical buffer with the identical loop but does not hash. This isolates the hash itself
  from buffer generation (which costs ~8.4 cycles/B and would otherwise dominate: memfill-1MiB
  alone is 8.78M cycles).
- Empty-guest baseline (`noop`: one `io::read` + one commit): **1,182 cycles / 3,263 PGU** -
  boot overhead is negligible at every scale measured.

### 3.2 Results

| op | N / size | cycles (marginal, per-op) | PGU (marginal, per-op) | PGU/cycle | patched vs unpatched | vs dossier-03 estimate |
|---|---|---:|---:|---:|---|---|
| ecrecover (k256, patched) | per sig (N=1→100) | **27,282** | **50,203** | 1.84 | **85.4× cycles / 45.1× PGU** | est. ~218k cycles → **8× cheaper** |
| ecrecover (k256, unpatched) | per sig (N=1→100) | 2,328,948 | 2,263,592 | 0.97 | - | (baseline for speedup) |
| p256 verify (patched) | per sig (N=1→100) | **104,668** | **113,143** | 1.08 | not measured (unpatched est. ~11.8M, zk-X509) | est. 200-450k cycles → **2-4× cheaper**; = 3.84× k256 |
| keccak256 (tiny-keccak, patched) | 1 KiB | 6,547 | 16,502 | 2.52 | not measured | est. 10-30 cyc/B: **6.4 cyc/B** but 16.1 PGU/B |
| keccak256 (patched) | 64 KiB | 401,677 | 998,023 | 2.48 | not measured | 6.13 cyc/B / 15.2 PGU/B |
| keccak256 (patched) | 1 MiB | 6,422,810 | 15,962,984 | 2.49 | not measured | 6.13 cyc/B / 15.2 PGU/B (perfectly linear) |
| sha256 (sha2, patched) | 1 KiB | 4,609 | 13,303 | 2.89 | 14.9× cycles / 5.3× PGU | - |
| sha256 (patched) | 64 KiB | **224,353** | **749,655** | 3.34 | **17.4× cycles / 5.33× PGU** | "order 10²-10³/block": **219 cyc / 732 PGU per 64-B block** |
| sha256 (patched) | 1 MiB | 3,572,833 | 11,970,274 | 3.35 | 17.4× cycles / 5.33× PGU | 3.41 cyc/B / 11.4 PGU/B (linear) |
| sha256 (unpatched) | 64 KiB | 3,894,241 | 3,992,568 | 1.03 | - | 59.4 cyc/B (baseline) |

Raw absolute counts (cycles/PGU) for every run are in `spike/crypto/README.md`'s repro output;
the `RESULT,` lines are: noop 1,182/3,263; ecrecover-patched N1 29,254/55,872, N100
2,730,192/5,025,919; ecrecover-nopatch N1 2,335,134/2,288,520, N100 232,901,026/226,384,090;
p256-patched N1 105,210/117,193, N100 10,467,337/11,318,359; memfill 1KiB 10,252/11,646,
64KiB 550,540/507,603, 1MiB 8,783,500/8,065,080; keccak 1KiB 16,799/28,148, 64KiB
952,217/1,505,626, 1MiB 15,206,310/24,028,064; sha256-patched 1KiB 14,861/24,949, 64KiB
774,893/1,257,258, 1MiB 12,356,333/20,035,354; sha256-nopatch 1KiB 79,133/81,957, 64KiB
4,444,781/4,500,171, 1MiB 70,968,941/71,825,337.

### 3.3 Surprises vs dossier 03

1. **Patched ecrecover is ~8× cheaper than the dossier's anchor.** 27.3k cycles / 50.2k PGU
   per signature vs the ~218k-cycle raiko/RSP figure (SP1 v1-era, and it included
   pubkey→address keccak). The 150-250k "medium confidence" range is dead; v6 patches are an
   order of magnitude better than the 2024 measurement.
2. **"PGUs, not cycles" confirmed and now quantified per op.** PGU/cycle is 0.97-1.03 for
   plain RISC-V code, **1.84 for ecrecover, 2.5 for keccak, 3.35 for sha256**. Precompiled
   hashing under-reports its prover cost in cycles by >3×; any budget arithmetic must use the
   PGU column. Corollary: patched-vs-unpatched speedups roughly halve (or worse) in PGU terms
   - ecrecover 85× → 45×, sha256 17.4× → 5.3×. Still decisively worth it.
3. **sha256 beats keccak per byte** (11.4 vs 15.2 PGU/B patched) - good news, the MST walk is
   sha256. Both scale perfectly linearly from 1 KiB to 1 MiB.
4. **Dossier §2's headline scenarios shrink ~8×.** N=1,000 EIP-712 ecrecover: measured
   **0.050B PGU** (dossier est. ~0.4B) → **$0.005-0.05** at the working $0.1-1.0/B-PGU price.
   N=100,000: **5.0B PGU** (est. ~40B) → **$0.5-5** per epoch. The per-attester atproto commit
   signature is 50.2k PGU (k256) / 113k PGU (p256): at 1k attesters that's 0.05-0.11B PGU
   plus 11.4 PGU/B of MST bytes hashed - signature cost is now even more decisively noise.
5. **p256:k256 stays inside the dossier's 1-2× guess only in PGU terms** (2.25×); in cycles
   it's 3.84×. Verify-vs-recover asymmetry is larger than estimated but immaterial at these
   absolute sizes.

**Not measured here:** prover-network clearing price per B-PGU (needs a live network request
with `NETWORK_PRIVATE_KEY` - pending Jake); unpatched p256/keccak builds (dossier's 11.8M-cycle
unpatched-p256 anchor stands unreplicated); proving wall-clock (execute-only spike).

---

## 4. Nostr / BIP340 schnorr (corrected 2026-08-19)

Owner: the Buzz/Nostr envelope spike ([`../BUZZ_NOSTR_PLAN.md`](../BUZZ_NOSTR_PLAN.md)). Harness:
the detached [`../nostr/sp1-bench/`](../nostr/sp1-bench/) workspace; SP1 v6.3.1, cargo-prove
`8252c29`, `SP1_PROVER=mock`, linux/arm64, patch tags `patch-k256-13.4-sp1-6.0.0` and
`patch-sha2-0.10.9-sp1-6.0.0`. Marginals are `(N=100 - N=1) / 99` with distinct valid cases and
committed outputs. Complete raw output and reproduction instructions are in
[`../nostr/README.md`](../nostr/README.md).

The 2026-08-16 rows are retired: they used k256's message-level `Verifier`, which hashes the
already-hashed Nostr event id. The corrected harness uses `PrehashVerifier`, asserts exact
host-`serde_json`/guest serializer parity, and round-trips the source-derived live Buzz bundle.

### 4.1 Results

| op | cycles (marginal, per-op) | PGU (marginal, per-op) | PGU/cycle |
|---|---:|---:|---:|
| BIP-340 prehash verification | **30,842** | **55,182** | 1.79 |
| complete Nostr event: NIP-01 serialize → SHA-256 id → prehash verify | **44,734** | **70,149** | 1.57 |
| Buzz audit-entry hash and chain fold | **10,302** | **11,920** | 1.16 |
| NIP-OA exact tagged hash + conditions + owner prehash verify | **35,964** | **61,246** | 1.70 |

The 20,297-byte live Option-A bundle—30 audit rows, 35 signed events, three OA credentials—runs
end to end in **2,519,703 cycles / 3,631,054 PGU**. The bin binds the TGNW data commitment,
strictly decodes caps, folds the audit prefix, checks event coverage, and verifies every event and
OA signature. Its graph semantics are intentionally outside this S0 envelope measurement.

### 4.2 Mechanism facts (from patch diffs, not docs)

1. **The sp1-patches `k256` fork covers schnorr explicitly.** The
   `patch-k256-13.4-sp1-*` diff modifies `schnorr.rs` + `schnorr/{signing,verifying}.rs`;
   patched `verify_raw` computes the BIP340 tagged challenge via `sha2` (accelerated when
   the sha2 patch is applied) and evaluates `R = lincomb(G, s, P, −e)` through
   `sp1_lib::ecdsa::ProjectivePoint` — i.e. the secp256k1 add/double/decompress
   precompiles. X-only key load rides hint-accelerated field `sqrt`/`inverse`. Succinct's
   own `patch-testing/k256/program/bin/schnorr_verify.rs` proves this path in CI, but the
   docs table only advertises ECDSA — treat schnorr as source-evidenced, and re-measure on
   any patch-tag or SP1 major bump.
2. **The sp1-patches C `secp256k1` fork does NOT accelerate schnorr.** Its zkvm cfg
   re-routes only `verify_ecdsa`/`recover_ecdsa` into patched k256; `src/schnorr.rs` is
   byte-identical to upstream and falls through to cross-compiled C libsecp256k1
   (external `RISCV_GNU_TOOLCHAIN` build dependency, unaccelerated). Corollary:
   rust-nostr's `Event::verify` (pinned `secp256k1 0.30` + `bitcoin_hashes`, neither
   accelerated) is the ~1.1M-cycle class in-guest — host-side use only.
3. **Canonicalization landmine.** The NIP-01 spec text ("all other characters must be
   included verbatim", content-field-only escaping) diverges from both reference
   implementations: `serde_json` (rust-nostr, hence buzz) and `JSON.stringify`
   (nostr-tools) additionally emit `\u00XX` for ASCII control characters outside the
   seven named escapes, and escape tag strings identically to content. The corrected guest
   implements the serde_json form and tests every control byte. U+0000 remains serializer-only
   because Buzz's PostgreSQL `jsonb` path rejects that tag escape before storage.
4. **Third-party context, not a replacement measurement:** CoW Protocol's multi-zkVM benchmark
   (SP1 v5.2.4, patched k256 with `features=["schnorr"]`) exercises the patched schnorr machinery,
   but its message contract and Merkle workload differ; it cannot validate a Nostr prehash cap.
   No public project proving Nostr events in a zkVM was found (GitHub + NIPs repo
   sweeps) — the ground is unoccupied.
