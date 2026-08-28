# Onchain attestation import: Trustgraphs over existing EAS attestations

**Status:** proposed design, not built

**Date:** 2026-08-28

**Scope:** let a Trustgraphs instance consume onchain EAS attestations from schemas that were
registered *without* the folding resolver, so the large existing corpus of EAS attestations can
seed and grow trust graphs. This note designs the ingestion lane and states exactly what the
proof claims when it is used. It does not choose which external schemas are worth importing,
and it does not cover offchain (EIP-712 signed) attestations, which have their own lane
([`EAS_OFFCHAIN_SUPPORT.md`](./EAS_OFFCHAIN_SUPPORT.md)).

## The opportunity

EAS has been live on mainnet and the major L2s since 2023, and millions of attestations already
exist: identity verifications, project reviews, endorsements, community memberships. Almost none
of them were made against a schema whose resolver folds into a Trustgraphs accumulator, because
those schemas predate us. Today that entire corpus is invisible to the platform.

A single small contract changes that. Onchain EAS attestations are self-authenticating: the full
record (attester, recipient, data, time, revocation time) sits in the EAS contract's own storage,
readable by any other contract. So a permissionless importer can rebuild, after the fact, the
same chained-hash commitment our resolver builds at attestation time, and the existing proof
pipeline consumes it unchanged. A community with years of attestation history could stand up a
Trustgraph over it in one backfill transaction batch, and keep it growing as new attestations
arrive.

## Background: what the folding resolver does, and why it cannot be retrofitted

In a native instance, `EASIndexerResolver` is the schema's EAS resolver. EAS calls it
synchronously on every attest and revoke, and it folds each event into a chained keccak
accumulator (`AttestationAccumulator._fold`). The zkVM guest re-folds every leaf and asserts it
reproduces the checkpointed `acc`; that assertion is the input-completeness proof. Because EAS
reverts the whole attestation if the resolver reverts, the resolver-fed accumulator commits to
*every attestation that exists for the schema*: the prover can neither omit an edge nor inject
one.

The binding is permanent in both directions. A schema's resolver address is part of its
registration, and the schema UID is derived from (schema string, resolver, revocable). An
existing schema can never gain a resolver, so for pre-existing attestations the resolver path is
simply unavailable. The question is not "resolver or no resolver"; it is "what rebuilds the
accumulator when the resolver could not be there".

## Design: a permissionless importer

`OnchainAttestationImporter` is an `AttestationAccumulator` that is fed by public calls instead
of by EAS:

- **`importAttestations(bytes32[] uids)`** (anyone): for each uid, read the attestation from EAS
  via `getAttestation`, require that its schema is on the instance's allowlist, that the uid has
  not been imported before, and fold it exactly as the resolver would:
  `_fold(kind, attester, recipient, uid, attestation.time, keccak256(data))`.
- **`importRevocations(bytes32[] uids)`** (anyone): for each already-imported uid, require
  `revocationTime != 0` in EAS storage and that the revocation has not been folded yet, then fold
  the revoke leaf with `timestamp = revocationTime`.
- The importer emits the same index events as `EASIndexerResolver` (`Attested`,
  `AttestationAttested`, `AttestationRevoked`, `EdgeFolded`), so Ponder's existing handlers and
  `input-exporter`'s candidate collection apply without modification.
- The importer implements the accumulator read surface (`acc`, `leafCount`, `checkpoint()`), so
  `MerkleSnapshot` binds to it exactly as it binds to a resolver today. Same one-shot
  `bindSnapshot`, same trigger-only checkpoint minting.

Authenticity needs no signatures and no trusted caller: every folded field is read from EAS
storage inside the import call. The caller chooses only *which* uids to import and *when*.

The guest does not change. It already just re-folds leaves and reconciles them; it never knew or
cared whether a resolver or an importer appended them. `Params.accumulator` carries the importer
address for domain separation, `Params.schema_uid` names the imported schema, and everything
downstream (proving, `submitProof`, governance, distribution) is untouched.

### Fold the attestation's own timestamp, not the import block's

