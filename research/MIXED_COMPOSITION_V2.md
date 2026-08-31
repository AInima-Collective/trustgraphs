# Mixed TrustGraph composition V2

Status: accepted implementation decision for issue #105, 2026-08-31. Production implementation
has not started.

This record defines how one composition may blend standard `trust-graph` and
`trust-graph-weighted` outputs without relabelling either source. It extends the final-distribution
operator selected in [`TRUSTGRAPHS_COMPOSITION.md`](./TRUSTGRAPHS_COMPOSITION.md); it does not
change the Hamilton arithmetic, source freshness rules, workload caps, output encoding, or the
meaning of a V1 composition.

## 1. Decision

Ship a side-by-side **trust-compose params/manifest V2** with one closed compatibility class. The
class admits exactly these authenticated program/output-domain pairs:

| Source program         | Program ID                                                           | Source output domain                                 | Output-domain ID                                                     |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `trust-graph`          | `0xdb036dae12e8641d1e58d416eec22090955469d8da1c292e2b6b02ecb9e8d380` | `trustgraphs.output.trust-graph-account.v1`          | `0xa8ba97693d080750d9a6972406e8f5488842c338c94b402e5f02dad3d9e9eea5` |
| `trust-graph-weighted` | `0xbab333b5932d7fa8073fe8ed541c0d2aef9667198b0417f43ee5c920071af2b2` | `trustgraphs.output.weighted-trust-graph-account.v1` | `0x0509c32608494c9065912b6e03f10cfe54d31c433ffe3547fc729474342c293f` |

Both pairs are reviewed as:

- key encoding / identity domain `eip155-address`
  (`0xbe297acfcdfeb941c947581e60a05f869a3ff1133b88bef7735bdab1c28e3bef`);
- output kind `allocation`
  (`0xf96f9891e6ddd310141c323b55c40e1ccf0fcb5560f755b3387240dee7f177a1`);
- a canonical, nonempty, positive address/value blob whose authenticated `totalValue` is its exact
  sum.

The programs deliberately keep different source output domains. Compatibility means that this one
operator may normalize and blend both domains; it does not assert that the programs have identical
scoring methods or make the domains aliases elsewhere in the product.

V2 may contain any 2–8 sources from the class, including a homogeneous policy. It does not require
one source of each type in every policy version. This lets governance rotate a mixed composition
temporarily to one type without changing the instance's constitutional identity.

## 2. Compatibility-class commitment

The V2 params tuple replaces V1's singular `admittedProgramId` word with
`sourceCompatibilityClass`. The only accepted value is:

```text
SOURCE_COMPATIBILITY_CLASS_V1 =
  keccak256(abi.encode(
    keccak256("trust-compose.source-compatibility.v1"),
    keccak256("eip155-address"),
    keccak256("allocation"),
    keccak256("trust-graph"),
    keccak256("trustgraphs.output.trust-graph-account.v1"),
    keccak256("trust-graph-weighted"),
    keccak256("trustgraphs.output.weighted-trust-graph-account.v1")
  ))
```

Its exact value is
`0x5426d501d31705b306bf65d6260a564441ff6b3b98a4375766c76348b7cca9e2`.
The positional order in the preimage above is normative: class tag, shared key domain, shared
output kind, standard pair, weighted pair. The `V1` suffix versions the compatibility class
itself; it is carried by trust-compose params V2.

This is a closed constant in the V2 Rust guest, Solidity validator, independent TypeScript oracle,
indexer verifier, and frontend verifier. It is not a permissionless root whose creator may fill
with arbitrary pairs, and it is not read from a mutable registry during proving. Adding a third
pair requires another reviewed class and a new params/guest version.

Every source record carries both its real `programId` and real `sourceOutputDomain`. Validation
requires the exact mapping in the table above. An unknown program fails even if it copies an
allowed output-domain value; an allowed program fails if paired with the other program's domain.

## 3. Program identity and prover routing

V1 and V2 both use the canonical instance program ID:

```text
keccak256("trust-compose") =
0xf21b8f73c590106e82fb255eb77cb874c0610b9db9e2ea9c2be36eda57b44102
```

Do **not** introduce `trust-compose-v2` as a new `InstanceRegistry.Instance.program` value. Existing
V1 `CompositionSourceAdapter` deployments reject nested composition by comparing a registry row
with `keccak256("trust-compose")`. A new program ID would be unknown to those immutable adapters and
could therefore be wrapped and admitted by a V1 policy as an apparently non-composite source.
Keeping one family ID makes the legacy nested-composition rejection cover every composition
version.

