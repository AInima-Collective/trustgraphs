# EAS off-chain support: envelope 0 protocol

**Status:** M0 design of record (2026-08-20). This document supersedes the envelope-0 and
Rule-Φ launch semantics in [`OFFCHAIN_ATTESTATIONS_ZK.md`](./OFFCHAIN_ATTESTATIONS_ZK.md). The
older document remains the architectural history for the two-lane design. Deviations that change
an already-published consensus interface remain recorded separately in
[`DEVIATIONS.md`](./DEVIATIONS.md).

## 1. Release boundary

Envelope 0 is an opt-in second input lane for a standard Trustgraphs instance. It accepts only an
EAS off-chain version-2 attestation signed by an Ethereum EOA over the instance's canonical
`string comment,uint256 confidence` schema. The signed attestation must have a nonzero recipient,
zero expiration, `revocable = true`, zero `refUID`, a nonzero 32-byte salt, canonical ABI data, and
a canonical 65-byte low-S signature. The attestation's signed time may not be later than the block
timestamp of the anchor that first commits it.

The only supported revocation is a signed Trustgraphs log mutation. Calling
`EAS.revokeOffchain(uid)` does not revoke an envelope-0 vouch. Payloads are public, content
addressed, and retained for historical proof reproduction. “Off-chain” describes gasless creation,
not privacy or erasure.

Legacy/v1 EAS attestations, EIP-1271 and EIP-6492 signers, nonzero expiration, references, canonical
EAS off-chain revocation, additional envelope kinds, log reset/compaction, and private payloads are
unsupported and fail closed.

## 2. Cryptographic primitives and integer convention

- `keccak256` means Ethereum Keccak-256, not FIPS SHA3-256.
- `sha256` means FIPS SHA-256.
- `abi.encode` and EIP-712 use the Ethereum ABI exactly.
- Every integer in `Envelope0PayloadV1` is unsigned, fixed-width, and big-endian. No varint appears
  in the payload.
- Every `bytes32` is copied in byte order as displayed by its `0x`-prefixed hexadecimal form.
- An address is its 20 raw bytes, with no ABI left padding in the payload.
- A signature is exactly `r[32] || s[32] || v[1]`. `r` and `s` are nonzero and less than the
  secp256k1 order, `s` is at most the half-order, and `v` is exactly 27 or 28. Compact EIP-2098,
  recovery ids 0/1, high-S alternatives, and bytes beyond the 65th are non-canonical.

All byte-length arithmetic is checked before allocation. A decoder consumes a bounded slice and
must reject overflow, premature EOF, or bytes remaining after the last record.

## 3. `Envelope0PayloadV1`

The payload contains one owner's complete append-only log and the complete EAS record for each
attest entry. It deliberately excludes every head-authorization signature, CID string, chain id,
EAS address, and registry address. Those values are either derived from the exact payload bytes or
bound by the separate on-chain authorization record.

### 3.1 Header

| Offset | Size | Field | Canonical value |
|---:|---:|---|---|
| 0 | 8 | `magic` | ASCII `TGEAS0PL`, bytes `54 47 45 41 53 30 50 4c` |
| 8 | 2 | `payloadVersion` | `0x0001` |
| 10 | 20 | `owner` | Ethereum EOA address |
| 30 | 4 | `entryCount` | number of log entries |
| 34 | 4 | `attestationCount` | number of kind-0 entries |

The fixed header is 38 bytes. `entryCount` must be in `1..=2,048`.
`attestationCount <= entryCount` and must exactly equal the number of attest entries encountered.

### 3.2 Log section

Immediately after the header are `entryCount` records of 33 bytes each:

| Size | Field | Rule |
|---:|---|---|
| 1 | `kind` | `0` = `ATTEST`, `1` = `REVOKE`; every other value fails |
| 32 | `uid` | EAS v2 UID of the named attestation |

Each `ATTEST(uid)` must have a matching attestation record in section 3.3, in attest-entry order.
An attest UID may appear as `ATTEST` exactly once. `REVOKE(uid)` must name a preceding, not already
revoked attest UID from this same log. Revoke-before-attest, a second revoke, and a duplicate attest
are malformed. A revoke does not remove historical bytes from the payload.

