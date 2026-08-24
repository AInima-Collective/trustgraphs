# Nostr workspace witness operations

> Internal operations guide. This page is not part of the public product documentation.

The `nostr-witness` command is the boundary between privileged Buzz collection and offline SP1
work. Build it only on collection/relayer hosts:

```sh
cd zk/prover
cargo build --release --features witness-nostr
```

The default prover has no database, HTTP, PostgreSQL, or transaction-signing surface. Once
`assemble` has written `input.json`, `nostr-workspace execute|prove` require no relay, RPC, archive
credential, database credential, or anchoring key.

## Pinned pilot profile

- Buzz base: `a362fecc2389955f942c9581bdfeba379ab115b3`
- compatibility patch SHA-256:
  `3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62`
- live migration-profile SHA-256:
  `1dc946eded958dbefd7174f840c37ea1bbe89e75b492ed58f29424378eebadd9`
- archive policy: `member-scoped`
- node kinds: `2 = did:nostr`, `3 = buzz:community`
- envelope kind: `2`

`inspect` rejects a different source SHA, patch, migration sequence, params community/domain, or
NIP-11 `self` key. In live mode it samples `self` before and after a read-only PostgreSQL
`REPEATABLE READ` transaction. Every `EventCreated` row must resolve to a signed event row, every
ordinary persistent event must have an audit row, and the only direct exceptions are the
source-proven roster/generated kinds 13534, 40099, and 44100. This makes an audit worker write
failure or undrained queue a hard operational failure, not a guest skip.

## 1. Inspect without writing

Fixture/profile inspection:

```sh
zk/prover/target/release/trustgraph-prover nostr-witness inspect \
  --source tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/source-corpus.json \
  --params tests/fixtures/nostr/params.json
```

Live inspection takes the credential by environment-variable **name**, so neither the URL nor its
password enters argv or logs:

```sh
export BUZZ_WITNESS_DATABASE_URL='postgresql://...'
zk/prover/target/release/trustgraph-prover nostr-witness inspect \
  --database-url-env BUZZ_WITNESS_DATABASE_URL \
  --community 01915f7a-6b4c-7d2e-8f10-112233445566 \
  --relay-url https://relay.example \
  --params /secure/nostr-params.json
```

The command verifies source/schema, relay key, audit availability and continuity, worker coverage,
database row coverage, NIP-01 signatures, canonical TGNW, the production envelope verifier, and
configured size/signature/PGU caps. It writes no archive and no anchor.

## 2. Export an immutable archive

```sh
prover=zk/prover/target/release/trustgraph-prover
archive=/secure/member-scoped/nostr-witness

$prover nostr-witness export \
  --database-url-env BUZZ_WITNESS_DATABASE_URL \
  --community 01915f7a-6b4c-7d2e-8f10-112233445566 \
  --relay-url https://relay.example \
  --params /secure/nostr-params.json \
  --variant buzz-audit --archive-dir "$archive" --access member-scoped
```

Option C uses the ordered `entryEventIds` and signed `headEventId` in a recovery source document:

```sh
$prover nostr-witness export \
  --source /secure/self-log-recovery.json \
  --params /secure/nostr-params.json \
  --variant self-log --authority 462779ad...55b0b \
  --archive-dir "$archive" --access member-scoped
```

The exporter independently rebuilds

```text
h_0 = sha256("trustgraphs.nostr.self-log.genesis.v1" || domain || author)
h_i = sha256("trustgraphs.nostr.self-log.entry.v1" || domain || author
             || i_u64_be || h_(i-1) || event_id_i)
```

and requires the supplied kind-36384 event to sign the exact resulting head/count. The head event
is never an entry. This is the recovery story: retain the ordered signed events plus published
signed head event; any authorized exporter reproduces the same TGNW without the author's secret.

Archives are keyed exactly as:

```text
<archive>/<community UUID>/<count>/<head hex>/
  bundle.tgnw
  manifest.json
```

The redacted public manifest contains only hashes/CID, counts, byte and work totals, source/schema/
params versions, event IDs, provenance variant, and access policy. It contains no PostgreSQL URL,
relay credential, signer key, or scoped event content. `eventIds` deliberately exposes A/C overlap;
only production core consensus resolves duplicates.

