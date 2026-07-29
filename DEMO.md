# Running the demo

Two claims, one stack:

> **A stranger creates a community network in one transaction, and it is live in the app seconds
> later.** No rebuild, no restart, no config edit.
>
> **Nobody then runs the runbook.** A daemon watches the chain, freezes checkpoints on the
> contract's cadence, proves them and lands them. Networks we curate are proven on us; a network
> that funded its own tank pays whoever produced its root.

Everything in §1–§6 was run end to end on a clean box and the numbers below are real. §7 (the
indexer and the app) is the one part not re-verified here — see the note there. Budget ~30 minutes
the first time, most of it the SP1 guest build.

Design docs: [`INSTANCE_FACTORY.md`](research/INSTANCE_FACTORY.md) for creation,
[`docs/OPERATOR.md`](docs/OPERATOR.md) for the daemon,
[`docs/trust-graph/DEMO.md`](docs/trust-graph/DEMO.md) for the factory-only walkthrough this
supersedes.

---

## 0. Toolchain, once

The SP1 `succinct` Rust toolchain is not part of a normal checkout, and you need it from §3 on.

```bash
curl -sSL https://raw.githubusercontent.com/succinctlabs/sp1/main/sp1up/sp1up | bash
sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
export SP1_PROVER=mock          # runs the guest for real; only the SNARK is stubbed
```

## 1. A chain, and a funded deployer

```bash
anvil --silent &

# .env's FUNDED_KEY is NOT an anvil default account, so on a fresh chain it has zero balance and
# the first deploy step dies with `Insufficient funds`.
set -a; . ./.env; set +a
cast send $(cast wallet address --private-key $FUNDED_KEY) --value 1000ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

## 2. Pin the verifier to the guest you actually built

**Do this before deploying, not after.** `SP1_PROGRAM_VKEY` in `.env` is whatever was current when
someone last edited it, and `SP1JournalVerifier` pins its vkey **immutably** at construction. Deploy
with a stale one and the stack looks healthy right up until the daemon refuses to prove anything,
because it will not pay for a proof no verifier on this chain can accept:

```json
{"action":{"action":"hold","hold":"verifier_rotated"}}
```

```bash
cd zk/prover
export SP1_PROGRAM_VKEY=$(cargo run -q --release -- trust-graph vkey)
export SP1_SIGNER_PROGRAM_VKEY=$(cargo run -q --release -- signer vkey)
export CONTRIBUTIONS_PROGRAM_VKEY=$(cargo run -q --release -- contributions vkey)
cd ../..
echo $SP1_PROGRAM_VKEY   # 0x005c236fe2e6157bd911925c2faefcae4d903e229dee2fc0ef555763dd31c496
```

## 3. Deploy everything

```bash
pnpm deploy:contracts
```

Thirteen steps: EAS, a dev SP1 gateway stub, the ZK verifier, the instance registry, the **proving
vault**, the **factory**, three dev networks created *through* the factory, the contributions
instance, the signer verifier, three Safes and the timelocks.

The vault runs **before** the factory on purpose: it is a factory constructor argument and it is
what makes `createInstance` payable, so the reverse order gives you a factory that permanently
reverts on any prepay. Locally the vault brings its own `MockEthUsdFeed` and `TestUSDC`; off-devnet
`ETH_USD_FEED` and `USDC` are required.

Check the wiring, and that the factory can append directory rows but never rewrite one:

```bash
R=http://127.0.0.1:8545
VAULT=$(jq -r .proving_vault      .docker/proving_vault_deploy.json)
FAC=$(jq   -r .factory            .docker/factory_deploy.json)
REG=$(jq   -r .instance_registry  .docker/instance_registry_deploy.json)

cast call $FAC 'VAULT()(address)' --rpc-url $R                       # == $VAULT
cast call $REG 'instanceCount()(uint256)' --rpc-url $R               # 3
cast call $VAULT 'feePerRootUsd(bytes32,uint8)(uint256)' \
  $(cast keccak "trust-graph") 1 --rpc-url $R                        # 5e8  ($5/root, band 1)

cast call $REG 'hasRole(bytes32,address)(bool)' \
  $(cast call $REG 'REGISTRAR_ROLE()(bytes32)' --rpc-url $R) $FAC --rpc-url $R   # true
cast call $REG 'hasRole(bytes32,address)(bool)' \
  $(cast call $REG 'OPERATOR_ROLE()(bytes32)'  --rpc-url $R) $FAC --rpc-url $R   # false
```

The fee schedule is set at deploy rather than left to a follow-up call, because an unpriced band is
not a smaller demo — it is a silent one. Roots land, claims run, every payout is zero.

## 4. Create a network, endowed, in one transaction

```bash
forge script script/examples/CreateInstance.s.sol:CreateInstance \
  --sig 'run(address,uint256,string)' $FAC 2000000000000000000 "Demo Co-op" \
  --rpc-url $R --private-key $FUNDED_KEY --broadcast --skip-simulation

