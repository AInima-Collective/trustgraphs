# Run a prover (advanced)

> Internal operations reference retained from the original public guide.

Anyone can run the proving daemon this page documents. That is the point of the design: scores stay fresh without a trusted middleman, because `submitProof` is permissionless and the contract accepts nothing but a correct proof. If you created your network through the factory you do not need this page, since factory-minted instances are discovered on-chain and picked up automatically by whoever runs a daemon (see [`create-a-network.md`](./create-a-network.md)); running your own prover is for operators, self-hosters, and anyone who wants zero dependence on us.

Proven scores go stale unless somebody freezes a checkpoint, proves it, and lands it, once per
epoch, forever. This document is about the thing that does that without a human in the loop.

Three ways a network's scores stay fresh, and you should pick one deliberately:

|                | who proves | what it costs you      | what you depend on                                 |
| -------------- | ---------- | ---------------------- | -------------------------------------------------- |
| **Self-prove** | you        | your own gas + proving | nothing. Permissionless, documented, free forever  |
| **Curated**    | us         | nothing                | our goodwill and our uptime                        |
| **Funded**     | anyone     | whatever you top up    | a public bounty, and whoever chooses to collect it |

There is no fourth tier where everybody gets proven for free. A permissionless factory plus an
unconditional free tier is an unbounded liability: an attacker pays roughly one attestation of gas
per epoch to make somebody else pay for a ~600k-gas submit. So the promise is "every **eligible**
instance", and this page says which ones those are rather than implying it covers everyone.

> **Status.** The decision engine (`crates/operator-core`), the daemon that drives it
> (`zk/operator`), and the proving vault it draws from are built. The local demo exercises both a
> vault-funded trust-graph root and a curated contributions root. `task demo` is a finite run;
> `task demo:live` leaves the daemon watching for later attestations.

---

## 1. What the daemon actually does

Once per tick, per instance:

```
  read chain  ──►  decide  ──►  act
                     │
                     ├─ nothing new since the last root ......... Idle       (free)
                     ├─ epoch boundary not reached yet .......... Idle       (free)
                     ├─ boundary passed, no checkpoint yet ...... Trigger
                     ├─ checkpoint not confirmed yet ............ AwaitFinality
                     ├─ checkpoint ready, not proved ............ Prove
                     ├─ proof in hand ........................... Submit
                     └─ something is off ........................ Hold + alert
```

Everything that can be _wrong_ — when to trigger, which checkpoint to prove, when to hold, when to
claim — lives in `crates/operator-core`, a plain crate in the root workspace that CI tests
against a fake chain. Only the thin sp1-sdk adapter lives in the detached `zk/` workspace. If you
are reading the code to answer "would it have paid twice here?", read `operator-core`.

Two rules shape the rest of the design:

- **Only the newest unproven checkpoint is ever proved.** `submitProof` is monotonic, so
  intermediates can be skipped forever. Spamming `trigger()` costs the spammer gas and the
  operator nothing.
- **Preventable spend is prevented; unpreventable spend is budgeted.** A params mismatch, a
  pending verifier rotation, an unfinalized checkpoint, an empty vault, an oversized instance:
  each is a hold or a skip _before_ the proof request. But a creator-admin can rotate config one
  block after any preflight, so some waste is not preventable. That is what the loss budgets are
  for: the operator halts an instance rather than bleeding on it.

---

## 2. Configuration

One TOML (or JSON) file. `rpc` is always required. `registry` is required unless a finalized public
`release_manifest` supplies it; anything not listed is not configurable.

