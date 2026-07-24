# Local Testing — the hypercerts program

This guide covers the **hypercerts instance** (atproto records → envelope-1 proof → trust-weighted
`{node → score}` root). The **EAS/trust-graph** local-testing guide is
[`/LOCAL_TESTING.md`](../../LOCAL_TESTING.md); operations for a real deployment are in
[`RUNBOOK.md`](./RUNBOOK.md); third-party epoch reproduction is [`REPRODUCE.md`](./REPRODUCE.md).

Two ways to exercise it locally:

- **[Quick check — `task e2e`](#quick-check--task-e2e)** — one command, committed fixture, no
  network. Deploys the instance on a throwaway anvil, anchors the fixture repos, proves through
  the guest, and lands the root. Best for verifying a change end-to-end fast.
- **[Full pipeline — real data, real proofs](#full-pipeline--real-data-real-proofs)** — real
  repos fetched from the **live production PDS** (`certified.one`), a real Groth16 proof, and
  `submitProof` against Succinct's real SP1 gateway on a mainnet-fork anvil. Zero mocks.

Prereqs are the same as the main guide (Foundry, Rust, `jq`, the SP1 toolchain via `sp1up`).
The quick check needs nothing else — the seeded fixture is committed. The full pipeline needs
network access, and (for the real proof) either the Succinct prover network or a 16–32 GiB box.

---

## Quick check — `task e2e`

```bash
task e2e            # or: bash test/e2e/run.sh
```

The e2e runs **four stages** and the last one is the full hypercerts pipeline on a throwaway
anvil: deploy the lane-2-only instance (`EmptyLaneAccumulator` + `AnchorRegistry` +
`SP1JournalVerifier` + `MerkleSnapshot`), register the fixture's two DIDs through the registrar
gate, anchor both repo heads, `trigger()` (checkpoints both lanes), prove the two-repo fixture
through the guest (`guest == native ✓`), `submitProof`, and assert the root + `skippedDigest`
landed and the instance resolves via `InstanceRegistry`. Look for **`E2E HYPERCERTS PASS`**.

The SNARK check is mocked at the gateway seam (`MockSP1Gateway`) — everything else (journal
binding, vkey pinning, envelope-1 verification in the guest, checkpoint wiring) is the production
path. The [full pipeline](#full-pipeline--real-data-real-proofs) below is the zero-mock version.

### Test suites & guest checks (no chain)

```bash
cargo test -p hypercerts-core   # decode + decimal + binding + E1–E4 semantics/anti-gaming
                                # + full-pipeline + two-sided multi-repo fixture tests
cargo test -p envelopes         # envelope 1: CAR/commit/PLC/MST + 12-test conformance suite
forge test --match-path "test/unit/golden/*"   # incl. HypercertsGoldenVectors (Solidity parity)
cd frontend && pnpm test        # TS parity + the reduced-tier recompute from indexed edges

task zk:execute PROGRAM=hypercerts    # guest == native byte-assert over the seeded fixture
task zk:parity  PROGRAM=hypercerts    # the full aggregate: vectors drift-gate + all four layers
task zk:vkey    PROGRAM=hypercerts    # ⚠ vkeys depend on the exact toolchain build — see PROGRAMS.md
```

The anti-gaming battery lives in `packages/hypercerts-core/tests/semantics.rs` and
`tests/two_sided_fixture.rs`. First guest build takes minutes; afterwards seconds. If you edit
`packages/*`, force a guest rebuild (`sp1_build` doesn't watch path deps): `cd zk/program &&
cargo prove build`, then `touch zk/prover/build.rs` before the next host build.

---

## Full pipeline — real data, real proofs

The hypercerts lexicons are **live in production**: accounts on Hypercerts' ePDS
(`https://certified.one`, standard `plc.directory` identities) publish real records in every
collection the guest scores. This section runs the entire production path locally against them:
real repos, real envelope-1 verification, a real Groth16 proof, and the real SP1 gateway.

```bash
export RPC=http://127.0.0.1:8545
export PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil key 0
export PROVER=zk/prover/target/release/trustgraph-prover
export HC=.trustgraph/hypercerts   # where the prover reads/writes this program's generated files
```

### 1. Discover publishing DIDs

The ecosystem's live index is queryable per collection (agent docs:
[`hyperscan.dev/agents`](https://www.hyperscan.dev/agents), network stats at `/agents/stats`):

```bash
curl -s -X POST https://api.hi.gainforest.app/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ appCertifiedGraphFollow(first: 50) { edges { node { did } } } }"}' \
  | jq -r '.data.appCertifiedGraphFollow.edges[].node.did' | sort -u
# same pattern for appCertifiedBadgeAward, appCertifiedLinkEvm, orgHypercertsClaimActivity, …
```

The distinct-DID union across the scored collections is exactly the set the registrar gate
admits on a real deployment (the PDS allowlist — [`RUNBOOK.md`](./RUNBOOK.md) roles table).

### 2. Fetch witnesses + build the input

```bash
cd zk/prover && cargo build --release --features witness-atproto && cd ../..

# archive each repo (CAR at the current commit + PLC audit log) into an offline bundle —
# pipe the discovery query from step 1 straight in. `--keep-going` warns and skips a DID
# whose repo lives on another PDS instead of aborting the bundle; `--did` flags still work
# for a hand-picked list.
curl -s -X POST https://api.hi.gainforest.app/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ appCertifiedGraphFollow(first: 50) { edges { node { did } } } }"}' \
  | jq -r '.data.appCertifiedGraphFollow.edges[].node.did' | sort -u \
  | $PROVER witness fetch --stdin --keep-going --relay-url https://certified.one
# (archives into $HC/witness-archive by default; override with --archive-dir)

# archive → GuestInput: every manifest entry becomes an anchored envelope-1 witness, and
# badge-definition strongRefs are resolved across the witness CARs. stdout is the
# did/nodeId/head list you register + anchor in step 4 — keep it.
$PROVER hypercerts buildinput \
  --seed-did did:plc:rrpj5emotskpamzcr3642qk6 \
  --seed-did did:plc:wjthxgygf2hwaknaekgmmthi \
  > $HC/anchors.txt
# (reads $HC/witness-archive, writes $HC/hypercerts_input.json; --archive-dir/--out override)

# real repos through the SP1 guest, guest == native byte-assert (no proof yet).
# (On a <16 GiB box, prefix executor-only commands with SP1_PROVER=mock — see troubleshooting.)
$PROVER hypercerts execute $HC/hypercerts_input.json
```

`--seed-did` (repeatable) fills the §6.1 launch params' **trusted-seed set** — the partner-curated
trust root that every other score is derived from, so pick accounts you'd trust axiomatically. A
seed only matters if its repo is in the witness set, and the seed set is baked into `paramsHash`
(step 3 binds it on-chain) — settle it before deploying. The DIDs above are Hypercerts-team
accounts (`dao.certified.one`, `lukas.certified.one`); to find meaningful seeds behind opaque
DIDs, resolve handles:

```bash
while read -r did; do echo "$did $(curl -s https://plc.directory/$did | jq -r '.alsoKnownAs[0]')"; done
# (pipe the step-1 DID list in; auto-provisioned accounts have random-string handles)
```

Pass `--params params.json` instead to supply a full serialized `Params`. A node scoring zero
usually just means its records skip (self-evaluation, unregistered targets, …) — read
`hypercerts_skips.json` before suspecting the fetch.

### 3. Chain + instance (real gateway)

Fork a chain that has Succinct's SP1 verifier gateway in state, so a genuine Groth16 proof
verifies — same trick as the main guide's full-stack section:

```bash
# Terminal 1 (FORK_RPC_URL: archive-capable RPC for mainnet / OP mainnet).
# --block-time matters for step 8: Ponder treats the newest 30 blocks as unfinalized and only
# indexes past them when NEW blocks arrive; a mine-on-demand anvil whose last tx is your
# submitProof leaves that event 0 blocks from the tip — permanently invisible to the indexer.
anvil --fork-url "$FORK_RPC_URL" --chain-id 31337 --block-time 2

# Succinct's Groth16 gateway — same CREATE2 address on every chain, pinned in .env.example
# (must carry the verifier for the SDK version this repo pins, v6.3.1):
export GW=0x397A5f7f3dBd538f23DE225B51f532c34448dA9B
```

Deploy the whole instance in one labeled script. **`FUNDED_KEY=$PK` matters**: the deploy
script broadcasts with `FUNDED_KEY` (foundry auto-loads `.env`, and a repo `.env` usually pins
a key that isn't funded on your anvil — the CLI `--private-key` does *not* override it):

```bash
FUNDED_KEY=$PK \
SP1_VERIFIER_GATEWAY=$GW \
HYPERCERTS_VKEY=$($PROVER hypercerts vkey) \
HYPERCERTS_PARAMS_HASH=$($PROVER hypercerts paramshash $HC/hypercerts_input.json) \
forge script script/DeployHypercertsInstance.s.sol:DeployHypercertsInstance \
  --sig "run(string)" local --rpc-url $RPC --private-key $PK --broadcast --skip-simulation
export HC_REGISTRY=$(jq -r .anchor_registry .docker/hypercerts_instance_local_deploy.json)
export HC_SNAPSHOT=$(jq -r .merkle_snapshot .docker/hypercerts_instance_local_deploy.json)
```

`HYPERCERTS_EPOCH_LENGTH` defaults to 0 (unscheduled — `trigger()` works immediately); the
weekly pilot value is in the RUNBOOK. The deployer holds all three roles, so the registrar
gate below is just `$PK`.

### 4. Register + anchor the real heads

Each line of `$HC/anchors.txt` is one node. Register it (kind 1 = DID), anchor its head, and patch
the anchor's **real** `block.timestamp` into the input — the guest re-folds the anchor log and
must match the checkpointed `anchorAcc` exactly:

```bash
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
i=0
while read -r _ node head; do
  NODE=${node#nodeId=}; HEAD=${head#head=}
  cast send $HC_REGISTRY "registerNode(bytes32,uint8)" $NODE 1 --rpc-url $RPC --private-key $PK
  cast send $HC_REGISTRY "anchor(bytes32,uint8,bytes32,bytes32)" $NODE 1 $HEAD $ZERO32 \
    --rpc-url $RPC --private-key $PK
  TS=$(cast block latest --field timestamp --rpc-url $RPC)
  jq --argjson i $i --argjson ts $TS '.anchors[$i].block_timestamp = $ts' \
    $HC/hypercerts_input.json > tmp.json && mv tmp.json $HC/hypercerts_input.json
  i=$((i+1))
done < $HC/anchors.txt
```

### 5. Trigger the checkpoint

```bash
cast send $HC_SNAPSHOT "trigger()" --rpc-url $RPC --private-key $PK
cast call $HC_SNAPSHOT "anchorCheckpoints(uint256)(bytes32,uint64)" 0 --rpc-url $RPC
```

### 6. Prove (for real)

```bash
cd zk/prover
# Succinct prover network (no big box needed; key = your Succinct network account):
SP1_PROVER=network NETWORK_PRIVATE_KEY=$NETWORK_PRIVATE_KEY \
  cargo run --release --features "network" -- hypercerts prove ../../.trustgraph/hypercerts/hypercerts_input.json --groth16
# or local Groth16 — ~16–32 GiB + the native-gnark feature (gnark/Go toolchain):
#   SP1_PROVER=cpu cargo run --release --features "witness-atproto native-gnark" -- \
#     hypercerts prove ../../.trustgraph/hypercerts/hypercerts_input.json --groth16
cd ../..
```

The prover reads the **process environment only** (no `.env` loading) — put `SP1_PROVER=…` on
the command line as shown, or `export` it; a plain `VAR=value` line in zsh or an entry in `.env`
never reaches the prover. On the network backend you'll see request-submitted/polling logs right
after the `vkey:` line.

Writes `$HC/hypercerts_proof.bin`, the pinnable `$HC/hypercerts_blob.json`, and
`$HC/hypercerts_skips.json` (the `skippedDigest` preimage — every rule-Φ and record-level skip the
guest committed). Three modest repos run ~4M guest cycles, so proving cost is small.

### 7. submitProof + post-checks

Grab the journal args from `hypercerts execute` output (or the `prove` log), then land it:

```bash
EXEC=$($PROVER hypercerts execute $HC/hypercerts_input.json)
ROOT=$(echo "$EXEC" | awk '/^outputRoot:/{print $2}');   IPFS=$(echo "$EXEC" | awk '/^ipfsHash:/{print $2}')
CID=$(echo "$EXEC" | awk '/^cid:/{print $2}');           TOTAL=$(echo "$EXEC" | awk '/^totalValue:/{print $2}')
SKIPPED=$(echo "$EXEC" | awk '/^skippedDigest:/{print $2}')

# (no xxd? use: "0x$(od -An -v -tx1 $HC/hypercerts_proof.bin | tr -d ' \n')")
cast send $HC_SNAPSHOT "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,bytes)" \
  0 $ROOT $IPFS $CID $TOTAL $SKIPPED "0x$(xxd -p $HC/hypercerts_proof.bin | tr -d '\n')" \
  --rpc-url $RPC --private-key $PK

# the root is on-chain:
cast call $HC_SNAPSHOT "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" --rpc-url $RPC
```

`submitProof` recomputes the journal digest from the chain-pinned checkpoint (both lanes) +
stored `paramsHash` + submitted outputs, and the **real** gateway verifies the Groth16 seal
against the pinned vkey. When it lands, you have proven real production atproto data into an
on-chain root with no mock anywhere in the path.

> **No fork RPC / no proving hardware?** The same battery runs on a plain `anvil` with
> `GW=$(forge create test/mocks/MockSP1Gateway.sol:MockSP1Gateway …)` and `SP1_PROVER=mock`
> proofs — real data, real checkpoint wiring, mocked SNARK seam only. That variant is exactly
> the e2e's hypercerts stage generalized to fetched repos.

### 8. See it in the UI

The frontend ships a **Hypercerts** card (`config/networks.development.json`, the
`program: "hypercerts"` entry) that renders the proven scores read-only: a DID-keyed member
table with handles resolved via the PLC directory, instance statistics, and no attest flow.
Keep that entry's `merkleSnapshot` in sync with your deploy artifact.

```bash
# a. Tell the indexer about the instance (Ponder discovers contracts from the deployment summary).
#    On this fork the hypercerts instance is the ONLY live deployment, so REPLACE the networks
#    array — entries left over from an old plain-anvil session point at addresses that are not
#    contracts here, and Ponder's setup handlers halt fatally reading them (e.g. `votingDelay`
#    returned no data). If you genuinely have a trust-graph deploy on the SAME chain, use
#    `.networks += […]` instead.
jq --slurpfile hc .docker/hypercerts_instance_local_deploy.json \
  '.networks = [{ "id": "hypercerts", "contracts": {
     "merkleSnapshot": $hc[0].merkle_snapshot, "anchorRegistry": $hc[0].anchor_registry } }]' \
  .docker/deployment_summary.json > tmp.json && mv tmp.json .docker/deployment_summary.json

# b. Pin the blob so ingestion can fetch it (kubo from docker-compose.dev.yml):
curl -sF file=@$HC/hypercerts_blob.json \
  "http://localhost:5001/api/v0/add?cid-version=1&raw-leaves=true"

# c. Indexer env — write BOTH into indexer/.env.local so they survive shell restarts
#    (a lost PONDER_START_BLOCK on a fork = Ponder backfills every pre-fork mainnet block,
#    sweeps up production events, and never reaches yours — see the main guide's Indexer section):
cat >> indexer/.env.local <<EOF
PONDER_START_BLOCK=$(( $(cast rpc anvil_nodeInfo --rpc-url $RPC | jq -r '.forkConfig.forkBlockNumber') + 1 ))
HYPERCERTS_BUNDLE_PATH=$PWD/$HC/hypercerts_bundle.json
EOF
pnpm indexer dev

# d. Frontend (restart it if it was already running — networks.json is imported statically):
pnpm frontend dev        # → http://localhost:3000/network/hypercerts
```

> **Addresses must match YOUR deploy.** The `hypercerts` entries in
> `config/networks.development.json` and `.docker/deployment_summary.json` must both carry the
> `merkle_snapshot` from `.docker/hypercerts_instance_local_deploy.json` — the catalog ships with
> the deterministic addresses of the documented flow, which drift if your deployer nonce
> differs. Diagnosis order when the page is empty: `curl localhost:65421/hypercerts/roots`
> (indexer saw the event?) → `cast call $SNAP "getLatestState()(...)"` (proof on the current
> chain?) → fetch the cid through the local gateway (blob pinned?) → the indexer console
> (ingestion logs IPFS failures and root-mismatch skips explicitly).

On the `MerkleRootUpdated` event the indexer detects the nodeId-keyed blob, rebuilds the guest's
exact output tree (including bound nodes' address leaves from the sidecar), asserts it reproduces
the on-chain root, and fills the `/hypercerts` score API the page reads. DID labels are
integrity-checked (`keccak256(did)` must equal the nodeId), so the unauthenticated sidecar can
label nodes but never mislabel them.

---

## Notes & troubleshooting

- **`execute`/`vkey`/`paramshash` get OOM-killed on a small box** → you're on the `cpu` backend
  (the `.env` default): it eagerly allocates a ~5 GiB prover machine those executor-only commands
  never use. Prefix them with `SP1_PROVER=mock` — identical executor + `guest == native`
  byte-assert, nothing else changes. Real proving needs `SP1_PROVER=network` or a 16–32 GiB box.
- **`succinct` toolchain missing** (fresh container) → `curl -L https://sp1up.succinct.xyz | bash
  && sp1up --version v6.3.1`.
- **`prove` gets killed right after the `vkey:` line** → you're on the `cpu` backend and the
  local prover machine's multi-GiB allocation got OOM-killed. `SP1_PROVER=network` didn't reach
  the process: the prover reads real process env only (no `.env`), and an unexported `VAR=value`
  line is shell-local. Prefix the variables inline on the `cargo run` line.
- **Deploy script fails with `gas required exceeds allowance: 0`** → it's broadcasting with the
  `.env`'s `FUNDED_KEY`, not your `--private-key`. Prefix `FUNDED_KEY=$PK` (step 3).
- **Indexer syncs but stops exactly 30 blocks short of the tip** (`/status` block = tip − 30,
  `merkle_snapshot` table empty, no handler logs) → Ponder's finality window: chain 31337 gets the
  default `finalityBlockCount = 30`, and the newest 30 blocks are only indexed as NEW blocks
  arrive. On a mine-on-demand anvil where `submitProof` was the last tx, nothing ever arrives.
  Escape hatch on a running chain: `cast rpc anvil_mine 0x40 --rpc-url $RPC` (mines 64 blocks);
  durable fix: start anvil with `--block-time 2` (step 3).
- **Indexer halts at startup with `The contract function "votingDelay" returned no data ("0x")`**
  (or any setup-handler read on an address that isn't a contract) → `.docker/deployment_summary.json`
  still lists networks from a previous chain. Ponder registers every contract in the summary and
  its setup handlers read them at startup. Re-run step 8a (it replaces the networks array), then
  restart the indexer.
- **`submitProof` reverts with a digest mismatch** → your input's anchors don't re-fold to the
  checkpointed `anchorAcc`: wrong order, wrong timestamps (must be the real `block.timestamp` of
  each `anchor()` tx — step 4 patches them), or a missing anchor.
- **A node scores zero unexpectedly** → check `hypercerts_skips.json` first; reasons are the
  closed enum in `hypercerts_core::semantics::skip_reason` (+ rule-Φ CARRIED/DROPPED from
  `pagerank_core::skip_reason`).
- **Regenerating the fixture**: the committed two-repo fixture (alice + bob, all seven v1.1.0
  collections, a real `link.evm` signature) is generated by `test/fixtures/atproto/hypercerts/gen/gen.mjs`
  against a real in-process PDS + PLC (`@atproto/dev-env`). DIDs/keys are random per run, so
  regenerating means re-pinning the consumers listed in `test/fixtures/atproto/hypercerts/fixtures/README.md`
  — don't regenerate unless you're changing the fixture's content.

See [`RUNBOOK.md`](./RUNBOOK.md) for the deploy battery, roles, and the weekly epoch loop;
[`docs/PROGRAMS.md`](../PROGRAMS.md) for the program index and vkey/toolchain caveat.
