# Running the instance-factory demo

The demo is one sentence: **a stranger creates a community network in one transaction, and it is
live in the app seconds later — no rebuild, no restart, no config edit.**

Everything below was run end to end on a clean box and the outputs are real. Budget ~20 minutes the
first time, most of it the SP1 guest build. Design: [`FACTORY.md`](./FACTORY.md).

## What you need running

Five services. Four are ordinary; the fifth (Postgres) is the one that usually bites, because this
repo normally gets it from Docker.

| | What | Port | Notes |
|---|---|---|---|
| 1 | anvil | 8545 | the chain |
| 2 | IPFS (kubo) | 5001 / 8080 | score blobs; `--offline` is fine |
| 3 | Postgres | 6432 | the indexer's database |
| 4 | Ponder indexer | 65421 | the catalog + score API |
| 5 | Next.js frontend | 3000 | the app |

```bash
task start-all-local     # if Docker is available, this does 1-3 for you
```

If Docker is not available, run them by hand:

```bash
anvil &

# kubo, if you don't already have it
curl -sSL https://dist.ipfs.tech/kubo/v0.32.1/kubo_v0.32.1_linux-arm64.tar.gz | tar xz
export IPFS_PATH=$PWD/ipfsrepo && ./kubo/ipfs init --profile server
./kubo/ipfs daemon --offline &

# any Postgres on 6432 with a `ponder` role and database will do; the indexer expects
# postgresql://ponder:ponder@localhost:6432/ponder  (indexer/.env.local)
```

## 0. Toolchain, once

The SP1 `succinct` Rust toolchain is not part of a normal checkout, and you need it for step 4.

```bash
curl -sSL https://raw.githubusercontent.com/succinctlabs/sp1/main/sp1up/sp1up | bash
sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
```

## 1. Fund the deployer

`.env`'s `FUNDED_KEY` is **not** an anvil default account, so on a fresh chain it has zero balance
and the very first deploy step dies with `Insufficient funds`.

```bash
cast send $(cast wallet address --private-key $FUNDED_KEY) --value 1000ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

## 2. Deploy everything

```bash
pnpm deploy:contracts
```

Twelve steps: EAS, a dev SP1 gateway stub, the ZK verifier, the instance registry, the
**factory**, three dev networks *created through the factory*, the contributions instance, the
signer verifier, three Safes, and the timelocks.

Sanity check — the factory can append directory rows but not rewrite them:

```bash
REG=$(jq -r .instance_registry .docker/factory_deploy.json)
FAC=$(jq -r .factory              .docker/factory_deploy.json)
cast call $REG 'instanceCount()(uint256)'                                    # 3
cast call $REG 'hasRole(bytes32,address)(bool)' $(cast call $REG 'REGISTRAR_ROLE()(bytes32)') $FAC   # true
cast call $REG 'hasRole(bytes32,address)(bool)' $(cast call $REG 'OPERATOR_ROLE()(bytes32)')  $FAC   # false
```

## 3. Start the indexer and the app

```bash
cd indexer  && pnpm dev      # :65421
cd frontend && pnpm dev      # :3000
```

```bash
curl -s localhost:65421/instances | jq '.pagination.total, .instances[].name'
# 3
# "Safe Demo"  "RegenHub"  "Example Network"
```

Open <http://localhost:3000/network>. All three are listed, and they came from the chain, not from
a config file.

## 4. The demo itself

**Create a network while everything is running.** Use the wizard at
<http://localhost:3000/create> — five screens, then one signature. Or send the same transaction
directly:

```bash
SEED=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
P="(850000000000000000,1000000000000,100,0,100000000000000000000,2000000000000000000,\
150000000000000000,800000000000000000,[$SEED],1000000000000000000000000,1000000000000000000,\
0x0000000000000000000000000000000000000000000000000000000000000000,1,[],0,\
0x0000000000000000000000000000000000000000,0)"

cast send $FAC 'createInstance((string,string,(uint256,uint256,uint32,uint256,uint256,uint256,uint256,uint256,address[],uint256,uint256,bytes32,uint32,bytes32[],uint64,address,uint64),address,uint64,bool,address,bytes32))' \
  "(\"Demo Co-op\",\"\",$P,0x0000000000000000000000000000000000000000,1,true,0x0000000000000000000000000000000000000000,0x00000000000000000000000000000000000000000000000000000000000000aa)" \
  --private-key $FUNDED_KEY
```

The three zeroed fields in the params (`schemaUid`, `accumulator`, `chainId`) are **derived** — the
factory fills them and rejects anything else.

Watch it arrive, with nothing restarted:

```bash
curl -s localhost:65421/instances | jq '.instances[] | select(.name=="Demo Co-op") | {id, contracts}'
```

Then open `http://localhost:3000/network/<that id>`. The page is live, with a working Vouch button.
Measured on a production build in an earlier run: **transaction at 23:10:41, page rendering at
23:10:52.**