```toml
# ── chain ───────────────────────────────────────────────────────────────────
rpc      = "https://…"          # required. JSON-RPC endpoint
registry = "0x…"                # required. InstanceRegistry address
chain_id = 1                    # optional; checked against eth_chainId at startup, never trusted over it
registry_from_block = 21000000  # the block `registry` was deployed at. SET THIS on any real chain.

# Sepolia alternative: omit registry/chain_id/registry_from_block and resolve them from the
# sanitized tracked release record. Relative paths are resolved from this TOML. Explicit values
# are allowed only when they exactly match the manifest; RPC credentials never come from JSON.
# release_manifest = "../../deployments/sepolia.json"

# ── which instances ─────────────────────────────────────────────────────────
# Factory-minted trust-graph instances and their optional governed signer modules need ZERO
# per-instance config. The daemon reconstructs the score instance from the registry/creation
# receipt, then derives signer work from SignerSyncModuleConfigured in that same receipt. New
# typed-controller Contributions rounds are registry-described too.
# `trust-graph-weighted` instances are likewise registry-described. Their exact TGWP bytes are
# recovered under the separate bounded policy below; they never use a hand-written manifest row.
#
# Legacy deployments still need a manifest entry when the chain does not describe them:
#   - old contributions instances predate their registry/controller publication
#   - hypercerts registers an opaque paramsHash with no params-bearing event
#   - old SignerSyncZkModule deployments have no factory helper event
# Say so plainly rather than implying the chain describes everything.

[[manifest]]
program      = "contributions"
snapshot     = "0x…"            # the contributions MerkleSnapshot
params       = "./params.contributions.json"
eas          = "0x…"
from_block   = 0                # first block to scan for this instance's logs
# submit_to defaults to `snapshot`
# depends_on = ["0x…"]          # instance ids that must have a fresh root first

[[manifest]]
program      = "signer"         # the config name; the registry's program-id string is "signer-sync"
snapshot     = "0x…"            # LEGACY ONLY: governed-factory modules need no entry
submit_to    = "0x…"            # SignerSyncZkModule — the one entry where these differ
params       = "./params.json"  # the trust instance's params; the signer reuses them
selection    = "./selection.json"
eas          = "0x…"

# ── who we prove for ────────────────────────────────────────────────────────
[curated]
# Proven on us, via plain submitProof, never drawing a vault. This list IS the free tier.
instances = ["0x…", "0x…"]

[paid]
# Every non-curated instance is proven only when its vault covers the quote, via submitAndClaim.
enabled   = true
vault     = "0x…"               # ProvingVault
recipient = "0x…"               # our payee; goes in the journal, so it cannot be sniped

# ── cadence ─────────────────────────────────────────────────────────────────
[cadence]
tick_seconds        = 60        # how often the loop wakes
subsidy_min_blocks  = 216_000   # ~1 month: how often we will pay for a CURATED instance.
                                # Distinct from the factory's creation floor (anti-spam) and from
                                # the vault's minPaidIntervalBlocks (the only enforceable one).
max_concurrent      = 4         # global in-flight proofs
max_per_instance    = 1         # in-flight proofs per instance. Do not raise this.

# ── gas ─────────────────────────────────────────────────────────────────────
[gas]
max_basefee_gwei    = 40        # above this, hold. A root that lands six hours late still files
                                # at its input-freeze block, so waiting costs correctness nothing.
priority_fee_gwei   = 0.1
replacement_after_s = 300       # a tx with no receipt after this long is re-signed at the SAME
                                # nonce with fees bumped ≥12.5%, up to twice (audit M-11)
simulate_before_send = true     # eth_call AT THE INTENDED GAS LIMIT first; a revert is a hold,
                                # not a broadcast. The limit itself comes from eth_estimateGas
                                # plus 25% margin, refused above the per-call cap

# ── finality ────────────────────────────────────────────────────────────────
[finality]
confirmations = 12              # a reorg must not erase a checkpoint we already paid to prove
track_block_hash = true

# ── proving ─────────────────────────────────────────────────────────────────
[prover]
backend      = "network"        # network | cpu | mock
groth16      = true
timeout_s    = 3_600
cycle_limit  = 8_000_000_000    # operator-local; independent of vault pricing and every vkey

# Profile v2 defaults come from the largest published calibrated graph row (1,800 raw/live
# records). The cheap pre-download gate needs the conservative 2*raw+seeds node allowance.
# Override any field for a differently provisioned host; omitted fields keep these defaults.
[prover.capability_profile]
max_raw_records      = 1_800
max_live_edges       = 1_800
max_unique_nodes     = 3_600
max_out_degree       = 1_800
max_witness_bytes    = 134_217_728 # independent 128 MiB memory-safety ceiling; matrix does not
                                   # establish a witness-byte maximum
max_lane2_anchors    = 1_800
max_signature_checks = 1_800
max_iterations       = 100

# ── loss budgets ────────────────────────────────────────────────────────────
# Unpreventable spend is real. When one of these is exceeded the instance is HALTED and alerted,
# not retried.
[budget]
per_instance_usd_per_day = 25
global_usd_per_day       = 250
cents_per_billion_cycles = 100   # what turns a cycle estimate into the budget's units
window_seconds           = 86400 # the rolling window the caps are measured over
eth_usd                  = 5000  # crude ETH/USD used to book on-chain gas burn (landed OR
                                 # reverted) into the same rolling budget — a stop-the-runaway
                                 # constant, not a price feed (audit H-3)

# ── score-selected Safe signer work ─────────────────────────────────────────
# Signer proofs follow score checkpoints only after the score root has landed. They never draw a
# vault, never publish an IPFS score blob, and use a separate operator id/spend namespace.
[signer_sync]
enabled                      = true
confirmations                = 24
track_block_hash             = true
per_instance_usd_per_day     = 5
global_usd_per_day           = 50
budget_window_seconds        = 86400

# ── publishing the scores ───────────────────────────────────────────────────
# The chain carries the ROOT, the sha256 and the CID. It does not carry the scores. Everything
# that renders a member list fetches the blob by CID, so a daemon that proves and submits without
# publishing produces roots that are correct, verifiable, and unreadable.
[ipfs]
min_success = 2                  # submit is blocked until this many targets add and serve the
                                 # exact canonical bytes
retry_seconds = 300              # failed work is journaled and survives restart

[[ipfs.targets]]
name = "primary"
api = "http://127.0.0.1:5001"    # kubo-compatible /api/v0/add endpoint
gateway = "http://127.0.0.1:8080/ipfs/"

[[ipfs.targets]]
name = "backup"
api = "https://kubo-api.backup.example"
gateway = "https://gateway.backup.example/ipfs/"

# ── weighted-prior input availability ──────────────────────────────────────
# These are checkpoint INPUT bytes, separate from the score blobs above. Recovery order is local
# cache, each raw-CID mirror, then the creation/proposal transaction input from the configured RPC.
# `cache_dir` defaults inside `[ops] state_dir`; name it only to put it somewhere else.
[weighted_manifests]
mirrors = [
  "https://gateway.primary.example/ipfs/",
  "https://gateway.backup.example/ipfs/",
]
max_versions = 128               # bounded across instances; must hold at least active + pending
max_bytes = 16777216             # must hold two constitutional max-size TGWP manifests
retry_seconds = 300              # degraded mirrors are retried and alerted on this cadence

# ── operations ──────────────────────────────────────────────────────────────
[ops]
# ONE directory holds everything the daemon owns: the request journal, the heartbeat, the
# per-checkpoint working files, and both recovery caches. Mount a volume here. Every relative path
# in this file — including this one — resolves against the CONFIG FILE, never against whatever
# directory the daemon was started from.
#
# The daemon creates this directory but not the tree above it. An absolute path whose parent is
# missing is what an unmounted volume looks like, and creating it anyway would put journal.jsonl
# on a filesystem that disappears at the next deploy.
state_dir    = "/data"

# Prebuilt reconstruction binaries (input-exporter, envelope0-preflight, trustgraph-prover).
# Unset means: look next to the operator executable, then fall back to `cargo run` from a source
# checkout. The published image needs neither key — its tools sit beside the daemon.
# tool_dir   = "/usr/local/bin"

# Read-only health and heartbeat listener. Off unless set. Three GET routes and nothing else:
# /health (the process is up), /ready (it is doing its job), /status (the sanitized heartbeat).
listen              = "0.0.0.0:8080"
ready_after_seconds = 180        # how stale a COMPLETED tick may be before /ready fails. Long
                                 # work — proving, a receipt watch, a reconstruction — is judged
                                 # against its own limit instead, so a proof in progress does not
                                 # read as a wedge.

alert_webhook = "https://…"
log_format   = "text"            # timestamped, levelled, colorized on an interactive terminal
submit_failure_threshold = 3    # estimate/simulation/mined execution reverts for one immutable
                                # checkpoint before it is abandoned and the planner advances.
                                # Provider, fee, timeout, availability, and reorg failures do
                                # not consume attempts.
```

Only `journal_path` and `status_path` remain as separate keys, and only to keep deployed configs
that set them working. A fresh config should not: they default to `journal.jsonl` and `status.json`
inside `state_dir`, which is the arrangement a backup and a volume mount both want.

