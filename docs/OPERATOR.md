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

> **Status.** The daemon (`zk/operator`) and the decision engine (`packages/operator-core`) are
> built in milestones M1-M2 of the proof-scheduler program; the vault it draws from is M3. This
> page is the frozen configuration contract they are built against, written at the interface
> freeze so the indexer and frontend could be built in parallel. Sections marked *(planned)*
> describe behaviour whose configuration shape is fixed but whose code lands in a later milestone.

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
snapshot     = "0x…"
params       = "./params.contributions.json"
eas          = "0x…"
submit_to    = "0x…"            # defaults to `snapshot`
depends_on   = []               # instance ids that must have a fresh root first

[[manifest]]
program      = "signer"
module       = "0x…"            # SignerSyncZkModule
trust_instance = "0x…"          # woken by MerkleRootUpdated on this instance
selection    = "./selection.json"

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
| `rpc` | JSON-RPC endpoint | required |
| `registry` | `InstanceRegistry` address | required |
| `chain_id` | expected chain; startup aborts on mismatch | read from chain |
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

*(The measured answer for sp1-sdk 6.3.1 — what it offers for request idempotency and status lookup
by requester — is recorded here at M1, and it decides whether `RequestOutcomeUnknown` is rare or
routine.)*

---

## 4. Self-hosting *(planned: M2)*

The hosted service sells convenience, not access. A community running the operator against its own
instance, with its own keys, produces the same root:

```bash
operator --config ./my-network.toml --once
```

with a config naming one instance and no `[paid]` section. Nothing about the on-chain path differs
from what we run: `submitProof` is permissionless, the journal binds the same values, and the root
that lands is byte-identical. The manual fallback — `taskfile/instances.sh`, the loop a human used
to run — stays documented in [`docs/trust-graph/RUNBOOK.md`](./trust-graph/RUNBOOK.md).

---

## 5. What the operator can and cannot promise

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

## 6. Related

- [`research/PROOF_SCHEDULER.md`](../research/PROOF_SCHEDULER.md) — the design, its economics and
  its failure semantics
- [`research/INSTANCE_FACTORY.md`](../research/INSTANCE_FACTORY.md) §5 — the enumeration seam this
  consumes
- [`research/UPGRADE_GOVERNANCE.md`](../research/UPGRADE_GOVERNANCE.md) §5.5-§5.6 — verifier and
  params rotations, and why one is pinned per checkpoint and the other deliberately is not
- [`docs/trust-graph/RUNBOOK.md`](./trust-graph/RUNBOOK.md) — the manual loop, now a fallback
