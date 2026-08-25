# ADR: Scalable weighted priors for network initialization

**Status:** Accepted for implementation planning, 2026-08-14  
**Scope:** closes the design questions in issue #34; this ADR does not ship the feature  
**Program:** new `trust-graph-weighted` program, params/manifest version 1  
**Constitutional entry cap:** `MAX_PRIOR_ENTRIES = 2048`

## Decision

A weighted import is the persistent personalized teleport prior of a separate trust-graph program.
It is not an initial score, payout allocation, vouch weight, synthetic edge, or temporary bootstrap.
The product sentence is:

> An account with weight 10 receives four times the imported prior mass of an account with weight
> 2.5. The graph still determines final scores.

The program commits a canonical, positive, address-keyed vector normalized to exactly `1e18`.
Prior accounts enter the scoring node universe, including accounts with no edges. No uniform mass is
given to arbitrary disconnected accounts. Dangling mass returns to the committed prior, so an
empty-edge graph reproduces the prior exactly.

At creation and rotation, the factory/controller receives the full compact manifest in calldata,
validates its version, chain, count, strict ordering, positivity, exact sum, and Merkle root, then
stores only `(priorRoot, priorCount, manifestSha256)` with the parameter version. Historical
transaction calldata is the permanent recovery copy; IPFS mirrors are accelerators, not a validity
dependency. A timelocked pending rotation gives operators an ingestion window before activation.

The program removes binary `trustShareFp`, `trustMultiplierFp`, and `trustDecayFp`. The PageRank
damping factor remains the only propagation/teleport mixture. Existing instances remain on their
current program forever and can opt in only by creating a new weighted instance.

## 1. Normative scoring semantics

Let:

- `S = 1e18`;
- `p_i` be the normalized imported prior, with every `p_i > 0` and `sum(p) = S`;
- `V = prior accounts union all accepted edge endpoints`;
- `d` be the operationally governed damping factor already bounded by `0 < d < S`; and
- `T` be the row-normalized transition matrix formed from accepted vouch weights after the existing
  self-loop, zero-weight, checkpoint, and reconciliation rules are applied.

Conceptually, the iteration is personalized PageRank:

```text
r(0)   = p
r(t+1) = (1 - d) p + d T' r(t)
```

For a node with no accepted outgoing weight, its transition row is `p`. Nodes outside the closure
reachable from prior support may remain zero and may be omitted from payout leaves under the
existing zero-output convention. This is intentional Sybil isolation, not missing uniform mass.

The implementation must conserve exactly `S` at each iteration. It does so through one common
integer apportionment primitive:

1. For non-negative numerators `x_i` and a positive denominator `D`, compute
   `floor(x_i * budget / D)`.
2. Assign the unallocated units to the largest exact remainders.
3. Resolve equal remainders by ascending 20-byte account address.

Each iteration allocates `d` across source accounts proportional to the previous rank; allocates
each non-dangling source budget across its accepted outgoing weights; sums dangling source budgets;
then allocates the single combined budget `S - d + danglingBudget` to `p`; and finally evaluates the
existing convergence test. Combining the base and dangling budgets before apportionment is
normative: apportioning them independently could introduce compensating one-unit rounding errors.
The eventual core/guest fixture must pin every intermediate allocation rule. This formulation
avoids post-hoc renormalization and guarantees that an empty graph remains byte-exactly `p`.

There is no separate `priorShare`: the prior receives all teleport mass and graph propagation
receives `d`, as the equation states. There is no fade schedule in version 1. A prior persists until
the operational timelock activates a replacement.

## 2. Canonical inputs and normalization

### 2.1 Raw weight grammar

Raw weights are relative, positive decimal strings. The canonical grammar is:

```text
(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?
```

Additional rules:

- at most 18 fractional digits;
- no sign, exponent, whitespace, thousands separator, leading integer zero, trailing fractional
  zero, or trailing decimal point;
- zero is rejected;
- JavaScript `number`/binary floating point is never an input to consensus; and
- duplicate or zero EVM addresses are rejected after name resolution.

An importer may clean human input, but it must show the canonical string before signing. Zero and
negative entries are rejected, not silently omitted. Negative priors are out of scope for all V1
paths.

### 2.2 Exact normalization

Parse each decimal into an integer `raw_i` at 18-decimal precision. Sort entries by ascending
address and reject duplicates. Let `W = sum(raw_i)`. For each entry:

