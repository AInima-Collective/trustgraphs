# Running the demo

Two claims, one stack:

> **A stranger creates a community network in one transaction, and it is live in the app seconds
> later.** No rebuild, no restart, no config edit.
>
> **Nobody then runs the runbook.** A daemon watches the chain, freezes checkpoints on the
> contract's cadence, proves them and lands them. Networks we curate are proven on us; a network
> that funded its own tank pays whoever produced its root.

Everything in §2–§7 was run end to end on a clean box and the numbers below are real. §1's Docker
step and §8 (the indexer and the app) are the parts not verified here — each says so where it
appears. Budget ~30 minutes the first time, most of it the SP1 guest build.

Design docs: [`INSTANCE_FACTORY.md`](research/INSTANCE_FACTORY.md) for creation,
[`docs/OPERATOR.md`](docs/OPERATOR.md) for the daemon,
[`docs/trust-graph/DEMO.md`](docs/trust-graph/DEMO.md) for the factory-only walkthrough this
supersedes.

---

## 0. Toolchain, once

The SP1 `succinct` Rust toolchain is not part of a normal checkout, and you need it from §4 on.

```bash
curl -sSL https://raw.githubusercontent.com/succinctlabs/sp1/main/sp1up/sp1up | bash
sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
export SP1_PROVER=mock          # runs the guest for real; only the SNARK is stubbed
```

## 1. Services

Four things, and **§2–§7 need only the first**. The daemon computes each root's IPFS hash and CID
in-circuit from the blob bytes, so it never contacts an IPFS node, and nothing before §8 touches
Postgres. That is why the chain-and-daemon half of this demo runs with no Docker at all.

| | What | Port | Needed by |
|---|---|---|---|
| 1 | anvil | 8545 | everything |
| 2 | Postgres (`ponder-db`) | 6432 | §8 (the indexer) |
| 3 | IPFS (kubo) | 5001 / 8080 | §8 (fetching a score blob by its CID) |
| 4 | Ponder + Next.js | 65421 / 3000 | §8 |

anvil first, because the services task below **waits** for it rather than starting it:

```bash
anvil --silent &
```

Then 2 and 3, from `docker-compose.dev.yml`:

```bash
task start-all-local
```

Two things about that command. It **stays in the foreground** and traps `EXIT` to
`docker compose down`, so it needs its own terminal — background it and you tear the containers
down with it. And it polls for anvil before doing anything, so starting it first just hangs. If you
would rather not hand it the containers' lifecycle:

```bash
docker compose -f docker-compose.dev.yml up -d      # ipfs + ponder-db, detached
docker compose -f docker-compose.dev.yml down       # when you are done
```

*(Not verified in this pass: the box this was written on has no reachable Docker daemon and no
`task` binary. The two commands are read off `Taskfile.yml` → `taskfile/services.yml` and
`docker-compose.dev.yml`. Everything in §2–§7 was run without them.)*

## 2. A funded deployer

