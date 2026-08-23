# Contributions program — Interfaces

**Status: FROZEN.** This file is the interface contract for the `contributions`
program (see [`networks-and-programs.md`](../../concepts/networks-and-programs.md) for the program index).
Every lane (contracts, core crate, guest/host, indexer, frontend) builds against
these definitions. A change to anything in this file requires regenerated golden
vectors (`tests/golden/contributions.json`) in the same PR and a
[`research/DEVIATIONS.md`](../../../research/DEVIATIONS.md) entry.

Design provenance: [`../../../research/CONTRIBUTION_FUNDING.md`](../../../research/CONTRIBUTION_FUNDING.md)
(normative); program index: [`networks-and-programs.md`](../../concepts/networks-and-programs.md), deviations of record: [`research/DEVIATIONS.md`](../../../research/DEVIATIONS.md).

## 1. The three EAS schemas

Registered exactly as these schema strings (field order and names are part of the
wire format — EAS payloads are `abi.encode` of the fields in order):

| # | Name | Schema string | Revocable |
|---|---|---|---|
| 0 | `contribution.claim` | `string title, bytes32 contentHash, string uri, address[] contributors, uint32[] shares` | yes |
| 1 | `contribution.response` | `bytes32 claimUID, uint8 response` | yes |
| 2 | `contribution.valuation` | `bytes32 claimUID, uint8 score` | yes |

All three point at the **same** `ContributionResolver` instance (never at the live
trust-graph `EASIndexerResolver` — its accumulator feeds PageRank unfiltered).

Payload value domains (violations are deterministic in-guest skips, never aborts):

- `contribution.claim`: `contributors.length == shares.length`, both non-empty.
  `shares` are relative weights, normalized per-claim to Σ = 1 in-guest.
- `contribution.response`: `response ∈ {1 = accept, 2 = reject}`.
- `contribution.valuation`: `score ∈ [0, 100]`.

## 2. Fold `kind` tagging (the contribution accumulator)

The contribution accumulator uses the **identical leaf ABI** as
`AttestationAccumulator` today:

```
leaf = keccak256(abi.encode(uint8 kind, address attester, address recipient,
                            bytes32 uid, uint256 blockTimestamp, bytes32 dataHash))
acc' = keccak256(abi.encode(bytes32 acc, bytes32 leaf))          // zk-core fold
```

Only the `kind` domain is new, and it is **per-accumulator-instance** (the trust
accumulator keeps kinds {0, 1}; nothing existing changes):

```
kind = schemaIndex * 2 + isRevoke
```

| kind | meaning |
|---|---|
| 0 | claim attested |
| 1 | claim revoked |
| 2 | response attested |
| 3 | response revoked |
| 4 | valuation attested |
| 5 | valuation revoked |

