# Contributions — local testing (the M5 round, end to end)

One full contribution-funding round on a local anvil, from a clean checkout to
wei-exact payouts: seed the 6-persona worked example, prove it, submit the root,
fund with test USDC, claim through the proof-bundle API, then run a second round
(with a claim deadline + sweep) over the same instance.

The seeded round reproduces the cross-lane oracle fixture
(`packages/contributions-core/src/testutil.rs::fixture()`, golden-locked in
`test/golden/contributions.json`), so every number below is a **hard expected
value** — if your run prints something else, something regressed.

Related: [`RUNBOOK.md`](./RUNBOOK.md) (operator view),
[`ARCHITECTURE.md`](./ARCHITECTURE.md), [`INTERFACES.md`](./INTERFACES.md),
repo-root [`LOCAL_TESTING.md`](../../LOCAL_TESTING.md) (trust-graph flow this
mirrors).

## 0. Prerequisites

From a clean checkout:

```bash
task setup          # pnpm install + forge install (CI=true pnpm install if a TTY prompt wedges it)
task build:forge
```

Rust toolchain + the SP1 SDK (`sp1up`) for the prover. The prover build wants
the `fetch` feature (on-chain reconstruction is feature-gated):

```bash
cd zk/prover && cargo build --release --features fetch
```

## 1. Stand up the stack

Four services: anvil (:8545), IPFS API (:5001), postgres (:6432), ponder
(:65421).

**Docker path** (the normal one):

```bash
task services:start-all     # anvil + docker compose: kubo (5001/8080) + postgres 17 (6432)
```

**No-docker fallback** (what the M5 run on this box used):

```bash
anvil --port 8545 &

# kubo binary, offline mode is fine (we only pin + cat locally)
IPFS_PATH=~/.ipfs-dev ipfs init 2>/dev/null; IPFS_PATH=~/.ipfs-dev ipfs daemon --offline &

# any postgres serving postgresql://ponder:ponder@localhost:6432/ponder works;
# the embedded-postgres npm package is a zero-install option:
#   new EmbeddedPostgres({ databaseDir:'./pgdata', user:'ponder', password:'ponder', port:6432 })
#   → initialise() → start() → createDatabase('ponder')
```

Then the indexer (after the deploy in §2, or restart it after):

```bash
cd indexer && npm run dev      # ponder dev on :65421; predev runs drizzle migrate + networks:link
```

`indexer/.env.local` needs:

```
DATABASE_URL=postgresql://ponder:ponder@localhost:6432/ponder
CONTRIBUTIONS_PARAMS_PATH=<absolute path to>/params.contributions.json
```

## 2. Deploy

The deployer key is `.env`'s `FUNDED_KEY`, which is **not** an anvil default
account — fund it first (or run `pnpm deploy:create-deployer`):

```bash
DEPLOYER=$(cast wallet address $(grep '^FUNDED_KEY=' .env | cut -d= -f2))
cast rpc anvil_setBalance $DEPLOYER 0x21e19e0c9bab2400000 --rpc-url http://127.0.0.1:8545

CI=true pnpm deploy:contracts
```

This deploys everything, including the whole contributions instance
(`DeployContributionsInstance.s.sol`): resolver + 3 schemas + allowlist,
`TrustAccumulatorMirror` (bound to the snapshot via the one-shot
`bindSnapshot`), mock-gateway `SP1JournalVerifier` (dev: no
`CONTRIBUTIONS_PROGRAM_VKEY` set), `MerkleSnapshot`, `MerkleFundDistributor`
(3% fee, fee recipient = deployer), and the `TestUSDC` pool token (1,000,000
tUSDC minted to the deployer). It provisions `params.contributions.json` from
`test/e2e/params.contributions.template.json` if absent and writes the
registered schema UIDs back into it.

Addresses land in `.docker/deployment_summary.json` under the
`program: "contributions"` network; the frontend + indexer configs update
automatically.

## 3. Seed the round (the 6-persona fixture)

```bash
task contributions:create-contribution-round-network
```

This runs, in order (user actions go through
`frontend/scripts/contribution-round.ts` — the exact `SchemaManager.encode` →
`EAS.attest` seam the frontend screens drive):