```bash
# .env's FUNDED_KEY is NOT an anvil default account, so on a fresh chain it has zero balance and
# the first deploy step dies with `Insufficient funds`.
set -a; . ./.env; set +a
cast send $(cast wallet address --private-key $FUNDED_KEY) --value 1000ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

## 3. Pin the verifier to the guest you actually built

**Do this before deploying, not after.** `SP1_PROGRAM_VKEY` in `.env` is whatever was current when
someone last edited it, and `SP1JournalVerifier` pins its vkey **immutably** at construction. Deploy
with a stale one and the stack looks healthy right up until the daemon refuses to prove anything,
because it will not pay for a proof no verifier on this chain can accept:

```json
{"action":{"action":"hold","hold":"verifier_rotated"}}
```

```bash
cd zk/prover
export SP1_PROGRAM_VKEY=$(cargo run --features "network" -q --release -- trust-graph vkey)
export SP1_SIGNER_PROGRAM_VKEY=$(cargo run --features "network" -q --release -- signer vkey)
export CONTRIBUTIONS_PROGRAM_VKEY=$(cargo run --features "network" -q --release -- contributions vkey)
cd ../..
echo $SP1_PROGRAM_VKEY   # 0x005c236fe2e6157bd911925c2faefcae4d903e229dee2fc0ef555763dd31c496
```

## 4. Deploy everything

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
# Every later section assumes these. They come from deploy artifacts, not from shell history, so
# this block is safe to re-run in a new terminal at any point — and you will need to, because a
# heredoc or a `cast call` with an unset variable fails in ways that do not name the variable
# (`rpc = ""`, or `invalid value '...' for '[TO]'`).
R=${R:-http://127.0.0.1:8545}
EAS=$(jq   -r .eas                .docker/eas_deploy.json)
VAULT=$(jq -r .proving_vault      .docker/proving_vault_deploy.json)
FAC=$(jq   -r .factory            .docker/factory_deploy.json)
REG=$(jq   -r .instance_registry  .docker/instance_registry_deploy.json)

# The network from §5, derived FROM THE CHAIN rather than from a scratch file. `.trustgraph/` is
# gitignored working space and does not survive a clean, so anything that depended on the JSON the
# create script writes would break the moment it was cleared. Nothing here needs it:
# `computeInstanceId` is a pure view (keccak256(abi.encode(creator, name, salt))), and the registry
# row carries the rest. Change NAME if you created yours with a different one.
NAME=${NAME:-Demo Co-op}
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ID=$(cast call $FAC 'computeInstanceId(address,string,bytes32)(bytes32)' \
  $(cast wallet address --private-key $FUNDED_KEY) "$NAME" $ZERO32 --rpc-url $R)
if [ "$(cast call $REG 'isRegistered(bytes32)(bool)' $ID --rpc-url $R)" = "true" ]; then
  REC=$(cast call $REG 'getInstance(bytes32)((bytes32,address,address,address,bytes32))' $ID --rpc-url $R)
  SNAP=$(echo $REC | tr -d '()' | cut -d, -f2 | tr -d ' ')
  RES=$(echo  $REC | tr -d '()' | cut -d, -f4 | tr -d ' ')
  SCHEMA=$(cast call $RES 'boundSchema()(bytes32)' --rpc-url $R)
fi

: "${R:?}" "${EAS:?}" "${VAULT:?}" "${FAC:?}" "${REG:?}" \
  "${FUNDED_KEY:?run 'set -a; . ./.env; set +a' first}"

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

## 5. Create a network, endowed, in one transaction

```bash
forge script script/examples/CreateInstance.s.sol:CreateInstance \
  --sig 'run(address,uint256,string)' $FAC 2000000000000000000 "Demo Co-op" \
  --rpc-url $R --private-key $FUNDED_KEY --broadcast --skip-simulation

ID=$(jq     -r .instanceId .trustgraph/create-instance.json)
SNAP=$(jq   -r .snapshot   .trustgraph/create-instance.json)
SCHEMA=$(jq -r .schemaUid  .trustgraph/create-instance.json)
```

(These three are also in §4's address block, which is the one to re-run if you open a new terminal.)

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

## 6. Vouch — before the first trigger

```bash
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

## 7. Let the daemon do the rest

This is the part that replaces the runbook. Write a config — the daemon finds factory-created
trust-graph instances from the chain alone, so there is nothing per-instance in it:

```bash
# Every later section assumes these. They come from deploy artifacts, not from shell history, so
# this block is safe to re-run in a new terminal at any point — and you will need to, because a
# heredoc or a `cast call` with an unset variable fails in ways that do not name the variable
# (`rpc = ""`, or `invalid value '...' for '[TO]'`).
R=${R:-http://127.0.0.1:8545}
EAS=$(jq   -r .eas                .docker/eas_deploy.json)
VAULT=$(jq -r .proving_vault      .docker/proving_vault_deploy.json)
FAC=$(jq   -r .factory            .docker/factory_deploy.json)
REG=$(jq   -r .instance_registry  .docker/instance_registry_deploy.json)

# The network from §5, derived FROM THE CHAIN rather than from a scratch file. `.trustgraph/` is
# gitignored working space and does not survive a clean, so anything that depended on the JSON the
# create script writes would break the moment it was cleared. Nothing here needs it:
# `computeInstanceId` is a pure view (keccak256(abi.encode(creator, name, salt))), and the registry
# row carries the rest. Change NAME if you created yours with a different one.
NAME=${NAME:-Demo Co-op}
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ID=$(cast call $FAC 'computeInstanceId(address,string,bytes32)(bytes32)' \
  $(cast wallet address --private-key $FUNDED_KEY) "$NAME" $ZERO32 --rpc-url $R)
if [ "$(cast call $REG 'isRegistered(bytes32)(bool)' $ID --rpc-url $R)" = "true" ]; then
  REC=$(cast call $REG 'getInstance(bytes32)((bytes32,address,address,address,bytes32))' $ID --rpc-url $R)
  SNAP=$(echo $REC | tr -d '()' | cut -d, -f2 | tr -d ' ')
  RES=$(echo  $REC | tr -d '()' | cut -d, -f4 | tr -d ' ')
  SCHEMA=$(cast call $RES 'boundSchema()(bytes32)' --rpc-url $R)
fi

: "${R:?}" "${EAS:?}" "${VAULT:?}" "${FAC:?}" "${REG:?}" \
  "${FUNDED_KEY:?run 'set -a; . ./.env; set +a' first}"

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
# A function, not a string variable: bash word-splits `$OP` and zsh does not, so the string form
# fails in zsh with `no such file or directory: cargo run -q ...`.
op() { cargo run -q --release --manifest-path zk/operator/Cargo.toml -- --config .demo/operator.toml "$@"; }
```