This is the one place the importer must deviate from `_fold` as it exists. The resolver folds
`block.timestamp` because at resolver time that *is* the attestation time. At import time it is
not, and the difference is not cosmetic: the guest's reconciliation is a total order over
`(timestamp, fold index)` with last-writer-wins per (attester, recipient) pair. If a backfill
folded import-time timestamps, ordering within the backfilled set would collapse to import
order, which is caller-chosen. An adversary could import an old, superseded vouch *after* a
newer one for the same pair and make the stale weight win.

Folding the EAS-stored `attestation.time` (and `revocationTime` for revokes) closes this
completely: reconciliation order equals true attestation order no matter who imports what in
which sequence, and the value is read from EAS storage, never taken from the caller. Concretely,
`AttestationAccumulator` gains an internal `_foldAt(kind, attester, recipient, uid, timestamp,
dataHash)` and the existing `_fold` becomes `_foldAt(..., block.timestamp, ...)`, so the leaf
encoding, the guest, and every existing feeder stay byte-identical.

One residual, and it is small: two attestations for the same pair in the same second are
tie-broken by fold index, which on the resolver lane is transaction order and on the import lane
is import order. Same-second same-pair conflicts are the only case where import order matters at
all.

### Expiration becomes supportable, not a blocker

The native resolver rejects any nonzero `expirationTime`, because on that lane the passage of
time cannot append the revocation leaf that would remove the edge. The importer does not have
that limitation: anyone may call **`importExpirations(bytes32[] uids)`** once
`block.timestamp >= expirationTime`, folding a revoke leaf with `timestamp = expirationTime`.
The guest's existing revoke semantics (clear the pair if the uid names the current edge) already
do the right thing, with zero guest changes. Existing corpora use expirations heavily, so this
matters; v1 may still choose to simply skip expiring attestations at import, but the clean
extension exists.

### Payloads from foreign schemas

The guest decodes edge weight from the attestation `data` at `Params.weight_field_index`, and a
failed decode already clamps to `min_weight`. Foreign schemas therefore degrade gracefully:
every imported attestation becomes an attester-to-recipient edge of minimum weight, which is a
sensible default reading of "this attestation is an endorsement". Where a foreign schema does
carry a usable numeric field, `weight_field_index` can point at it per instance.

Two payload policies the importer enforces at ingress:

- **Skip `recipient == address(0)`.** Self-describing attestations with no recipient are common
  in the wild and would otherwise create edges into the zero address.
- **Ignore `refUID`.** Reference chains carry no meaning to the trust graph in v1.

### One importer, one schema (for now)

Like the native lane, v1 keeps one accumulator per instance and one schema per accumulator. An
instance that wants to blend several existing schemas into one graph would either deploy one
importer per schema behind a future multi-lane snapshot, or use a schema-tagged `kind` byte the
way the contributions resolver does. Both are known patterns; neither is designed here.

## What the proof claims on this lane

The completeness statement changes, and the change must be stated honestly wherever this lane is
described. For a checkpoint `C` on an importer accumulator, the verifier claims:

> The committed scores are the deterministic result of the pinned parameters over **exactly the
> set of EAS attestations and revocations imported into accumulator `C.accumulator` before the
> checkpoint**, each one authenticated against EAS contract storage at import time, reconciled in
> true attestation-time order.

It does not claim that every attestation existing under the schema was imported. On the resolver
lane, completeness is *enforced-push*: nothing can exist outside the log. On the import lane it
is *permissionless-pull*: an attestation nobody imported is invisible to the score for that
epoch. Soundness is identical on both lanes (no fake edge can ever enter, and the prover still
cannot omit anything that is in the log); what weakens is coverage.

Permissionlessness is the mitigation, and it is a strong one, the same shape as forced inclusion
on rollups: anyone can import their own edge, or anyone else's, at any time, and it lands in the
next checkpoint.

### The sync gap never has to reach a checkpoint

The gap between "exists on EAS" and "imported" is invisible on-chain (a contract has nothing to
compare against) but *exact* off-chain: Ponder already reads EAS `Attested` logs, so the indexer
knows the full pending-uid set at any block. And scores only ever move at checkpoints. Two
mechanisms make the gap costless where currency matters:

- **Epoch-boundary sweep.** Batch-import every pending attestation and revocation just before
  `MerkleSnapshot.trigger()`. Every checkpoint is then complete with respect to what exists on
  EAS at that block, so an imported graph is exactly as current as a native graph at every point
  scores are read. The gap survives only intra-epoch, where no score can observe it.
- **Attest-and-import router.** For attestations made through our own app against an imported
  schema, one multicall does `EAS.attest(...)` (which returns the uid) followed by
  `importer.importAttestations([uid])` atomically. The gap is zero for our-app attestations;
  only foreign frontends rely on the sweep.

The residual failure mode is "sweeper down and nobody imported", which degrades to a visibly
stale as-of date with the permissionless backstop still open. The honest claim therefore
tightens to: **checkpoint-complete whenever the sweep is live; permissionless backstop always.**

### Why enforced completeness for a foreign schema is a no-go

The only way to *prove* that no attestation under a resolver-less schema was omitted is to prove
over the receipts of every block since the schema's registration, because EAS keeps no on-chain
per-schema enumeration (storage is keyed by uid only, so storage proofs establish membership,
never exhaustiveness). For a schema live since 2023 that is millions of blocks of receipt-trie
proving: ZK-coprocessor scale work, the same wall the ERC-8004 deployed-history analysis hit
([`ERC8004_INPUT_COMPLETENESS.md`](./ERC8004_INPUT_COMPLETENESS.md)). Rejected for the same
reasons. The importer's weaker-but-honest claim is the design boundary.

EAS itself confirms there is nothing to borrow. Core storage is uid-keyed only, with no
counter, no per-schema list, and no running commitment; the schema resolver is the only
synchronous attest-time hook, which is exactly what existing schemas lack. EAS's own
`Indexer.sol` is its answer to enumeration, and it is a permissionless pull contract with the
same sync gap by the same necessity — and strictly weaker for our purposes: it records uids
only (no `data`, which the guest needs for weights), tracks no revocations, and its arrays are
consumable only via deep storage proofs of both the Indexer and EAS's `_db`. It validates the
pull pattern without replacing the importer.

## Implementation sketch

Small, and nothing downstream moves:

1. **`AttestationAccumulator`**: add internal `_foldAt` with an explicit timestamp; `_fold`
   delegates to it. Leaf encoding unchanged.
2. **`OnchainAttestationImporter`** (~150 lines): allowlist (one schema uid, set once, same
   admin shape as `ContributionResolver.setSchemas`), `importAttestations` /
   `importRevocations` (/ optionally `importExpirations`), per-uid dedup mapping for each leaf
   kind, zero-recipient skip, index events.
3. **Factory / deploy path**: an instance flavor whose accumulator is an importer instead of a
   resolver; `MerkleSnapshot` wiring is identical.
4. **Indexer**: handlers already match the emitted events; add the importer address to the
   contract config.
5. **Backfill tooling**: enumerate uids from EAS logs off-chain, batch-import, resumable.
   Batches are cheap: each import is one external storage read, one keccak fold, one storage
   write.
6. **Epoch-boundary sweep**: an epoch task that imports every pending attestation and
   revocation before `trigger()`, so checkpoints are complete under a live sweeper.
7. **Attest-and-import router**: the app's create-attestation path on importer instances
   submits one multicall (attest, then import the returned uid), closing the gap for our-app
   attestations entirely.
8. **Guest, prover, golden vectors: no changes.** The one encoding-adjacent change (`_foldAt`)
   preserves leaf bytes exactly.

## Open questions

1. **Expiration policy for v1:** skip expiring attestations at import, or ship
   `importExpirations` from the start?
2. **Foreign-schema weight semantics:** is uniform `min_weight` the right default reading of an
   arbitrary attestation, and should the instance-creation flow expose `weight_field_index`
   when the chosen schema has a plausible numeric field?
3. **Mixed instances:** should a community be able to run a native resolver schema *and* an
   imported legacy schema in one graph from day one (forcing the multi-lane question now), or is
   import-only-instance plus native-only-instance composition enough for v1?
4. **Auto-import duty:** does the platform's indexer import new attestations for every
   importer instance as a courtesy, or is keeping the log current explicitly the community's
   job? (Either is safe; this is a liveness/UX ownership question.)