1. **Trust lane** — the fixture's six vouches through the trust resolver:
   SEED→ALICE 100, SEED→BOB 80, SEED→CAROL 60, SEED→DAVE 90, ALICE→BOB 50,
   DAVE→CAROL 40. Personas are anvil accounts 0–5 (SEED = account 0 = the
   `trusted_seeds` entry in the params template). EVE gets no vouch — her
   reputation stays below `min_rater_rep_fp`.
2. **C4, the out-of-window claim** — BOB self-claims *before* the window
   opens.
3. **Window open** — `task contributions:open-round-window`: sets
   `round_start = latest block timestamp + 1`, `round_end = +7 days` in
   `params.contributions.json`, recomputes the 21-word `paramsHash`
   (`trustgraph-prover contributions paramshash`), and pins it with the
   operational `setParamsHash`. C4 is now genuinely outside the window.
4. **The in-window fixture sequence** — C1 ALICE self-claim [ALICE:100];
   C2 BOB claim [BOB:60, CAROL:40]; C3 ALICE nomination [EVE:50, DAVE:50];
   C5 BOB self-claim [BOB:100]; CAROL accepts C2; EVE rejects C3; then the 12
   valuations incl. DAVE's LWW re-rate of C1 (80 → 90), ALICE's self-rating of
   C1 (filtered), EVE's dust-rep rating (filtered), CAROL's rating of C5
   (collaborator-discounted via the BOB/CAROL co-claim C2), and DAVE's rating
   of C4 (inert).

Claim UIDs persist in `.docker/contribution_round_dev_state.json`.

## 4. The operator loop

```bash
task contributions:trigger        # freeze BOTH accumulators → checkpoint id 0
task contributions:prove-round    # fetch → execute (guest==native) → mock-groth16 prove → pin blob
task contributions:submit-proof   # submitProof with the args prove-round saved
```

`prove-round` reconstructs `contributions_input.json` from the two on-chain
checkpoints (self-checked by re-folding to the checkpointed accumulators),
byte-asserts guest == native, writes `zk/prover/contributions_proof.bin` +
`contributions_blob.json`, pins the blob to kubo, and saves the submit args to
`.docker/contributions_round_submit.env`.

**Expected round-1 blob** (`zk/prover/contributions_blob.json`) — these are the
merkle VALUES, byte-identical to the golden fixture payouts, Σ = the 5e9 pool,
EVE absent:

```json
{"0x15d34aaf54267db7d7c367839aaf71a00a2c6a65":"94160282",
 "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc":"1184138552",
 "0x70997970c51812dc3a010c7d01b50e0d17dc79c8":"3509435528",
 "0x90f79bf6eb2c4f870365e785982e1f101e93b906":"206730620",
 "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266":"5535018"}
```

(`execute` also prints `totalValue: 5000000000`. The `outputRoot` depends only
on these `(address, value)` pairs, so it is reproducible too:
`0x939b892519f253bc0a88398dccc850cfd7040f0346095bca1bd9cdf37dd16496`.)

## 5. Indexer verification

Give ponder ~10s after `submit-proof`, then:

```bash
SNAP=$(jq -r '.networks[] | select(.program=="contributions") | .contracts.merkleSnapshot' .docker/deployment_summary.json)

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

## 6. Fund + claim (wei-exact)

```bash
task contributions:fund-round AMOUNT=5000000000    # 5,000 tUSDC; approve + 3-arg distribute, expectedRoot pinned
task contributions:claim-payouts INDEX=0           # all six personas via the proof-bundle API
```

Every claim pays `mulDiv(amountFunded − feeAmount, value, totalMerkleValue)`
with `feeAmount = 3% = 150000000` exactly. Expected final tUSDC balances:

| persona | merkle value | claimed (× 0.97, floor) |
|---|---|---|
| ALICE | 3509435528 | **3404152462** |
| BOB | 1184138552 | **1148614395** |
| CAROL | 206730620 | **200528701** |
| DAVE | 94160282 | **91335473** |
| SEED | 5535018 | **5368967** |
| EVE | — | **0** (no leaf) |

Fee recipient (= deployer in dev) gains exactly `150000000`; `2` base units of
quantization dust stay in the distributor (this round has no deadline, so its
dust is never sweepable — a deliberate property of the open-ended overload).

```bash
TOKEN=$(jq -r '.networks[] | select(.program=="contributions") | .contracts.poolToken' .docker/deployment_summary.json)
cast call $TOKEN "balanceOf(address)(uint256)" 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --rpc-url http://127.0.0.1:8545
# → 3404152462
```

## 7. Round 2 — repeatability, claim deadline, sweep

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

Expected round-2 blob (raters SEED+DAVE split the 1% carve-out pro-rata
reputation; CAROL/BOB split 99% of the pool 60/40):

```json
{"0x15d34aaf54267db7d7c367839aaf71a00a2c6a65":"32640032",
 "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc":"1980001980",
 "0x90f79bf6eb2c4f870365e785982e1f101e93b906":"2970002970",
 "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266":"17355018"}
