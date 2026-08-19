# Buzz `a362fecc` conformance profile

This directory freezes the source contract used by `nostr-workspace` S0. The upstream base is
`block/buzz@a362fecc2389955f942c9581bdfeba379ab115b3` (2026-08-18), whose workspace pins
`rust-nostr = 0.44`. The supported full-signal pilot profile applies
[`buzz-trustgraphs-compat.patch`](./buzz-trustgraphs-compat.patch), SHA-256
`3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62`.

The patch is necessary, not an optional convenience. At the base SHA,
`required_scope_for_kind` is a closed allowlist: it rejects unknown kinds and omits Buzz's own
43001–43006 job constants. An unmodified relay therefore cannot ingest V1, J1, the persistent
binding carrier, or the Option-C head. The patch only registers/adopts those kinds and gives them
explicit scope/routing; all event validation, storage, audit, replacement, and deletion behavior
remains upstream Buzz code. This deviation is recorded in `research/DEVIATIONS.md`.

## Primary-source pins

- Buzz upstream base: `a362fecc2389955f942c9581bdfeba379ab115b3`
- Nostr NIPs collision sweep: `nostr-protocol/nips@656cecc7c0a815b6a2b218d3b5d6f078b3f4dbab`
- Machine-readable kind registry sweep:
  `nostr-protocol/registry-of-kinds@fa7fa9cc4b733878d68bcedcab2133aa73cb88cf`
- Selected unclaimed addressable kinds: vouch `36382`, EVM binding `36383`, self-log head `36384`
- SP1: `6.3.1`; `sha2` patch `patch-sha2-0.10.9-sp1-6.0.0`; `k256` patch
  `patch-k256-13.4-sp1-6.0.0`

Kinds 36382–36384 were absent from both pinned Nostr registries and Buzz's `ALL_KINDS`. These are
experimental application kinds. Coordination is an optional S5 follow-on; historical v1 meaning
is fixed by this document even if later coordination selects different numbers for a new version.

## Buzz audit preimage

For each community, sequence starts at 1 and the first `prev_hash` is SQL `NULL`. Its hash preimage
uses the 32-byte all-zero genesis value. Every later row carries the previous row's exact 32-byte
hash. The SHA-256 preimage is the raw concatenation below, with no separators or length words:

```text
community_uuid_bytes[16]
|| seq_i64_be[8]
|| created_at.to_rfc3339().utf8
|| action_snake_case.utf8
|| actor_present_u8 || actor_pubkey_bytes_if_present
|| object_present_u8 || object_id_utf8_if_present
|| canonical_recursive_detail_json.utf8
|| (prev_hash[32] or zero[32])
```

`created_at` is truncated to Postgres microsecond precision before both hashing and storage.
Chrono's `to_rfc3339()` renders UTC as `+00:00` and emits 0, 3, or 6 fractional digits after that
truncation. JSON objects are recursively key-sorted; arrays retain order; scalar spelling is
`serde_json` spelling. `Some(empty)` differs from `None` because each optional field has a one-byte
presence marker.

The complete action map at this SHA, in the enum's stable order, is:

```text
0 event_created             6 member_removed
1 event_deleted             7 auth_success
2 channel_created           8 auth_failure
3 channel_updated           9 rate_limit_exceeded
4 channel_deleted          10 media_uploaded
5 member_added
```

For a stored event, `EventCreated` has `object_id = lowercase event-id hex`, `actor_pubkey` equal
to the authenticated actor (not necessarily the event author for relay-generated events), and
detail exactly equivalent to:

```json
{"channel_id":null,"event_kind":43001}
```

`channel_id` is either JSON `null` or the canonical lowercase hyphenated UUID string. The shown
key order is the hash order, not the insertion order in `serde_json::json!`.

`AppState` creates a bounded 1,000-entry queue only when audit is enabled. Enqueue uses
`send().await`, so a full queue backpressures ingest. A closed queue rejects the enqueue, but the
worker logs database-write failures and does not retry them. Anchoring consequently fails health
checks on any coverage gap; it never interprets a worker failure as an allowed event skip.

## Event and roster behavior

NIP-01 ids are SHA-256 over the UTF-8 JSON array
`[0,pubkey_hex,created_at,kind,tags,content]` emitted with `serde_json` escaping. That includes
lowercase `\u00xx` escapes for unnamed ASCII controls in both content and tag strings. Every v1
event, including Option-C entries, must also pass its own BIP-340 signature; the head signature is
additional completeness authentication.