### Keys

| key                                              | meaning                                                                                 | default                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `rpc`                                            | JSON-RPC endpoint; must be an absolute `http(s)://` URL                                 | required                                       |
| `rpc_timeout_seconds`                            | budget for one chain read; a provider that never answers must not stop the daemon       | 30                                             |
| `release_manifest`                               | sanitized finalized public release JSON; supplies and checks chain/registry coordinates | unset                                          |
| `registry`                                       | `InstanceRegistry` address                                                              | required unless supplied by `release_manifest` |
| `chain_id`                                       | expected chain; startup aborts on mismatch                                              | read from chain                                |
| `registry_from_block`                            | where the `InstanceRegistered` scan starts                                              | 0 (alerts on any chain but 31337)              |
| `manifest[]`                                     | instances the chain cannot describe                                                     | empty                                          |
| `curated.instances`                              | proven on us, no vault                                                                  | empty                                          |
| `paid.enabled` / `paid.vault` / `paid.recipient` | the funded path                                                                         | off                                            |
| `cadence.tick_seconds`                           | loop period                                                                             | 60                                             |
| `cadence.subsidy_min_blocks`                     | our cadence for curated instances                                                       | 216000                                         |
| `cadence.max_concurrent` / `max_per_instance`    | concurrency caps                                                                        | 4 / 1                                          |
| `gas.max_basefee_gwei`                           | basefee gate                                                                            | 40                                             |
| `gas.replacement_after_s`                        | stuck-tx bump                                                                           | 300                                            |
| `finality.confirmations`                         | before spending on a checkpoint                                                         | 12                                             |
| `prover.backend`                                 | `network` \| `cpu` \| `mock`                                                            | `network`                                      |
| `prover.cycle_limit`                             | local estimated-cycle refusal; not a protocol/vkey limit                                | 8000000000                                     |
| `prover.capability_profile.*`                    | versioned local work-shape limits; partial overrides allowed                            | profile v2 below                               |
| `budget.*_usd_per_day`                           | halt thresholds                                                                         | 25 / 250                                       |
| `budget.cents_per_billion_cycles`                | price used to cost a proof                                                              | 100                                            |
| `budget.window_seconds`                          | rolling window for both caps                                                            | 86400                                          |
| `budget.eth_usd`                                 | crude ETH/USD for booking gas into the budget (H-3)                                     | 5000                                           |
| `signer_sync.enabled`                            | schedule factory-discovered signer modules                                              | true                                           |
| `signer_sync.confirmations` / `track_block_hash` | signer-specific finality before proving                                                 | 24 / true                                      |
| `signer_sync.*_usd_per_day`                      | signer-only halt thresholds, isolated from root spend                                   | 5 / 50                                         |
| `signer_sync.budget_window_seconds`              | rolling signer budget window                                                            | 86400                                          |
| `ipfs.targets[]`                                 | named independent kubo-compatible add API + reader gateway pairs                        | empty (nothing published)                      |
| `ipfs.min_success`                               | targets that must add and serve the exact bytes before submit                           | all configured targets                         |
| `ipfs.retry_seconds`                             | durable failed-publication retry cadence                                                | 300                                            |
| `ipfs.api` / `ipfs.gateway`                      | legacy single target; both required, cannot mix with `targets`                          | unset                                          |
| `weighted_manifests.cache_dir`                   | durable exact-byte TGWP cache                                                           | `weighted-manifests` inside `state_dir`        |
| `weighted_manifests.mirrors[]`                   | raw-CID readers tried before archival calldata                                          | empty                                          |
| `weighted_manifests.max_versions` / `max_bytes`  | deterministic cache ceilings                                                            | 128 / 16 MiB                                   |
| `weighted_manifests.retry_seconds`               | retry/alert cadence for degraded mirrors                                                | 300                                            |
| `ops.state_dir`                                  | the one directory the daemon owns; relative paths resolve against the config file        | `.trustgraph/operator` beside the config       |
| `ops.tool_dir`                                   | prebuilt reconstruction binaries; unset falls back to the executable's directory, then `cargo run` | unset                              |
| `ops.listen`                                     | `host:port` for the read-only health listener                                            | unset (no socket)                              |
| `ops.ready_after_seconds`                        | how stale a completed tick may be before `/ready` fails                                  | `max(3 × tick_seconds, 90)`                    |
| `ops.journal_path` / `ops.status_path`           | override the defaults inside `state_dir`                                                 | inside `state_dir`                             |
| `ops.log_format`                                  | human `text` output or collector-friendly JSON lines                                     | `text`                                         |
| `ops.submit_failure_threshold`                   | deterministic submit reverts before advancing past a checkpoint                         | 3                                              |
| `ops.*`                                          | journal, heartbeat, alerts, logging                                                     | see above                                      |

`text` logs carry an RFC 3339 timestamp and a conventional level: healthy progress is green
`INFO`, alertable holds/skips are yellow `WARN`, and failures are red `ERROR`. ANSI colors are
enabled only when stdout is an interactive terminal and can always be disabled with `NO_COLOR`.
Set `log_format = "json"` for ingestion or the log-oriented `jq` commands below; JSON records keep
the event fields and add `timestamp` and `level`.

### Host capability and cost admission

The daemon uses two gates before it puts proving money at risk. The cheap gate uses authenticated
checkpoint counts, program parameters, and conservative bounds (`live_edges <= raw_records`,
`unique_nodes <= 2 * raw_records + seeds`) with the configured `max_iterations`. After it has
reconstructed and natively executed the exact input, the prepared-input gate checks the real graph
shape, witness bytes, signature calls, and `iterations_run` immediately before writing the request
intent. The intent retains cost-model version, estimated cycles, `max_iterations`, and
`iterations_run`, so estimate drift and convergence drift are observable after a restart.

Capability profile v2 defaults to 1,800 raw records, 1,800 live edges, 3,600 conservatively bounded
unique nodes, 1,800 maximum out-degree, 128 MiB of witness bytes, 1,800 lane-2 anchors, 1,800
signature checks, and 100 iterations. The 1,800/3,600 graph envelope admits the largest published
calibration row before and after reconstruction. The witness ceiling remains an independent memory
safety bound because that matrix does not establish a maximum serialized witness size.