The consequence is that a program ID no longer selects one composition ELF by itself. The operator
and prover route on the authenticated triple:

```text
(InstanceRegistry.program, params.version, snapshot verifier's programVKey)
```

The only accepted routes are:

| Program         | Params version | Verifier key                                                            | Guest            |
| --------------- | -------------: | ----------------------------------------------------------------------- | ---------------- |
| `trust-compose` |              1 | the pinned V1 key in [`composition/README.md`](./composition/README.md) | immutable V1 ELF |
| `trust-compose` |              2 | the V2 key generated and pinned by the V2 build                         | immutable V2 ELF |

The V2 key is intentionally not guessed in this design record. The reproducible guest build must
publish the ELF SHA-256 and vkey before a V2 verifier or factory is deployed. A missing route,
version/key mismatch, verifier read failure, or unrecognized key fails before witness assembly or
proof spend. There is no "latest composition guest" fallback.

The repository must retain a buildable, pinned V1 guest and its host adapter beside V2. Refactoring
the V1 guest or a dependency it compiles changes its ELF and is not a coexistence strategy. The V2
core/guest should therefore be a new versioned crate/program; version-neutral helpers may be copied
or imported only from code that does not alter the V1 build artifact.

The composition's own output semantics do not change. V2 keeps output domain
`trustgraphs.output.trust-compose-account.v1`
(`0xa5df42a9d061bedde1153250a461a5fa10945a6458a7e9a2e9217eb2a1cf0cc4`), the existing canonical
address/value blob and Merkle leaf, and the common 12-word journal.

## 4. V2 encodings

All integers below are unsigned big-endian in compact manifests. ABI words use ordinary Solidity
`abi.encode`. Source records are sorted by ascending `sourceId`, as in V1.

### 4.1 Params

The tuple remains 20 static ABI words so existing generic event/calldata tooling can distinguish
versions before selecting a semantic decoder. Word 6 changes meaning and must never be exposed
under the V1 field name after version dispatch.

|  Word | V2 field                   | Solidity type     | Rule                                    |
| ----: | -------------------------- | ----------------- | --------------------------------------- |
|     0 | `version`                  | `uint32`          | exactly `2`                             |
|     1 | `programId`                | `bytes32`         | `keccak256("trust-compose")`            |
|     2 | `scopeHash`                | `bytes32`         | nonzero, unchanged by rotation          |
|     3 | `identityDomain`           | `bytes32`         | `keccak256("eip155-address")`           |
|     4 | `outputKind`               | `bytes32`         | `keccak256("allocation")`               |
|     5 | `outputDomain`             | `bytes32`         | composition-account V1 domain           |
|     6 | `sourceCompatibilityClass` | `bytes32`         | exact closed constant from section 2    |
|     7 | `weightScale`              | `uint64`          | `1e18`                                  |
|     8 | `outputPool`               | `uint128`         | positive and at least `maxSources`      |
|     9 | `sourcePolicyRoot`         | `bytes32`         | derived from complete V2 policy records |
|    10 | `sourceCount`              | `uint8`           | 2–8 and at most `maxSources`            |
|    11 | `policyManifestSha256`     | `bytes32`         | SHA-256 of exact TGCP V2 bytes          |
| 12–17 | workload/freshness bounds  | existing V1 types | no V1 cap may be raised                 |
|    18 | `accumulator`              | `address`         | V2 accumulator                          |
|    19 | `chainId`                  | `uint64`          | nonzero and equal to the capture chain  |

The params hash remains `keccak256(abi.encode(all 20 fields))`. Version, compatibility class, policy
root, and manifest digest make a V1/V2 or same-shape policy replay fail.

### 4.2 Static policy: TGCP V2

The 15-byte header remains:

```text
"TGCP"[4] || manifestVersion=2[u16] || chainId[u64] || sourceCount[u8]
```

Each record is 165 bytes:

| Offset | Field                | Width |
| -----: | -------------------- | ----: |
|      0 | `sourceId`           |    32 |
|     32 | `snapshot`           |    20 |
|     52 | `familyId`           |    32 |
|     84 | `programId`          |    32 |
|    116 | `sourceOutputDomain` |    32 |
|    148 | `weight`             |     8 |
|    156 | `maxAgeBlocks`       |     8 |
|    164 | `required`           |     1 |