```

Claims: CAROL **2880902880**, BOB **1920601920**, SEED **16834367** (each
value × 0.97, floored). Then close the window and sweep:

```bash
cast rpc evm_setNextBlockTimestamp $((DEADLINE + 1)) --rpc-url http://127.0.0.1:8545
cast rpc anvil_mine 1 --rpc-url http://127.0.0.1:8545

# a late claim now reverts ClaimWindowClosed():
task contributions:claim-payouts INDEX=1 AS=DAVE    # ← reverts, as designed

task contributions:sweep INDEX=1
# swept = 4850000000 − 4818339167 = 31660833 back to the funder
# (DAVE's unclaimed 31660831 + 2 dust)
```

## 8. Third-party re-derivation (the "audited by construction" check)

Holding only chain data + the pinned blob, anyone re-derives every payout:

```bash
# the blob at the CID the journal committed:
curl -s -X POST "http://127.0.0.1:5001/api/v0/cat?arg=<cid from round API>" | sha256sum
# == the round's ipfsHash (round 1: 975b0b08…49ebcb)

# full recompute from chain (fetch re-folds the logs to the checkpointed accumulators,
# execute re-runs the exact guest semantics natively AND in the SP1 executor):
task contributions:prove-round ID=<checkpoint>
```

## Gotchas

- **`SP1_PROVER=mock`** for every executor-only step (`vkey`, `execute`, and
  dev proving against the MockSP1Gateway). The `cpu` backend eagerly allocates
  a ~5 GiB prover and OOMs small boxes. The taskfile pins this.
- **`prove --groth16`**: the on-chain path always takes the Groth16-shaped
  blob; under `SP1_PROVER=mock` the seal is empty and only the dev
  MockSP1Gateway accepts it. Real proving: `SP1_PROVER=cpu` needs
  `--features native-gnark` + ~16 GiB; or use the Succinct prover network.
- **`--features fetch`** when building the prover, or the
  `contributions fetch` subcommand errors out.
- **`CONTRIBUTIONS_PARAMS_PATH`**: the indexer refuses to publish derived
  scores unless the sidecar params file's 21-word hash reproduces the
  snapshot's on-chain `paramsHash` at ingest time. Keep
  `params.contributions.json` exactly in sync (the
  `contributions:open-round-window` task maintains it; rotate params → the
  file must rotate in the same breath, BEFORE `submit-proof`).
- **`PONDER_START_BLOCK`**: only needed on a mainnet-fork anvil (start the
  backfill above the fork block). Plain local anvil backfills from block 1 by
  default.
- **Stale `frontend/lib/contracts.ts` after a redeploy**: `cd frontend &&
  npm run wagmi:generate` (the `predev`/`prebuild` hooks run it for you when
  using `npm run dev`). Contract addresses are deterministic per deployer
  nonce, so they only drift when the deploy script's tx sequence changes.
- **`CI=true pnpm install`** in headless environments — pnpm's TTY prompts
  otherwise wedge `task setup`.
- **`NEXT_PUBLIC_CONTRIBUTIONS_MOCKS` must stay OFF** (unset). It exists only
  for building screens before an indexer exists; with it on, the driver and
  the pages read mock fixtures instead of the live API.
- **Trigger reverts `EpochNotElapsed`?** `CONTRIBUTIONS_EPOCH_LENGTH` (default
  10 blocks in dev) paces `trigger()`. Mine blocks
  (`cast rpc anvil_mine 10`) or wait.
- **Trigger reverts `NotSnapshot`?** The mirror's one-shot `bindSnapshot` is
  missing — only possible with a hand-rolled deploy;
  `DeployContributionsInstance` binds it for you.