Buzz accepts timestamps only within ±900 seconds of relay time and content up to 262,144 UTF-8
bytes, behind a default 524,288-byte WebSocket frame cap. It has no generic tag-count, tag-element,
or tag-string cap. The stricter TGNW/circuit limits below are therefore consensus and operator
limits, not claims about upstream ingest.

There is one lower storage boundary: a signed Nostr event containing U+0000 serializes correctly
as `\u0000`, but PostgreSQL `jsonb` rejects that escape when Buzz stores the tags. The live probe
returned HTTP 500 with `unsupported Unicode escape sequence`. Consequently the all-ASCII-control
case is a **serializer-only** source vector; it is never represented as a stored or audited event.
The independent verifier still checks all control bytes, Unicode, quotes, and backslashes against
rust-nostr's exact preimage.

The current roster is the winning kind-13534 event authored by the configured relay key. The
source builder emits one exact `['-']` protected marker followed by `['member', pubkey, role]`
tags, where `pubkey` is 64-character lowercase hex and role is `owner`, `admin`, or `member`.
Duplicate member pubkeys, any other role/shape, more than one protected marker, non-empty content,
or a signer other than the configured relay key invalidates the roster. NIP-11 `self` is only an
operator cross-check of that configured key.

`buzz-admin` publishes 13534 with `replace_addressable_event` and Redis directly; it does not call
the relay's `EventCreated` enqueue path. The winning roster row therefore comes from a consistent
direct `events`-table export and is not counted in the Option-A audit head. The exporter reads every
stored row, including soft-deleted deletion targets and superseded versions, because the audit row
stores only the event id, actor, kind, and channel—not the signed event bytes.

Buzz's canonical NIP-16/NIP-33 winner is greatest `created_at`, then lexicographically lowest
event id for an equal second. NIP-33 identity is `(kind, pubkey, d)`, independent of channel.
An incoming dominated candidate is returned as HTTP 200, `accepted=true`, message `duplicate:`,
but is neither stored nor audited. If a new winner displaces an already stored version, Buzz
soft-deletes the old row before inserting the winner, so that old row remains directly exportable.
Kind-5 accepts exactly one `e` or `a` target; NIP-33 coordinate deletion only affects versions
whose `created_at` is not newer than the deletion event. The program additionally verifies target
ownership for both forms.

## V1, binding, and Option-C schemas

All string comparisons are byte-exact. Hex is lowercase and has no `0x` unless stated otherwise.
Unknown or duplicate singleton tags make the event malformed.

### V1 vouch — kind 36382

- exactly one `['d', subject_pubkey_hex]`;
- exactly one `['weight', canonical_decimal_0_through_100]`;
- optional one valid four-element NIP-OA `auth` tag for an eligible agent author;
- no other tags and empty content.

The live state is one addressable event per `(author, subject)`. Weight zero and a valid kind-5
tombstone revoke it. A self-vouch is valid state but creates no edge.

### G1 merge — kinds 1617/1618 and 1631

The relationship carrier is a kind-1631 status with exactly one
`['e', root_event_id, '', 'root']`. The status may otherwise contain only the shapes emitted by
Buzz's `build_git_status`: `p`, `a`, `r`, `q`, `merge-commit`, and `applied-as-commits`; singleton
tags may not be duplicated and every hex/id/coordinate field must pass the builder's grammar.
Hints never identify the edge target.

The referenced, signed root must be present and be one of:

- kind 1617 with exactly one repository `a` coordinate, the repository-owner `p`, exactly one
  `['t', 'root']`, no `root-revision` or reply tag, and non-empty patch content; or
- kind 1618 with exactly one repository `a`, repository-owner `p`, non-empty `subject`, commit `c`,
  and non-empty `clone` tag, using the exact `build_git_pull_request` field shapes.

Kind 1619 is a PR update, not a root, and cannot establish G1. The edge is status author → root
event author. Missing roots, any other root kind, duplicate root markers, and self edges are inert.

### F1 vote — kinds 45001/45003 and 45002

A vote has exactly one two-element canonical-UUID `h` tag, exactly one two-element event-id `e`
tag, no other tags, and content exactly `+` or `-`. Its referenced signed target must be present,
have kind 45001 or 45003, and carry the same sole `h` value. State is keyed by `(voter, target)` and
ordered by committed audit/self-log order: `+` creates voter → target-author state and `-` clears
it. Missing targets, arbitrary content, malformed shapes, and self edges are inert.