```text
floor_i     = floor(raw_i * S / W)
remainder_i = (raw_i * S) mod W
```

Let `missing = S - sum(floor_i)`. Add one unit to the `missing` entries with the greatest
`remainder_i`, with ascending address as the tie-break. Any positive input that still normalizes to
zero is rejected. The result is strictly sorted, strictly positive, and sums exactly to `S`.

### 2.3 Canonical CSV and JSON

Names are import conveniences only. ENS names are resolved to addresses before either canonical
form is produced.

Canonical CSV is UTF-8/ASCII without BOM, uses LF, has a terminal LF, contains no quotes or spaces,
and is strictly address-sorted:

```csv
account,weight
0x1111111111111111111111111111111111111111,10
0x2222222222222222222222222222222222222222,2.5
```

Canonical JSON is UTF-8 without BOM or terminal newline. It is minified with the exact property
order below; `chainId` is a decimal string and entries are address-sorted:

```json
{"schema":"trustgraph-weighted-prior-input-v1","chainId":"10","entries":[{"account":"0x1111111111111111111111111111111111111111","weight":"10"},{"account":"0x2222222222222222222222222222222222222222","weight":"2.5"}]}
```

Both are deterministic exchange views, not the on-chain commitment. They must produce the same
normalized binary manifest. A provenance package may retain the original uploaded bytes and their
digest, but only the normalized manifest is consensus-critical.

## 3. Manifest and commitment

The canonical V1 manifest is:

| Offset | Size | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII `TGWP` |
| 4 | 2 | unsigned big-endian version, exactly `1` |
| 6 | 8 | unsigned big-endian chain ID |
| 14 | 4 | unsigned big-endian entry count |
| 18 | `28*N` | ascending `address[20] || normalizedWeight[u64]` entries |

V1 rejects chain IDs above `u64::MAX`; every normalized weight fits `u64` because it is at most
`1e18`. The manifest length is exactly `18 + 28*N`, `1 <= N <= 2048`, entries are strictly
ascending and nonzero, and weights sum to `1e18`.

For entry `(account, weight)`:

```text
leaf = keccak256(abi.encode(address account, uint256 weight))
```

Leaves are in ascending account order. Each Merkle parent hashes its children in bytes32-sorted
order; an unpaired final node is promoted unchanged. The contract and guest reject a noncanonical
list before accepting the root, so sorted-pair hashing does not make list order optional.

The stored commitment is:

```text
priorRoot       = merkleRoot(entries)
priorCount      = N
manifestSha256  = sha256(exact manifest bytes)
```

The fixture in [`weighted-priors/fixture.json`](./weighted-priors/fixture.json) pins normalization,
leaves, root, manifest bytes, and SHA-256 across Rust, TypeScript, and Solidity.

## 4. Architecture selection

| Candidate | Validity at rotation | Long-term storage | Recovery/availability | Decision |
|---|---|---:|---|---|
| Full dynamic array in contract storage/events | On-chain | `O(N)` permanent state and event data | Strong | Reject; repeats the current 64-seed bottleneck. |
| Root plus IPFS/blob only | Root shape cannot be validated; bad or missing data can wedge proofs | `O(1)` | Depends on external pinning | Reject at V1. |
| Full compact calldata, validated root, commitment stored | On-chain ordering/sum/root validation | `O(1)` state; calldata in history | Chain history is authoritative; mirrors improve UX | **Accept through 2,048.** |
| Separate prior-validity proof and external DA | Proof validates root; DA still needs a rule | `O(1)` | Depends on selected DA proof/retention | Defer for a future >2,048 program/version. |

The accepted call takes one compact `bytes manifest`, not two ABI arrays. This cuts input from
roughly 64 bytes to 28 bytes per entry and makes the transaction bytes identical to the recovery
artifact. Validation must happen in both factory/controller and guest. The guest additionally pins
`priorRoot`, `priorCount`, and `manifestSha256` in the weighted params hash.

## 5. Availability, provenance, and rotation

The transaction that creates or proposes a prior is the canonical recovery source. The contract
emits the parameter version, root, count, SHA-256, activation time, and proposal transaction
identity available through the event receipt. The indexer decodes the manifest from the
transaction input and verifies it before serving it. Operators fetch in this order:

1. their local content-addressed cache;
2. configured IPFS/raw-CID mirrors; and
3. an archival RPC's proposal transaction calldata.

The raw-block CIDv1 using SHA-256 of the exact manifest is the canonical mirror address. The
creator must pin before proposing; the project indexer and each proving operator pin after seeing
the proposal and retry with alerting. Mirror failure cannot make the version unprovable while chain
history remains available.

Rotation is two-stage. `proposePrior(manifest, metadataDigest)` validates and records a pending
version. `activatePrior(version)` is callable only after the standard operational timelock delay.
The pending event is the operator preview. Activation cannot refer to a manifest that was absent
from calldata, and each checkpoint pins the active complete params hash, so a proof started before
activation cannot silently use the new prior. Creation validates in its creation transaction; an
instance has no earlier active checkpoint to disrupt.

Provenance is governance evidence, not V1 scoring consensus. A proposal records a digest of a
metadata document containing source URI/digest, author, license where known, original-file digest,
canonical CSV/JSON digests, ENS resolution records, and a human description of any transform. V1
does not execute or bless identity/rank/log/cap transforms. A transform whose correctness must be
proven needs its own source program and params version.

ENS is accepted only in the local importer. The preview records name, resolved address, resolution
block number, and block hash. Immediately before wallet signing, the client re-resolves at a fresh
finalized block. Any changed result invalidates the preview and forces manifest/root regeneration.
No ENS name appears in consensus bytes.

## 6. Governance

Operational timelock authority controls the prior commitment, damping/tolerance/iteration values,
and provenance metadata. The factory and guest constitutionally enforce:

- manifest/program version and chain ID;
- `1 <= priorCount <= 2048`;
- strict unique address ordering, positive weights, exact `1e18` sum, root and SHA-256;
- existing damping validity (`0 < dampingFp < 1e18`); and
- the weighted program's eventual cycle/iteration envelope.

V1 has no protocol concentration cap. A cap would encode a community policy, can be evaded through
identity splitting, and would prevent explicit high-conviction priors. The signer UI must show the
largest share, top-10 share, and Herfindahl-Hirschman index; it warns above configurable policy
thresholds but does not alter consensus weights. Governance and signers must treat a prior rotation
as a high-impact trust-root change.

The maximum count is constitutional because it bounds factory gas, witness ingestion, and proving
cost. Raising it requires a new program/version and benchmark, not an operational parameter update.

## 7. Scale decision and benchmark evidence

The reproducible commands, measurement boundaries, and raw CSV live in
[`weighted-priors/README.md`](./weighted-priors/README.md) and
[`weighted-priors/benchmarks.csv`](./weighted-priors/benchmarks.csv).

Representative degree-four rings at 40 iterations:

| Prior entries | JSON witness | Native sparse kernel | SP1 guest cycles | Compact manifest | EVM validate/store + calldata upper bound | V8 preview median |
|---:|---:|---:|---:|---:|---:|---:|
| 128 | 21,064 B | 106 us | 8,551,341 | 3,602 B | 281,120 gas | 2.647 ms |
| 512 | 86,728 B | 325 us | 32,589,185 | 14,354 B | 884,065 gas | 8.287 ms |
| 1,024 | 173,448 B | 656 us | 65,149,097 | 28,690 B | 1,746,630 gas | 15.242 ms |
| **2,048** | **355,720 B** | **1,276 us** | **130,268,917** | **57,362 B** | **3,694,644 gas** | **30.804 ms** |

At the chosen maximum, an empty graph measured 51,576,098 cycles with a 167,993-byte JSON witness.
A degree-16 ring measured 445,972,213 cycles, a 918,904-byte JSON witness, 4,210 us native time,
and a 368,640-byte reference core live set. The client typed-array/reference-artifact working set at
2,048 was 204,800 bytes.

These SP1 figures measure a deliberately isolated sparse research kernel and are directional, not a
claim that its rounding should ship. The final mass-conserving implementation must remain below
1 billion cycles on the degree-16/40-iteration cap fixture, leaving at least a 2.2x budget over the
spike. If it cannot, the child implementation must reduce its iteration/edge envelope or return to
design review; it may not silently weaken exact arithmetic.

