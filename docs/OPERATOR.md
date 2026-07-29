# The proof operator

Proven scores go stale unless somebody freezes a checkpoint, proves it, and lands it, once per
epoch, forever. This document is about the thing that does that without a human in the loop.

Three ways a network's scores stay fresh, and you should pick one deliberately:

| | who proves | what it costs you | what you depend on |
|---|---|---|---|
| **Self-prove** | you | your own gas + proving | nothing. Permissionless, documented, free forever |
| **Curated** | us | nothing | our goodwill and our uptime |
| **Funded** | anyone | whatever you top up | a public bounty, and whoever chooses to collect it |

There is no fourth tier where everybody gets proven for free. A permissionless factory plus an
unconditional free tier is an unbounded liability: an attacker pays roughly one attestation of gas
per epoch to make somebody else pay for a ~600k-gas submit. So the promise is "every **eligible**
instance", and this page says which ones those are rather than implying it covers everyone.

> **Status.** The decision engine (`packages/operator-core`) is **built**: every branch below is a
> test in `packages/operator-core/tests/`. The daemon that drives it (`zk/operator`) is M2, and the
> vault it draws from is M3. This page is the configuration contract they are built against, frozen
> at the interface freeze so the indexer and frontend could be built in parallel. Sections marked
> *(planned)* describe behaviour whose configuration shape is fixed but whose code lands later.

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

Everything that can be *wrong* — when to trigger, which checkpoint to prove, when to hold, when to
claim — lives in `packages/operator-core`, a plain crate in the root workspace that CI tests
against a fake chain. Only the thin sp1-sdk adapter lives in the detached `zk/` workspace. If you
are reading the code to answer "would it have paid twice here?", read `operator-core`.

Two rules shape the rest of the design:

- **Only the newest unproven checkpoint is ever proved.** `submitProof` is monotonic, so
  intermediates can be skipped forever. Spamming `trigger()` costs the spammer gas and the
  operator nothing.
- **Preventable spend is prevented; unpreventable spend is budgeted.** A params mismatch, a
  pending verifier rotation, an unfinalized checkpoint, an empty vault, an oversized instance:
  each is a hold or a skip *before* the proof request. But a creator-admin can rotate config one
  block after any preflight, so some waste is not preventable. That is what the loss budgets are
  for: the operator halts an instance rather than bleeding on it.

---

## 2. Configuration

One TOML (or JSON) file. Every key below has a default except `rpc` and `registry`; anything not
listed is not configurable.

```toml
# ── chain ───────────────────────────────────────────────────────────────────
rpc      = "https://…"          # required. JSON-RPC endpoint
registry = "0x…"                # required. InstanceRegistry address
chain_id = 1                    # optional; checked against eth_chainId at startup, never trusted over it
registry_from_block = 21000000  # the block `registry` was deployed at. SET THIS on any real chain.

# ── which instances ─────────────────────────────────────────────────────────
# Factory-minted trust-graph instances need ZERO per-instance config: the daemon reconstructs
# them from the chain (registry row → InstanceRegistered tx → factory InstanceCreated → full
# params) and self-checks params_hash(event.params) == snapshot.paramsHash().
#
# Everything else needs a manifest entry, because the chain does not describe it:
#   - contributions instances are not in InstanceRegistry at all
#   - hypercerts registers an opaque paramsHash with no params-bearing event
#   - SignerSyncZkModule is not discoverable from the registry in any form
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
program      = "signer-sync"
snapshot     = "0x…"            # the TRUST instance it follows (woken by its MerkleRootUpdated)
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
replacement_after_s = 300       # bump a stuck submit
simulate_before_send = true     # eth_call first; a revert is a hold, not a broadcast

# ── finality ────────────────────────────────────────────────────────────────
[finality]
confirmations = 12              # a reorg must not erase a checkpoint we already paid to prove
track_block_hash = true

# ── proving ─────────────────────────────────────────────────────────────────
[prover]
backend      = "network"        # network | cpu | mock
cycle_limit  = 1_000_000_000    # refuse instances that would exceed it. MUST name the same
                                # boundary as the vault's top fee band; that agreement is a test
groth16      = true
timeout_s    = 3_600

# ── loss budgets ────────────────────────────────────────────────────────────
# Unpreventable spend is real. When one of these is exceeded the instance is HALTED and alerted,
# not retried.
[budget]
per_instance_usd_per_day = 25
global_usd_per_day       = 250
cents_per_billion_cycles = 100   # what turns a cycle estimate into the budget's units
window_seconds           = 86400 # the rolling window the caps are measured over

# ── operations ──────────────────────────────────────────────────────────────
[ops]
journal_path = "./.trustgraph/operator/journal.jsonl"
status_path  = "./.trustgraph/operator/status.json"
alert_webhook = "https://…"
log_format   = "json"
```

### Keys