### Nostr↔EVM binding — kind 36383

- exactly one `['d', '0x' + 40_lowercase_hex_address]`;
- no other tags and canonical JSON content with exactly these fields in this order:

```json
{"address":"0x0000000000000000000000000000000000000000","chainId":"1","timestamp":"0","nonce":"0","signature":"0x<130 lowercase hex>"}
```

`chainId`, `timestamp`, and `nonce` are non-empty canonical unsigned base-10 strings. `address`
must equal `d`. The EIP-712 message is the existing `IdentityLink` v1 `LinkAttestation`, with
`did = did:nostr:<event-author-hex>` and the instance chain id. The recovered wallet must equal the
content address. Replacement rebinds; weight-zero has no special meaning; a valid kind-5 `a`
tombstone unbinds.

### Option-C head — kind 36384

- exactly one `['d', instance_domain_hex32]`;
- exactly one `['commitment', 'self-log-v1']`;
- exactly one `['head', head_hex32]`;
- exactly one `['count', canonical_u64_decimal]`;
- no other tags and empty content.

The author must equal the anchored `did:nostr` node. The head event is not itself an entry in the
log. Genesis and each entry are:

```text
h_0 = sha256("trustgraphs.nostr.self-log.genesis.v1" || instance_domain[32] || author[32])
h_i = sha256("trustgraphs.nostr.self-log.entry.v1" || instance_domain[32] || author[32]
             || i_u64_be || h_(i-1)[32] || event_id_i[32])
```

The head tag and on-chain anchor head both equal `h_count`. The count tag and on-chain anchor count
both equal the exact number of committed events. Log order, not `created_at`, orders ordinary
lifecycle events. Each entry still carries and verifies its own NIP-01 signature.

## J1 completed-job profile

Buzz defines 43001–43006 but has no producer or payload/reference contract at the pin. J1 freezes
the following Trustgraphs profile. It is evidence of a claimed result, never requester acceptance.

Request (43001), authored by a roster member:

- exactly one two-element `h` tag containing a canonical lowercase channel UUID;
- exactly one two-element `p` tag containing the intended agent pubkey;
- no `e` or `auth` tag and no other tags;
- content length 1–16,384 UTF-8 bytes.

Result (43004), authored by that agent:

- exactly one `h`, byte-equal to the request's `h`;
- exactly one `p`, byte-equal to the requester's pubkey;
- exactly one `['e', request_event_id, '', 'root']`;
- exactly one four-element NIP-OA `auth` tag whose owner is in the current roster and whose exact
  signed conditions authorize kind 43004 at the result's timestamp;
- no other tags; content length 1–65,536 UTF-8 bytes.

Cancel (43005) uses the result reference shape, is authored by the requester, points `p` to the
agent, has no `auth`, and permits 0–4,096 content bytes. Error (43006) uses the result shape, is
authored by the OA-valid agent, points `p` to the requester, carries exactly one valid `auth`, and
permits 0–4,096 content bytes. Accepted/progress events (43002/43003) are authenticated and
archived but do not establish J1.

For each request, valid result/cancel/error events are ordered by committed audit/self-log order;
the last terminal state wins. J1 exists only when that state is a valid result. A later cancel or
error clears it; a later valid result may establish it again. The exact request and winning result
must both be present. The agent is eligible only through the result's unambiguous OA credential,
whose owner is a roster member.

## TGNW v1

`dataCommitment = sha256(exact_TGNW_envelope_bytes)`. Integers are unsigned big-endian. Lengths
are `u32`; decoders check remaining input before allocation and reject trailing bytes. UTF-8 fields
must decode exactly. The common prefix is:

```text
"TGNW"[4] || version_u8=1 || variant_u8 || flags_u16=0
|| community_uuid[16] || instance_domain[32] || authority_pubkey[32]
```

`variant=1` (`buzz-audit-v1`) uses the relay pubkey as `authority_pubkey`, followed by
`audit_count_u32 || audit_entries || event_count_u32 || events`. `variant=2` (`self-log-v1`) uses
the log author as `authority_pubkey`, followed by
`event_count_u32 || events_in_log_order || head_event`. Variant 3 is reserved for
`sidecar-head-v1` and is rejected in v1 params.

An audit entry is:

```text
seq_u64 || hash[32] || prev_present_u8 || prev_hash[32]?
|| action_u8 || actor_present_u8 || actor[32]?
|| object_present_u8 || object_len_u32 || object_utf8 ?
|| created_at_len_u32 || created_at_utf8
|| detail_len_u32 || canonical_detail_json_utf8
```

