# Strict EAS off-chain testnet runbook

> Internal operations guide. This page is not part of the public product documentation.

Status: implementation and local adversarial acceptance are available; the credentialed testnet
rollout, 14-day soak, and independent review are not complete. This lane is opt-in and testnet-only.
Mainnet must remain disabled until a later recorded decision consumes a passing rollout report.

The supported feature is deliberately narrow: public EAS off-chain v2 attestations from Ethereum
EOAs, the instance's canonical vouch schema, zero expiration and `refUID`, a nonzero salt, and
in-log revocation. It is gasless for the member, not private or erasable. Canonical
`EAS.revokeOffchain` is not consumed by this lane.

The wire format and statement are frozen in
[`research/EAS_OFFCHAIN_SUPPORT.md`](../../../research/EAS_OFFCHAIN_SUPPORT.md). The operator must
never edit payloads, select an older head, or omit an unavailable node. A missing newest payload
holds the checkpoint; it does not produce a degraded root.

## Required topology

Before creating a hybrid instance, prepare:

- a supported testnet EAS deployment, the new factory/deployers, a real `SP1JournalVerifier`, and
  the canonical SP1 verifier gateway;
- two relays with different `ANCHORER_ROLE` EOAs, separate secret custody, separate failure domains,
  and only enough native currency to anchor;
- at least two durable raw-CID stores per relay with a write-and-exact-read quorum of two, plus two
  independent public/operator readers and encrypted repository backups;
- finalized/failover RPCs, an indexer with `EAS_OFFCHAIN_GATEWAYS`, a strict-capable operator, and
  alert delivery for relay errors, CID failures, inclusion lag, cap utilization, held proofs, and
  root mismatches; expose the operator's public heartbeat file through a bounded internal HTTPS
  endpoint for deployment audit, without exposing its config file or credentials; and
- an instance-admin Safe or equivalent governed authority. Relayers get `ANCHORER_ROLE`, never
  `DEFAULT_ADMIN_ROLE`.

Do not reuse keys, Kubo repositories, credentials, host volumes, or a single provider account and
call them independent. Record provider/account/region ownership privately; the public report needs
only a redacted assertion and evidence digest.

## Freeze and dark deploy

1. Record the git commit, SP1 version `6.6.0`, guest ELF SHA-256, locally derived program vkey,
   chain ID, EAS address/version, canonical gateway, factory/deployer addresses, source-verification
   links, operator image digest, relay image digests, and configuration digests. Never identify code
   by a mutable image tag or branch name.
2. Deploy and explorer-verify the real verifier and factories. Verify the verifier's immutable
   `gateway()` and `programVKey()` before creating an instance.
3. Create the instance only through `createHybridInstance` (or its governed hybrid entry point),
   with two distinct relayer addresses and the reviewed immutable cap. Leave
   `NEXT_PUBLIC_EAS_OFFCHAIN_RELAYER_ADDRESSES` unset in the public frontend so creation remains
   hidden.
4. Configure both relays from [`packages/eas-offchain-relay/.env.example`](../../../packages/eas-offchain-relay/.env.example).
   `STORAGE_QUORUM` is at least two. Configure the indexer's independent readers and the operator's
   envelope-0 readers. Serve only the operator's public heartbeat—not `operator.toml`—at the audit
   URL. Start services without placing RPC, pinning, or signing credentials in logs.
5. Run the read-only audit below. It reconstructs the instance from the directory and factory
   events; rechecks params, EAS, schema, snapshot binding, both domain separators, cap, verifier,
   gateway, vkey, code presence, roles, relay identity/quorum metrics, indexer cap, and a fresh
   operator heartbeat bound to this instance, network Groth16, block-hash finality, and at least two
   exact-read publication/input targets. It also fails unless the non-secret immutable evidence
   references for the operational checks that cannot be inferred from public endpoints are present.

