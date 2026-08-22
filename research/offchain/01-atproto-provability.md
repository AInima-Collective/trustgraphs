# AT Protocol Cryptographic Provability Dossier

**Status:** Source dossier (substrate for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md); realized — see [`../../docs/concepts/networks-and-programs.md`](../../docs/concepts/networks-and-programs.md)).

> Source research for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md). Compiled 2026-07-10 from atproto.com specs, web.plc.directory, bluesky-social GitHub, and 2025–2026 roadmap posts. Uncertainties flagged inline with ⚠️.

---

## 1. Repo structure, MST, content addressing

**Repository = signed key/value map.** A repo is a mapping from path strings to records, stored in a Merkle Search Tree (MST), with a single signed commit object on top. Spec: https://atproto.com/specs/repository

**Keys (paths):** exactly two segments, `<collection NSID>/<record-key>`. Record keys (https://atproto.com/specs/record-key): 1–512 chars from `[A-Za-z0-9._:~-]`, case-sensitive, `.`/`..` forbidden, `%` reserved. Most common rkey type is a **TID** (timestamp identifier, e.g. `3jzfcijpj2z2a`): 13-char base32-sortable string; sorts chronologically, but values are client-supplied — TID timestamps must not be trusted, and apps may use `literal:self`, NSIDs, or arbitrary strings. Keys sort in **lexicographic byte order**, which is the property that makes a collection a *contiguous key range* (crucial for §4).

**Encoding (DRISL, née DAG-CBOR).** All signed/hashed data uses a strict deterministic CBOR profile now called **DRISL** ("a normalized subset of CBOR… successor to DAG-CBOR"; all DRISL is valid CBOR). Rules: byte-deterministic map-key sorting, **no floats**, ints ≤64-bit signed (53-bit recommended), CID links as **CBOR tag 42** with the binary CID prefixed by `0x00`. JSON is a non-deterministic sibling encoding (`$link`, `$bytes` objects); only CBOR bytes are signed/hashed. Spec: https://atproto.com/specs/data-model. (DRISL relates to the IETF standardization track, §3.)

**Content addressing ("blessed" CID format):**
- CIDv1 (`0x01`)
- codec `dag-cbor` (`0x71`) for records, MST nodes, commits; `raw` (`0x55`) for blobs
- multihash `sha2-256` (`0x12`), 32-byte digest (`0x20`)
- string form: base32, `b` prefix.

So a record's CID = CIDv1(dag-cbor, sha256(DRISL-CBOR bytes)). One hash function, one codec — very zkVM-friendly (SHA-256 only).

**MST node format** (dag-cbor map):
- `l`: nullable CID of leftmost subtree
- `e`: array of entries, each `{p, k, v, t}`:
  - `p`: int, count of key bytes shared with the *previous* entry in this node (prefix compression, **mandatory** "to ensure that the MST structure is deterministic across implementations")
  - `k`: bytes, key suffix
  - `v`: CID of the record
  - `t`: nullable CID of subtree to the right of this entry

**Fanout / layer rule:** a key's layer = `floor(count_leading_zero_bits(SHA-256(key_bytes)) / 2)`. Two bits per level ⇒ probability 1/4 of promotion ⇒ **expected fanout 4**. Tree shape is therefore a pure function of the key set: "The overall structure and shape of the MST is deterministic based on the current key/value content, regardless of the history of insertions and deletions." Empty nodes are pruned from top/bottom of the tree but empty *intermediate* nodes are kept. This canonical-form property is what makes set-completeness proofs possible (§4).

**Limits:** record blocks ≤1 MB; commit `blocks` diff ≤2 MB; ≤200 ops/commit; repos intended for "up to single-digit millions" of records. Blobs are outside the MST (referenced via `{$type:"blob", ref:<raw-CID>, mimeType, size}`).

---

## 2. Commit signatures

**Commit object (v3)** — dag-cbor map with fields:
- `did`: account DID (string)
- `version`: `3`
- `data`: CID of MST root
- `rev`: TID string, logical clock, must increase monotonically (recommend current timestamp)
- `prev`: nullable CID of previous commit — **virtually always `null` in v3** (see §6)
- `sig`: signature as raw bytes

**What is signed:** serialize the commit *without* `sig` as DRISL CBOR → SHA-256 the bytes → ECDSA-sign the 32-byte digest → store signature bytes in `sig` → re-serialize with `sig` (the commit's own CID covers the signed form). Spec: https://atproto.com/specs/repository, https://atproto.com/specs/cryptography.

**Curves:** exactly two "blessed":
- **k256** (secp256k1) — default for new keys
- **p256** (NIST P-256 / secp256r1)

**Low-S is mandatory** for both curves (BIP-0062 style), for signing and verification, to kill ECDSA malleability. Public keys use compressed 33-byte points, encoded as **multikey**: multicodec varint prefix (`p256-pub` = code 0x1200, varint bytes `0x80 0x24`; `secp256k1-pub` = code 0xE7, varint `0xE7 0x01`) + compressed point, base58btc with `z` prefix; `did:key:` prefix optional. A deprecated legacy multibase encoding (uncompressed points) still appears in some older DID docs. ⚠️ The spec calls `sig` "raw bytes" without pinning the exact layout in the page text retrieved; in practice all reference implementations (`@atproto/crypto`, indigo, atproto Python) emit/verify **64-byte compact `r||s`** (not DER). Treat 64-byte compact + low-S as the de-facto wire rule but re-verify against https://atproto.com/specs/cryptography before hardcoding.

**Who holds the signing key: the PDS, not the user.** The "atproto signing key" (DID doc `verificationMethod` id `…#atproto`) is operationally held by the PDS, which signs every commit on the user's behalf. Users are *encouraged* to hold their own **rotation keys** (did:plc control keys, §3), which govern the identity but do not sign repo commits. On migration, the **new PDS generates a fresh signing key** and a PLC op rebinds the DID to it (https://atproto.com/guides/account-migration). Consequence for trustgraphs: a commit signature proves "the PDS currently authorized for DID D produced this state," not "the human D signed this attestation." Per-record user-held signatures would need an app-level signature field inside your lexicon.

---

## 3. DID layer

Spec: https://atproto.com/specs/did — two blessed methods, `did:plc` and `did:web`; the set is deliberately small but "additional methods may eventually be supported." DID doc must contain `verificationMethod` `#atproto` (type `Multikey`, `publicKeyMultibase`) and `service` `#atproto_pds` (`AtprotoPersonalDataServer`, HTTPS endpoint).

**did:plc** (spec: https://web.plc.directory/spec/v0.1/did-plc):
- Identifier = `did:plc:` + first **24 chars of base32(SHA-256(DAG-CBOR(genesis operation)))**. The identifier is self-certifying with respect to its genesis op.
- Operations: `{type, rotationKeys[1–5, did:key, k256/p256 only], verificationMethods{name→did:key}, alsoKnownAs[], services{}, prev: CID|null, sig: base64url ECDSA-SHA256}`. Each op points at the previous op's CID → a hash-chained log. `plc_tombstone` ops permanently kill a DID.
- **Rotation & recovery:** rotationKeys are ordered by priority; a *higher*-priority key can fork/nullify operations signed by a lower-priority key within a **72-hour recovery window**.
- **Verifiability:** the audit log (`https://plc.directory/<did>/log/audit`) contains everything needed to validate the chain independently: verify DID = hash-of-genesis, then each op is signed by a rotation key of its predecessor, respecting nullification rules. So DID→current-signing-key binding is **cryptographically checkable given the log**.
- **Residual trust in plc.directory:** the directory can't forge operations (they'd fail signature checks), but it *can* withhold operations or serve a stale/pruned view (omission attack), and it's the arbiter of op ordering during 72h fork races. So: self-certifying content, **trusted availability/ordering**.
- **Decentralization status (2026):** Bluesky announced (Sept 2025) transfer of the PLC Directory to an **independent Swiss Association**, in progress as of the Spring 2026 roadmap, with updates promised at AtmosphereConf (https://atproto.com/blog/plc-directory-org, https://docs.bsky.app/blog/protocol-checkin-fall-2025, https://atproto.com/blog/2026-spring-roadmap). A **WebSocket streaming API for PLC ops shipped January 2026**, enabling live third-party PLC mirrors — a mirror you run yourself neutralizes most omission risk. Community proposals for federated/BFT directories exist (e.g. "minimal web-of-trust governance," plcbft: https://github.com/bluesky-social/atproto/discussions/4002) but nothing is adopted. Also relevant: an **IETF ATP working group was formally chartered in late March 2026** (after an IETF 124 BoF), standardizing repository/data-model specs (Internet-Drafts already in the Datatracker).

**did:web:** hostname-only (no paths, no ports except localhost dev), resolved via HTTPS `/.well-known/did.json`. Trust model = TLS + DNS at resolution time; **no history, no audit log** — the host can swap keys silently and you can't distinguish rotation from compromise. For trustgraphs, did:web identities are strictly weaker; did:plc's audit log is the one you can bind to in a proof.

---

## 4. Completeness proofs within one repo

**Yes — enumeration of a full collection at a given commit is provable.** This is the strongest property atproto gives you, and it comes from two facts: (a) MST keys are sorted byte-lexicographically, so collection `app.certain.trust.vouch` occupies exactly the contiguous key range `["app.certain.trust.vouch/", "app.certain.trust.vouch0")` (`0x30` = `/`+1); (b) the tree shape is **canonical** for a given key set, and every node explicitly lists all its entries and subtree links — there is no way to present a valid root that hides keys from a range you fully traverse.

**Exact verification procedure** (this is what a zkVM guest would run):
1. Start from commit `C`; check `sig` over DRISL-CBOR(commit minus sig) with key `K`; take `data` = MST root CID.
2. Walk the tree from the root. In each node, decompress keys (`p`/`k` prefix scheme), enforce structural invariants: keys strictly ascending, every key at the correct layer per the leading-zero rule, entries/subtrees correctly interleaved.
3. For the target range `[lo, hi)`: recurse into `l` and every `t` subtree whose position between adjacent entry keys means it *could* contain keys in the range. Every such CID **must** be present in the supplied block set; a missing block ⇒ proof fails (fail-closed).
4. Keys outside the range in boundary nodes act as fences: an entry `k1 < lo` immediately followed by `k2 ≥ hi` with a null (or fully-traversed) subtree between them proves nothing else exists in the range.
5. Emit the set `{rkey → record CID}`; optionally hash the supplied record blocks to check they match the CIDs.

**Proofs of absence** are the degenerate case (empty range / single key): walk to where the key would live and show it isn't there. This is an explicitly supported, first-class operation: `com.atproto.sync.getRecord` is documented as "Get data blocks needed to prove the existence **or non-existence** of record in the current version of repo" and returns a CAR with commit + path blocks (https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getRecord.json). ⚠️ The repository spec mentions "compact proof chains for individual records" but does not spell out range-proof mechanics; the range algorithm above is implied by the data structure, and reference verification code exists in `github.com/bluesky-social/indigo/atproto/repo` (Go) — validate against it.

**What you cannot prove within one repo:** anything about *other* commits (no history chain, §6), and global completeness across repos (§9).

---

## 5. Sync, firehose, verifiable snapshots

Spec: https://atproto.com/specs/sync.

**Firehose (`com.atproto.sync.subscribeRepos`)** — event types: `#commit`, `#sync`, `#identity`, `#account`. `#commit` fields: `repo` (DID), `commit` (CID), `rev`, `since` (rev this diff builds on), **`prevData`** (MST root CID of the previous commit — added in Sync v1.1), `blocks` (CAR slice ≤2 MB containing the commit, changed MST nodes, new records), `ops` (≤200 `{action: create|update|delete, path, cid|null, prev?}`), `time`. WebSocket frames ≤5 MB.

**Sync v1.1 ("inductive firehose")**, rolled out through late 2025/Jan 2026 (bsky.network relay upgraded Jan 2026; reference consumer "tap" released; a fully spec-compliant consumer "still didn't exist" as of Fall 2025 — see https://docs.bsky.app/blog/protocol-checkin-fall-2025, https://atproto.com/blog/2026-spring-roadmap): each `#commit` is now *self-verifying relative to the previous one*. A consumer holding only the previous MST root can **invert the ops** against the supplied blocks and check it reproduces `prevData`, then apply them forward to reach the new signed root — full validation without storing whole repos. `#sync` re-asserts current `{did, rev, commit}` (blocks = commit only) to re-anchor when the chain breaks. The `tooBig` escape hatch was removed. **Relays are explicitly untrusted repeaters**: consumers verify signatures and MST consistency themselves; relays may only mutate identity/handle metadata.

**Snapshots:** `com.atproto.sync.getRepo` returns the entire repo as a **CARv1** file (`application/vnd.ipld.car`), first root = the commit CID; contains commit + all MST nodes + all records. Verification without trusting the PDS: hash every block → CIDs; check commit sig against the DID's `#atproto` key (resolved via PLC audit log); walk MST from `data` checking canonical structure and that every referenced CID is present. **Integrity and completeness-at-that-commit are fully verifiable; the only thing the PDS controls is *which* (i.e., how fresh) commit it serves you** — staleness/equivocation toward different observers is detectable only via the firehose or by comparing `rev`s from multiple vantage points. `getRecord` gives the same guarantee for a single record incl. non-existence. Remaining gaps being worked on (Spring 2026 roadmap): defined block ordering in CAR exports and **subset-of-repo exports** — the latter is exactly "give me collection X + proof" as a first-class API; today you fetch the whole CAR or per-record proofs. Account status matters: repos can be `takendown/suspended/deactivated/deleted` and sync endpoints then refuse to serve them.

---

## 6. Deletions, mutability, migration — what breaks "append-only log"

Bluntly: **atproto is a signed *mutable state* system, not an append-only log.** Facts:

- **Deletion is trace-free by design:** "Record deletion is supported without leaving a trace or 'tombstone' of previous contents." After deletion the MST is *as if the record never existed* (canonical tree shape). A later snapshot cannot prove a record ever existed; conversely an old signed commit remains a valid proof that it existed *at that rev*.
- **No commit chain:** since repo format v3 (2023), `prev` is virtually always `null`. Commits do not hash-chain; `rev` is just a monotonic TID. The historical v2 chain and the old `#rebase` firehose event are gone. There is **no protocol-level guarantee that commit history is retained** — PDSes serve current state only; the spec doesn't address historical retention at all. "History" exists only as the transient firehose, which relays buffer for a limited window (backfill beyond that = full re-sync of current state).
- **Equivocation is possible:** nothing prevents a PDS from signing commit A for one observer and A′ for another at overlapping revs; only firehose consumers comparing `rev`/`prevData` chains detect it. `#sync` events exist precisely because chains break in practice.
- **Migration:** user moves PDS via service-auth token → `getRepo` CAR → `importRepo` → blob transfer → PLC op signed with a rotation key updating both `#atproto_pds` endpoint **and the signing key** (new PDS generates its own). Same DID, same record CIDs, but future commits are signed by a **different key**. (https://atproto.com/guides/account-migration)
- **Account lifecycle:** `#account` events report `takendown/suspended/deleted/deactivated`; did:plc can be tombstoned.

**Implication for trustgraphs:** you cannot rely on atproto for input *history* or non-equivocation. The pattern that works: an packages/indexer/oracle observes commits (firehose or polling), pins `(did, commit CID, rev, MST root)` tuples into your own accumulator (on-chain or committee-signed), and archives the corresponding CAR blocks — because the PDS may not be able to re-serve that commit later. Attestation *revocation* comes for free (delete the record; next observed commit's collection-range proof simply won't contain it), which is arguably a feature for a trust graph, but scores must be defined "as of snapshot set S," not "over all history."

---

## 7. Custom lexicons & existing trust/attestation work

**Mechanics** (https://atproto.com/specs/lexicon): record types are named by **NSIDs** (reverse-DNS, e.g. `app.certain.trust.vouch`), authority = control of the DNS domain (`certain.app`), at the "group" level (all names differing only in final segment share one authority repo). Since the 2025 **lexicon resolution** rollout: publish a `com.atproto.lexicon.schema` record (rkey = the NSID) in a repo, and point a DNS TXT record `_lexicon.trust.certain.app` at that repo's DID. No recursive parent-domain fallback. PDS validation is **fail-open** by default ("optimistic validation"): unknown/unresolvable lexicons are accepted, so third-party apps can write any record type into any user's repo (with an auth-scoped session). Every record carries `$type`. Tooling matured in 2025–26: `@atproto/lex` codegen, `goat` CLI publish/resolve/lint (https://atproto.com/blog/2026-spring-roadmap).

**Existing attestation/trust lexicons — thin.** As of mid-2026 there is **no widely adopted vouch/trust-edge lexicon**. What exists:
- **attested.network** — "proof of payment for ATProtocol": 4 record types + 3 XRPC methods; payment records in the payer's repo carrying a `signatures` array referencing counterparty proof records — the closest live precedent for cross-repo attestations (https://attested.network/).
- **lexicon-community** has an open "Attestation Lexicon" discussion (attestations as labeler-adjacent records; notes that v1 has no cross-repo writes/shared records) — https://github.com/orgs/lexicon-community/discussions/8.
- Bluesky's own graph primitives (`app.bsky.graph.follow`, `block`, verification records) are the only trust-ish records at scale.
- ⚠️ No established "vouch" NSID surfaced in ecosystem searches; assume greenfield. Defining a vouch lexicon `{subject: did, weight, createdAt, optional user-key signature}` and publishing it per the above is the expected path. Check https://github.com/bluesky-social/atproto-ecosystem and UFOs/lexicon indexes before finalizing names.

---

## 8. Private/encrypted data (2026 status)

- **Public-only today.** Everything in a repo is world-readable via sync. No private records in repos.
- **"Permissioned/private data"** is the Bluesky protocol team's **main 2026 focus**: sketch design published, parallel implementations by Blacksky, Northsky, Habitat; explicitly "will probably look pretty different from the MST + firehose system" and **not E2EE** — access-controlled, TLS-in-transit only (https://atproto.com/blog/2026-spring-roadmap, https://atproto.com/blog/2025-protocol-roadmap-spring, community WG: https://atproto.wiki/en/working-groups/private-data). ⚠️ Design unsettled; do not assume MST-style provability will exist for private data — early sketches suggest it won't.
- **E2EE DMs:** sequenced *after* permissioned data; Bluesky intends to build on **IETF MLS**. Meanwhile the startup **Germ** shipped MLS-based E2EE messaging integrated into the Bluesky app (profile badge → App Clip, atproto-handle auth) in **February 2026** (https://techcrunch.com/2026/02/18/a-startup-called-germ-becomes-the-first-private-messenger-that-launches-directly-from-blueskys-app/). Current `chat.bsky.*` DMs remain centralized and non-E2EE.
- For trustgraphs: **private attestations on atproto are not viable in 2026**; if attestation privacy is needed, encrypt payloads inside public records (losing PDS validation) or wait for permissioned data (losing, probably, Merkle provability).

---

## 9. zkVM proving fit — sizes and full verification pipeline

**Sizes (expected-case; derived from spec parameters, flagged where estimated):**
- Commit object: 6 small fields + 64-byte sig ≈ **150–250 bytes**.
- MST: expected fanout 4 ⇒ depth ≈ log₄(N): ~5 levels @ 1k records, ~7 @ 16k, ~10 @ 1M. ⚠️ Depth is probabilistic (per-key leading-zeros), so budget ~2× expected for worst paths.
- MST node: ~4 entries average; per entry `p`+`k` (prefix-compressed key, typically ≤30 B) + 36-byte CID `v` + optional 36-byte `t` ⇒ **~300–500 B typical**; variance is high (a node can legally hold dozens of entries; hard cap only via the 1 MB block limit — treat node size as adversary-influenced since users choose rkeys). ⚠️
- Single-record proof: depth × node size ≈ **2–10 KB**. Full-collection range proof for M records in an N-record repo: ≈ M/4 subtree nodes + boundary paths, i.e. **O(M) blocks ≈ M×(record size + ~100 B amortized MST overhead)**. Everything is SHA-256 over dag-cbor — no exotic hashes; k256 ECDSA verify is cheap in SP1 via precompiles, p256 also supported (both required, since atproto mandates both curves).

**Statement:** "record set S is the complete contents of collection X in repo of DID D at commit C, signed by key K bound to D." Guest program steps:
1. **CBOR-decode commit block**, check `version==3`, `did==D`; recompute SHA-256 → matches claimed commit CID C.
2. **Verify ECDSA** (k256 or p256, enforce low-S) of SHA-256(DRISL(commit sans `sig`)) against K (33-byte compressed point).
3. **Verify K is D's `#atproto` key:** for did:plc, verify the **PLC audit log chain** inside or outside the zkVM: genesis hash → 24-char DID check; each op signed by a predecessor rotation key; last op's `verificationMethods.atproto == K`. All ops are DAG-CBOR + SHA-256 + k256/p256 — same primitive set, so this *can* go in-circuit; ~1 sig + 1 hash per op, logs are usually <10 ops. ⚠️ Residual assumptions: (a) log freshness/omission — mitigate by running your own PLC mirror (WebSocket mirroring API live since Jan 2026) and committing its head into your accumulator; (b) 72-hour nullification window — treat key bindings younger than 72 h as provisional. did:web accounts cannot get this treatment (no verifiable log) — consider excluding or trust-flagging them.
4. **MST range walk** (algorithm in §4) over range `[X+"/", X+"0")`, enforcing canonical-structure invariants (sorted keys, layer rule via SHA-256 per key, mandatory prefix compression), fail-closed on any missing referenced block ⇒ outputs complete `{rkey → CID_record}`.
5. **Hash each record block** → matches its CID; CBOR-decode; check `$type == X`; extract `(subject DID, weight, …)` edges.
6. Commit public outputs: `(D, C, rev, X, H(edge set))` — these feed PageRank exactly where the EAS/chained-hash inputs do today.

**The hard part atproto does NOT solve: cross-repo completeness.** A commit proves completeness *within one repo*; nothing proves you enumerated all *repos* containing `X` records. The current on-chain accumulator solves exactly this per-event; the atproto analogue must be rebuilt: either (a) an indexer service that consumes the (verifiable, inductive) Sync v1.1 firehose and maintains an on-chain accumulator of `(did, commit CID)` heads — trust reduces to "indexer saw the whole firehose," partially checkable by anyone replaying the relay; (b) require participants to register `(did, PDS)` on-chain and have the prover fetch + prove each registered repo's snapshot (deterministic, fully verifiable, O(participants) fetches — closest to the current model); or (c) accept relay trust. Also remember §6: capture CAR blocks at observation time — old commits are not re-servable, and per-repo snapshots taken at different times make the "graph at time T" only piecewise-consistent (each repo consistent at its own `(rev, commit)`; there is no global clock).

**Bottom line:** atproto gives you, per account: one signature, one hash function, a canonical Merkle structure with true range/absence proofs, and (for did:plc) an independently verifiable key-binding log — an unusually good fit for SP1. What it does not give you: append-only history, non-equivocation, global enumeration, or user-held signing keys. Every one of those must live in your own layer (accumulator + PLC mirror + optional in-record user signatures).

**Key sources:** [repository spec](https://atproto.com/specs/repository) · [data model](https://atproto.com/specs/data-model) · [cryptography](https://atproto.com/specs/cryptography) · [record keys](https://atproto.com/specs/record-key) · [sync spec](https://atproto.com/specs/sync) · [DID spec](https://atproto.com/specs/did) · [did:plc spec](https://web.plc.directory/spec/v0.1/did-plc) · [lexicon spec](https://atproto.com/specs/lexicon) · [getRecord lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/sync/getRecord.json) · [account migration](https://atproto.com/guides/account-migration) · [PLC directory org announcement](https://atproto.com/blog/plc-directory-org) · [Fall 2025 check-in](https://docs.bsky.app/blog/protocol-checkin-fall-2025) · [Spring 2026 roadmap](https://atproto.com/blog/2026-spring-roadmap) · [PLC web-of-trust discussion #4002](https://github.com/bluesky-social/atproto/discussions/4002) · [indigo repo package](https://pkg.go.dev/github.com/bluesky-social/indigo/atproto/repo) · [attested.network](https://attested.network/) · [lexicon-community attestation discussion](https://github.com/orgs/lexicon-community/discussions/8) · [Germ E2EE launch (TechCrunch)](https://techcrunch.com/2026/02/18/a-startup-called-germ-becomes-the-first-private-messenger-that-launches-directly-from-blueskys-app/) · [Private Data WG](https://atproto.wiki/en/working-groups/private-data)