Sanity-check what got written, because this is the step that goes wrong quietly:

```bash
head -2 .demo/operator.toml     # rpc and registry must both be non-empty
```

Look before you leap — `--dry-run` does every chain read and every decision and skips only the
sends:

```bash
op --once --dry-run | jq -c 'select(.event=="decision") | {instance, action}'
```

Then run it. Three ticks is a full trigger → prove → submit cycle; `anvil_mine` stands in for time
passing, because anvil only mines on transactions:

```bash
for i in 1 2 3; do cast rpc anvil_mine 8 --rpc-url $R >/dev/null; op --once; done
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

**If either number is wrong, ask the daemon rather than guessing.** `hasAppliedCheckpoint` false or
a zero credit almost always means it has not finished the cycle yet — three ticks is the *minimum*,
one each for trigger, prove and submit, and a tick that does nothing still counts as one:

```bash
jq -c '[.instances[] | {name, do: .action.action,
                        why: (.action.hold // .action.idle // .action.skip)}]' .demo/status.json
```

- `trigger` / `prove` / `submit` — mid-cycle. Run more ticks.
- `hold: "unfunded"` — this instance has no tank and is not curated. Did `setPolicy` run (§5), and
  did the prepay land? `cast call $VAULT 'accountOf(bytes32)((address,bytes32,uint128,uint128))' $ID
  --rpc-url $R`
- `hold: "verifier_rotated"` — §3. The deployed verifier wants a vkey this binary cannot produce.
- `skip` with a params hash — the reconstruction disagrees with the chain; the instance was not
  created by this factory, or its params were rotated.
- `idle: "quiet"` — nothing to do, because nothing changed since the last root. Vouch again.

A landed-but-unpaid root is the one case that is *not* impatience: the root is in, the fee is zero.
That means the fee schedule (§4) or the community's `maxPerRootUsd` (§5) is zero, or the price feed
is stale — the vault treats an unusable price as no price and pays nothing rather than guessing.

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
# Not `sed -i`: BSD/macOS sed requires an argument to -i, so the in-place form is not portable.
sed "s|instances = \[\]|instances = [\"$DEV_ID\"]|" .demo/operator.toml > .demo/o.toml \
  && mv .demo/o.toml .demo/operator.toml
for i in 1 2 3; do cast rpc anvil_mine 8 --rpc-url $R >/dev/null; op --once; done
```

Its root lands too, and its vault account stays empty — `(0x0, 0x0, 0, 0)`. Proven on us, not on
its own money. That is the whole difference between the tiers, running in one loop.

## 8. The indexer and the app

> Not re-verified in this pass: the dev server and Ponder both need more memory than the box this
> was written on had. The commands are unchanged from
> [`docs/trust-graph/DEMO.md`](docs/trust-graph/DEMO.md) §3, which was verified when it was written;
> treat §8 as that document's, not this one's.

Needs services 2 and 3 from §1 up.

```bash
cd indexer  && pnpm dev      # :65421
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

- **Start anvil before `task start-all-local`, and give that command its own terminal.** It waits
  for anvil rather than starting it, and it tears the containers down when it exits. §1.
- **Export the vkeys before deploying.** §3. The verifier pins its vkey immutably, so a stale
  `.env` value means a stack that deploys cleanly and then refuses to prove.
- **Attest before the first trigger.** §6, and [#15](https://github.com/JakeHartnell/ZkTrustGraph/issues/15).
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
- **A config generated by a heredoc can come out empty.** If `$R`/`$REG`/`$VAULT` are not set in
  the shell that runs it, you get `rpc = ""` — valid TOML, and previously a death on the first
  `eth_chainId` with reqwest's `relative URL without a base`, naming neither the field nor the file.
  The operator now rejects it at load with the reason; §7 re-derives the addresses so it should not
  arise.
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