```sh
export TESTNET_RPC_URL=https://secret-rpc.example
export TESTNET_INSTANCE_REGISTRY=0x...
export TESTNET_REGISTRY_FROM_BLOCK=...
export TESTNET_INSTANCE_ID=0x...
export TESTNET_EXPECTED_CHAIN_ID=...
export TESTNET_EXPECTED_ADMIN=0x...
export TESTNET_RELAYER_A=0x...
export TESTNET_RELAYER_B=0x...
export TESTNET_RELAY_URL_A=https://relay-a.example
export TESTNET_RELAY_URL_B=https://relay-b.example
export TESTNET_EXPECTED_VERIFIER=0x...
export TESTNET_EXPECTED_GATEWAY=0x...
export TESTNET_EXPECTED_PROGRAM_VKEY=0x...
export TESTNET_EXPECTED_MAX_TOTAL_INPUTS=...
export TESTNET_INDEXER_API=https://indexer.example
export TESTNET_OPERATOR_STATUS_URL=https://operator-status.example/status.json
export TESTNET_CONFIRMATIONS=...
export TESTNET_DEPLOYMENT_VERIFICATION_EVIDENCE=sha256:...
export TESTNET_RELAYER_CUSTODY_EVIDENCE=sha256:...
export TESTNET_STORAGE_INDEPENDENCE_EVIDENCE=sha256:...
export TESTNET_ALERT_DELIVERY_EVIDENCE=sha256:...
export TESTNET_BACKUP_RESTORE_EVIDENCE=sha256:...
export TESTNET_RECOVERY_EXPORT_EVIDENCE=sha256:...
export TESTNET_FEATURE_HIDDEN_EVIDENCE=sha256:...
scripts/eas-offchain-testnet-audit.sh
```

Each operational reference must be an `ipfs://` or `ar://` content address or contain an explicit
`sha256:` digest. The generated JSON retains these references under `requiredEvidence`; it never
retains secret endpoints or credentials. Deployment verification covers explorer source and
immutable service images. The other records cover independent relayer-key custody,
storage/provider ownership, a delivered alert, a fresh encrypted-backup restore, usable recovery
exports, and proof that the public frontend flag remains hidden. The command does not print PASS
while any of them is absent or mutable.

## Canary and real proof

Use only team-controlled nodes initially. Exercise on-chain vouch → off-chain replacement →
off-chain revoke, then the reverse replacement order and a two-relay race. Confirm both relays
return the same canonical result and all required stores retain every historical raw block.

Trigger a checkpoint only after `envelope0-preflight` succeeds through independent readers. The
scheduled workflow `.github/workflows/eas-offchain-assurance.yml` builds every pinned guest ELF,
derives and compares the vkey, reconstructs the next unproven checkpoint from chain and exact CIDs,
executes locally, requests a real network Groth16 proof, pins the score blob twice with exact
readback, submits it, and compares the applied root. It also reconstructs the newly frozen
`HeadAnchored` transactions, records their receipt gas, emits a standalone checkpoint evidence
record, hashes that record, and places its `sha256:` reference in the report's numeric
`.checkpoint` object. That object can be copied without reinterpretation into the controlled soak
ledger. The workflow also hashes every non-secret report into `evidence-manifest.sha256`. A
scheduled run fails if the checkpoint is not mixed-lane or contains no new lane-2 anchor. Configure
these GitHub values:

| kind                | name                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| repository variable | `EAS_OFFCHAIN_TESTNET_INSTANCE_REGISTRY`                                           |
| repository variable | `EAS_OFFCHAIN_TESTNET_REGISTRY_FROM_BLOCK`                                         |
| repository variable | `EAS_OFFCHAIN_TESTNET_INSTANCE_ID`                                                 |
| repository variable | `EAS_OFFCHAIN_TESTNET_CHAIN_ID`                                                    |
| repository variable | `EAS_OFFCHAIN_TESTNET_ADMIN`                                                       |
| repository variable | `EAS_OFFCHAIN_TESTNET_RELAYER_A`, `EAS_OFFCHAIN_TESTNET_RELAYER_B`                 |
| repository variable | `EAS_OFFCHAIN_TESTNET_RELAY_URL_A`, `EAS_OFFCHAIN_TESTNET_RELAY_URL_B`             |
| repository variable | `EAS_OFFCHAIN_TESTNET_EXPECTED_VERIFIER`                                           |
| repository variable | `EAS_OFFCHAIN_TESTNET_EXPECTED_GATEWAY`                                            |
| repository variable | `EAS_OFFCHAIN_TESTNET_PROGRAM_VKEY`                                                |
| repository variable | `EAS_OFFCHAIN_TESTNET_MAX_TOTAL_INPUTS`                                            |
| repository variable | `EAS_OFFCHAIN_TESTNET_INDEXER_API`                                                 |
| repository variable | `EAS_OFFCHAIN_TESTNET_OPERATOR_STATUS_URL`                                         |
| repository variable | `EAS_OFFCHAIN_TESTNET_CONFIRMATIONS`                                               |
| repository variable | `EAS_OFFCHAIN_TESTNET_DEPLOYMENT_VERIFICATION_EVIDENCE`                            |
| repository variable | `EAS_OFFCHAIN_TESTNET_RELAYER_CUSTODY_EVIDENCE`                                    |
| repository variable | `EAS_OFFCHAIN_TESTNET_STORAGE_INDEPENDENCE_EVIDENCE`                               |
| repository variable | `EAS_OFFCHAIN_TESTNET_ALERT_DELIVERY_EVIDENCE`                                     |
| repository variable | `EAS_OFFCHAIN_TESTNET_BACKUP_RESTORE_EVIDENCE`                                     |
| repository variable | `EAS_OFFCHAIN_TESTNET_RECOVERY_EXPORT_EVIDENCE`                                    |
| repository variable | `EAS_OFFCHAIN_TESTNET_FEATURE_HIDDEN_EVIDENCE`                                     |
| secret              | `EAS_OFFCHAIN_TESTNET_RPC_URL`                                                     |
| secret              | `EAS_OFFCHAIN_TESTNET_SUBMITTER_PRIVATE_KEY`                                       |
| secret              | `EAS_OFFCHAIN_TESTNET_ENVELOPE0_GATEWAYS`                                          |
| secret              | `EAS_OFFCHAIN_TESTNET_SCORE_IPFS_API_A`, `EAS_OFFCHAIN_TESTNET_SCORE_IPFS_API_B`   |
| optional secret     | `EAS_OFFCHAIN_TESTNET_SCORE_IPFS_AUTH_A`, `EAS_OFFCHAIN_TESTNET_SCORE_IPFS_AUTH_B` |
| secret              | `SP1_NETWORK_PRIVATE_KEY`                                                          |

The submitter key and SP1 requester key are different authorities. The report artifact contains no
secret endpoint, credential, payload, or signature material.

`TESTNET_REGISTRY_FROM_BLOCK` is the exact directory deployment block; do not scan a long-lived
chain from genesis. Set `TESTNET_CONFIRMATIONS` from the selected testnet's written finality
policy; the audit requires the operator heartbeat to use that exact value, and the real-proof gate
uses it for checkpoint and receipt finality before comparing the receipt's block hash with the
canonical block at that height.

## Hosted API and product checks

The indexer mounts the strict lane under `/eas-offchain`. Audit these read surfaces against direct
registry calls before canary admission:

| endpoint                                              | required interpretation                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /eas-offchain`                                   | factory-discovered lanes only                                                                         |
| `GET /eas-offchain/:registry/config`                  | EAS/schema/domains/cap and immutable lane provenance                                                  |
| `GET /eas-offchain/:registry/utilization`             | anchor, entry, exact work, cap, and validation-failure counters                                       |
| `GET /eas-offchain/:registry/nodes`                   | newest canonical head and verification state per node                                                 |
| `GET /eas-offchain/:registry/nodes/:nodeId/history`   | complete anchored history, never a reconstructed older fallback                                       |
| `GET /eas-offchain/:registry/nodes/:nodeId/mutations` | independently verified active set plus the complete ordered `logEntries` mutation/tombstone audit log |
| `GET /eas-offchain/:registry/cids/:commitment`        | deterministic raw CID and reader observations                                                         |

Relay `/healthz` is process liveness; `/metrics` carries quorum/work/inclusion observations. Neither
endpoint proves storage independence, so retain the topology and loss-drill evidence separately.
The app enables hybrid creation only when it has 2–16 distinct
`NEXT_PUBLIC_EAS_OFFCHAIN_RELAYER_ADDRESSES`; the configured relay URLs and readers must describe
the same reviewed testnet cohort. With those variables unset, lane-1 creation, vouching, revocation,
APIs, and scoring remain the existing path and no off-chain machinery is required.

The hosted browser acceptance is: create a named opt-in hybrid through the standard wizard, make an
unchanged wallet-paid on-chain vouch, replace it gaslessly with typed signatures only, observe both
provenance kinds and CID/relay health, revoke gaslessly in-log, and see both later proven roots.
Conflict recovery must reload the canonical head and reapply the unsigned draft. Preserve
screenshots/interaction logs for the unchanged on-chain path. Signer-sync and contributions actions
must show their explicit hybrid-unsupported explanation; weighted creation remains lane-1-only.

The pull-request acceptance job runs this flow with `EAS_OFFCHAIN_E2E_INDEXER=1`,
`EAS_OFFCHAIN_E2E_BROWSER=1`, pinned Chromium, and a fresh Postgres service. It temporarily supplies
Ponder only the just-deployed base/governed factories and directory, regenerates the live Wagmi
addresses, and redirects a production Next build to those local services. It restores the prior
deployment summary, frontend config, and generated contract files on exit. The seed fixture is
submitted at strict work 10; the app-created instance is submitted at work 5 and 10. The wizard
creation and parity vouch each produce exactly one expected wallet transaction. The strict create
and revoke produce respectively two and one typed-signature requests and zero member
`eth_sendTransaction` calls. The browser independently re-fetches and verifies exact CIDs, requires
its root to equal the published root, and ends with the normal graph/API showing no resurrected
vouch after the newest in-log revoke.

## Soak ledger and stop rules

Copy the schema-v3 `rollout-evidence.example.json` into the
controlled rollout record. Replace its example topology with every deployed relay, storage target,
public/operator reader, primary RPC, indexer, and prover, then append one immutable evidence
reference per topology entry, checkpoint, and drill. Component IDs are stable ledger labels, not
credentials or secret URLs.
Validate it with:

```sh
scripts/eas-offchain-soak-check.mjs /secure/evidence/eas-offchain-rollout.json
```

An immutable reference is an `ipfs://` or `ar://` content address, or a reference containing an
explicit `sha256:<64-hex-digest>` token. A mutable dashboard, ticket, workflow run, or “latest”
artifact URL without a digest is not evidence for this gate.

The checker requires 14 complete elapsed days ending no later than the present, 20 distinct,
chronologically increasing applied checkpoint records, and all observations/drills inside that
window. Each checkpoint records a unique submission transaction, raw SHA-256 CID, cycles, proof
latency, new-anchor gas, submission gas, exact bundle bytes, `lane1Leaves`, `lane2Anchors`,
`lane2Work`, `workCount = lane1Leaves + lane2Work`, and an immutable evidence digest. Every
record must carry lane 2 and at least one real SP1 network Groth16 record must contain both lanes.
The scheduled real-proof artifact emits this exact object at `.checkpoint`; verify its digest
against the adjacent standalone checkpoint file and the artifact manifest before appending it.

The ledger derives required loss-drill keys from that declared topology: `relay-loss:<id>`,
`storage-loss:<id>`, and `reader-loss:<id>` for every entry, plus the named RPC, indexer, and prover
loss drills. Every relay must declare at least two storage targets. It also requires total-reader
loss/hold, corrupt-reader recovery, conflict recovery, re-pin, fresh backup restore, and relayer-key
rotation drills. Each drill records alert delivery, preserved proof/root safety, completed recovery,
and a checkpoint produced after recovery; type-specific fields prove the expected failover rather
than only process restart.