`schemaIndex` is the resolver's index into its immutable schema-UID allowlist
(0 = claim, 1 = response, 2 = valuation). The resolver **reverts** attestations
from any schema not in the allowlist, so the kind tag is trustworthy.
`recipient` is folded as EAS delivers it; v1 guest semantics do not consume it
(claim attribution comes from the payload's `contributors`).

## 3. Params layout and `params_hash`

`paramsHash = keccak256(abi.encode(<21 static fields below, in order>))`. All
fields are static ABI types, so the encoding is the concatenation of 32-byte
words — hand-rolled identically in `contributions-core::params_hash` (Rust),
`ContributionsParamsCodec.hash` (Solidity), and the TS port, locked together by
the golden vectors.

Slots 1–11 are the stage-1 reputation params, mirrored from the trust program
(same semantics as `pagerank-core::Params`; the contrib guest re-runs the exact
trust algorithm over the trust accumulator's edges). Slots 12–21 are the
contributions round params.

| slot | field | type | notes |
|---|---|---|---|
| 1 | `paramsSchemaVersion` | uint256 | literal `3`; domain-separates this tuple shape |
| 2 | `dampingFp` | uint256 | fixed-point, scaled by `precisionScale` |
| 3 | `toleranceFp` | uint256 | |
| 4 | `maxIterations` | uint32 | |
| 5 | `minWeightFp` | uint256 | vouch-weight clamp floor |
| 6 | `maxWeightFp` | uint256 | vouch-weight clamp cap |
| 7 | `trustShareFp` | uint256 | |
| 8 | `trustDecayFp` | uint256 | required by the trust algorithm |
| 9 | `seedSetRoot` | bytes32 | OZ standard tree over the **sorted** seed addresses, leaf = `keccak256(abi.encode(address))` — same builder as the trust program |
| 10 | `precisionScale` | uint256 | fixed-point scale S (1e18) |
| 11 | `weightFieldIndex` | uint32 | ABI head slot of the vouch confidence field |
| 12 | `roundStart` | uint64 | claims count only in `[roundStart, roundEnd]` (unix seconds, inclusive) |
| 13 | `roundEnd` | uint64 | |
| 14 | `unacceptedMultFp` | uint256 | consent multiplier for no-response shares (default 0.5 · S) |
| 15 | `collaboratorMultFp` | uint256 | same-round co-claim rater discount (default 0.5 · S; 0 = hard exclusion) |
| 16 | `minRaterRepFp` | uint256 | raters below this rep are ignored (and earn no carve-out) |
| 17 | `evaluatorCarveoutBps` | uint32 | β in basis points (default 100 = 1%; 0 disables) |
| 18 | `totalPool` | uint256 | the distribution scale fed to `distribute_points_generic` |
| 19 | `claimSchemaUid` | bytes32 | binds kind tags 0/1 to a concrete schema |
| 20 | `responseSchemaUid` | bytes32 | binds kind tags 2/3 |
| 21 | `valuationSchemaUid` | bytes32 | binds kind tags 4/5 |

The struct fields carry the raw (unsorted) seed list; `seedSetRoot` sorts
internally, so the hash depends only on the seed *set*.

## 4. Journal — shared shape reused, frozen

The 12-word journal v3 tuple is reused **unmodified** (shape, order, digest rule
identical to the trust program — `pagerank-core::encode::journal_encoded`):

| field | contributions meaning |
|---|---|
| `acc`, `leafCount` | **trust accumulator** checkpoint (slot A — the vouch graph input commitment) |
| `anchorAcc`, `anchorCount` | **contribution accumulator** checkpoint (slot B — claims/responses/valuations) |
| `paramsHash` | §3 above |
| `outputRoot` | OZ standard tree over the final payout allocation, leaf = `keccak256(bytes.concat(keccak256(abi.encode(address account, uint256 value))))` (identical to trust-graph output leaves; v1 leaves are address-domain only) |
| `ipfsHash`, `cidDigest` | sha256 + CIDv1(raw) of the canonical blob (§5) |
| `totalValue` | Σ of all leaf values (= the distributed pool) |
| `skippedDigest` | **`bytes32(0)` in v1.** Contribution-record skips/filters are deterministic from committed inputs; the indexer derives skip reasons for display. |
| `recipient` | the bounty payee (v3), committed verbatim by the guest; `submitProof` folds its own `recipient` argument into the digest. Zero address = no bounty. |
| `instanceDomain` | `keccak256(abi.encode(snapshot, chainId))` (v3), rebuilt on-chain by `submitProof` from `address(this)` + `block.chainid` — binds the proof to one instance. |

## 5. Blob format

Canonical sorted JSON, identical to trust-graph lane 1
(`zk-core::cid::canonical_blob`): `{"0x<address>":"<decimal>", …}` — lowercase
hex addresses, ascending by address, decimal string values, no whitespace.
CID = CIDv1, `raw` codec, sha2-256.

## 6. Golden vectors

`tests/golden/contributions.json`, written by
`cargo run -p contributions-core --example export_golden`, locked by:

- `contracts/test/unit/golden/ContributionsGoldenVectors.t.sol` (Solidity)
- `contributions-core` unit tests (native Rust)
- the SP1 guest and `packages/frontend/lib/contributions/golden.test.ts`

The file carries the `params` family (every field + `seedSetRoot` + `paramsHash`),
the `kinds` table, a sample contribution accumulator `leaf`, a `blob` sample, and
the full `compute` family (fixture edges → journal).