**Vouch, then prove.**

```bash
SCHEMA=$(curl -s localhost:65421/instances | jq -r '.instances[]|select(.name=="Demo Co-op")|.schema.uid')
forge script script/E2eAttest.s.sol:E2eAttest --sig 'run(address,bytes32)' \
  $(jq -r .eas .docker/eas_deploy.json) $SCHEMA --rpc-url http://127.0.0.1:8545 --broadcast

REGISTRY=$REG PK=$FUNDED_KEY IPFS_API=http://127.0.0.1:5001 bash taskfile/instances.sh
```

The loop enumerates the registry, rebuilds each instance's params **from its `InstanceCreated`
event**, self-checks `params_hash(event params) == snapshot.paramsHash()`, and refuses to prove
anything at all if one instance fails that check. Instances with no attestations are skipped, not
crashed on. Reload the network page: scored members.

**Pay people.** The distributor was bundled at creation (`withDistributor: true`). Fund it, publish
a distribution against the proven root, and claim. A worked run:
`10 ETH` distributed, and a member holding 21.5465430930861861723725% of the pool claimed exactly
`2.154654309308618617 ETH`.

## 5. The two claims worth demonstrating

These are the security properties, not the happy path.

**Clones cannot cross-feed.** Create two networks, `trigger()` both before either has any
attestation — their checkpoints are then byte-identical (`acc = 0x0, leafCount = 0`) — prove one,
and submit its proof to the other. It reverts `JournalMismatch` (`0x65099f97`), and submitting to
its own instance succeeds. The only thing separating them is `paramsHash`.

**Squatting cannot brick the factory.** The resolver address is predictable, and EAS lets anyone
register a schema for an address that has no code yet:

```bash
PRED=$(cast compute-address $FAC --nonce $(cast nonce $FAC) | grep -oE '0x[0-9a-fA-F]{40}')
cast send $(jq -r .schema_registrar .docker/eas_deploy.json) \
  'register(string,address,bool)(bytes32)' "string comment,uint256 confidence" $PRED true \
  --private-key <any key>
```

Creation still succeeds: the factory adopts the squatted UID. Before this was fixed, that one
transaction bricked `createInstance` for every creator, permanently.

**Foreign schemas cannot poison a network.** Register a second schema pointing at a live instance's
resolver and attest against it: the attestation reverts `ForeignSchema` and the accumulator's
`leafCount()` does not move.

## Gotchas, all of them hit while writing this

- **Restarting anvil silently breaks the indexer.** Ponder caches RPC data keyed by chain id, and a
  fresh anvil is the same chain id with different contents — so it replays the old chain and indexes
  **zero events** while looking perfectly healthy (`cache_rate=100%`, `event_count=0`). Drop the
  cache whenever you restart the chain:
  ```sql
  DROP SCHEMA ponder_sync CASCADE;
  ```
  Use a fresh `--schema` name too; Ponder refuses to reuse one after any indexing-code edit.
- **anvil only mines on transactions.** If the chain goes idle, Ponder's finalized head stops
  advancing and a just-created network can sit unindexed. `cast rpc anvil_mine 20`, or run
  `anvil --block-time 1`.
- **Deploy artifacts are not chain-scoped.** `.docker/*.json` and `config/networks.development.json`
  have fixed filenames, so deploying to a second chain overwrites the first's. It fails
  *confidently*: the same deployer and nonce sequence produces the same addresses on both chains, so
  every address still has code — just belonging to a different contract. Deploy one chain at a time.
- **`pgrep -f <pattern>` matches the checking command itself** in some shells and will tell you a
  dead service is alive. Check by port.
- **The indexer's database is disposable.** Everything it serves is derived from chain events, so
  losing Postgres costs nothing but a rebuild: restart it, point Ponder at a fresh `--schema`, and
  the full catalog and every network's scored member list come back in seconds. Verified by killing
  Postgres mid-demo and rebuilding — 4 instances and the demo network's 3 members, all recovered
  from the chain.
- **Proving is mocked locally.** `SP1_PROVER=mock` runs the guest for real and commits its real
  public values, but the SNARK is a stub, and the dev gateway is a stub too. The params self-check,
  the exporter's re-fold proof, guest-vs-native byte equality, journal binding and the whole write
  path are production code either way. Real proving needs `SP1_PROVER=network` or a 16-32 GiB box.

## Related

- [`FACTORY.md`](./FACTORY.md) — what the factory is, what it refuses, and why
- [`RUNBOOK.md`](./RUNBOOK.md) — proving a single instance by hand
- [`LOCAL_TESTING.md`](./LOCAL_TESTING.md) — the mainnet-fork rehearsal, where proofs are real