The ledger also requires exactly one measured sample set in bands 1 (`1..1,000` work), 2
(`1,001..20,000`), and 3 (`20,001..200,000`), zero lost anchored bundles/root
mismatches/unresolved incidents, and a clean independent-review disposition. Each band records
`sampleCount`, `observedAt`, `workCount`, cycles, proof seconds/cost, bundle bytes,
anchor/submission gas, failure basis points, cap-utilization basis points, and an immutable evidence
reference. The gate contracts are regression-tested by
`tests/e2e/eas-offchain-dark-audit.test.mjs` and
`tests/e2e/eas-offchain-rollout-gates.test.mjs`.

Stop admitting new users and hold proof submission on any unexplained params/domain/vkey mismatch,
unrecoverable newest payload, root mismatch, cap/accounting disagreement, equivocation, suspected
key compromise, secret in logs, or unresolved high/critical finding. Do not “fix” a checkpoint by
dropping input or editing bytes.

## Failure and recovery drills

Run one failure at a time and keep alert, timeline, exact recovery, and post-recovery proof evidence.

| failure                  | expected behavior and recovery                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| each relay unavailable   | Wallet retries another admitted relay; the same signed bundle lands once. Restore the failed relay from configuration and confirm it returns canonical idempotent success.             |
| each store unavailable   | A relay may succeed only if its configured exact-read quorum still has at least two targets. Restore/re-pin the exact raw block before returning the store to service.                 |
| each reader unavailable  | Remaining readers reconstruct the exact canonical input. Restore and verify the failed reader before returning it to the admitted set.                                                 |
| all readers unavailable  | Preflight/export/proving stops with `E0_AVAILABILITY`; no proof is requested or submitted. Restore a byte-exact historical reader, then reconstruct the same input.                    |
| corrupt cache/gateway    | Digest/CID verification rejects it and tries another reader. Quarantine the corrupt copy and overwrite only with the exact bytes from a healthy holder.                                |
| primary RPC unavailable  | Relay/operator/indexer fail over to a separately operated RPC and re-read finalized state. No locally assumed count/head is authoritative.                                             |
| indexer unavailable      | On-chain ingress can continue within policy, but UI health/provenance is degraded. Replay from factory and registry events; independently revalidate every CID before publishing rows. |
| prover interrupted       | Preserve the exact input and request journal. Retry the byte-identical checkpoint; never regenerate with fewer nodes.                                                                  |
| same-count/fork conflict | Return `409`, reload the canonical head, and explicitly reapply the user's unsigned draft operations before asking for new signatures. Never overwrite or decrement the registry.      |
| storage re-pin           | Fetch the raw CID from a surviving holder, recompute SHA-256/CID, `block/put` to the replacement, and `block/get` compare byte-for-byte. The on-chain head is unchanged.               |
| backup restore           | Restore the complete pin inventory into a fresh repository, recompute every CID, and reproduce a historical checkpoint from that repository.                                           |
| relayer key rotation     | Grant the new key, deploy and validate the replacement relay, verify at least two live distinct relayers, then revoke the old role. Investigate all anchors during the overlap.        |

Backups must include every historical raw block and a pin inventory. A restore drill uses a fresh
repository, restores blocks, recomputes every CID, and proves an older checkpoint from that reader.
Deleting or garbage-collecting a historical bundle is not an accepted retention policy.

## Metrics by band

For each band retain cycle/PGU count, network proof latency and charged cost, payload bytes and entry
growth, anchor gas, relay validation/inclusion failures, reader latency/error rate, and
`workCount / maxTotalInputs`. Use the checkpointed work value, not raw anchor count. Any semantic,
wire-format, or safety-bound change returns to protocol freeze and explicitly rotates the vkey; a
soak is not permission to tune consensus in place.