ID=$(jq     -r .instanceId .trustgraph/create-instance.json)
SNAP=$(jq   -r .snapshot   .trustgraph/create-instance.json)
SCHEMA=$(jq -r .schemaUid  .trustgraph/create-instance.json)
```

One transaction created the resolver, adopted the vouching schema, bound both, deployed the
snapshot, handed the constitutional key to the creator, registered the directory row, **and put 2
ETH in the network's proving tank**:

```bash
cast call $VAULT 'accountOf(bytes32)((address,bytes32,uint128,uint128))' $ID --rpc-url $R
# (0xD9Fe…80a3, 0xdb03…d380, 2000000000000000000, 0)
```

Three fields in the params (`schemaUid`, `accumulator`, `chainId`) are **derived** — the factory
fills them and rejects anything else. The wizard at <http://localhost:3000/create> sends this same
transaction, prepay slider included.

Now the community sets its own spending limit. This is the only enforceable cadence: `EPOCH_FLOOR`
binds at creation, but `setEpochLength` is constitutional, so any creator could lower their own
epoch afterwards.

```bash
# pay for every root, at most $50 each
cast send $VAULT 'setPolicy(bytes32,uint64,uint96)' $ID 0 5000000000 \
  --rpc-url $R --private-key $FUNDED_KEY
```

## 5. Vouch — before the first trigger

```bash
EAS=$(jq -r .eas .docker/eas_deploy.json)
forge script script/E2eAttest.s.sol:E2eAttest --sig 'run(address,bytes32)' $EAS $SCHEMA \
  --rpc-url $R --private-key $FUNDED_KEY --broadcast --skip-simulation

cast call $(jq -r .resolver .trustgraph/create-instance.json) 'leafCount()(uint64)' --rpc-url $R  # 3
```

**Order matters, and getting it wrong wedges the network.** If the daemon triggers before anyone has
vouched, checkpoint 0 freezes over an empty graph; its root proves to `0x0` with `totalValue = 0`,
and the `MerkleGovModule` hook reverts `InvalidTotalVotingPower()` inside `submitProof`. The
checkpoint's contents are immutable, so it can never be applied — and the daemon retries it every
tick forever instead of freezing a fresh one. Recovery is one permissionless call, `cast send $SNAP
'trigger()'`, because `submitProof` requires only `checkpointId > lastAppliedCheckpoint` and not
contiguity. Tracked as [#15](https://github.com/JakeHartnell/ZkTrustGraph/issues/15).

## 6. Let the daemon do the rest

This is the part that replaces the runbook. Write a config — the daemon finds factory-created
trust-graph instances from the chain alone, so there is nothing per-instance in it:

```bash
mkdir -p .demo
cat > .demo/operator.toml <<EOF
rpc      = "$R"
registry = "$REG"
chain_id = 31337

# Proven on us. This list IS the free tier; there is no unconditional one.
[curated]
instances = []

# Everyone else draws their own tank, and the same loop pays whoever produced the root.
[paid]
enabled   = true
vault     = "$VAULT"
recipient = "$(cast wallet address --private-key $FUNDED_KEY)"

[cadence]
tick_seconds       = 2
subsidy_min_blocks = 0

[finality]
confirmations = 0      # anvil; 12 anywhere real

[prover]
backend = "mock"
groth16 = true

[ops]
journal_path = ".demo/journal.jsonl"
status_path  = ".demo/status.json"
log_format   = "json"
EOF

export SUBMITTER_PRIVATE_KEY=$FUNDED_KEY
OP="cargo run -q --release --manifest-path zk/operator/Cargo.toml -- --config .demo/operator.toml"
```

Look before you leap — `--dry-run` does every chain read and every decision and skips only the
sends:

```bash
$OP --once --dry-run | jq -c 'select(.event=="decision") | {instance, action}'
```

Then run it. Three ticks is a full trigger → prove → submit cycle; `anvil_mine` stands in for time
passing, because anvil only mines on transactions:

```bash
for i in 1 2 3; do cast rpc anvil_mine 8 --rpc-url $R >/dev/null; $OP --once; done
```

What actually happened, with nobody touching it:

```bash
cast call $SNAP 'hasAppliedCheckpoint()(bool)' --rpc-url $R      # true
cast call $VAULT 'creditOf(address,address)(uint256)' \
  $(cast wallet address --private-key $FUNDED_KEY) \
  0x0000000000000000000000000000000000000000 --rpc-url $R
# 1666666819999999   ≈ 0.00167 ETH  ==  $5 at the mock feed's $3,000
```

A root landed and **the tank paid for it**, priced by the band the community's own policy allows.
The credit is a pull payment: `withdrawCredit(token, to)` collects it. A recipient that reverts on
receive can never revert a successfully verified root.

The heartbeat shows the two tiers side by side. The three dev networks have no tank and are not
curated, so the daemon holds rather than quietly subsidising them:

```bash
jq -c '[.instances[] | {name, action: .action.action, hold: .action.hold}]' .demo/status.json
# [{"name":"Example Network","action":"hold","hold":"unfunded"},
#  {"name":"RegenHub","action":"hold","hold":"unfunded"},
#  {"name":"Safe Demo","action":"hold","hold":"unfunded"},
#  {"name":"Demo Co-op","action":"submit","hold":null}]
```

**Now show the free tier.** Put one of them in `[curated]`, vouch in it, and run the same loop:

```bash
DEV_ID=$(cast call $REG 'getInstanceIds()(bytes32[])' --rpc-url $R \
  | tr -d '[] ' | tr ',' '\n' | head -1)