A Nostr event is:

```text
id[32] || pubkey[32] || created_at_u64 || kind_u32
|| tag_count_u32
|| repeated(tag_element_count_u32 || repeated(string_len_u32 || string_utf8))
|| content_len_u32 || content_utf8 || signature[64]
```

Audit entries are sequence-ascending from 1 through the anchored count. Audit events are unique by
id and ordered by their `EventCreated` sequence. A valid `EventCreated` detail is required before
the kind can be classified. Bytes for every trust-relevant created event must be present exactly
once; absence invalidates the whole head. Present malformed events enter the closed skip taxonomy.
Non-relevant actions and event kinds remain in the audit fold but need no event bytes.

The hard v1 circuit maxima are:

| Resource | Maximum |
|---|---:|
| one TGNW envelope | 12,582,912 bytes (12 MiB) |
| selected heads per guest input | 129 |
| audit entries across input | 4,096 |
| Nostr events across input, after A/C id dedup | 512 |
| one encoded event | 131,072 bytes |
| event content | 65,536 bytes |
| tags per event | 64 |
| elements per tag | 8 |
| one tag string | 1,024 bytes |
| all tag strings per event | 16,384 bytes |
| audit detail | 4,096 bytes |
| NIP-01 signature checks | 640 |
| NIP-OA signature checks | 256 |

Instance params may set equal or lower operational maxima and include those choices in
`paramsHash`; they may never raise the hard limits. Operator preflight counts the raw work before
wallet or prover-network spend. The measured conservative estimate is
`2 × (24×bundle_bytes + 12,000×audit_entries + 71,000×NIP-01_checks + 62,000×OA_checks + 1,000,000)`
PGU. Joint hard maxima estimate to 826.9M PGU. The pilot further limits bundles to 4 MiB, audit
entries to 2,048, OA checks to 128, and estimated work to 400M PGU; the existing 512-event and
640-total-signature hard limits still apply.

## Fixture and benchmark status

The compatibility patch applies cleanly to the pinned base, passes `cargo fmt --all --check`, and
passes its focused `buzz-relay` unit test. The isolated `generator/` crate pins Buzz by Git SHA,
invokes Buzz's audit hash and forum/git/OA code, and uses rust-nostr 0.44.7 for the source event
bytes. The deterministic baseline emits 24 events, two serializer-only vectors, 18 OA
grammar/application cases, a 23-row model audit prefix, one direct roster row, a duplicate A+C
case, and nine named adversarial cases. Regenerate and independently verify it from this directory:

```sh
cargo run --manifest-path generator/Cargo.toml -- source-corpus.json
cargo run --manifest-path generator/Cargo.toml --bin verify_source_corpus -- source-corpus.json
```

The baseline output SHA-256 is
`3c18b2c2a0bf87f67edc3680814955604544b958c2b83bf68be7ecf80b7b6fb4`;
regeneration is byte-identical. The all-control-byte event moved from `events` to
`serializerVectors` after the live PostgreSQL NUL probe, which is why this count differs from the
earlier source-only draft.

The verifier is independent of rust-nostr and Buzz verification code. It reconstructs the NIP-01
bytes, uses k256's BIP-340 **prehash** API, recomputes the audit chain, verifies OA conditions and
signatures, checks the binding and self-log, and enforces the frozen valid/adversarial expectations.
It also asserts that k256's message-level `Verifier` rejects a real corpus signature; that API
would SHA-256 the already-hashed event id and was the defect in the retired 2026-08-16 SP1 spike.

The same generator materializes and the independent verifier strictly decodes, canonically
re-encodes, and byte-compares these envelopes:

| artifact | bytes | SHA-256 / `dataCommitment` |
| --- | ---: | --- |
| `source-option-a.tgnw` | 14,519 | `e3ad3bf20d1174796e6d5cf9bc4502b2e54b543bbb14a7a5b9da985c75cb1a0b` |
| `source-option-c.tgnw` | 1,630 | `357bc1a2eee57b48d402cd0c8ce8e0f934f92380cff0af41a76e38ee99056522` |

`adversarial/audit-gap.tgnw` removes sequence 2 without repairing the chain;
`adversarial/changed-bundle-byte.tgnw` flips byte 32 of Option A. The verifier requires both to
fail against the committed artifact metadata and corpus. Their SHA-256 values are respectively
`3cf16616d4df918d64ea3542e1c20b22d47b0ffbaae7bd7eea53695613abbd5f` and
`04338ff215ab734266acf75e458820917213afbe565943067b45fd05524577e7`.