The log head is unchanged from the prototype:

```text
entryLeaf_i = keccak256(abi.encode(uint8(kind_i), bytes32(uid_i)))
h_0         = bytes32(0)
h_i         = keccak256(abi.encode(bytes32(h_(i-1)), bytes32(entryLeaf_i)))
head        = h_entryCount
```

`nodeId = keccak256(abi.encode(address(owner)))`.

### 3.3 Attestation section

Immediately after the log are `attestationCount` variable-length records. A record is:

| Size | Field | Canonical rule |
|---:|---|---|
| 2 | `easVersion` | exactly `0x0002` |
| 32 | `schema` | exactly the instance's canonical vouch schema UID |
| 20 | `recipient` | nonzero |
| 8 | `time` | signed Unix time |
| 8 | `expirationTime` | zero |
| 1 | `revocable` | exactly byte `0x01` |
| 32 | `refUID` | zero |
| 4 | `dataLength` | `96..=4,192`, exact byte length of `data` |
| `dataLength` | `data` | canonical ABI described below |
| 32 | `salt` | nonzero |
| 65 | `signature` | canonical `r || s || v` |

The fixed part of an attestation record is 204 bytes. The payload is rejected before parsing if it
exceeds 1,048,576 bytes. The same 1 MiB limit applies to HTTP bodies after transport decoding;
compression is not accepted by the reference relay endpoint.

`data` must be the unique canonical ABI encoding of `(string comment, uint256 confidence)`:

1. word 0 is exactly `uint256(64)`;
2. word 1 is `confidence`;
3. word 2 is a `commentLength` in `0..=4,096`;
4. exactly `commentLength` bytes follow, rounded up to a 32-byte word; and
5. every padding byte is zero and no trailing byte remains.

Solidity strings are byte strings, so consensus does not impose UTF-8. The product accepts and
renders UTF-8 text only. Confidence is interpreted, clamped, and scored exactly as the same lane-1
ABI field is today.

For each record, the verifier reproduces the official SDK's version-2 UID byte-for-byte and requires
it to equal the corresponding log UID:

```text
keccak256(solidityPacked(
  uint16(2),
  bytes(utf8("0x" + lowercaseHex(schema))),
  recipient,
  address(0),
  uint64(time),
  uint64(0),
  bool(true),
  bytes32(0),
  data,
  salt,
  uint32(0)
))
```

The unusual 66-byte UTF-8 schema string is part of the EAS SDK format. It is not replaced by the
32 raw schema bytes.

The EAS EIP-712 domain is:

```text
EIP712Domain(
  name = "EAS Attestation",
  version = EAS.version(),
  chainId = instance chain id,
  verifyingContract = configured EAS contract
)
```

The primary type is exactly:

```text
Attest(
  uint16 version,
  bytes32 schema,
  address recipient,
  uint64 time,
  uint64 expirationTime,
  bool revocable,
  bytes32 refUID,
  bytes data,
  bytes32 salt
)
```

The recovered signer must equal `owner`. There is one accepted EAS domain, derived by the factory
and pinned in instance params; a caller cannot provide an alternative separator.

The existing `envelope0DomainSeparators` params field encodes the supported profile without adding
a params word: it is empty when lane 2 is disabled and is exactly
`[easAttestationDomainSeparator, trustgraphsHeadV2DomainSeparator]` for a hybrid instance. Any
other length fails closed. Because the lane-1 value remains the same empty array, its 17-word
params-hash preimage is unchanged.

## 4. Commitment and locator

For the exact section-3 byte string:

```text
dataCommitment = sha256(payloadBytes)
cidBytes       = 0x01 || 0x55 || 0x12 || 0x20 || dataCommitment
CID            = "b" || base32lower_no_padding(cidBytes)
```

This is CIDv1, raw codec, sha2-256. Storage must publish and retrieve the payload as one raw block,
not as a UnixFS file whose root commits to chunk metadata. The relay derives the CID locally and
requires every configured target to return the exact bytes before it anchors.

The guest first checks `sha256(payloadBytes) == anchor.dataCommitment`, then parses. Hashing a
decoded object, normalized JSON, a CAR wrapper, or transport-compressed bytes is invalid.