There are four distinct ceilings; treating them as one was the H-1 defect:

| ceiling                                                      |        shipped value | meaning                               | default binding order                                                                     |
| ------------------------------------------------------------ | -------------------: | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `InputCapacity.MAX_TOTAL_INPUTS` / vault `MAX_PRICED_INPUTS` |       200,000 inputs | protocol ingress/payment ceiling      | last; not a host-capacity claim                                                           |
| profile `max_unique_nodes`                                   |          3,600 nodes | cheap bound is `2 * raw + seeds`      | co-binds near 1,800 raw inputs                                                            |
| profile `max_raw_records`                                    |        1,800 records | largest calibrated raw/live graph row | **first (co-binding)**                                                                    |
| `prover.cycle_limit`                                         | 8,000,000,000 cycles | local cost-model refusal              | would accept 3,467 and refuse 3,468 max-iteration trust inputs if the profile were raised |

The profile and cycle limit are operator configuration, published verbatim in the status heartbeat
alongside the 200,000 protocol ceiling. Each instance also publishes `limiting_capacity`, including
the binding gate, its observed value, and its limit. A higher-capacity self-prover can raise the
local ceilings without a guest or verification-key change. A refusal is logged as
`skip/capability/<dimension>` or `skip/too_large` with observed and limit values. It means only that
**this host declines the work**: the checkpoint remains valid and another prover may accept it. No
cost-only ceiling is present in a guest or vkey.

The irreversible-input warning uses whichever configured profile dimension, cycle limit, or lower
instance ingress cap is nearest exhaustion and emits `operator_capacity_approaching` at 80%. It no
longer waits for 80% of the unrelated 200,000 payment ceiling.