# …attest against that instance's schema, then:
sed -i "s|instances = \[\]|instances = [\"$DEV_ID\"]|" .demo/operator.toml
for i in 1 2 3; do cast rpc anvil_mine 8 --rpc-url $R >/dev/null; $OP --once; done
```

Its root lands too, and its vault account stays empty — `(0x0, 0x0, 0, 0)`. Proven on us, not on
its own money. That is the whole difference between the tiers, running in one loop.

## 7. The indexer and the app

> Not re-verified in this pass: the dev server and Ponder both need more memory than the box this
> was written on had. The commands are unchanged from
> [`docs/trust-graph/DEMO.md`](docs/trust-graph/DEMO.md) §3, which was verified when it was written;
> treat §7 as that document's, not this one's.

```bash
cd indexer  && pnpm dev      # :65421   needs Postgres on 6432
cd frontend && pnpm dev      # :3000
```

```bash
curl -s localhost:65421/instances | jq '.pagination.total, .instances[].name'
curl -s localhost:65421/vault/$ID | jq '{ethBalance, burn, unpaidRootsSinceLastPayment}'
```

Open `http://localhost:3000/network/$ID`. The **proving tank** panel reads that endpoint: how much
is left, how fast it is going, and what happens when it runs out. It deliberately distinguishes
"nobody has funded this" from "the money ran out" — different situations, different fixes — and
shows a runway only when there is evidence for one.

## Gotchas

Everything below cost someone real time.

- **Export the vkeys before deploying.** §2. The verifier pins its vkey immutably, so a stale
  `.env` value means a stack that deploys cleanly and then refuses to prove.
- **Attest before the first trigger.** §5, and [#15](https://github.com/JakeHartnell/ZkTrustGraph/issues/15).
- **`registry_from_block` is not optional off-devnet.** Left at 0 against a registry deployed at
  block 21,000,000 the scan issues ~2,100 empty `eth_getLogs` calls, and most providers reject the
  range outright as an archive request — so the daemon gets *no catalog at all and every tick
  fails*. Startup alerts if you forget. Irrelevant on a fresh anvil, fatal on a real chain.
- **anvil only mines on transactions.** An idle chain stops advancing Ponder's finalized head and
  stalls the daemon's finality check. `cast rpc anvil_mine 20`, or `anvil --block-time 1`.
- **Restarting anvil silently breaks the indexer.** Ponder caches RPC data by chain id, and a fresh
  anvil is the same chain id with different contents, so it replays the old chain and indexes zero
  events while looking healthy (`cache_rate=100%`, `event_count=0`). `DROP SCHEMA ponder_sync
  CASCADE;` and use a fresh `--schema`.
- **Deploy artifacts are not chain-scoped.** `.docker/*.json` has fixed filenames, so deploying to a
  second chain overwrites the first's — and fails *confidently*, because the same deployer and nonce
  sequence produces the same addresses on both. One chain at a time.
- **`pnpm deploy:contracts` needs a platform-matched esbuild.** If `node_modules` was installed on a
  different OS you get `TransformError`; fetch the right `@esbuild/<platform>` tarball and point
  `ESBUILD_BINARY_PATH` at its binary. `pnpm add` fails outright on a store mismatch.
- **`pkill -f anvil` matches the shell running it** and will kill your own session. `pkill -x anvil`.
- **Proving is mocked locally, and here is exactly where that stops.** `SP1_PROVER=mock` runs the
  guest for real and commits its real public values; the dev gateway is a stub too. The params
  self-check, the exporter's re-fold proof, guest-vs-native byte equality, journal binding, the
  vault's payout arithmetic and the entire write path are production code either way. What is *not*
  demonstrated is that a real Groth16 proof verifies at Succinct's canonical gateway — that needs
  `SP1_PROVER=network` or a 16–32 GiB box, and it is the first thing a real deployment should do
  ([`DEVIATIONS`](docs/DEVIATIONS.md) #20).

## Related

- [`docs/OPERATOR.md`](docs/OPERATOR.md) — the daemon: configure, run, alert, recover, self-host
- [`docs/trust-graph/RUNBOOK.md`](docs/trust-graph/RUNBOOK.md) — proving one instance by hand, now
  the documented fallback
- [`docs/trust-graph/FACTORY.md`](docs/trust-graph/FACTORY.md) — what the factory refuses, and why
- [`test/e2e/fork.sh`](test/e2e/fork.sh) — the same loop on mainnet state, plus the adversarial pass
  (front-run, trigger spam, `kill -9`, params rotation, loss budget)