### Deterministic second epoch

`epoch2/` is generated from the same keys, domains, schemas, and pinned Buzz code with
`TG_BUZZ_FIXTURE_EPOCH=2`. It retains the complete first prefix, then adds one roster member,
replaces Alice's vouch to Bob, deletes Bob's vouch to Alice, flips Alice's forum vote, completes a
new member→agent J1 lifecycle, and advances the agent self-log from count 2 to 3. The source keeps
both signed self-log recovery heads; the exporter must select the uniquely defined greatest count
for the requested authority and reject conflicting metadata at that maximum.

```sh
TG_BUZZ_FIXTURE_EPOCH=2 cargo run --manifest-path generator/Cargo.toml -- \
  epoch2/source-corpus.json
cargo run --manifest-path generator/Cargo.toml --bin verify_source_corpus -- \
  epoch2/source-corpus.json
```

| artifact | bytes | SHA-256 / `dataCommitment` |
| --- | ---: | --- |
| `epoch2/source-corpus.json` | 100,690 | `3d8fa0239213d1a9fe5bab3128966d3bf3d967aa6b905b835dde3f232a5e018a` |
| `epoch2/source-option-a.tgnw` | 18,891 | `bd746a4dfe85af7f3ad7cc58af95646106bad4edf7d7b22309ae276daae21447` |
| `epoch2/source-option-c.tgnw` | 2,292 | `02d58eaf92814010fe6aae531f4fcf15e97dbe5baff618bdd7152e2b698ffa24` |

The S4 live rehearsal anchors A2 and C2 but intentionally withholds C2 from assembly. H-5 forbids
resurrecting C1, so the guest emits one `DROPPED` rule-Φ preimage and still resolves all relay-
attested epoch mutations through A2. Two independent exports must reproduce the committed A2/C2
bytes before either head is anchored.

### Pinned live export

`live/` is the required real Buzz capture, not a hand-authored model. It was produced on
2026-08-19 from the patched pinned relay with audit enabled, PostgreSQL 16.14, Redis 7.0.15, and
MinIO `RELEASE.2025-09-07T16-13-09Z`. The MinIO and `mc` binary SHA-256 values used during the run
were `5c83cd2cf151717ba0243f73e1c7802ff36e272b67144bdd7f1f7d684fd6f03d` and
`14c8c9616cfce4636add161304353244e8de383b2e2752c0e9dad01d4c27c12c`.
Buzz's mandatory S3 conditional-write conformance probe passed before the relay began serving.

The deployment identities are frozen in the export:

- community `6d18989e-2d5b-4ea9-9a12-3081797d3211`, host `127.0.0.1:33300`;
- channel `01915f7a-6b4c-7d2e-8f10-665544332211`;
- NIP-11 `self` / roster signer
  `1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f`;
- Alice as relay/channel owner and Bob as relay/channel member; and
- the OA agent absent from the relay roster, with its eligible actions delegated by Alice.

The live run accepted 23 v1 source submissions. The dominated same-second vouch returned the
source response `accepted=true, message="duplicate:"` and appears in neither the database nor the
audit prefix, as required by Buzz's replacement path. After the deterministic channel setup and
Buzz-generated discovery/notification side effects, the database contained 35 signed event rows,
including five soft-deleted rows. The complete audit prefix contains 30 `event_created` rows and
ends at
`6778a840882644444cd37b3a0abc239176e0cda21cc58e33a853fb0c7ef23c95`.
Every audit object has its signed DB event row. Five additional direct rows are outside the audit:
the relay roster, two kind-40099 notification rows, and two kind-44100 membership notification
rows. `live/live-export.json` records and verifies this DB-minus-audit set explicitly.