The named model terms and the SP1 executor calibration matrix are published in the
[trust-graph operator runbook](./trust-graph/runbook.md#m1-full-guest-cost-calibration).

### Keys and balances

Two keys, following the sp1-blobstream template:

- `NETWORK_PRIVATE_KEY` — the Succinct prover network requester key. We are a **requester**, not a
  prover; there is no on-chain proving obligation and the SLA is best-effort plus redundancy.
- `SUBMITTER_PRIVATE_KEY` — pays submit gas. Separate on purpose: the payee is in the journal, so
  the submitting key holds no value and can be rotated without touching bounties.

Startup aborts if `chain_id` disagrees with `eth_chainId`, and alerts if the submitter key has a
zero balance (every send would fail). An instance whose deployed `SP1JournalVerifier` is pinned to
a vkey this binary's guest cannot produce is held per instance (`VerifierRotated`) rather than
spent on.

---

## 3. Crash safety, and the one honest gap

The contracts are the database. Local state is an append-only JSONL journal whose only job is
"don't pay twice after a crash", keyed `(chainId, instanceId, checkpointId)`.

The sequence is: **fsync an intent record carrying a client-side idempotency nonce → make the
request → append the returned request id.** On restart:

| journal state | meaning                                    | action                                        |
| ------------- | ------------------------------------------ | --------------------------------------------- |
| intent + id   | the request is ours and we know its handle | re-attach, poll it                            |
| no intent     | nothing was requested                      | proceed normally                              |
| intent, no id | **ambiguous**                              | resolve by querying the backend for the nonce |

That last row is the gap, and it is a real one: a request id cannot be journaled before the request
that mints it. If the backend can answer "what happened to nonce N?", the window closes
automatically. If it cannot, the record becomes `RequestOutcomeUnknown`, which is surfaced to a
human and **never auto-retried** — the failure mode of auto-retry here is paying twice.

Publication has its own cheaper restart boundary. The completed proof, reconstruction input, and
canonical score blob are written before any target is contacted. Every failed policy attempt is
appended to the same journal with the CID, policy hash, target failures, and timestamp. A restart
therefore resumes publication without requesting another proof. While the minimum is unmet the
planner reports `publication_backoff` and **cannot produce `submit`**. Alerts fire on attempt 1 and
powers of two; every attempt remains visible in logs and the heartbeat without flooding the
webhook every tick. Changing the target set or minimum changes the policy hash and requires the
held blob to satisfy the new policy before submission.

### Measured: what sp1-sdk 6.3.1 actually offers

Read against the pinned SDK source, because whether that last row is rare or routine is entirely a
property of the backend:

- **There is no client-supplied idempotency key.** `NetworkClient::request_proof` takes no caller
  nonce. The `nonce` in the signed request body is `self.get_nonce()`, fetched server-side
  immediately before signing, so it cannot be journaled in advance. The convenience builder
  (`NetworkProveBuilder::request()`) exposes no idempotency knob at all.
- **But `public_values_hash` is a natural one, and it round-trips.** `request_proof` accepts it,
  and the `ProofRequest` record returned by both `get_proof_request_details` and
  `get_filtered_proof_requests` carries it back. For this operator it is fully determined _before_
  the request — ground rule 4 computes the journal natively first — so it is a content-addressed
  request key we did not have to invent, and it distinguishes checkpoints because the journal
  commits the checkpoint's accumulator state.
- **Status lookup by requester exists**: `get_filtered_proof_requests(version, fulfillment_status,
execution_status, minimum_deadline, vk_hash, requester, fulfiller, from, to, limit, page, …)`.

So the resolution is: filter on `requester = us`, `vk_hash = our program`, `from = intent time −
slack`, and match `public_values_hash`. **`RequestOutcomeUnknown` is rare, not routine** — it
survives only for index lag or a request created but not yet visible.

One trap, because it silently disarms all of the above: the SDK attaches `public_values_hash` only
when it simulates, and it skips simulation when **both** `cycle_limit` and `gas_limit` are set.
This operator sets a `cycle_limit` on every request. So the adapter must call the lower-level
`NetworkClient::request_proof` with the hash it already computed, not the convenience builder.

---

## 4. Running it

The published image is the short answer, and §5 is the whole of it:

```bash
docker run --rm \
  -v operator-state:/data \
  -v "$PWD/operator.toml:/etc/trustgraph/operator.toml:ro" \
  -e SUBMITTER_PRIVATE_KEY -e NETWORK_PRIVATE_KEY \
  -p 8080:8080 \
  ghcr.io/ainima-collective/trustgraphs-operator:latest
```

From a source checkout, the same four invocations:

```bash
# one pass over every instance, then exit. What CI and a human debugging use.
cargo run --release --manifest-path zk/operator/Cargo.toml -- --config ./operator.toml --once

# decide and report, send nothing. Safe against production config.
cargo run --release --manifest-path zk/operator/Cargo.toml -- --config ./operator.toml --once --dry-run

# the daemon.
cargo run --release --manifest-path zk/operator/Cargo.toml -- --config ./operator.toml

# repair an already-landed but unavailable CID. No prover or submitter credentials are needed.
cargo run --release --manifest-path zk/operator/Cargo.toml -- \
  --config ./operator.toml republish \
  --instance 0x0123...cdef --checkpoint 42
```

`republish` rebuilds checkpoint inputs and historical controller parameters, verifies the
root/hash/CID/total against the exact landed chain state, and only then uses the normal publication
policy. It refuses unlanded or unpinned checkpoints and any mismatch. For manifest-only programs,
retain the params file version used by each checkpoint; the manifest is the description source
precisely because those params are not available from chain history.

Startup refuses a config that cannot work rather than dying on the first call: an empty or
scheme-less `rpc`, a zero `registry`, `[paid]` naming a zero vault or recipient, a `state_dir` that
is not writable, and a named `state_dir` whose parent does not exist. An empty `rpc` is the common
one, because a config written by a shell heredoc whose variable was unset produces `rpc = ""`,
which is perfectly valid TOML. The `state_dir` refusal is the expensive one: an absolute path whose
parent is missing is what an unmounted volume looks like, and a journal written to a container's
own filesystem is gone at the next deploy — after which the daemon re-requests, and re-pays for,
proofs it already has.

Startup also says which executable each reconstruction lane resolved to, so "does this box need a
compiler?" is answered before the first tick rather than by the first tick that needs one:

```json
{"event":"tools","input-exporter":"/usr/local/bin/input-exporter", …}
{"event":"tools","input-exporter":"cargo run -q -p input-exporter -- (source checkout; needs a Rust toolchain)", …}
```

`--dry-run` is the first thing to run against any config you have just changed. It performs every
chain read and every decision and skips only the sends, so the decision log it prints is exactly
what the real loop would act on.

### `registry_from_block` is not optional in practice

Left at 0 against a registry deployed at block 21,000,000, the scan issues ~2,100 empty
`eth_getLogs` calls before it can decide anything — and most public providers reject that range as
an archive request, so the daemon gets **no catalog at all and every tick fails**. Startup alerts
when it is 0 on any chain but 31337. Set it to the registry's deployment block.

### Reading the output

Two files, both rewritten in place, both meant to be scraped:

- **`ops.status_path`** — the heartbeat. `head_block`, `tick_at`, one row per instance with its
  decided action, the non-secret `settings` policy projection, and the current `unresolved` list.
  If `tick_at` stops advancing, the daemon is wedged; nothing else in this file matters more than
  that.
- **`ops.journal_path`** — the append-only money and recovery record. It carries proof intents,
  request handles, submit gas, deterministic submit failures, settlements, and terminal
  `abandoned` checkpoints. It is the only file whose loss can duplicate paid work or resurrect a
  rejected checkpoint, and the only one worth backing up.

The log on stdout narrates **changes**; the heartbeat file carries steady state. A quiet healthy
daemon prints exactly one `tick` line per pass — `head` plus instance/idle/proving/skipped/alert
counts — and nothing else. A `decision` line (with the instance's name and program) appears when an
instance's planned action changes state, not every tick: a rising confirmation count or a wiggling
basefee is progress inside one state, while a new checkpoint id or a different hold is a
transition. `instance_skipped` appears when an instance is newly refused, or refused for a new
reason; `instance_recovered` closes the bracket when it is listed again. One skip is deliberately
never logged: "owned by another SP1 program" across lanes, because every instance is expected to be
another program's in every lane but its own. An instance **no** lane claims (an unknown program id,
or its lane disabled) does get a single lane-less `instance_skipped` line. A restart re-announces
the current state once.

Useful one-liners:

```bash
jq -c '{head_block, tick_at, instances: [.instances[] | {name, action: .action}]}' status.json
jq -c 'select(.kind=="intent")' journal.jsonl | tail             # what has been paid for
jq -r 'select(.event=="instance_skipped") | .reason' run.log | sort | uniq -c
jq -c 'select(.event=="tick")' run.log | tail -1                 # is it alive, and how busy
```

The network settings page can consume this heartbeat through `OPERATOR_STATUS_URL`, or
`OPERATOR_STATUS_PATH` when the frontend and daemon share a volume. Its same-origin API adapter
validates and republishes only `head_block`, `tick_at`, per-instance health, and the explicit
`settings` allowlist. RPC/IPFS endpoints, keys, webhook URLs, filesystem paths, alerts, and
unresolved journal entries never cross that boundary. Do not serve the raw heartbeat directly to
the browser; future heartbeat fields are private until they are explicitly added to the adapter.

### The health listener

`ops.listen` serves the URL mode of the above, plus the two things a platform and an uptime check
need. Three GET routes, all read-only; there is no way to trigger, halt, resolve or configure
anything over the network.

| route     | 200 means                                             | 503 means                                                       |
| --------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `/health` | the process is up and answering                       | the process is gone (nothing answers at all)                    |
| `/ready`  | it is doing its job, or legitimately busy doing it    | no tick has completed yet, or the current phase has overrun      |
| `/status` | the sanitized heartbeat, same shape as `status.json`  | no tick has completed yet                                        |

`/ready` is phase-aware on purpose. A proof can legitimately take an hour and a receipt watch ten
minutes, and during both the daemon logs nothing and completes no tick. A probe that knew only
when the last tick finished would call those dead — and a platform that restarts on a failed probe
would then restart the daemon in the middle of the one thing it is there to do. So each phase is
judged against a limit the daemon already enforces on itself:

| phase                     | limit                          |
| ------------------------- | ------------------------------ |
| between/inside ticks      | `ops.ready_after_seconds`      |
| reconstructing an input   | 900s (the source-checkout fallback compiles it) |
| proving                   | `prover.timeout_s` + 120s      |
| watching for a receipt    | 720s (the watch caps at 600s)  |
| publishing                | 300s                           |
| starting                  | 300s                           |

The body of `/ready` says which phase and for how long, so a red probe is diagnosable without
shell access. **A daemon that has never completed a tick is never ready**, whatever it is busy
with, so a container healthcheck needs a start period that covers a first pass — the published
image allows 15 minutes.

What `/status` serves is a projection of the heartbeat, not the heartbeat: it is the frontend
adapter's allowlist applied on the way OUT as well as on the way in. That is not belt-and-braces.
An `alerts` entry can quote a transport error, a transport error can quote the RPC URL, and an RPC
URL can carry a provider key — so `alerts` and `unresolved` are in the file and not on the wire.

### Alerts

`ops.alert_webhook` receives a plain-text POST for anything a human has to act on. What raises one,
and what each actually means:

| alert                                                          | what happened                                                                                         | what to do                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tick failed: …`                                               | a whole pass errored (usually RPC)                                                                    | nothing, if it clears; the next tick re-reads everything from chain                                                                                                                                                                                      |
| `/ready` returns 503 while `/health` returns 200               | the process is fine and the WORK has stalled; the body names the phase and its age                    | read the phase. `ticking` past its limit is a wedged chain read; `proving` past `prover.timeout_s` is a prover that never answered; `reconstructing` for minutes on a source checkout is usually a cold cargo build                                       |
| `N proof request(s) with an unknown outcome`                   | a crash landed in the ambiguous window (§3)                                                           | resolve each by hand; **never** auto-retried                                                                                                                                                                                                             |
| `registry_from_block is 0 on chain N`                          | the scan will start at genesis                                                                        | set it, restart                                                                                                                                                                                                                                          |
| `submitter key has a zero balance`                             | every send will fail                                                                                  | fund it                                                                                                                                                                                                                                                  |
| `<instance>: Unfunded`                                         | a paid instance's tank will not cover the next root                                                   | tell the community, or move it to `curated`                                                                                                                                                                                                              |
| `<instance>: VerifierRotated`                                  | its deployed verifier expects a vkey this binary cannot produce                                       | rebuild against the new guest, or leave it — the operator will not spend on it                                                                                                                                                                           |
| `<instance>: LossBudget`                                       | a rolling cap was exceeded                                                                            | investigate before raising the budget; it does not clear until the window rolls                                                                                                                                                                          |
| `publication policy failed` / `publication_backoff`            | fewer than `ipfs.min_success` targets added and served the exact blob                                 | repair the named targets or lower the minimum only as an explicit durability decision; submission stays blocked and the journal retries automatically                                                                                                    |
| `the API accepted the blob but the gateway … answers 504`      | one target's add API and reader gateway hit **different nodes**                                       | compare `curl -X POST <api>/api/v0/id` with the gateway host; that target does not count until readers can fetch the exact bytes                                                                                                                         |
| an already-landed CID is unreadable                            | content addressing proves which bytes belong at a CID, not that anyone still stores them              | restore a retained copy or reconstruct from checkpoint history, then run `operator republish --instance … --checkpoint …`; the indexer retries once the CID is readable                                                                                  |
| `checkpoint N abandoned after M deterministic submit failures` | the same immutable proof reverted during estimate, simulation, or in a mined receipt M times          | no manual unstick is required. The proof remains rejected; after consumed inputs move, the operator triggers and proves a newer checkpoint. Investigate the named `failure_class` before lowering the threshold or restoring the underlying hook/policy. |
| `journal … was written against a DIFFERENT chain`              | a devnet restarted (or the config moved) and the old journal's keys collide with the new chain's work | point `ops.journal_path` at a fresh file for this chain. See below                                                                                                                                                                                       |

#### Why a restarted devnet wedges the journal

A `WorkKey` is `(chain_id, instance_id, checkpoint_id)`, and on a devnet **none of the three is
fresh**: the chain id is fixed at 31337, an instance id is `keccak(creator, name, salt)`, and a
restarted chain counts checkpoints from 0 again. So the previous run's `settled: landed` record
matches the new chain's first unit of work exactly, and the journal refuses it — correctly, given
what it knows. The daemon then re-plans the same doomed `Prove` every tick forever, because a
settled record reads as "no work in flight" to `plan`.

The daemon detects this rather than guessing: a `Landed`/`Superseded` record is a _claim about the
chain_, so if that instance's snapshot reports no such root, the two cannot be describing the same
chain. Mainnet is unaffected — chains there do not restart.

### Recovering

The contracts are the database, so recovery is mostly "start it again".

- **Ordinary crash / `kill -9`.** Restart. The journal re-attaches to any in-flight request and the
  disk re-attaches to any finished-but-unsubmitted proof. Verified in `tests/e2e/fork.sh`: killed
  mid-proof, restarted, no second request and roots kept landing.
- **Someone else landed the root first.** Nothing to do; that is the design. The bounty follows the
  journal's recipient, so `ProvingVault.claim(instanceId, checkpointId)` still pays the prover
  afterwards — anyone may call it.
- **A submit deterministically reverts.** Estimate-time, simulation-time, and mined receipt
  reverts increment the same checkpoint-local counter. At `ops.submit_failure_threshold`, an
  `abandoned` record is fsynced and survives restart. The held proof is never called valid and is
  never submitted again. If inputs have not moved, the operator reports `awaiting_new_inputs`
  instead of trigger-looping; once they move, it freezes/proves a newer checkpoint automatically.
  Provider transport, rate limits, fee/nonce failures, receipt timeouts, blob availability, and
  reorgs do not increment this counter and retain their existing retry/re-attach behavior.
- **`RequestOutcomeUnknown`.** The one case needing a human. Query the prover network for the
  request (§3 says how), then append a `Resolved` record to the journal. Do not delete the line and
  do not restart hoping it clears — that is how you pay twice.
- **Lost journal.** Recoverable but expensive: the daemon will re-request proofs it already paid
  for. Roots are unaffected (`submitProof` is monotonic, so a duplicate simply reverts). Back the
  journal up; nothing else.
- **Wrong `paramsHash` after a governance rotation.** Expected, and self-healing for new
  checkpoints only. In-flight checkpoints keep the params they were pinned with; the operator
  skips the instance until its own reconstruction matches again, and says
  `params_hash(reconstruction) != snapshot.paramsHash()` while it does.

---

## 5. Self-hosting

The hosted service sells convenience, not access. A community running the operator against its own
instance, with its own keys, produces the same root — byte-identical, verified by the same
contract, with no relationship to us of any kind.

One image, one config file, two secrets, one volume. No checkout, no Rust toolchain, no GitHub
account:

```bash
docker pull ghcr.io/ainima-collective/trustgraphs-operator:latest
```

`operator.toml`:

```toml
rpc                 = "https://…"
registry            = "0x…"
registry_from_block = 21000000

[curated]
instances = ["0x…your instance id…"]   # "prove this on my own money"

[prover]
backend = "network"                    # or "cpu" with 16-32 GiB

[ipfs]
min_success = 1

[[ipfs.targets]]
name    = "mine"
api     = "https://…"
gateway = "https://…/ipfs/"

[ops]
state_dir = "/data"                    # the mounted volume, and everything the daemon owns
listen    = "0.0.0.0:8080"             # /health, /ready, and the sanitized heartbeat
```

No `[paid]` section: with it off the operator is self-proving and pays for everything it proves.
Listing your instance under `[curated]` is what tells it "this one is proven on us" — from your
config's point of view, _you_ are the host.

```bash
docker volume create operator-state
docker run -d --name operator \
  -v operator-state:/data \
  -v "$PWD/operator.toml:/etc/trustgraph/operator.toml:ro" \
  -e SUBMITTER_PRIVATE_KEY \
  -e NETWORK_PRIVATE_KEY \
  -p 8080:8080 \
  ghcr.io/ainima-collective/trustgraphs-operator:latest

curl localhost:8080/ready
```

Two things about that volume, both of which cost money if they are wrong:

- **`/data` must be a NAMED volume.** `journal.jsonl` lives there, and it is the only file whose
  loss duplicates paid work. The image's `VOLUME ["/data"]` means the journal is never on the
  container's writable layer, but the volume you get without asking is anonymous and is orphaned
  when the container is replaced rather than restarted. Replacing the container is what a deploy
  is. The daemon's own guard does not cover this case and should not be relied on to: it refuses
  a named `state_dir` whose PARENT is missing, which protects `/mnt/operator/state` against an
  unmounted `/mnt/operator`, and cannot fire for `/data`, whose parent is `/`.
- **Never run two operators against one journal or one submitter key.** Do not raise the replica
  count, and do not raise `cadence.max_per_instance` above 1.

### Checking what you pulled

The image is built by a public workflow from a public commit, and every release publishes the
guest table it was built from. Both are checkable without an account:

```bash
# what this container's guests are, without starting it
docker run --rm --entrypoint cat \
  ghcr.io/ainima-collective/trustgraphs-operator:latest /etc/trustgraph/elf-digests.txt

# who built it, and from which commit
gh attestation verify oci://ghcr.io/ainima-collective/trustgraphs-operator:latest \
  --repo AInima-Collective/trustgraphs

# and, from source, that those are the bytes the source produces
sh scripts/build-guests.sh && sh scripts/guest-elf-digests.sh
```

That last command is only a meaningful check because guest builds are reproducible: every guest is
compiled inside the pinned SP1 builder image, and CI fails a release if two architectures disagree
about the bytes. See [`addresses-and-vkeys.md`](./addresses-and-vkeys.md).

### From a source checkout instead

Nothing above is required. `[ops] tool_dir` is what the image sets implicitly by putting the
reconstruction binaries beside the daemon; a checkout with nothing pre-built falls back to
`cargo run` and works exactly as it always has.

Nothing about the on-chain path differs from what we run. `submitProof` is permissionless and
monotonic, the journal binds the same values, and N operators on one instance compose rather than
race: the first root to land wins and the others revert, having spent only gas.

The manual fallback — the loop a human drives by hand, one command per step — stays documented in
[`trust-graph/runbook.md`](./trust-graph/runbook.md) §"Manual proving". It is the same
sequence the daemon automates, and it is what to fall back to if the daemon itself is the problem.

---

## 6. What the operator can and cannot promise

- **Cannot** guarantee a root lands: proving is best-effort, and any of gas, prover capacity, or a
  paused instance can delay one.
- **Cannot** stop anyone else from proving your instance. That is a feature; `submitProof` is
  permissionless and monotonic, so N operators compose instead of racing.
- **Can** guarantee it will not silently subsidize you. An empty vault means the operator stops and
  says so, rather than quietly paying.
- **Can** guarantee the bounty is not stealable. The fee follows the journal's recipient; only gas
  reimbursement follows `msg.sender`, and that reimbursement is **capped and conservative, never
  exact** — `gasleft()` deltas cannot see intrinsic cost, and pricing at `block.basefee`
  deliberately excludes the priority fee so a self-inflated tip is not reimbursable.

---

## 7. What has and has not been run

Written down because "there is a test for it" and "it has been proven on a real chain" are
different claims, and only one of them is true here.

**Exercised end to end, unattended, on `tests/e2e/fork.sh`:** three epochs of trigger → prove →
submit with no human in the loop; a network created and its proving tank endowed in one
transaction; the tank paying the prover for every root it bought; a stranger's direct
`accumulator.checkpoint()` refused; five spam checkpoints coalescing to one paid proof; a params
rotation leaving an already-pinned checkpoint alone while the next one binds the new value; the
operator refusing to spend on an instance whose params it can no longer reproduce; `kill -9`
mid-proof followed by a clean re-attach; a loss budget halting an instance rather than bleeding on
it; and a verifier rotation held rather than proved into.

**The front-run, specifically.** A second key was handed the daemon's held proof — strictly more
than a mempool observer could see — and landed the claim itself. The fee still went to the address
the journal named (1.67e15 wei, the band-1 price); the copier got 1.3e10 wei, gas only. Copying
works. Stealing does not.

**Not run: a real Groth16 proof verified by the canonical gateway.** Local Groth16 needs 16–32 GiB
(this box has 11) and there is no prover-network key, so every proof above wraps at a
`MockSP1Gateway`. The fork e2e does the next best thing and asks the _real_ mainnet gateway
directly: it has 1,975 bytes of deployed code and it refuses a fabricated proof. So the seam is
demonstrably not something mainnet would accept — but the positive direction is unproven, and it is
the one thing on this page that a deployment must do before trusting the rest. Recorded as
[`DEVIATIONS`](../../research/DEVIATIONS.md) #20; the rehearsal belongs in the session that first funds a
prover-network key, alongside the vkey pinning check in
[`networks-and-programs.md`](../../docs/concepts/networks-and-programs.md).

**Signer scheduling is now part of the standard catalog.** A governed creation receipt yields a
distinct signer operator id, module target, verifier/vkey, score source, and selection tuple. The
operator waits for a landed score checkpoint, reconstructs `SignerInput`, proves with the signer
guest, and submits the complete owner set directly to the module without IPFS or vault handling.
Catalog derivation, native receipt construction, isolated budgets, and the real-Safe owner update
are regression-tested. Legacy signer deployments retain the manifest fallback above.

**A real reorg, against a running daemon — `tests/e2e/reorg.sh`.** This used to say "the
block-hash finality check is unit-tested against a synthetic one", which is a test of the
arithmetic rather than of the daemon: the anchor memory that lets the check fire at all is
per-RUN state, so a reorg is only detectable by a process that was already running when the chain
changed under it. A `--once` tick can never notice one. Both paths now run against a single
long-lived daemon on an anvil snapshot/revert:

- A checkpoint the daemon had already anchored is reverted away and comes back at a different
  block. It refuses the stale anchor rather than proving against a block that is no longer on the
  chain, then re-anchors and recovers on its own.
- A submit that already landed is reverted away before its confirmations accrue. It notices,
  alerts, and resubmits the proof it is still holding — one intent and one journaled landing
  across the whole run, so it neither paid twice nor recorded a landing that had vanished.

**A soak — `tests/e2e/soak.sh`.** Not a wall-clock one, deliberately. Three production days at a
60-second cadence is 4,320 quiet ticks and zero restarts, which is a long time to prove very
little. The harness accumulates the things that actually break a daemon instead: it kills the
process every 45 seconds, black-holes the RPC for 8 seconds out of every 70, and adds a graph edge
every 25 seconds. What it asserts afterwards: one request per checkpoint, a journal that parses
line for line after every kill, no recorded landing that is not on chain, and growth that follows
work rather than the clock. Note that ticks do NOT accumulate faster than wall-clock under that
abuse — a restart re-reads the chain from scratch and a black-holed read burns its full
`rpc_timeout_seconds` — so the tick count is the least interesting number it prints.

Measured, 2026-08-24, over twenty minutes: **382 ticks (10 of them failed, all during injected
outages), 25 restarts, 15 outages survived, 41 checkpoints frozen and 39 roots applied — with 41
proof requests over 41 distinct checkpoints.** One request per checkpoint, across 25 kills. Every
journaled landing was still on chain at the end, the journal re-opened and re-planned against
cleanly, and 382 ticks produced 199 journal lines, because a line is caused by a checkpoint
reaching a stage and never by a tick.

**Sizing, since a volume forces the question.** That run cost about **1.4 KB of journal and 34 KB
of total state directory per checkpoint**, the difference being the per-checkpoint working files
(the reconstructed input, the held proof, the written-out params). A 5 GB volume is therefore on
the order of a hundred thousand checkpoints of headroom, and the journal alone is millions. The
weighted-manifest cache is separately bounded at 16 MiB by config.

**Three defects, all found by writing those two.** Each was a way for the daemon to be dead
without saying so, and all three are fixed:

| found | what it was |
| --- | --- |
| the chain client had no timeout | `reqwest` imposes none, so a provider that accepts the connection and never answers — what an overloaded one does, rather than refusing — stopped the daemon permanently: no tick, no `tick_failed`, no alert, until a human noticed |
| readiness could not tell working from wedged | a proof takes up to an hour and a receipt watch up to ten minutes, logging nothing and completing no tick throughout; a tick-staleness probe calls both dead |
| every tick re-derived every guest vkey | seven SP1 setups measure 68 seconds of CPU, and the loop did six of them per pass — roughly a full core, continuously, re-deriving constants that cannot change while the process runs. Ticks went from 11–25 seconds to 1.01 seconds once they were derived at startup |

**What the soak shows about restarts, which is worth knowing before you deploy one.** Killing the
daemon during a proof lands inside the ambiguous window §3 describes, and the window is as wide as
the proving call rather than milliseconds: the intent is fsynced before the request and the handle
is recorded after it returns. Twenty-five kills produced one of them. The daemon does exactly the
right thing — it holds `RequestOutcomeUnknown`, refuses to auto-retry, and alerts — but that
instance then waits for a human, and does no further work until it gets one. A deployment that
restarts often will accumulate these, and a soak that restarts often eventually stalls itself,
which is why `soak.sh` reports the count rather than quietly running out the clock. Restart
rarely; resolve promptly.

**Still not run: `RequestOutcomeUnknown` against the live prover network.** The hold above is
produced and handled locally; what is measured from the SDK source in §3 rather than executed is
the RESOLUTION — matching `public_values_hash` through `get_filtered_proof_requests` against the
real network. That needs a funded Succinct key, which is also required by the
[Sepolia operator deployment](../../docs/build/railway.md#3-create-the-shared-variables), and the
rehearsal belongs in the session that first funds one.

**Still not run unattended in a rehearsal a runner can execute: a Contributions round.** The
daemon-side gap is smaller than it was — `task demo` has scheduled a Contributions round through
the daemon since 2026-08-04, and `demo:prove` fails unless both the trust root and the round root
land. What is missing is that leg inside `tests/e2e/`, and the obstacle is now the demo harness
rather than the daemon: `task demo` writes `.docker/` and `.demo/` at fixed paths and expects the
default RPC port, so it takes over a checkout and cannot run beside a live stack. Restated in
[`DEVIATIONS`](../../research/DEVIATIONS.md) #23 with that reason. `reorg.sh` and `soak.sh` drive
only the trust-graph lane for the same reason the fork rehearsal does.

---

## 8. Related

- [`quickstart.md`](./quickstart.md) — the local walkthrough (`task demo`): deploy,
  create a funded network, and watch this daemon prove and pay for it

- [`research/PROOF_SCHEDULER.md`](../../research/PROOF_SCHEDULER.md) — the design, its economics and
  its failure semantics
- [`research/INSTANCE_FACTORY.md`](../../research/INSTANCE_FACTORY.md) §5 — the enumeration seam this
  consumes
- [`research/UPGRADE_GOVERNANCE.md`](../../research/UPGRADE_GOVERNANCE.md) §5.5-§5.6 — verifier and
  params rotations, and why one is pinned per checkpoint and the other deliberately is not
- [`trust-graph/runbook.md`](./trust-graph/runbook.md) — the manual loop, now a fallback
