# Local Testing — contributions (the funding program)

> Internal test procedure. This page is not part of the public product documentation.

This guide covers the **contributions program**: claim/nominate a contribution, let others
rate its value, and split a funding pool by those valuations weighted by the raters' proven
trust-graph reputation — the whole path computed inside one SP1 proof and paid out through
`MerkleFundDistributor`. The trust-graph / signer-sync lane has its own guide
([`../trust-graph/local-testing.md`](../trust-graph/local-testing.md)) and this one mirrors
its shape.

The instance has **two input accumulators**, frozen together at one checkpoint:

- **slot A** — the trust vouch graph (a read-only `TrustAccumulatorMirror` over the trust
  instance's accumulator), which drives stage-1 reputation;
- **slot B** — the contribution log (claims / responses / valuations) folded by the
  `ContributionResolver`, which drives stage-2 scoring.

> **`task demo` drives a round too, with different numbers.** The product demo
> ([`../quickstart.md`](../quickstart.md)) seeds this same 6-persona round on top of its
> own 21-edge community graph and lets the proof-scheduler daemon land the root (a manifest entry on
> the curated tier). Rater reputation there is computed over the **composed** graph, so the wei-exact
> expectations below do not apply to it — they hold for this guide's flow, where the fixture's six
> vouches are the entire graph.

Two ways to exercise it locally:

- **[Quick check](#quick-check--parity--core)** — no chain, no UI, no proving. The core-crate
  tests + the four-way parity gate (native Rust / SP1 guest / Solidity / TS). Best for verifying
  a change to the encodings or the scoring math end-to-end in seconds.
- **[Full round on anvil](#full-round-on-anvil)** — one complete round from a clean checkout:
  deploy the whole instance, seed the 6-persona worked example through the real UI seams, prove
  it, submit the root, fund with test USDC, and claim to **wei-exact** payouts — then a second
  round with a claim deadline and a sweep.

Ports/services used by the full round:

| Service | URL | Started by |
|---|---|---|
| anvil | http://localhost:8545 | `anvil --port 8545` (or `task services:start-all`) |
| Ponder indexer | http://127.0.0.1:65421 | `cd packages/indexer && npm run dev` |
| IPFS (score blobs) | http://localhost:5001 (api) | `task services:start-all` / kubo `ipfs daemon` |
| Postgres (Ponder) | localhost:6432 | `task services:start-all` / embedded-postgres |
| frontend (optional) | http://localhost:3000 | `pnpm frontend dev` |

Prereqs (one-time): Foundry, Rust, `jq`, Node 21+/pnpm and the SP1 toolchain —
[`../setup.md`](../../../docs/build/setup.md) installs each. Then:

```bash
task setup            # pnpm install + forge install (use CI=true pnpm install if a TTY prompt wedges it)
task build:forge
task zk:build         # the SP1 guest ELFs — nothing else builds them, and everything below needs them
```

The full round also needs the prover built with the `fetch` feature (on-chain reconstruction is
feature-gated):

```bash
cd zk/prover && cargo build --release --features fetch
```

---

## Quick check — parity + core

No chain, no services. This is the fastest way to know the scoring semantics and every byte
encoding still agree across all four languages.

```bash
# (1) the core crate: record decoding, reconciliation, two-stage scoring, the 6-persona
#     worked-example fixture (verified to the wei against an independent recompute), the
#     property suite, and the §5 anti-gaming vector suite.
cargo test -p contributions-core

# (2) the four-way parity gate: regenerates tests/golden/contributions.json and fails if the
#     encodings drifted without regenerated vectors, then runs the Rust / Solidity / TS /
#     guest==native legs for the program.
task zk:parity PROGRAM=contributions
```

What the parity gate checks, leg by leg:

- **native** — `contributions-core` reproduces the golden vectors (`tests/golden/contributions.json`);
- **Solidity** — `contracts/test/unit/golden/ContributionsGoldenVectors.t.sol` recomputes the 21-word
  `paramsHash`, the seed-set root, the fold `kind` tags, the accumulator leaf/fold, and the full
  fixture journal encode + digest;
- **TS** — `packages/frontend/lib/contributions/golden.test.ts` recomputes everything from the fixture
  input (reputation, per-claim scores, payouts, blob, CID, every journal field);
- **guest==native** — the SP1 guest's committed public values equal the native journal encoding
  byte-for-byte.

`SP1_PROVER=mock` is pinned for the executor-only leg (the `cpu` backend allocates a ~5 GiB prover
and OOMs small boxes). The first run builds the guest ELF (minutes); after that it's seconds.

---

## Full round on anvil

One complete round from a clean checkout to wei-exact payouts. The seeded round reproduces the
cross-lane oracle fixture (`crates/contributions-core/src/testutil.rs::fixture()`,
golden-locked in `tests/golden/contributions.json`), so **every number below is a hard expected
value** — if your run prints something else, something regressed.

**Startup order matters: infra services → deploy → frontend → indexer.** The deploy writes
`.docker/deployment_summary.json`; the frontend's `predev` (`config:generate` + `wagmi:generate`)
regenerates the config and the ABIs in `packages/frontend/lib/contract-abis` *from that summary*; and the
indexer imports those ABIs. Start the indexer before the frontend has regenerated them and it can
run against stale ABIs/addresses. Keep the indexer **down during the deploy** too — its RPC flood
can drop a deploy transaction (see the troubleshooting note on the deploy hang).

### 1. Stand up the infra services

**Docker path** (the normal one):

```bash
task services:start-all      # anvil :8545 + docker compose: kubo (5001/8080) + postgres 17 (6432)
```

**No-docker fallback**:

```bash
anvil --port 8545 &

# kubo binary, offline mode is fine (we only pin + cat locally)
IPFS_PATH=~/.ipfs-dev ipfs init 2>/dev/null; IPFS_PATH=~/.ipfs-dev ipfs daemon --offline &

# any postgres serving postgresql://ponder:ponder@localhost:6432/ponder works;
# the embedded-postgres npm package is a zero-install option:
#   new EmbeddedPostgres({ databaseDir:'./pgdata', user:'ponder', password:'ponder', port:6432 })
#   → initialise() → start() → createDatabase('ponder')
```

`packages/indexer/.env.local` needs the DB URL. Contributions params are reconstructed from the typed
controller's event history and matched to each checkpoint hash:

```
DATABASE_URL=postgresql://ponder:ponder@localhost:6432/ponder
```

### 2. Deploy

The deployer key is `.env`'s `FUNDED_KEY`, which is **not** an anvil default account — fund it
first (or run `pnpm deploy:create-deployer`):

```bash
DEPLOYER=$(cast wallet address $(grep '^FUNDED_KEY=' .env | cut -d= -f2))
cast rpc anvil_setBalance $DEPLOYER 0x21e19e0c9bab2400000 --rpc-url http://127.0.0.1:8545

CI=true pnpm deploy:contracts
```

This stands up the contributions ROUND FACTORY and creates the demo round through it, the same
one-transaction path a community's authority uses from the app:

1. `DeployContributionsFactory.s.sol` — the shared contributions `SP1JournalVerifier` (a dev
   placeholder vkey over the mock gateway when `CONTRIBUTIONS_PROGRAM_VKEY` is unset; the factory
   refuses a zero vkey), the `ContributionsParamsControllerDeployer`, the `ContributionsFactory`
   itself, and its append-only `REGISTRAR_ROLE` grant. Written to
   `.docker/contributions_factory_deploy.json` → `deployment_summary.json` under
   `contributionsFactory`.
2. `CreateDevContributionsRound.s.sol` — `factory.createInstance` against dev network 0 (the
   deployer holds its constitutional role at this point in the chain): resolver + 3 schemas +
   one-shot allowlist, `TrustAccumulatorMirror` (bound via the one-shot `bindSnapshot`, so only
   `trigger()` can mint checkpoints), `MerkleSnapshot`, `MerkleFundDistributor` (fee 0,
   fee recipient = the admin — the factory convention), and the typed params controller. It
   provisions `params.contributions.json` from `tests/e2e/params.contributions.template.json` if
   absent; the file is READ-only now (schema UIDs are factory-derived, never written back).

There is no `program: "contributions"` entry in the networks config any more: the indexer
catalogs the round from the factory's `ContributionsInstanceCreated` event and serves it at
`GET /contributions/instances`, which is where the frontend reads it.

The creation script also writes the round's full deploy-time record — contracts, typed params
controller, parent accumulator, pool token, and the factory-derived schema UIDs — to
`.docker/contributions_round_dev_deploy.json`. That artifact is what the operator-side tasks
(`contributions:*`, `demo:*`) and the seed driver read, so seeding and proving work with **no
indexer running at all** — and, with one running, the seed driver still targets the round this
deploy minted rather than whatever the catalog (which trails Ponder's finality window) lists
first.

### 3. Start the frontend, then the indexer (in that order)

```bash
pnpm frontend dev         # http://localhost:3000 — predev regenerates config + ABIs from the deploy summary
cd packages/indexer && npm run dev # ponder dev on :65421 — predev runs drizzle migrate + networks:link; imports the ABIs above
```

The frontend first: its `predev` regenerates `packages/frontend/lib/contract-abis` and the network config
from `.docker/deployment_summary.json`, which the indexer then imports. (For a pure CLI/indexer
run without the UI you can regenerate the ABIs directly with `pnpm frontend wagmi:generate`
before starting the indexer — but keep the order.) Contributions networks route to the round view;
keep `NEXT_PUBLIC_TG_REVIEW_FIXTURES` unset so the pages read the live API.

### 4. Seed the round (the 6-persona fixture)

```bash
task contributions:create-contribution-round-network
```

This runs, in order (user actions go through `packages/frontend/scripts/contribution-round.ts` — the
exact `SchemaManager.encode` → `EAS.attest` seam the frontend screens drive):

1. **Trust lane** — the fixture's six vouches through the trust resolver:
   SEED→ALICE 100, SEED→BOB 80, SEED→CAROL 60, SEED→DAVE 90, ALICE→BOB 50,
   DAVE→CAROL 40. Personas are anvil accounts 0–5 (SEED = account 0 = the
   `trusted_seeds` entry in the params template). EVE gets no vouch — her
   reputation stays below `min_rater_rep_fp`.
2. **C4, the out-of-window claim** — BOB self-claims *before* the window opens.
3. **Window open** — `task contributions:open-round-window`: sets
   `round_start = latest block timestamp + 1`, `round_end = +7 days` in
   `params.contributions.json`, then publishes the complete tuple through
   `ContributionsParamsController.updateParams`, executed by the dev network's 1-of-1 Safe. The
   controller atomically updates the snapshot and registry hashes and emits the public preimage.
   C4 is now genuinely outside the window.
4. **The in-window fixture sequence** — C1 ALICE self-claim [ALICE:100];
   C2 BOB claim [BOB:60, CAROL:40]; C3 ALICE nomination [EVE:50, DAVE:50];
   C5 BOB self-claim [BOB:100]; CAROL accepts C2; EVE rejects C3; then the 12
   valuations incl. DAVE's LWW re-rate of C1 (80 → 90), ALICE's self-rating of
   C1 (filtered), EVE's dust-rep rating (filtered), CAROL's rating of C5
   (collaborator-discounted via the BOB/CAROL co-claim C2), and DAVE's rating
   of C4 (inert).

Claim UIDs persist in `.docker/contribution_round_dev_state.json`.

### 5. The operator loop

```bash
task contributions:trigger        # freeze BOTH accumulators → checkpoint id 0
task contributions:prove-round    # fetch → execute (guest==native) → mock-groth16 prove → pin blob
task contributions:submit-proof   # submitProof with the args prove-round saved
```

`prove-round` reconstructs `contributions_input.json` from the two on-chain checkpoints
(self-checked by re-folding to the checkpointed accumulators), byte-asserts guest == native,
writes `.trustgraph/contributions/contributions_proof.bin` + `contributions_blob.json`, pins the
blob to kubo, and saves the submit args to `.docker/contributions_round_submit.env`.

**Expected round-1 blob** (`.trustgraph/contributions/contributions_blob.json`) — these are the
merkle VALUES, byte-identical to the golden fixture payouts, Σ = the 5e9 pool, EVE absent:

```json
{"0x15d34aaf54267db7d7c367839aaf71a00a2c6a65":"94160282",
 "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc":"1184138552",
 "0x70997970c51812dc3a010c7d01b50e0d17dc79c8":"3509435528",
 "0x90f79bf6eb2c4f870365e785982e1f101e93b906":"206730620",
 "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266":"5535018"}
```

(`execute` also prints `totalValue: 5000000000`. The `outputRoot` depends only on these
`(address, value)` pairs, so it is reproducible too:
`0x939b892519f253bc0a88398dccc850cfd7040f0346095bca1bd9cdf37dd16496`.)

### 6. Indexer verification

Give ponder ~10s after `submit-proof`, then confirm the indexer independently re-derived the
proven root from its own tables (`verified: true`) and served the golden per-claim scores:

```bash
SNAP=$(jq -r '.merkle_snapshot' .docker/contributions_round_dev_deploy.json)

curl -s http://127.0.0.1:65421/contributions/$SNAP/round | jq '{verified, numClaims, numRecipients, totalValue}'
# → {"verified": true, "numClaims": 4, "numRecipients": 5, "totalValue": "5000000000"}

curl -s http://127.0.0.1:65421/contributions/$SNAP/claims | jq '[.claims[] | {title, scoreFp}]'
```

Expected S(c) values (fp, scale 1e18 — golden `.compute.claimScores`):

| claim | scoreFp |
|---|---|
| C1 "Indexer contribution lane" | `506824390837398103` |
| C5 "Deployment tooling" | `127318578491555229` |
| C2 "Joint protocol research" | `68631029410138147` |
| C3 "Community-call facilitation" | `48379068918605035` |
| C4 "Out-of-window write-up" | *(no score row — unscored)* |

The audit view shows every filter/discount decision (uids from
`.docker/contribution_round_dev_state.json`):

```bash
C1=$(jq -r .claims.C1 .docker/contribution_round_dev_state.json)
curl -s http://127.0.0.1:65421/contributions/$SNAP/audit/$C1 | jq '.valuations[] | {rater, score, status, reason}'
# ALICE (0x7099…) → filtered/selfValuation; EVE (0x9965…) → filtered/belowMinRep;
# DAVE counted at 90 (the LWW winner — the superseded 80 row carries superseded=true
# in the contribution_valuation table); BOB/CAROL/SEED counted.
C5=$(jq -r .claims.C5 .docker/contribution_round_dev_state.json)
curl -s http://127.0.0.1:65421/contributions/$SNAP/audit/$C5 | jq '.valuations[] | {rater, score, status, discountFp}'
# CAROL → discounted, discountFp 500000000000000000 (co-claims C2 with BOB); SEED counted.
```

### 7. Fund + claim (wei-exact)

```bash
task contributions:fund-round AMOUNT=5000000000    # 5,000 tUSDC; approve + 3-arg distribute, expectedRoot pinned
task contributions:claim-payouts INDEX=0           # all six personas via the proof-bundle API
```

Every claim pays `mulDiv(amountFunded − feeAmount, value, totalMerkleValue)`. A factory-created
round is born with **fee 0** (fee recipient = the round admin; the admin can set a fee later), so
`feeAmount = 0` and each persona's claim equals its merkle value exactly:

| persona | merkle value | claimed (fee 0) |
|---|---|---|
| ALICE | 3509435528 | **3509435528** |
| BOB | 1184138552 | **1184138552** |
| CAROL | 206730620 | **206730620** |
| DAVE | 94160282 | **94160282** |
| SEED | 5535018 | **5535018** |
| EVE | — | **0** (no leaf) |

No fee moves (fee 0 at creation); any quantization dust stays in the distributor (this round has
no deadline, so its dust is never sweepable — a deliberate property of the open-ended overload).

```bash
TOKEN=$(jq -r '.usdc' .docker/proving_vault_deploy.json)
cast call $TOKEN "balanceOf(address)(uint256)" 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --rpc-url http://127.0.0.1:8545
# → 3404152462   (ALICE)
```

### 8. Round 2 — repeatability, claim deadline, sweep

Proves rounds are repeatable over the same instance and exercises the sweep path:

```bash
task contributions:create-round-2
# window rotates (open-round-window again: new paramsHash), then:
#   CAROL claims "Round-2 retrospective" [CAROL:60, BOB:40]; BOB accepts;
#   SEED rates 80; DAVE rates 40.

task contributions:trigger        # checkpoint id 1
task contributions:prove-round    # round-1 claims/valuations are now provably out-of-window
task contributions:submit-proof   # monotonic: checkpoint 1 > 0

# fund WITH a claim deadline (the 4-arg distribute overload):
DEADLINE=$(( $(cast block latest -f timestamp --rpc-url http://127.0.0.1:8545) + 3600 ))
task contributions:fund-round AMOUNT=5000000000 DEADLINE=$DEADLINE
task contributions:claim-payouts INDEX=1 AS=SEED,BOB,CAROL     # DAVE deliberately does not claim
```

Expected round-2 blob (raters SEED+DAVE split the 1% carve-out pro-rata reputation; CAROL/BOB
split 99% of the pool 60/40):

```json
{"0x15d34aaf54267db7d7c367839aaf71a00a2c6a65":"32640032",
 "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc":"1980001980",
 "0x90f79bf6eb2c4f870365e785982e1f101e93b906":"2970002970",
 "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266":"17355018"}
```

Claims: CAROL **2970002970**, BOB **1980001980**, SEED **17355018** (fee 0, so each claim is its
merkle value exactly). Then close the window and sweep:

```bash
cast rpc evm_setNextBlockTimestamp $((DEADLINE + 1)) --rpc-url http://127.0.0.1:8545
cast rpc anvil_mine 1 --rpc-url http://127.0.0.1:8545

# a late claim now reverts ClaimWindowClosed():
task contributions:claim-payouts INDEX=1 AS=DAVE    # ← reverts, as designed

task contributions:sweep INDEX=1
# swept = 5000000000 − 4967357968 = 32640032 back to the funder
# (exactly DAVE's unclaimed value; fee 0, no dust this round)
```

### 9. Third-party re-derivation (audited by construction)

Holding only chain data + the pinned blob, anyone re-derives every payout:

```bash
# the blob at the CID the journal committed:
curl -s -X POST "http://127.0.0.1:5001/api/v0/cat?arg=<cid from round API>" | sha256sum
# == the round's ipfsHash (round 1: 975b0b08…49ebcb)

# full recompute from chain (fetch re-folds the logs to the checkpointed accumulators,
# execute re-runs the exact guest semantics natively AND in the SP1 executor):
task contributions:prove-round ID=<checkpoint>
```

---

## Notes & troubleshooting

- **`SP1_PROVER=mock`** for every executor-only step (`vkey`, `execute`, dev proving against the
  MockSP1Gateway). The `cpu` backend eagerly allocates a ~5 GiB prover and OOMs small boxes; the
  taskfile pins mock. Real proving: `SP1_PROVER=cpu` needs `--features native-gnark` + ~16 GiB, or
  use the Succinct prover network.
- **`prove --groth16`** — the on-chain path always takes the Groth16-shaped blob; under
  `SP1_PROVER=mock` the seal is empty and only the dev MockSP1Gateway accepts it.
- **`--features fetch`** when building the prover, or the `contributions fetch` subcommand errors.
- **Params history** — the indexer refuses to publish derived scores unless a valid
  `ContributionsParamsUpdated` event tuple reproduces the checkpoint's pinned `paramsHash`.
  Rotate through the controller; direct snapshot hash mutation is unavailable on new instances.
- **`NEXT_PUBLIC_TG_REVIEW_FIXTURES` must stay OFF** (unset). It exists only for building and
  reviewing screens without live data; with it set to `1`, the pages read built-in review
  fixtures instead of the live API.
- **Trigger reverts `EpochNotElapsed`?** The round's epoch length (a `createInstance` argument,
  clamped to the factory's floor — 1 block on dev) paces `trigger()`. Mine blocks
  (`cast rpc anvil_mine 10`) or wait.
- **Trigger reverts `NotSnapshot`?** The mirror's one-shot `bindSnapshot` is missing — only
  possible with a hand-rolled deploy; `ContributionsFactory.createInstance` binds it in the
  creating transaction (as the legacy `DeployContributionsInstance` script did). This is the
  guard that makes `trigger()` the sole checkpoint mint, so both lanes are always frozen together
  (a directly-minted mirror checkpoint would otherwise leave the contribution lane at `(0,0)` and
  admit a contributions-blind proof — see [`research/audits/2026-07-M6.md`](../../../research/audits/2026-07-M6.md) M6-1).
- **Stale `packages/frontend/lib/contracts.ts` / `contract-abis` after a redeploy** — start the frontend
  before the indexer (§3): its `predev` runs `wagmi:generate` / `config:generate` off the fresh
  deploy summary, and the indexer imports those ABIs. Or regenerate directly with
  `pnpm frontend wagmi:generate`. Contract addresses are deterministic per deployer
  nonce, so they only drift when the deploy script's tx sequence changes.
- **Indexer crashes on a `MerkleRootUpdated` event (`Failed to fetch merkle tree from IPFS CID …`),
  and a fresh deploy / `forge clean` doesn't fix it?** The IPFS daemon is down. Each proven root
  pins its `{account: value}` blob to the local kubo node; the indexer *must* re-fetch that blob to
  rebuild proofs, and that fetch (`src/merkle.ts`) is **not** swallowed — a dead gateway kills the
  handler. Redeploying can't help: the blobs (and the crash) live in IPFS, not the chain. This is
  distinct from the harmless, caught `getStateCount returned no data ("0x")` line — that one is the
  `merkleSnapshot:setup` handler reading at the historical start block (block 1), before any
  snapshot is deployed, and is always ignored. Fix: bring the gateway back (`curl -s -m4
  http://127.0.0.1:8080/ipfs/<any-pinned-cid>` should return the score JSON; if it times out,
  restart kubo — `IPFS_PATH=<repo> ipfs daemon`), confirm the round's CIDs are still pinned
  (`ipfs pin ls --type=recursive`), then restart the indexer. The pins survive a daemon restart as
  long as the repo dir is intact.
- **`pnpm deploy:contracts` hangs on a step (forge spamming `eth_getTransactionReceipt`)?** A
  broadcast tx was dropped and the rest queued behind the nonce gap (`cast rpc txpool_status` shows
  `pending: 0x0` with a nonzero `queued`). Almost always the **running indexer flooding the RPC**
  dropped the batch's first send. Fix: stop the indexer during the deploy, restart anvil fresh to
  clear the poisoned txpool, and redeploy — the orchestrator sends one tx at a time (`--slow`) so a
  gap can't form, but a fresh chain is needed to drain the already-queued txs.
- **`PONDER_START_BLOCK`** — only needed on a mainnet-fork anvil (start the backfill above the
  fork block); a plain local anvil backfills from block 1 by default.
- **`CI=true pnpm install`** in headless environments — pnpm's TTY prompts otherwise wedge
  `task setup`.

For the operator/role view and the independent re-derivation recipe, see
[`runbook.md`](./runbook.md); for the design,
[`../../../research/CONTRIBUTION_FUNDING.md`](../../../research/CONTRIBUTION_FUNDING.md) and
[`interfaces.md`](./interfaces.md).