| key | meaning | default |
|---|---|---|
| `rpc` | JSON-RPC endpoint; must be an absolute `http(s)://` URL | required |
| `registry` | `InstanceRegistry` address | required |
| `chain_id` | expected chain; startup aborts on mismatch | read from chain |
| `registry_from_block` | where the `InstanceRegistered` scan starts | 0 (alerts on any chain but 31337) |
| `manifest[]` | instances the chain cannot describe | empty |
| `curated.instances` | proven on us, no vault | empty |
| `paid.enabled` / `paid.vault` / `paid.recipient` | the funded path | off |
| `cadence.tick_seconds` | loop period | 60 |
| `cadence.subsidy_min_blocks` | our cadence for curated instances | 216000 |
| `cadence.max_concurrent` / `max_per_instance` | concurrency caps | 4 / 1 |
| `gas.max_basefee_gwei` | basefee gate | 40 |
| `gas.replacement_after_s` | stuck-tx bump | 300 |
| `finality.confirmations` | before spending on a checkpoint | 12 |
| `prover.backend` | `network` \| `cpu` \| `mock` | `network` |
| `prover.cycle_limit` | refuse-to-prove ceiling | 1e9 |
| `budget.*_usd_per_day` | halt thresholds | 25 / 250 |
| `budget.cents_per_billion_cycles` | price used to cost a proof | 100 |
| `budget.window_seconds` | rolling window for both caps | 86400 |
| `ops.*` | journal, heartbeat, alerts, logging | see above |

### Keys and balances

Two keys, following the sp1-blobstream template:

- `NETWORK_PRIVATE_KEY` — the Succinct prover network requester key. We are a **requester**, not a
  prover; there is no on-chain proving obligation and the SLA is best-effort plus redundancy.
- `SUBMITTER_PRIVATE_KEY` — pays submit gas. Separate on purpose: the payee is in the journal, so
  the submitting key holds no value and can be rotated without touching bounties.

Startup refuses to run if either balance is below its floor, if the deployed
`SP1JournalVerifier`'s vkey does not match the guest the binary was built from, or if `chain_id`
disagrees with `eth_chainId`.

---

## 3. Crash safety, and the one honest gap

The contracts are the database. Local state is an append-only JSONL journal whose only job is
"don't pay twice after a crash", keyed `(chainId, instanceId, checkpointId)`.

The sequence is: **fsync an intent record carrying a client-side idempotency nonce → make the
request → append the returned request id.** On restart:

| journal state | meaning | action |
|---|---|---|
| intent + id | the request is ours and we know its handle | re-attach, poll it |
| no intent | nothing was requested | proceed normally |
| intent, no id | **ambiguous** | resolve by querying the backend for the nonce |

That last row is the gap, and it is a real one: a request id cannot be journaled before the request
that mints it. If the backend can answer "what happened to nonce N?", the window closes
automatically. If it cannot, the record becomes `RequestOutcomeUnknown`, which is surfaced to a
human and **never auto-retried** — the failure mode of auto-retry here is paying twice.

### Measured: what sp1-sdk 6.3.1 actually offers

Read against the pinned SDK source, because whether that last row is rare or routine is entirely a
property of the backend:

- **There is no client-supplied idempotency key.** `NetworkClient::request_proof` takes no caller
  nonce. The `nonce` in the signed request body is `self.get_nonce()`, fetched server-side
  immediately before signing, so it cannot be journaled in advance. The convenience builder
  (`NetworkProveBuilder::request()`) exposes no idempotency knob at all.
- **But `public_values_hash` is a natural one, and it round-trips.** `request_proof` accepts it,
  and the `ProofRequest` record returned by both `get_proof_request_details` and
  `get_filtered_proof_requests` carries it back. For this operator it is fully determined *before*
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
This operator's config sets `cycle_limit`. So the adapter must call the lower-level
`NetworkClient::request_proof` with the hash it already computed, not the convenience builder.

---

## 4. Running it

```bash
# one pass over every instance, then exit. What CI and a human debugging use.
cargo run --release --manifest-path zk/operator/Cargo.toml -- --config ./operator.toml --once

# decide and report, send nothing. Safe against production config.
cargo run --release --manifest-path zk/operator/Cargo.toml -- --config ./operator.toml --once --dry-run

# the daemon.
cargo run --release --manifest-path zk/operator/Cargo.toml -- --config ./operator.toml
```

Startup refuses a config that cannot work rather than dying on the first call: an empty or
scheme-less `rpc`, a zero `registry`, or `[paid]` naming a zero vault or recipient. An empty `rpc` is
the common one, because a config written by a shell heredoc whose variable was unset produces
`rpc = ""`, which is perfectly valid TOML.

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
  decided action, and the current `unresolved` list. If `tick_at` stops advancing, the daemon is
  wedged; nothing else in this file matters more than that.
- **`ops.journal_path`** — the append-only money record. One `intent` per proof request, one
  `settled` per resolved one. It is the only file whose loss costs money, and the only one worth
  backing up.

Useful one-liners:

```bash
jq -c '{head_block, tick_at, instances: [.instances[] | {name, action: .action}]}' status.json
jq -c 'select(.kind=="intent")' journal.jsonl | tail             # what has been paid for
jq -r 'select(.event=="instance_skipped") | .reason' run.log | sort | uniq -c
```

### Alerts

`ops.alert_webhook` receives a plain-text POST for anything a human has to act on. What raises one,
and what each actually means:

| alert | what happened | what to do |
|---|---|---|
| `tick failed: …` | a whole pass errored (usually RPC) | nothing, if it clears; the next tick re-reads everything from chain |
| `N proof request(s) with an unknown outcome` | a crash landed in the ambiguous window (§3) | resolve each by hand; **never** auto-retried |
| `registry_from_block is 0 on chain N` | the scan will start at genesis | set it, restart |
| `submitter key has a zero balance` | every send will fail | fund it |
| `<instance>: Unfunded` | a paid instance's tank will not cover the next root | tell the community, or move it to `curated` |
| `<instance>: VerifierRotated` | its deployed verifier expects a vkey this binary cannot produce | rebuild against the new guest, or leave it — the operator will not spend on it |
| `<instance>: LossBudget` | a rolling cap was exceeded | investigate before raising the budget; it does not clear until the window rolls |

### Recovering

The contracts are the database, so recovery is mostly "start it again".

- **Ordinary crash / `kill -9`.** Restart. The journal re-attaches to any in-flight request and the
  disk re-attaches to any finished-but-unsubmitted proof. Verified in `test/e2e/fork.sh`: killed
  mid-proof, restarted, no second request and roots kept landing.
- **Someone else landed the root first.** Nothing to do; that is the design. The bounty follows the
  journal's recipient, so `ProvingVault.claim(instanceId, checkpointId)` still pays the prover
  afterwards — anyone may call it.
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

```toml
rpc                 = "https://…"
registry            = "0x…"
registry_from_block = 21000000

[curated]
instances = ["0x…your instance id…"]   # "prove this on my own money"

[prover]
backend = "network"                    # or "cpu" with 16-32 GiB

[ops]
journal_path = "./.trustgraph/operator/journal.jsonl"
status_path  = "./.trustgraph/operator/status.json"
```

No `[paid]` section: with it off the operator is self-proving and pays for everything it proves.
Listing your instance under `[curated]` is what tells it "this one is proven on us" — from your
config's point of view, *you* are the host.

Nothing about the on-chain path differs from what we run. `submitProof` is permissionless and
monotonic, the journal binds the same values, and N operators on one instance compose rather than
race: the first root to land wins and the others revert, having spent only gas.

The manual fallback — the loop a human drives by hand, one command per step — stays documented in
[`docs/trust-graph/RUNBOOK.md`](./trust-graph/RUNBOOK.md) §"Manual proving". It is the same
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

**Exercised end to end, unattended, on `test/e2e/fork.sh`:** three epochs of trigger → prove →
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
`MockSP1Gateway`. The fork e2e does the next best thing and asks the *real* mainnet gateway
directly: it has 1,975 bytes of deployed code and it refuses a fabricated proof. So the seam is
demonstrably not something mainnet would accept — but the positive direction is unproven, and it is
the one thing on this page that a deployment must do before trusting the rest. Recorded as
[`DEVIATIONS`](./DEVIATIONS.md) #20; the rehearsal belongs in the session that first funds a
prover-network key, alongside the vkey pinning check in
[`PROGRAMS.md`](./PROGRAMS.md).

**Not run: the daemon scheduling a contributions round or a signer-sync rotation.** The fork run
drives two trust-graph instances — one curated, one vault-funded, in the same loop, which is the
pair that can disagree with each other. Both other programs have handlers, and `test/e2e/run.sh`
proves each one's full pipeline through the CLI, but nothing yet shows the daemon deciding and
landing them unattended. Everything between the decision and the submit is program-agnostic; the
per-program difference is input reconstruction. Recorded as [`DEVIATIONS`](./DEVIATIONS.md) #23.

**Also not run:** a multi-day soak, a real reorg (the block-hash finality check is unit-tested
against a synthetic one), and the `RequestOutcomeUnknown` resolution path against the live prover
network — that last one is measured against the SDK source in §3 rather than executed.

---

## 8. Related

- [`DEMO.md`](../DEMO.md) — the local walkthrough: deploy, create a funded network, and watch this
  daemon prove and pay for it

- [`research/PROOF_SCHEDULER.md`](../research/PROOF_SCHEDULER.md) — the design, its economics and
  its failure semantics
- [`research/INSTANCE_FACTORY.md`](../research/INSTANCE_FACTORY.md) §5 — the enumeration seam this
  consumes
- [`research/UPGRADE_GOVERNANCE.md`](../research/UPGRADE_GOVERNANCE.md) §5.5-§5.6 — verifier and
  params rotations, and why one is pinned per checkpoint and the other deliberately is not
- [`docs/trust-graph/RUNBOOK.md`](./trust-graph/RUNBOOK.md) — the manual loop, now a fallback
