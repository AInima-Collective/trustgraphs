# ADR: proof-complete ERC-8004 registry inputs

**Status:** accepted design boundary; current deployed-history path is a no-go

**Decision date:** 2026-08-14

**Issue:** [#60](https://github.com/JakeHartnell/trustgraphs/issues/60)

**Scope:** authenticate the finite external Identity/Reputation event set consumed by a future
agent-reputation proof. This ADR does not choose a reputation formula, ship a guest, upgrade an
ERC-8004 deployment, or turn the issue-59 experiment into a production score.

## Decision

The current Optimism ERC-8004 proxies cannot support a proof-complete claim over their existing
history. They emit standard EVM logs but maintain no event accumulator, and their owner-controlled
UUPS implementations can change the meaning and completeness of those logs. A Ponder export,
operator signature, event-list CID, or set of individual receipt-inclusion proofs authenticates
only supplied items; none proves that no eligible event was omitted.

Trustgraphs therefore records two deliberately separate outcomes:

1. **No-go for the deployed-history claim.** A proved program MUST NOT consume pre-activation
   feedback from the current Optimism proxies unless a later implementation supplies an exhaustive,
   finalized header/receipt proof from deployment. The lower-bound workload in this ADR is not
   acceptable for the present product.
2. **Conditionally viable activation-scoped boundary.** The official Identity and Reputation
   proxies may become inputs only after reviewed implementations synchronously append every
   relevant semantic event to a separate, non-upgradeable accumulator and import a complete frozen
   starting wallet state. Scores may then cover the activation state plus every accumulator event
   through a checkpoint. They may not describe earlier feedback as proven.

This does not unblock #62 by itself. Issue #59 independently reached a no-go for its scoring policy,
and the cooperating registry architecture below still requires implementation and upstream/deployer
coordination. The ordered child issues created from this ADR are prerequisites, not hidden work
inside the program epic.

## The precise future verifier claim

For an accepted source checkpoint `C` and policy `P`, a future verifier may claim only:

> The committed output is the deterministic result of policy `P` over the complete ordered event
> interval `(C.previousCount, C.count]` recorded by accumulator `C.accumulator`, starting from the
> previously proven state (or the complete activation state at count zero). Every event names one
> admitted registry proxy, one reviewed implementation code hash and event-set version, and exact
> EVM topic/data bytes. The interval re-folds from the previous authenticated head to `C.head`, and
> its final source block is the checkpointed canonical ancestor on the settlement chain.

The verifier does **not** claim that:

- feedback before activation was complete or processed;
- a feedback value is truthful, Sybil-resistant, comparable across tags/units, or evidence of a
  real interaction;
- an agent endpoint is available or safe;
- an implementation allowlist is trustless—the review/upgrade authority is an explicit policy
  authority;
- a CID or chain history remains retrievable forever; or
- an RPC/indexer/exporter supplied all events without the accumulator re-fold succeeding.

## Threat model

| Actor or fault                    | Capability                                                                         | Required result                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious prover/exporter/indexer | Delete, insert, reorder, duplicate, truncate, corrupt, or withhold event preimages | Head/count/range/preimage checks fail; no score advances                                                                                        |
| Registry upgrade owner            | Upgrade, pause, or replace interpretation                                          | Reviewed implementation records the transition before control moves; unknown code hash fails closed                                             |
| Buggy/unreviewed implementation   | Omit mirror calls, forge semantic records, mutate storage incompatibly             | Its entry transition is permanent in the sidecar; policy refuses that epoch and requires a new reviewed recovery era                            |
| Accumulator administrator         | Censor initialization/recovery or choose a bad activation import                   | Authority is disclosed; sidecar has no reset/overwrite path; recovery creates a visible new era rather than rewriting history                   |
| Sequencer/L1 reorg                | Present unsafe or later-orphaned OP blocks                                         | Operator waits for `finalized`; same-chain checkpoint/root transactions reorg together; cross-chain use requires a separate finalized transport |
| RPC/archive/DA failure            | Omit logs, return a fork, or lose historical bytes                                 | Multiple-source reconstruction must reproduce the head; missing preimage halts and is repairable, never skipped                                 |
| Feedback spammer                  | Buy many canonical feedback writes to exhaust proving                              | Fixed count milestones, a hard delta cap, adaptive checkpoint cadence, and pricing expose the paid workload                                     |
| Censoring relayer                 | Refuse to export or prove a complete interval                                      | Anyone with preimages can reproduce/prove; the canonical registry write itself appends without an application relayer                           |

The selected design still trusts reviewed registry code to call the sidecar with the exact source
event. That trust is narrower and auditable: accepted bytecode hashes and event-set versions are
part of the proof policy, and an upgrade cannot erase the preceding head.

## Candidate comparison

| Candidate                          | Non-omission boundary                                                                                       | Upgrade/finality story                                                                                     | Workload and recovery                                                                                                                          | Decision                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Relayer-fed trustgraphs mirror     | Complete only for events the relayer submitted to the mirror                                                | Mirror says nothing about silent canonical-registry events                                                 | Cheap; relayer censorship/omission is unprovable                                                                                               | Reject for canonical ERC-8004; acceptable only as a separately named “wrapper-routed feedback” domain |
| Complete headers + receipt tries   | Rebuild every relevant block receipt root, using authenticated header blooms only for sound-negative blocks | Can bind exact proxy logs/code proofs to a finalized OP derivation/output                                  | Cryptographically sound; legacy bootstrap requires scanning 8,036,646 headers and positive-block receipts, plus archive/DA and reorg machinery | No-go for current product; retain as a research-grade legacy migration option                         |
| Canonical registry cooperation     | Reviewed proxy code appends synchronously to immutable sidecar; head/count is the finite set                | Upgrade transition carries post-upgrade `extcodehash`; unknown epoch stops; checkpoint lives on same chain | ~51.7k measured steady append gas and bounded incremental proving; repair from any preimage archive                                            | Select, activation-scoped and contingent on upstream/deployer adoption                                |
| Trusted committee/export signature | Complete according to committee assertion                                                                   | Committee chooses fork/range and can omit                                                                  | Operationally simple; weaker correctness and censorship trust                                                                                  | Reject for a canonical proof claim; may label an explicitly committee-attested experiment             |

### Why a unilateral mirror is insufficient

An EVM contract cannot observe another contract's logs. A sidecar updated by an off-chain relayer
proves only “all messages admitted by this sidecar,” not “all logs emitted by the canonical
registry.” A wrapper can be sound if every scored feedback transaction is deliberately routed
through that wrapper, but that is a new feedback domain and must not be labeled the complete
ERC-8004 Reputation Registry.

### Why individual receipt proofs are insufficient

The block header's receipt root commits every transaction receipt. An inclusion proof proves that
one receipt/log is present. The trie is indexed by transaction position, not registry address or
event topic, so a handful of inclusion proofs cannot prove that another receipt lacks a matching
log. The header bloom has no false negatives and can soundly eliminate negative blocks, but a
positive bloom cannot establish multiplicity or non-omission. Positive blocks require exhaustive
receipt reconstruction or an equivalent execution proof; every block header must still be
authenticated and scanned.

The pinned Optimism range from Identity deployment block `147,514,947` through experiment cutoff
`155,551,592` contains **8,036,646 blocks**. OP derivation requires an L1-attributes transaction in
every L2 block, and an execution header/receipt bloom is 256 bytes. Merely reading one 256-byte
header bloom per block is therefore **2,057,381,376 bytes (1.916 GiB)** before header fields, RLP,
MPT nodes, positive-block receipts/logs, OP derivation, or proof overhead. Incremental recursion can
amortize future blocks, but it does not make the legacy bootstrap or its archival dependencies
disappear.

Complete receipt proofs remain technically sound if a future dedicated benchmark accepts this
cost. The claim must then bind finalized OP derivation, every header in the range, every
bloom-positive receipt trie, proxy account/storage proofs for implementation epochs, and all raw
log preimages. An explorer API or RPC signature is not that proof.

## Selected architecture

### 1. Immutable global accumulator sidecar

Deploy one non-upgradeable sidecar for the admitted Identity/Reputation proxy pair. It authorizes
calls only from those two proxy addresses and maintains one global `head` and `count`, preserving
cross-registry execution order. Each reviewed implementation calls the sidecar in the same
transaction and immediately adjacent to its corresponding semantic state mutation/event emission.

The sidecar cannot reject legitimate events because of a proving quota; doing so would make
registry behavior depend on trustgraphs capacity. Instead it automatically stores a cumulative
milestone head whenever `count` crosses a fixed 16,384-event boundary. A prover consumes one or
more bounded deltas from an earlier authenticated head. A final partial milestone may be frozen at
a source block by the existing snapshot lifecycle.

The sidecar is intentionally separate from UUPS proxy storage. An unreviewed implementation may
append junk or stop appending, but it cannot delete or reset the head that permanently records the
transition into its epoch.

### 2. Activation and starting state

The current v2 implementations do not call a sidecar, so the first cooperative upgrade is a trust
boundary rather than retroactive proof. Activation must be an explicit migration:

1. Upgrade both registries to reviewed cooperative implementations and freeze registration,
   wallet/ownership changes, feedback, revocation, and response writes.
2. Record `ImplementationActivated` for both proxies, their implementation addresses,
   `extcodehash` values, event-set version, activation block, and captured sequential agent-ID upper
   bound.
3. Batch-import exactly every agent ID from zero through that captured upper bound. Each
   `IdentityStateSeed` commits `agentId`, owner, and current verified wallet (zero if unset).
   The sidecar enforces the next expected ID, so a batch cannot skip, duplicate, or reorder an
   identity. Registration remains frozen until the terminal ID is recorded.
4. Finalize the activation checkpoint and unfreeze both proxies atomically under the reviewed
   migration procedure.

No legacy feedback is imported. Post-activation feedback attribution starts from the complete seed
and then replays every wallet/transfer event in the same global accumulator as feedback. This is a
complete history for the declared activation-scoped claim, not a claim about a reviewer's earlier
wallet bindings.

If pausing both registries and enumerating the sequential ID space cannot be implemented without a
storage-layout or availability ambiguity, activation fails and no program is enabled.

### 3. Upgrades and authority

For every later UUPS upgrade, the currently accepted implementation must append `Upgraded` before
control moves. The sidecar computes/binds the new implementation address's `extcodehash` and starts
a new implementation epoch. The proof policy independently contains the allowed
`(proxy, codeHash, eventSetVersion)` set.

This ordering matters. If an owner upgrades from reviewed code to unknown code, the immutable head
already contains the unknown transition; upgrading back cannot hide it. The verifier stops at the
last accepted checkpoint. Adding a code hash to the allowlist is a constitutional policy change
with review/delay, not an operator toggle.

The current upstream implementation's `_authorizeUpgrade` is only-owner and imposes no such
sidecar/allowlist continuity. That is why the deployed proxies are not eligible today. ERC-1967's
`Upgraded` event is useful provenance, but the standard recommends rather than cryptographically
forces correct event emission, and the event alone is not an accumulator.

### 4. Checkpoints and canonical encoding

The frozen vector lives in
[`erc8004-completeness/golden.json`](./erc8004-completeness/golden.json). For each canonical record:

```text
topicsHash   = keccak256(uint8(topicCount) || topic[0] || ... || topic[n-1])
dataHash     = keccak256(exactSourceLogData)
preimageHash = keccak256(uint8(topicCount) || topics || uint64(dataLength) || data)

leaf = keccak256(abi.encode(
  EVENT_DOMAIN,
  sourceChainId,
  registryProxy,
  sourceBlockNumber,
  globalSequence,
  implementationCodeHash,
  eventSetVersion,
  eventKind,
  topicsHash,
  dataHash
))

head[i+1]     = keccak256(abi.encode(head[i], leaf[i]))
preimages[i+1] = keccak256(abi.encode(preimages[i], preimageHash[i]))
```

`topicCount` is 0–4, lengths are unsigned big-endian fixed-width values, source topics remain in
EVM order, and source data is never decoded/re-encoded for the leaf. Strings, signed integers,
packed wallet bytes, empty values, and indexed-string hashes therefore retain their exact ABI
bytes. `globalSequence` distinguishes legitimate repeated identical source events and makes order
explicit.

The checkpoint digest is:

```text
keccak256(abi.encode(
  CHECKPOINT_DOMAIN,
  sourceChainId,
  accumulator,
  identityRegistry,
  reputationRegistry,
  activationBlock,
  endBlock,
  endBlockHash,
  count,
  head,
  eventSetVersion,
  identityImplementationCodeHash,
  reputationImplementationCodeHash,
  preimageCommitment
))
```

The TypeScript exporter, detached Rust guest reference, and Solidity miniature reproduce every
golden leaf, fold, checkpoint, and historical wallet attribution independently.

### 5. Exact event set

Every record below is appended, even when the first score policy ignores its presentation fields.
That keeps the source audit complete and prevents a later implementation from silently redefining
which lifecycle mutations matter.

| Registry   | Kind                                                                                          | Canonical source payload                                              | Score-state effect                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Identity   | `ImplementationActivated`                                                                     | Synthetic activation address, code hash, event-set version            | Starts reviewed epoch                                                                     |
| Identity   | `IdentityStateSeed`                                                                           | Synthetic `agentId`, owner, current `agentWallet`                     | Complete activation wallet state                                                          |
| Identity   | `Transfer(address,address,uint256)`                                                           | Exact standard topics/data                                            | Owner change; non-mint transfer clears wallet after the contract's preceding clear record |
| Identity   | `Registered(uint256,string,address)`                                                          | Exact topics/data including URI                                       | Creates identity; paired wallet `MetadataSet` supplies binding                            |
| Identity   | `URIUpdated(uint256,string,address)`                                                          | Exact topics/data                                                     | Audit/presentation only in v1                                                             |
| Identity   | `MetadataSet(uint256,string,string,bytes)`                                                    | **Every** key/value, including exact packed `agentWallet` bytes       | `agentWallet` updates historical attribution; other keys remain audit data                |
| Identity   | `OwnershipTransferred(address,address)`                                                       | Exact topics/data                                                     | Registry authority provenance                                                             |
| Identity   | `Upgraded(address)`                                                                           | Exact source event plus sidecar-bound post-upgrade code hash          | Ends/starts implementation epoch                                                          |
| Reputation | `ImplementationActivated`                                                                     | Synthetic activation address, code hash, event-set version            | Starts reviewed epoch                                                                     |
| Reputation | `NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)` | Exact topics/data including indexed/unindexed tag and URI/hash fields | Creates one feedback record                                                               |
| Reputation | `FeedbackRevoked(uint256,address,uint64)`                                                     | Exact topics/data                                                     | Marks, never deletes, the record                                                          |
| Reputation | `ResponseAppended(uint256,address,uint64,address,string,bytes32)`                             | Exact topics/data                                                     | Preserves response history/count; policy decides weight                                   |
| Reputation | `OwnershipTransferred(address,address)`                                                       | Exact topics/data                                                     | Registry authority provenance                                                             |
| Reputation | `Upgraded(address)`                                                                           | Exact source event plus sidecar-bound post-upgrade code hash          | Ends/starts implementation epoch                                                          |

ERC-721 `Approval`/`ApprovalForAll` are excluded from the scoring event set. They can affect whether
a feedback call is accepted as self-feedback, but a successful `NewFeedback` already reflects that
registry check at execution time; they do not change reviewer-to-agent wallet attribution. Adding
them later is an event-set version change, not an interpretation tweak. Validation Registry events,
off-chain registration documents, feedback-file contents, and endpoint observations are also
outside v1.

The implementation child must prove one-to-one adjacency between each relevant state mutation,
source event, and sidecar append, including registration's `Transfer`/`Registered`/wallet records
and transfer's wallet-clear-before-`Transfer` order. Fuzzing must compare replayed state with proxy
storage at arbitrary cutoffs.

### 6. Finality, reorgs, and cross-chain transport

The selected first deployment keeps the registry pair, accumulator checkpoint, score snapshot, and
verifier on Optimism. The checkpoint is read from same-chain contract state; a reorg that removes
the source checkpoint also removes dependent proof/root transactions. The operator still waits for
the JSON-RPC `finalized` tag and binds the exact end-block hash before export/proving. It compares
multiple providers and refuses a stale, unavailable, or disagreeing finalized view.

“Safe” is not “finalized.” OP derives safe blocks from L1-published data and finalizes them with L1
finality. An unsafe sequencer block may disappear. Product provenance must show source end block/hash
and finality status.

If the verifier moves to another chain, this same-chain argument no longer applies. The destination
must authenticate a finalized OP checkpoint through a canonical bridge/output/fault-proof path (or
an explicitly weaker named committee). It must bind source chain ID, accumulator, checkpoint digest,
and transport message. A generic cross-chain messenger, RPC proof, or operator signature is not
silently acceptable. No cross-chain child is opened for the Optimism-first scope.

### 7. Availability, repair, and recovery

Accumulator logs and original registry logs supply event preimages, while the folded hashes prove
their exact identity. Before a score proof is submitted, the exporter must reconstruct every
preimage in the delta, re-fold both commitments, serialize canonical witness bytes, and publish them
under the repository's existing multi-target minimum-success durability policy. The output journal
binds the witness/blob CID in addition to the source checkpoint.

If one RPC/archive is missing data, reconstruction retries independent sources. If any preimage
remains missing, proving halts at the last applied checkpoint. There is no
“skip-with-proof-of-unavailability” branch: unavailability is not a cryptographically verifiable
negative, and skipping would return omission discretion to the prover.

Historical repair re-fetches or republishes the same content-addressed bytes and checks both folds.
If data is permanently lost or an unreviewed implementation epoch is entered, constitutional
recovery creates a new accumulator era/activation state. The old era and last score stay visible;
no head/count is overwritten, and no proof crosses the `Recovery` record.

### 8. Capacity, gas, pricing, and DoS

The executable miniature measured:

| Path                              |                                     Measurement |
| --------------------------------- | ----------------------------------------------: |
| Steady registry → sidecar append  |                            51,674 execution gas |
| Sidecar checkpoint                |                            83,128 execution gas |
| 16,384 events × 256-byte preimage |  9,256,968-byte witness; 192,335,661 SP1 cycles |
| 65,536 events × 256-byte preimage | 37,027,848-byte witness; 770,469,301 SP1 cycles |

These are issue-60 research measurements, not service prices. OP fees add L1 data cost and vary with
network conditions. The append figure excludes the existing registry mutation; the SP1 figure
excludes wallet/policy replay, score arithmetic, output-tree construction, proof wrapping, and
publication.

The accepted research cap is therefore **16,384 new canonical records per automatic milestone**.
The full implementation may lower but not raise it without a complete-guest benchmark. Automatic
count milestones prevent an event burst from creating an unsplittable delta. The operator quote
uses exact delta count and serialized preimage bytes, not an average event estimate. If incoming
events outrun proof cadence, it processes successive fixed milestones and exposes backlog age/count;
it never drops expensive events.

Spam remains possible because ERC-8004 feedback is permissionless. The attacker must pay the
registry and added sidecar execution/data cost, but that is not a Sybil defense. Per-instance
pricing/cadence must cover worst-case accepted deltas, and production enablement needs sustained
backlog/load tests. The sidecar must not impose a global lifetime count cap: incremental proof state
and bounded milestones keep per-proof work finite while history grows append-only.

## Executable exit evidence

[`erc8004-completeness/reference.test.ts`](./erc8004-completeness/reference.test.ts) demonstrates:

- deletion, insertion, reorder, duplicate, and range truncation rejection;
- finalized-block-hash/reorg rejection;
- fail-closed unavailable preimages, recovery boundaries, and unreviewed upgrades;
- current implementation hashes matching checkpoint state; and
- feedback reviewer attribution from the same complete wallet event history.

The Solidity test independently verifies all 18 golden event vectors and the checkpoint digest,
then exercises append → upgrade → rejection of stale implementation → checkpoint. The detached Rust
test independently verifies the same vectors, and the isolated SP1 program byte-matches its head
and preimage commitment against native replay. Reproduction commands and the complete benchmark
matrix live in [`erc8004-completeness/README.md`](./erc8004-completeness/README.md).

## Ordered implementation work

The selected path is viable only in this order:

1. [#86](https://github.com/JakeHartnell/trustgraphs/issues/86) — implement/audit the immutable
   sidecar, cooperative proxy hooks, upgrade-epoch discipline,
   activation freeze/state import, exact golden vectors, and automatic count milestones.
2. [#87](https://github.com/JakeHartnell/trustgraphs/issues/87) — integrate checkpoint/finality/
   export/availability/recovery and benchmark the complete input adapter under burst/backlog
   conditions.
3. [#88](https://github.com/JakeHartnell/trustgraphs/issues/88) — revisit the policy no-go from #59
   with materially broader complete-era evidence. Only after it records a go may #62 implement and
   deploy an agent-reputation guest.

The child issue bodies carry independent acceptance criteria. Upstream refusal, inability to pause
and enumerate activation state, a storage-layout ambiguity, an unreviewed upgrade, or a complete
guest exceeding the accepted workload all preserve the no-go; none authorizes an operator-list
fallback.

## Primary sources

- [ERC-8004 specification](https://eips.ethereum.org/EIPS/eip-8004)
- [Pinned official ERC-8004 contracts and deployments](https://github.com/erc-8004/erc-8004-contracts/tree/68fc6765761a10fb26f0692df21c8a6f9d12b1be)
- [Pinned upgrade model](https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/UPGRADEABLE_IMPLEMENTATION.md)
- [ERC-1967 implementation slot and `Upgraded` event](https://eips.ethereum.org/EIPS/eip-1967)
- [Ethereum execution receipt/root definition](https://ethereum.github.io/execution-specs/src/ethereum/forks/bpo2/blocks.py.html)
- [Ethereum Yellow Paper receipt bloom and trie definition](https://ethereum.github.io/yellowpaper/paper.pdf)
- [OP Stack derivation transaction ordering](https://specs.optimism.io/protocol/derivation.html)
- [OP Stack deposits: L1 attributes is the first transaction](https://specs.optimism.io/protocol/deposits.html)
- [OP Mainnet transaction finality](https://docs.optimism.io/op-mainnet/network-information/transaction-finality)
- [OP derivation finality/reorg behavior](https://specs.optimism.io/protocol/derivation.html)