The issue #52 production implementation subsequently passed that gate at **923,463,928 exact guest
cycles** for 2,048 entries, degree 16, and 40 iterations. It retains Hamilton apportionment and exact
`1e18` mass conservation. The reproducible command, ELF/vkey, parity scenarios, rejection matrix,
and raw release rows are recorded in the weighted-priors evidence README and
`production-benchmarks.csv`; the older figures above remain labeled research measurements.

The decision is **2,048, not tens of thousands**. At that bound, calldata remains below 58 KiB,
validation remains below 4M L1-style gas, client preview is interactive, and representative proving
is within the existing sub-billion class. Ten-thousand-entry calldata/validation and the exact
guest would consume the safety margin without an adopted proof/DA architecture.

## 8. Versioning and migration inventory

The new registry program label is `trust-graph-weighted`; its first params/manifest version is 1.
It is not `trust-graph-v2`, because the existing label continues to mean binary seeds and changing
that meaning would make historical operator/indexer assumptions ambiguous.

| Surface | Weighted change | Isolation requirement |
|---|---|---|
| Contracts/factory/controller | Compact manifest validator, pending/active commitment, weighted params codec/events | New contracts or modules; no existing instance mutation. |
| Guest/core | Sparse weighted node universe, exact apportionment, manifest checks | Separate crate/bin so existing ELFs and vkeys remain byte-identical. |
| Vkey/registry | New weighted vkey and program registration | No trust-graph, signer-sync, contributions, or Hypercerts rotation. |
| Operator/input exporter | Resolve manifest by params version; refuse unavailable/mismatched data | New weighted handler selected by program label. |
| Indexer/schema/API | Prior-version table, entries, availability/provenance state, paginated API | Additive schema; binary instances keep current fields. |
| Frontend | File importer, ENS freeze/recheck, preview/concentration, new-instance flow | Never reinterpret an existing instance as weighted. |
| Fixtures | Rust/guest/TS/Solidity normalization, manifest, params, journal, scoring vectors | Separate weighted fixture family. |

Existing instances remain permanently on binary-seed semantics. Opt-in means deploying a new
weighted instance; there is no in-place params upgrade. A migration wizard may prefill the new prior
with equal weights for the old seeds and may reference the source instance in provenance, but it
must present a new instance/program identity and cannot claim history-preserving migration.

## 9. Indexer and API representation

The indexer discovers a prior version from its proposal/creation event, retrieves the proposal
transaction, decodes and revalidates the exact manifest, and stores:

- instance, params version, status (`pending`, `active`, `superseded`), and activation block;
- root, count, SHA-256, manifest raw-CID, source transaction/block;
- availability state and last verification/error time;
- optional provenance metadata digest/document; and
- normalized entries keyed by `(instance, version, account)`.

The API returns commitment/status metadata and paginates entries. It never reconstructs weights
from an event array. If mirrors and the configured archival RPC both fail, the API marks the version
`unavailable` and the operator refuses to prove it; it never substitutes another list with the same
human provenance.

## 10. Threat analysis

| Threat | Control / accepted residual risk |
|---|---|
| Disconnected Sybil component receives rank | No prior support means no teleport or dangling mass; disconnected non-prior nodes remain zero. |
| Identity splitting within the prior | Splitting cannot create more total mass unless governance assigns it; no concave transform is run by consensus. Source quality remains a governance risk. |
| Single-account concentration | Explicit preview metrics and timelock review. No protocol cap in V1; this is an accepted governance choice. |
| Malicious/captured rotation | Operational timelock, full pending manifest, signer-visible diffs, checkpoint-pinned params. Timelock capture remains a known governance root of trust. |
| Invalid root/list wedges an instance | Factory/controller and guest both validate ordering, count, positivity, sum, digest, and root. |
| Missing IPFS blob | Exact bytes are in transaction calldata; indexer/operator mirrors and archival RPC recovery are independent paths. |
| Historical RPC/data loss | Operators and indexer pin every version. Loss of all chain-history providers plus all mirrors is an operational archival failure, explicitly alerted. |
| Unprovable parameter version | Pending ingestion window, guest cap, cycle acceptance fixture, operator preflight/refusal, and prior params remain checkpoint-pinned. |
| ENS changes between preview and signing | Resolution provenance plus mandatory finalized re-resolution; change forces rebuild. |
| Ambiguous decimals / cross-language drift | String grammar, exact integer parsing, Hamilton rule, binary manifest, and four-port fixtures. |
| Oversized calldata/proving grief | Constitutional 2,048 cap; no “unlimited” path. |