The policy leaf is:

```text
keccak256(abi.encode(
  sourceId,
  snapshot,
  familyId,
  programId,
  sourceOutputDomain,
  weight,
  maxAgeBlocks,
  required
))
```

Tree construction is unchanged: source-ID-order leaves, commutative sorted-pair parents, and
odd-node promotion. Sources remain required, unique by snapshot and adapter, positive-weighted,
same-chain, and collectively sum to `1e18`.

### 4.3 Captured state: TGCM V2

The 23-byte header remains:

```text
"TGCM"[4] || manifestVersion=2[u16] || chainId[u64] || captureBlock[u64] || sourceCount[u8]
```

Each record is 293 bytes:

| Offset | Field                | Width |
| -----: | -------------------- | ----: |
|      0 | `sourceId`           |    32 |
|     32 | `snapshot`           |    20 |
|     52 | `familyId`           |    32 |
|     84 | `programId`          |    32 |
|    116 | `sourceOutputDomain` |    32 |
|    148 | `stateIndex`         |     8 |
|    156 | `freezeBlock`        |     8 |
|    164 | `outputRoot`         |    32 |
|    196 | `blobSha256`         |    32 |
|    228 | `cidDigest`          |    32 |
|    260 | `totalValue`         |    16 |
|    276 | `weight`             |     8 |
|    284 | `maxAgeBlocks`       |     8 |
|    292 | `required`           |     1 |

Re-encoding the static fields from TGCM must reproduce the exact TGCP V2 bytes, policy root, and
policy digest committed in params. V1 parsers reject manifest version 2; V2 parsers reject version

1. Neither parser guesses from byte length.

## 5. Adapter reuse and nested-composition rejection

Existing `CompositionSourceAdapter` instances and their factory may be reused. They already bind
the actual registry `programId`, snapshot, params authority, verifier bytecode, program vkey,
checkpoint provenance, and reviewed deployment packet. They also reject every source whose
registry program is `keccak256("trust-compose")`.

The adapter does not expose a source output domain. V2 does not trust a caller-supplied domain to
fill that gap. Instead the V2 validator and accumulator derive the sole allowed output-domain value
from the adapter's authenticated `programId`, require the TGCP value to match, retain it in TGCM,
and require the adapter's existing output-kind declaration to equal `allocation`. This makes the
pair explicit in commitments without adding a mutable semantic registry or redeploying otherwise
valid source adapters.

V2 rejects nesting at three independent points:

1. Existing adapters refuse the shared `trust-compose` program ID.
2. The closed compatibility class contains only standard and weighted TrustGraph IDs.
3. Guest and off-chain verifiers reject `trust-compose` explicitly before blob decoding.

Future composition versions must retain the shared program ID unless every older adapter and
validator is first shown to reject the new identity. A differently named composition program is a
protocol compatibility change, not a cosmetic label.

## 6. V1 coexistence and policy rotation

V1 is immutable and remains fully operable:

- V1 params, TGCP/TGCM bytes, validator, contracts, verifier/vkey, guest ELF, goldens, indexer
  decoder, and proof route stay available and byte-identical.
- V1 instances continue accepting homogeneous policy rotations under their singular immutable
  `admittedProgramId`.
- The V2 verifier, accumulator, controller, factory, and governed wrapper are new deployments. A
  V1 instance is not upgraded in place by pointing it at V2 code.
- Both factory generations register `keccak256("trust-compose")`; their typed controller params and
  verifier key select the version-specific implementation.

For V2, `sourceCompatibilityClass` is an immutable identity field. A policy rotation may add,
remove, reweight, or replace sources from either admitted program, including moving between mixed
and homogeneous sets. It may not change the class, source/output mapping, program identity, output
semantics, bounds, accumulator, or chain. Rotation continues to timelock and atomically install the
complete manifest and adapter array; rollback is a new version using a recovered older preimage.

Removing one admitted program from a particular policy does not narrow the instance's class.
Adding an unreviewed third program cannot be smuggled in through rotation because class and mapping
validation run on proposals and again on activation/capture/proving.

## 7. Per-layer implementation boundary

This section assigns work; it does not authorize compatibility shortcuts between layers.

### Rust and SP1

- Keep `composition-core` and `zk/composition-program` as reproducible V1 sources.
- Add versioned V2 core/guest crates implementing the encodings and closed class above while
  reusing the exact V1 blob validation and two-stage Hamilton semantics.