The live artifacts are:

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `live/source-corpus.json` | 82,893 | `eba126d575a5f79970d73fa3ce93196717801d45bc01fabcbf9bb20d5c949163` |
| `live/source-option-a.tgnw` | 14,519 | `ae04f78cd05e06af8b038e48f57e86a8ae1e3a62e537c0d3088f6ed2ecc2b668` |
| `live/source-option-c.tgnw` | 1,630 | `5c85af4161eb16b5053a0604bd28781a63f26809d3a47cc82c9b8667e2fd5c7b` |
| `live/seed-report.json` | 5,422 | `49e421c20c7746a20d591f666737fb4f0e8066fce0c6d5208ae0aa8dc3118dca` |
| `live/nul-ingest-probe.json` | 2,665 | `ad237796ac9efe97f2eb5dd040a5afd664a8f39b0c3bf97082c2ce6af302d87c` |
| `live/live-export.json` | 150,666 | `2c10c55eb26df0e300d5f8dc2647eba4abda51697c92af21eb9c0dad0662d392` |
| `live/live-option-a.tgnw` | 20,297 | `872093fcdc876464c5c98f4349e090bc86a70da8bef7ef105ccdb5a532033a5d` |

`live/source-corpus.json` freezes the exact fresh timestamps and source-built input bytes. Its
model audit prefix and `source-option-*.tgnw` files are generator conformance artifacts. The
authoritative deployed rows and audit timestamps/hashes are in `live/live-export.json`, and
`live/live-option-a.tgnw` is their canonical binary projection. The JSON also embeds every database
event's independently reconstructable NIP-01 preimage, all migrations and membership rows,
NIP-11, the seed receipts, audit coverage, and the direct-row set.

Both layers verify offline without a database or relay:

```sh
cargo run --manifest-path generator/Cargo.toml --bin verify_source_corpus -- \
  live/source-corpus.json
cargo run --manifest-path generator/Cargo.toml --bin verify_live_export -- \
  live/live-export.json live/source-corpus.json live/seed-report.json \
  live/nul-ingest-probe.json live/live-option-a.tgnw
```

The second verifier uses only serde, SHA-256, k256's BIP-340 prehash verification, and local schema
logic—never rust-nostr, Buzz audit code, or a database. It verifies all 35 stored signatures and
preimages, the exact 30-row Buzz audit hash chain, roster/NIP-11/member agreement, input/receipt
identity, replacement behavior, audit coverage, the five direct rows, the byte-exact live TGNW
bundle, and the separately signed fresh-timestamp NUL probe's expected HTTP 500/non-persistence
result. The checked commands report:

```text
verified 24 events, 23 audit rows, 2 serializer vectors, 18 OA cases, and 9 adversarial cases
verified live export: 35 DB events, 30 audit rows, 5 direct rows, 23 submitted inputs; TGNW 20297 bytes / 872093fcdc876464c5c98f4349e090bc86a70da8bef7ef105ccdb5a532033a5d
```

`cargo test --manifest-path generator/Cargo.toml --bin verify_live_export` adds six independent
adversarial checks. It flips every TGNW header, audit, event, tag/content, and signature field in
turn and requires rejection; checks the data commitment changes; accepts every exact hard cap and
rejects its next value; exercises string and encoded-event bounds; and verifies the measured hard
and pilot work formulas against `live/adversarial/cap-boundaries.json`.

For a new live capture, choose `TG_BUZZ_FIXTURE_BASE_TIME` within Buzz's ±900-second window and set
the deployment community/channel UUIDs before running the source generator, then run `live_seed`
against a freshly initialized relay and `export_live_db` with its `DATABASE_URL`. The committed
capture deliberately keeps its original real database and receipt timestamps; it is a frozen
fixture, not a timeless replay request.

S0 exits on this fixture: the corrected SP1 spike supplies marginal audit/NIP-01/OA costs and a
whole-live-TGNW guest round trip: 2,519,703 cycles / 3,631,054 PGU for 30 audit rows, 35 events,
and three OA checks.
The measured work formula and stricter 400M-PGU pilot ceiling are frozen in
`research/nostr/README.md`, and the per-field/cap suite is green. The spike guest is measurement
evidence; S1 owns the reusable production envelope verifier and its conformance guest. No
consensus-facing code may use the retired message-level measurements.

S1 also exits on this fixture. `packages/envelopes::nostr` verifies both checked-in A/C bundles,
and the detached production conformance guest matches all six native output words on the live A
bundle at 3,501,450 cycles / 4,553,481 PGU. Its accepted/skipped digests are respectively
`0f19891df43eae1cd874fcbfd5d7f64c33211fbdfb7bcc72dc51c04e16d620b9` and
`46b01e4c9ce37c375e0faf4a0a607ba0f33c204ebc900ff72e0a47bdf44d1a47`. Native and guest both
reject the re-committed signed-byte mutation. Missing-reference and duplicate-A+C expectations are
owned by S2 because they require graph-schema and cross-envelope semantics, not envelope validity.