## 11. Decisions and deferrals for issue #34

| # | Decision / deferral |
|---:|---|
| 1 | Relative **persistent teleport-prior** weights; not initial/final scores or a temporary bootstrap. |
| 2 | Yes. Prior accounts are in `V` and receive day-zero leaves; an empty graph returns the prior. |
| 3 | The imported vector is 100% of teleport support. Organic propagation is mixed only by `d`; there is no non-prior component or `priorShare`. |
| 4 | No global uniform floor. Teleport and dangling mass are restricted to prior support. |
| 5 | `trustMultiplierFp`, `trustDecayFp`, and binary `trustShareFp` disappear from the weighted program. |
| 6 | Aggregate dangling transition mass and apportion it to the prior; empty graph is exactly the prior. |
| 7 | Persistent until governance rotation. Fade-by-time/evidence is deferred to a future program after manipulation analysis. |
| 8 | Canonical positive decimal strings with at most 18 fractional digits; no floats/exponents. |
| 9 | Normalize to `1e18` with exact Hamilton/largest remainder, address tie-break; reject normalized zero. |
| 10 | Zero and negative values are rejected. Negative priors are out of V1 scope. |
| 11 | No consensus concentration cap; UI exposes and warns on concentration metrics. |
| 12 | No consensus transforms in V1. Provenance documents source/transform; verifiable transforms require a source program/version. |
| 13 | EVM address only in V1. DID/generic-node priors are deferred; they must not force unrelated vkey rotation. |
| 14 | ENS is importer-only, resolved with block provenance and re-resolved immediately before signing; changes force rebuild. |
| 15 | Design for low thousands. The selected maximum is 2,048, not tens of thousands. |
| 16 | `MAX_PRIOR_ENTRIES = 2048` in factory and guest. |
| 17 | Full compact calldata is acceptable at this cap; measured upper bound is 3.69M gas and <58 KiB. |
| 18 | Exact `TGWP` V1 binary manifest; SHA-256/raw CID. Creator, indexer, and operators pin/retry/report. |
| 19 | Yes. Every create/proposal transaction contains the exact manifest; params history identifies the source transaction and digest. |
| 20 | Rotation is proposed and validated before a timelocked activation. Chain calldata demonstrates minimum availability; operators use the delay to ingest. |
| 21 | Root rotation is operational-timelock authority. Count/version/sum/damping/cycle bounds are constitutional; concentration is not. |
| 22 | New registry label `trust-graph-weighted`, params/manifest V1. |
| 23 | Existing instances remain binary. Opt-in is an explicit new instance; no in-place migration. |
| 24 | Isolate the core/bin/contracts so all existing program ELFs and vkeys remain unchanged; this is an implementation acceptance condition. |
| 25 | Indexer decodes proposal calldata into a versioned, paginated prior table with commitment, provenance, and availability status. |

## 12. Ordered implementation split

Implementation is intentionally split at reviewable trust boundaries:

1. [#52 — weighted core, guest, and golden fixtures](https://github.com/AInima-Collective/trustgraphs/issues/52)
   — normative arithmetic/manifest implementation, sparse performance envelope, and new isolated
   ELF/vkey; no weighted-prior implementation dependency.
2. [#53 — factory/controller commitment and rotation lifecycle](https://github.com/AInima-Collective/trustgraphs/issues/53)
   — compact calldata validation, pending activation, params hashing, events, and recovery tests;
   depends on #52.
3. [#54 — operator recovery and indexer API](https://github.com/AInima-Collective/trustgraphs/issues/54)
   — version recovery, cache/pinning/refusal behavior, schema/API, and reorg handling; depends on
   #52 and #53.
4. [#55 — import, preview, creation, and redeployment UX](https://github.com/AInima-Collective/trustgraphs/issues/55)
   — canonical CSV/JSON, ENS recheck, concentration display, wallet payload, and weighted-instance
   migration language; depends on #53 and #54.

No child may reinterpret this ADR's deferred items as implicit implementation permission.

## Superseded research

[`GRAPH_SEEDING.md`](./GRAPH_SEEDING.md) remains useful background, but this ADR supersedes its
mandatory global uniform floor, fading bootstrap mixture, DID-first keying, shared-core vkey
rotation, and root-plus-external-blob recommendations for weighted V1.