Access policies mean:

- `public`: bundle may be fetched without membership;
- `member-scoped`: pilot default; storage authorization follows workspace membership;
- `private-operator`: only collection/prover operators receive bundle bytes.

The repository records the policy but does not implement a storage provider's ACL. Configure and
audit that ACL separately. Manifest hashes remain safe to publish for all three policies.

Creation uses exclusive files. Re-export at an existing key is an idempotent success only when
both bundle and manifest bytes are identical. Repair/republish must first re-run verification and
restore those same bytes. A changed digest necessarily changes `dataCommitment` and cannot repair
an already anchored preimage.

## 3. Anchor a verified manifest

```sh
export TRUSTGRAPH_ANCHOR_KEY='0x...'
$prover nostr-witness anchor \
  --manifest "$archive/<community>/<count>/<head>/manifest.json" \
  --params /secure/nostr-params.json \
  --rpc https://ethereum-rpc.example \
  --registry 0x... \
  --private-key-env TRUSTGRAPH_ANCHOR_KEY
unset TRUSTGRAPH_ANCHOR_KEY
```

Before signing, `anchor` rehashes and production-verifies the archive, checks params and chain ID,
registration, exact node kind, `ANCHORER_ROLE`, last count, snapshot binding, and live combined
capacity. It simulates the exact `anchor(nodeId, 2, head, count, dataCommitment, "")` call, then
locally signs an EIP-155 transaction. It never derives `count` from chain state. A newer on-chain
count is stale failure; an equal count is an idempotent no-op only if the historical event has the
same complete preimage.

## 4. Assemble once, prove offline

After `MerkleSnapshot.trigger()` freezes a checkpoint:

```sh
$prover nostr-witness assemble \
  --rpc https://ethereum-rpc.example \
  --snapshot 0x... --checkpoint 7 --from-block 0 \
  --params /secure/nostr-params.json \
  --manifest /secure/a/manifest.json \
  --manifest /secure/c/manifest.json \
  --recipient 0x... --out /secure/checkpoint-7-input.json
```

Assembly reads the snapshot's own registry and empty-lane checkpoint, reconstructs every
`HeadAnchored` event through the checkpoint block, requires contiguous fold indices, and re-folds
to the frozen `(anchorAcc, anchorCount)`. Every selected immutable archive must appear in that
complete log. It validates the checkpoint-pinned params and runs full native production compute
before writing. The sidecar receipt records archive commitments and A/C duplicate IDs.

Now remove credentials/network access:

```sh
env -u BUZZ_WITNESS_DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
  $prover nostr-workspace execute /secure/checkpoint-7-input.json

env -u BUZZ_WITNESS_DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
  $prover nostr-workspace prove /secure/checkpoint-7-input.json --groth16
```

Use CPU/network proving according to the normal prover runbook; neither needs Buzz or anchor
credentials. `--groth16` is required when an on-chain seal artifact is wanted. Core proofs verify
locally but have no SP1 on-chain encoding.

## Failure posture and smoke test

All of these stop before an anchor or proof transaction: audit gaps, missing audited objects,
undeclared direct rows, stale relay key, partial snapshot, wrong migration profile, malformed or
altered archive, hard/pilot cap excess, stale/equal-but-different counts, missing database or signer
credential, missing role/registration, wrong node kind, exhausted capacity, failed simulation,
incomplete checkpoint logs, mismatched params, and unanchored selected bundles.

The end-to-end local test starts a disposable Anvil, deploys and reciprocally binds the real
contracts, exports twice, byte-compares both TGNWs and both GuestInputs, proves anchor idempotence,
and runs credential-free execute plus mock Groth16 prove:

```sh
scripts/nostr-witness-anvil-smoke.sh
```

The two-checkpoint production-surface rehearsal additionally publishes the score blobs, submits
both proofs, checks proving/publication/submission restart behavior, rejects a proof replayed into a
twin snapshot with identical inputs, and captures the latest authenticated source provenance:

```sh
task zk:nostr-workspace-e2e
```

For a source document containing historical and current self-log recovery records for one
authority, `export --authority` chooses the uniquely defined greatest signed count. Conflicting
records at that maximum count fail closed as equivocation; source order never chooses the head.