## 5. Head authorization and registry transition

After constructing the payload and deriving `dataCommitment`, the owner signs this EIP-712 message:

```text
EIP712Domain(
  name = "Trustgraphs Offchain Head",
  version = "2",
  chainId,
  verifyingContract = EasOffchainAnchorRegistry
)

Anchor(
  bytes32 nodeId,
  uint8 envelopeKind,
  bytes32 schemaUid,
  bytes32 previousHead,
  bytes32 head,
  uint64 count,
  bytes32 dataCommitment
)
```

The canonical type strings, including the domain dependency, are:

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
Anchor(bytes32 nodeId,uint8 envelopeKind,bytes32 schemaUid,bytes32 previousHead,bytes32 head,uint64 count,bytes32 dataCommitment)
```

`envelopeKind` is zero, `schemaUid` is the immutable registry schema, `count = entryCount`, and
`head` is the section-3.2 fold. `previousHead` is zero on first use and otherwise equals the
registry's current head for this node. The signature uses the canonical form in section 2.

An accepted registry transition has all of these properties:

- the recovered signer is `owner` and `nodeId` is its canonical address node id;
- first use creates the address-node registration and anchor atomically;
- `count` strictly increases and does not exceed 2,048;
- `previousHead` equals the stored latest head;
- exact retries, count regressions, and same-count alternatives do not append an anchor record;
- the count delta, aggregate latest entry count, and combined work fit before any state change; and
- only an admitted relayer may pay for and submit the transition.

The event contains every typed field, the owner, the canonical signature, and the resulting anchor
fold position. A relay whose transaction loses a race reports idempotent success only if the stored
`(head, count, dataCommitment)` equals the request. A same-count or same-predecessor conflict is not
success.

## 6. Strict checkpoint verification

A hybrid checkpoint supplies the complete anchor history through its checkpointed `anchorCount`,
the authorization metadata emitted for each record, and the exact newest payload for every
registered address node that has anchored. Verification is all-or-nothing:

1. Re-fold every anchor record and reproduce checkpoint `anchorAcc` and `anchorCount`.
2. Group by node and choose the last anchored record. Counts must be strictly increasing and every
   authorization must recover to that node's owner in this registry's EIP-712 domain.
3. Require the newest payload. Check its SHA-256 commitment before decoding it.
4. Decode and verify every profile, UID, EAS signature, log, head, owner, schema, domain, and count
   rule in this document.
5. While folding the newest full log, record every prefix head. For every earlier anchor for that
   node, the prefix at its signed count must equal its recorded head. This proves append-only
   history without fetching older payloads for the current checkpoint.
6. Map each entry to the earliest anchor for that node whose count covers it. An attestation's
   signed time may not exceed that anchor's block timestamp. A revoke mutation takes that anchor's
   block timestamp as its effective time.
7. Emit every ordered attest and revoke mutation; do not emit a pruned live set.

Missing bytes, a failed reader quorum, malformed content, an unsupported kind, a forked prefix, or
any other unknown state aborts the Trustgraphs proof. Envelope 0 has no `CARRIED` or `DROPPED`
result. A valid envelope-0 proof always commits `skippedDigest = 0`. The journal-v3 field remains so
other programs can retain their established semantics.

Older payloads remain operationally mandatory because a prover reproducing an older checkpoint
must retrieve the payload that was newest at that checkpoint. Re-pinning identical bytes is the
only availability repair. Different bytes require a new higher-count owner authorization.

## 7. Reconciliation and ties

Lane 1 and envelope 0 feed one pair-state machine. An attest replaces the current UID for
`(attester, recipient)`. A revoke clears the pair only if it names the current UID. Clearing never
falls back to an older attestation; a later attest explicitly reactivates the pair.

Consensus order is ascending by:

```text
(effectiveTimestamp, sourceLane, sourcePosition)
```

- lane 1 has `sourceLane = 0`, `effectiveTimestamp = leaf.blockTimestamp`, and
  `sourcePosition = leaf fold index`;
- envelope 0 has `sourceLane = 1`; attest effective time is its signed `time`, revoke effective
  time is its first-commit anchor timestamp; `sourcePosition` is ordered by first-commit anchor
  fold index and then log-entry index.

Thus an off-chain mutation follows an on-chain mutation in the same second, preserving the existing
“lane 2 appended after lane 1” tie rule explicitly. Within one anchor, log order breaks a tie. This
ordering is tested over on-chain → off-chain replacement → revoke, off-chain → on-chain replacement
→ old revoke, repeated pairs, and mixed fold order.

## 8. Limits, work units, and pricing

The release constants are:

| Constant | Value | Enforcement |
|---|---:|---|
| `MAX_ENVELOPE0_PAYLOAD_BYTES` | 1,048,576 | client, relay, host, guest |
| `MAX_ENVELOPE0_ENTRIES_PER_NODE` | 2,048 | client, relay, registry, guest |
| `MAX_ENVELOPE0_COMMENT_BYTES` | 4,096 | client, relay, guest |
| `MAX_ENVELOPE0_DATA_BYTES` | 4,192 | client, relay, guest |
| `E0_ENTRY_WORK_UNITS` | 4 | registry, snapshot, operator, vault |
| `MAX_TOTAL_INPUTS` | 200,000 | registry, operator, vault |

The live work count is:

```text
lane1LeafCount
+ anchorRecordCount
+ aggregateLatestEnvelope0EntryCount * E0_ENTRY_WORK_UNITS
```

Replacing a node head changes the aggregate entry term by the strictly positive count delta; old
anchor records remain in the anchor term. Every envelope entry is charged as an attest even when it
is a revoke. At 40,000 estimated cycles per work unit, multiplier 4 budgets 160,000 cycles per
entry, in addition to one work unit for each head authorization and the operator's 2,000,000-cycle
base. The earlier primitive SP1 v6.3.1 measurements were 27,282 cycles / 50,203 PGU per patched
secp256k1 recovery, 6.13 cycles / 15.2 PGU per byte of Keccak at scale, and 3.41 cycles / 11.4 PGU
per byte of SHA-256 at scale ([`offchain/05-spike-results.md`](./offchain/05-spike-results.md)).

The checked-in full-envelope benchmark then measured the frozen decoder, hashes, UID reproduction,
log fold, every EAS recovery, and one typed head recovery together. From 100 to 1,000 entries, the
all-attest path costs **130,436 cycles / 153,096 PGU per entry** and the maximum valid revoke-density
path costs **73,278 cycles / 84,390 PGU per entry**. The 2,048-entry all-attest maximum is a
682,022-byte payload and costs 267,339,452 cycles / 313,743,626 PGU; four work units plus base budget
329,720,000 cycles, about 23% headroom. See
[`eas-offchain/sp1-bench/results.json`](./eas-offchain/sp1-bench/results.json) and its adjacent
reproduction README. A change that exceeds the budget rotates these constants through a new
protocol version rather than silently weakening admission.

Checkpoint `workCount`, operator refusal, and vault bands use the same value. Bands remain
`<=1,000`, `<=20,000`, and `<=200,000`; `200,001` is unpriced and refused. A legacy registry that
does not expose work falls back to its checkpointed anchor count, but a hybrid factory never
deploys that legacy shape.

## 9. Stable error taxonomy

Each component may attach detail, but it exposes one of these stable reason codes. Unknown errors
map to `E0_INTERNAL` and fail closed; they never map to acceptance.

| Code | Meaning |
|---|---|
| `E0_DISABLED` | hybrid lane or supported chain is not enabled |
| `E0_UNSUPPORTED_KIND` | envelope kind is not zero |
| `E0_MAGIC` / `E0_PAYLOAD_VERSION` | bad protocol prefix or version |
| `E0_TRUNCATED` / `E0_TRAILING_BYTES` | bounded decoder did not consume exactly one payload |
| `E0_PAYLOAD_LIMIT` / `E0_ENTRY_LIMIT` / `E0_DATA_LIMIT` | hard size or count limit exceeded |
| `E0_COUNT_MISMATCH` | header, log, attestation, or anchored counts disagree |
| `E0_LOG_KIND` / `E0_DUPLICATE_ATTEST` | non-canonical log entry |
| `E0_REVOKE_BEFORE_ATTEST` / `E0_ALREADY_REVOKED` | invalid revoke history |
| `E0_PROFILE_VERSION` / `E0_SCHEMA` / `E0_RECIPIENT` | unsupported EAS profile field |
| `E0_FUTURE_TIME` / `E0_EXPIRATION` / `E0_REVOCABLE` | unsupported time/revocation field |
| `E0_REF_UID` / `E0_ZERO_SALT` / `E0_DATA_ABI` | unsupported or malformed payload field |
| `E0_UID` | official v2 UID does not reproduce |
| `E0_SIGNATURE_FORM` | length, scalar, low-S, or recovery-id canonicality failed |
| `E0_EAS_DOMAIN` / `E0_EAS_SIGNATURE` | attestation domain or signer failed |
| `E0_COMMITMENT` / `E0_CID` | exact bytes do not match the anchored digest or locator |
| `E0_NODE_ID` / `E0_HEAD` / `E0_PREVIOUS_HEAD` | owner, fold, or transition mismatch |
| `E0_HEAD_DOMAIN` / `E0_HEAD_SIGNATURE` | authorization domain or signer failed |
| `E0_PREFIX_FORK` / `E0_STALE_COUNT` / `E0_SAME_COUNT_CONFLICT` | non-append-only history or relay race |
| `E0_AVAILABILITY` / `E0_STORAGE_QUORUM` | exact bytes unavailable from required readers/writers |
| `E0_WORK_CAP` / `E0_RATE_LIMIT` | ingress admission refused without anchoring |
| `E0_UNSUPPORTED_WALLET` / `E0_UNSUPPORTED_COMBINATION` | EOA/profile or companion-program guard |
| `E0_SIMULATION` / `E0_REORG` | exact anchor call or finalized chain view is unsafe |
| `E0_INTERNAL` | unclassified failure; operator alert required |

Relays return the code without secrets. Metrics may label the code, chain, registry, node id, count,
and CID. They do not include transaction keys, pin credentials, RPC credentials, encrypted local
drafts, or any signature beyond protocol-public payload/anchor data.

## 10. Trust and threat model

The proof trusts Ethereum finality, the deployed registry/snapshot/verifier code, the SP1 security
assumption, SHA-256/Keccak/secp256k1, and availability of already-anchored bytes. It does not trust a
relay, storage provider, indexer, hosted operator, browser API, or prover to define an edge or omit
a node.

Admitted relayers can censor and can consume capacity with valid owner-signed updates, so their role
set is governed, monitored, rate limited, and operationally independent. They cannot forge an EAS
edge, change the owner log, move a head between registries or chains, replace its commitment, replay
a lower count, or make selective omission prove. At least two independently keyed relays and two
independently credentialed storage/read systems are required before testnet enablement.

Availability loss is a liveness failure, not a different graph. The operator identifies the CID,
retries all configured readers, holds proving, and alerts. It never drops that node or consumes an
older head. A compromised prover can choose witness bytes but cannot make their SHA-256, log fold,
signatures, history prefixes, or checkpoint accumulator agree with a different statement.

The profile deliberately does not prove that canonical `EAS.revokeOffchain` was never called. UI
and documentation must not imply that it does. Adding that mechanism requires a checkpoint-bound
Ethereum storage proof or a new on-chain revocation accumulator and therefore a separate consensus
decision.

## 11. Golden-corpus contract

`tests/fixtures/eas-offchain/v1/` is normative. Its manifest records the exact SDK package and lockfile
integrity, EAS and head domains, typed data, typed digests, UIDs, signatures, payload bytes,
commitment, CID, log prefix heads, and expected decoded mutations. The positive fixture is generated
by pinned `@ethereum-attestation-service/eas-sdk` code, not by the Rust verifier.

Negative cases cover EAS v1, wrong EAS address, wrong chain, wrong schema, future signed time,
nonzero expiration, nonzero ref UID, zero salt, high-S signatures, bad head domain, changed
`dataCommitment`, and trailing payload bytes. Each names the first expected reason code. Rust/native,
the SP1 guest, the shared TypeScript library, and a Solidity digest/registry test consume the same
checked-in bytes. Regeneration is explicit and the test suite fails on an unexplained corpus diff.