- Pin a V2 ELF digest/vkey and rerun maximum-shape cycle, witness, memory, and mock Groth16 gates.
- Maintain independent rejection cases for wrong class, crossed program/domain pairs, unknown
  programs, and V1/V2 manifest replay.

### Solidity

- Add V2 codec/validator, accumulator, controller, factory, deployer, and governed wrapper beside
  V1. Keep the 20-word type layout but expose the correct V2 field name.
- Reuse the existing adapter factory; validate its registry and authenticated program before
  deriving `sourceOutputDomain`.
- Give V2 its own verifier/vkey and factory addresses. Preserve EIP-170 headroom and existing V1
  deployments/tests.

### Operator and prover

- Recover params version and verifier vkey before witness work and route by the triple in section 3. Keep both ELFs callable.
- Quote the same bounded work from decoded V2 sources; mixed program type does not change Hamilton
  cost, but exact manifest bytes remain part of witness pricing.
- Refuse catalog/controller/verifier disagreements and record version/vkey in durable provenance.

### Indexer and API

- Discover V1 and V2 factory/controller/accumulator generations separately, then materialize their
  common output API with an explicit `paramsVersion` and compatibility class.
- Decode TGCP/TGCM only after version dispatch and independently revalidate every program/domain
  pair, adapter, source checkpoint, blob, quota, and output.
- Preserve each source's actual program and output domain in composition provenance; never replace
  them with the class or the composition output domain.

### Frontend

- Offer `Add` for either admitted source type on the same chain without clearing existing sources.
- Build new compositions through V2, show each source's real program/domain, and run the exact V2
  verifier for preview, simulation, creation, and rotation.
- Continue reading and operating V1 homogeneous instances through the V1 decoder and factory
  surfaces. A version mismatch is an error, not a prompt to rebuild under current defaults.

### Deployment and documentation

- Release manifests and environment validation carry both composition factory generations and
  both vkeys. "Composition vkey" may no longer be a singular unversioned setting.
- Cold-stack tests create, prove, index, rotate, and render one mixed V2 instance while also
  refreshing an existing V1 fixture.

## 8. Threat cases and fail-closed behavior

| Threat                                     | Required behavior                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Same address width, wrong semantics        | Unknown program or wrong output-domain pair fails before source blob fetch.                                                 |
| Domain relabelling                         | The domain is derived from authenticated program ID and checked against committed TGCP/TGCM bytes.                          |
| Nested composition under V2                | Shared composition program ID is rejected by adapter, class, guest, indexer, and frontend.                                  |
| Nested composition via a new program label | This ADR forbids a second composition registry ID; introducing one requires a compatibility audit of immutable V1 adapters. |
| V1 proof replayed as V2                    | Params version/hash, manifest version, verifier, and vkey all differ; every layer rejects.                                  |
| Wrong ELF selected by operator             | Version/vkey route has no fallback and is checked before proof spend.                                                       |
| Compatibility widened during rotation      | Class is immutable and every proposed/activated policy revalidates exact pair membership.                                   |
| Mutable registry changes source identity   | Existing adapter identity/code/controller checks fail as in V1.                                                             |
| Unequal source pools                       | Each source is normalized by its authenticated positive `totalValue`; raw point scale cannot buy influence.                 |
| Missing account in one source              | Missing remains zero for that source; no per-account weight renormalization.                                                |
| Source enumeration changed                 | Canonical source-ID sorting produces identical manifests, quotas, attribution, and output.                                  |
| Cross-layer compatibility-table drift      | Independent golden implementations must reproduce the class, bytes, roots, digests, quotas, and failures below.             |

## 9. Frozen mixed golden fixtures

The V2 implementation must add an independent TypeScript exporter and checked-in vector consumed by
Rust, SP1, Solidity, operator/indexer, and frontend tests. Define `b32(x)` as `0x` followed by byte
`x` repeated 32 times and `addr(x)` as `0x` followed by byte `x` repeated 20 times. This notation is
exact, not illustrative.

### 9.1 Valid mixed fixture

Common policy:

| Field                              | Value                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| chain                              | `10`                                                                 |
| capture block                      | `1_000_000`                                                          |
| params version                     | `2`                                                                  |
| compatibility class                | `0x5426d501d31705b306bf65d6260a564441ff6b3b98a4375766c76348b7cca9e2` |
| scope hash                         | `0xb0993679504f19d518e9dac8362d3e2bc12d2c42f41606dad6d44c53af667e9d` |
| output pool                        | `1_000`                                                              |
| weight scale                       | `1_000_000_000_000_000_000`                                          |
| source count                       | `2`                                                                  |
| maximum sources                    | `8`                                                                  |
| per-source entries                 | `4_096`                                                              |
| aggregate entries                  | `8_192`                                                              |
| union accounts                     | `8_192`                                                              |
| aggregate blob bytes               | `1_048_576`                                                          |
| global source age                  | `500_000`                                                            |
| accumulator                        | `addr(c0)`                                                           |
| journal recipient                  | `addr(d1)`                                                           |
| instance domain                    | `b32(d2)`                                                            |
| journal anchor accumulator / count | `b32(00)` / `0`                                                      |
| journal skipped digest             | `b32(00)`                                                            |

Standard source A:

| Field                          | Value                                        |
| ------------------------------ | -------------------------------------------- |
| source ID / snapshot / family  | `b32(aa)` / `addr(a1)` / `b32(f1)`           |
| program / source output domain | exact standard pair from section 1           |
| state index / freeze / max age | `7` / `999_900` / `1_000`                    |
| weight / required              | `400_000_000_000_000_000` / `1`              |
| `addr(01)`                     | `900_000_000_000_000_000_000_000`            |
| `addr(02)`                     | `100_000_000_000_000_000_000_000`            |
| authenticated total            | `1_000_000_000_000_000_000_000_000` (`1e24`) |

Weighted source B:

| Field                          | Value                                |
| ------------------------------ | ------------------------------------ |
| source ID / snapshot / family  | `b32(bb)` / `addr(b1)` / `b32(f2)`   |
| program / source output domain | exact weighted pair from section 1   |
| state index / freeze / max age | `12` / `999_500` / `1_000`           |
| weight / required              | `600_000_000_000_000_000` / `1`      |
| `addr(02)`                     | `166_666_666_666_666_667`            |
| `addr(03)`                     | `333_333_333_333_333_333`            |
| `addr(04)`                     | `500_000_000_000_000_000`            |
| authenticated total            | `1_000_000_000_000_000_000` (`1e18`) |

The independent vector must pin the canonical source blobs, source roots, SHA-256 digests, CIDs,
CID digests, complete 345-byte TGCP, complete 609-byte TGCM, policy leaves/root, manifest digests,
20-word params bytes/hash, 12-word journal, output blob/root/CID, and per-source attribution.

Expected source quotas and output are exact:

| Source/account | Allocation |
| -------------- | ---------: |
| source A quota |        400 |
| A → `addr(01)` |        360 |
| A → `addr(02)` |         40 |
| source B quota |        600 |
| B → `addr(02)` |        100 |
| B → `addr(03)` |        200 |
| B → `addr(04)` |        300 |

| Final account | Value |
| ------------- | ----: |
| `addr(01)`    |   360 |
| `addr(02)`    |   140 |
| `addr(03)`    |   200 |
| `addr(04)`    |   300 |
| total         | 1,000 |

This one fixture pins unequal source pools, overlap at `addr(02)`, and missing-account behavior:
`addr(01)` is absent from B, while `addr(03)` and `addr(04)` are absent from A.

The exact independently calculated commitments are:

| Commitment            | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| source A root         | `0x3c828dd1608eed7f434d9db38d03a8f1d9d01a28aaef834724745a22ad70458c` |
| source A blob SHA-256 | `0x4f7c1a78dfd030c3dc6bf82cf45f4477edde82ad70b1dc9982ff947456a752fd` |
| source A CID          | `bafkreicppqnhrx6qgdb5y27yft2f6rdx5xpifllqwhojtax7sr2fnj2s7u`        |
| source A CID digest   | `0x2419b0a12f35ad1d6bf90c6beee28e0affbda0fc8d362ec2bcc55027bd8f3359` |
| source B root         | `0xecb321b678ebf9586f6144498da2f890468ddede659fee84a5b06fcaef8808bb` |
| source B blob SHA-256 | `0xafa56aa8298452660746335868b3d72f3d574c1fc69e2fd9741be53ae26a1f7e` |
| source B CID          | `bafkreifpuvvkqkmekjtaorrtlbulhvzphvluyh6gtyx5s5a34u5oe2q7py`        |
| source B CID digest   | `0x5026781b0bbec73371bb334079b864a452a4f0eb02e75e67480392d096af309d` |
| policy leaf A         | `0xc898cb07f1b5531c33e2f3452eb578c2051f09d51a48166908ac0fc8827ed7be` |
| policy leaf B         | `0x88765c6d8e1f91fad0891d7862dfcb9bc8e047a37816e02d3cd28d349b01aa52` |
| policy root           | `0x400d406845f7147a06660c33eb0806722308107e1aba2681d05bded4ed444a82` |
| 345-byte TGCP SHA-256 | `0x0395bec4154c5bc38dc80f47ed4372c3e5cc76e3c4db4d1434105bcb247b0728` |
| 609-byte TGCM SHA-256 | `0xe9993e1104477f854e738ad059589e6d44deac19b4a757b9ba6f7332fb82d2f6` |
| params hash           | `0x24f4ced83ce995541c6cbbeb9ce5c93e4c18ad4020af26b374f9965302125f22` |
| output root           | `0xb69aa6c6afaac5433398e4f4d870ffce07e89584c5d224ba6a24e2916974ddd6` |
| output blob SHA-256   | `0x5cfdef4b909ae09453deb122ed0e106f962fd2d6bbdac610bde9e8963c6b44d9` |
| output CID            | `bafkreic47xxuxee24ckfhxvrelwq4edpsyx5fvv33ldbbppj5cldy22e3e`        |
| output CID digest     | `0xb77f2e825b7085261bf16af8e627ac97f560f5fc4451003bcf997d5f9a7ba455` |
| journal ABI digest    | `0xdc5d9209f6b2beba3eb674ba89030cb11c83905bc12ce87a3b0b4d418deadd32` |

### 9.2 Reversed enumeration

Supply the same sources and adapters to the independent builder in `[B, A]` order. It must produce
the same canonical `[A, B]` TGCP/TGCM bytes, policy root/digests, params hash, quotas, attribution,
output blob/root/CID, and journal as section 9.1. On-chain calldata must reorder the adapter array to
the resulting source-ID order; an unreordered adapter array fails `AdapterPolicyMismatch` rather
than changing the result.

### 9.3 Incompatible third program

Add source C after A and B:

| Field                          | Value                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| source ID / snapshot / family  | `b32(cc)` / `addr(c1)` / `b32(f3)`                                                                                     |
| program                        | `contributions` = `0x5c883795f9585e31baccff3867399dcf995294cc54a208a2d3785eb3ec1fb323`                                 |
| source output domain           | `trustgraphs.output.contributions-recipient.v1` = `0x52c9abae38394805336d80b3217a45f59effdcc6258b6a062e0b00d7bc392c5f` |
| state index / freeze / max age | `13` / `999_800` / `1_000`                                                                                             |
| weight / required              | `100_000_000_000_000_000` / `1`                                                                                        |

For this rejection fixture only, set A/B weights to
`350_000_000_000_000_000` / `550_000_000_000_000_000`, so all structural fields and the `1e18`
weight sum are otherwise valid. Every implementation must reject source index 2 as an unadmitted
program/output pair before fetching or decoding C's blob. A companion mutation that keeps C's
program but substitutes either allowed TrustGraph output domain must fail at the same boundary.

### 9.4 V1 regression and rotation vectors

- Regenerating the existing V1 production vector must yield no diff, and its V1 guest must still
  execute and verify under the pinned V1 key.
- A V2 rotation that changes source weights or removes either class member succeeds after the
  existing delay when its exact manifest/adapter preimage is supplied.
- A V2 rotation that changes `sourceCompatibilityClass`, crosses one allowed program/domain pair,
  or inserts source C fails without changing accumulator policy, snapshot params, or registry
  params.

## 10. Release gate

Mixed composition is ready only when:

1. the independent vector in section 9 is byte-identical across Rust, SP1, Solidity, indexer, and
   frontend implementations;
2. the V1 vector, ELF/vkey route, homogeneous creation, rotation, proof, and provenance remain
   operable;
3. a cold-stack walkthrough creates A+B, previews the exact values above, deploys/reuses both
   adapters, creates a V2 governed composition, captures, proves, indexes, renders real source
   identities, rotates its policy, and reproduces the output independently; and
4. the picker says `Add` for compatible same-chain mixed sources and refuses C without clearing the
   valid A+B selection.
