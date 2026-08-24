# Quickstart: run everything locally

> Internal demo record retained from the original public guide.

The whole trustgraphs stack on one machine: chain, prover, indexer, app. You get one complete demo
network, plus the permissionless path:

> **The local stack ships one fully worked Demo Co-op:** real vouches and scores, explicit vouching
> criteria, an application link, a Safe, trust-weighted governance, distributions, and a
> contribution-funding round. The empty Example Network, RegenHub, and Safe Demo seeds are gone.
>
> **A stranger can still create another community in one transaction, live in the app seconds
> later.** Nobody then runs the runbook: a daemon watches the chain, freezes checkpoints on the
> contract's cadence, proves them and lands them. Networks we curate are proven on us; a network
> that funded its own tank pays whoever produced its root.

`task demo` does the whole finite walkthrough. It proves the seeded roots and exits. It does **not**
leave a proof scheduler running. Use `task demo:live` when you want the same deployment followed by
a foreground scheduler that notices and proves later attestations. The prose here is what each step
does, why it is shaped that way, and what to read when something goes wrong.

Design: [`create-a-network.md`](./create-a-network.md) for creation,
[`run-a-prover.md`](./run-a-prover.md) for the daemon. Toolchain installs are in
[`setup.md`](../../docs/build/setup.md).

> **What has been re-run, and what is inherited.** §0–§4 were run end to end on a clean anvil via
> `task demo` _before_ the contribution round joined the default flow; the outputs below are from
> that run and show the trust half. The round steps (`demo:seed-round`, the second root in
> `demo:prove`, `demo:payout`) have **not** been re-run end to end on the box this was last edited
> on — the taskfile, the generated operator config, and the build path were verified in isolation
> there. §5 (the indexer and the app) and the three experiments in §6 were verified when written
> and have not been re-run since. Budget ~30 minutes the first time, most of it §0's one-time
> toolchain install and guest build.

## 0. Toolchain and guests, once

The SP1 `succinct` Rust toolchain is not part of a normal checkout, and proving needs it. Pin the
version: the SDK is `=6.3.1` in `zk/prover/Cargo.toml`, and the toolchain build a vkey was derived
on is part of that vkey
([`networks-and-programs.md`](../../docs/concepts/networks-and-programs.md)).

```bash
curl -sSL https://raw.githubusercontent.com/succinctlabs/sp1/main/sp1up/sp1up | bash
~/.sp1/bin/sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
```

Then build the repo and the guest programs. **`task zk:build` is the step people miss**, and
`task demo` refuses to start without it:

```bash
task setup         # pnpm install + forge install
task zk:build      # all SP1 guest ELFs + the prover host — minutes the first time
```

Nothing in `task demo` builds the guests. Every step of it runs the prover with
`SP1_SKIP_PROGRAM_BUILD=true` so it isn't paying for a rebuild each tick, which means the ELFs have
to be there already. Full explanation, plus what to do after editing `crates/`, in
[`setup.md`](../../docs/build/setup.md#build-the-guest-programs).

## 1. Services

|     | What                   | Port         | Needed by                                      |
| --- | ---------------------- | ------------ | ---------------------------------------------- |
| 1   | anvil                  | 8545         | everything                                     |
| 2   | IPFS (kubo)            | 5001 / 8080  | publishing the score blob, and reading it back |
| 3   | Postgres (`ponder-db`) | 6432         | the indexer                                    |
| 4   | Ponder + Next.js       | 65421 / 3000 | the app                                        |

**anvil first**, because the services task waits for it rather than starting it — and give that
task its own terminal, since it traps `EXIT` to `docker compose down`:

```bash
anvil --block-time 1 &     # --block-time saves you a whole class of confusion; see Gotchas
task start-all-local       # 2 and 3, from docker-compose.dev.yml
```

If you would rather own the containers' lifecycle yourself:

```bash
docker compose -f docker-compose.dev.yml up -d      # ipfs + ponder-db, detached
docker compose -f docker-compose.dev.yml down       # when you are done
```

IPFS is **not** optional. The daemon computes each root's IPFS hash and CID in-circuit, but it must
still publish the blob those commit to: the chain carries the root, never the scores, and every
member list is built by fetching that blob by CID.

## 2. Everything, in one command

```bash
task demo
```

Which is: fund the deployer, derive the guest vkeys, deploy one factory-created and prepaid Demo
Co-op with governance, distributions and a contribution round, seed a real graph **and the full
6-persona contribution round over that same graph**, then let the scheduler land both roots — the
trust root collects the vault bounty; the round has no registry row, so the daemon reaches it
through a `[[manifest]]` entry in the generated operator config and proves it on the curated tier.
With an indexer up it then funds the round and pays the contributors; without one it says so and
skips exactly that step. It ends by mining past Ponder's finality window and saying whether the app
can actually see any of it:

```
  tick 1: triggered
  tick 2: proved
  tick 3: submitted
  ✓ a root landed on tick 3
  ✓ mined to block 220 (from 156) so Ponder can finalize

  root landed   true (checkpoint 0)
  tank left     (0xD9Fef…, 0xdb036dae…, 1998333333333333334 [1.998e18], 0)
  prover paid   1666666666666666 [1.666e15] wei
  scores        readable at http://127.0.0.1:8080/ipfs/bafkreiclfxhopt…
```

(That capture predates the round joining the flow: `prove` now tags each tick with
`[trust … · round …]` and waits for both roots, the report adds `round landed` / `round funded` /
`ALICE holds` lines, and a `payout` step follows `settle`.)

Every step is also its own task, because the useful thing about a demo is re-running one piece of
it:

```bash
task --list-all | grep demo:
```

`demo:deploy`, `demo:fund`, `demo:create`, `demo:seed`, `demo:seed-round`, `demo:govern`,
`demo:contributions`, `demo:dry-run`, `demo:prove`, `demo:operator`, `demo:live`, `demo:settle`,
`demo:payout`, `demo:report`, `demo:clean` — plus `demo:id`, `demo:snapshot`, `demo:resolver` and
`demo:addresses`, which answer "what is this network's X" from the chain rather than from a scratch
file.

Two things `task demo` deliberately does not do: **start your chain** (it refuses to run without
one rather than owning an anvil it would then have to tear down), and **start Postgres or IPFS**
(same reason — `start-all-local` owns those).

### Keep proving after the seeded demo

The finite command above drives the scheduler with `--once` until the initial trust and
contributions roots land, then exits. To deploy that same complete demo and leave the real daemon
watching in the foreground:

```bash
task demo:live
```

Keep that terminal open. In another terminal, create a vouch in the app or send one directly:

```bash
bash taskfile/vouch.sh "Demo Co-op" 0 10 90 "new demo vouch"
```

Demo Co-op has a one-block epoch, so the daemon's next ticks trigger a new checkpoint, prove it,
publish its score blob, and submit the new root. `anvil --block-time 1` is still recommended for a
live local demo; a default anvil stops producing blocks when there are no transactions.

If the stack is already deployed, do not redeploy it just to start the watcher:

```bash
task demo:operator
```

The heartbeat is `.demo/status.json` and the crash-safe request journal is
`.demo/journal.jsonl`. Stop the foreground operator with Ctrl-C; restarting `task demo:operator`
reattaches to the same journal.

Sanity check — the factory can _append_ directory rows but not rewrite them:

```bash
REG=$(jq -r .instance_registry .docker/factory_deploy.json)
FAC=$(jq -r .factory           .docker/factory_deploy.json)
cast call $REG 'instanceCount()(uint256)'                                                            # 1
cast call $REG 'hasRole(bytes32,address)(bool)' $(cast call $REG 'REGISTRAR_ROLE()(bytes32)') $FAC   # true
cast call $REG 'hasRole(bytes32,address)(bool)' $(cast call $REG 'OPERATOR_ROLE()(bytes32)')  $FAC   # false
```

## 3. The claim: created live, with nothing restarted

This is the part `task demo` cannot show you, because it runs before you are watching. Do it by
hand, with the indexer and the app already up (§5):

```bash
task demo:create NAME='Bakers Guild'
```

`demo:create` uses the raw factory: one transaction creates the instance and endows its proving
tank; a second sets the community's own per-root spend limit on the vault. Run `demo:govern` for
that raw instance to add its Safe and transfer scoring authority. The wizard at
<http://localhost:3000/create> instead uses the governed wrapper: five screens and one signature
create the instance, Safe, and enabled voting module atomically.

Three fields in the params (`schemaUid`, `accumulator`, `chainId`) must be sent as zero: the factory
**derives** them and rejects anything else. That is what stops a creator pointing a new instance at
someone else's accumulator.

Watch it arrive, with nothing restarted:

```bash
curl -s localhost:65421/instances | jq '.instances[] | select(.name=="Bakers Guild") | {id, contracts}'
```

Then open `http://localhost:3000/networks/<that id>` — live, with a working Vouch button. Measured on
a production build in an earlier run: **transaction at 23:10:41, page rendering at 23:10:52.**
Nothing was rebuilt, restarted or edited: Ponder discovers each snapshot, resolver and distributor
through a `factory()` source on `InstanceCreated`, so the chain is the catalog.

## 4. Vouch, prove, pay

```bash
task demo:seed  NAME='Bakers Guild'    # 21 edges over 14 accounts, rooted at its trusted seed
task demo:prove NAME='Bakers Guild'    # trigger, prove, submit, collect the bounty
task demo:settle                       # mine, so Ponder will serve it
```

Seed **before** the first trigger. A checkpoint frozen over an empty graph proves to a zero root,
the gov hook rejects it, and its contents are immutable —
[#15](https://github.com/JakeHartnell/trustgraphs/issues/15).

Reload the network page: scored members. Proving by hand instead of by scheduler is
`task instances:prove-all`, kept as the documented fallback
([`trust-graph/runbook.md`](./trust-graph/runbook.md)); to see what the daemon would do without
spending anything, `task demo:dry-run`.

**Pay people.** The dev deploy attaches the distributor as soon as the network's Safe exists, so
the fund is Safe-owned from its first block. Fund it, publish a
distribution against the proven root, and claim. A worked run: `10 ETH` distributed, and a member
holding 21.5465430930861861723725% of the pool claimed exactly `2.154654309308618617 ETH`.

The contribution round is this same mechanism driven end to end without you: `task demo` seeds the
round's claims and valuations, the daemon proves the two-lane root (rater reputation over the
community's real vouch graph, mirrored in at the checkpoint), and `demo:payout` funds the round's
own distributor against that root and claims for every persona — through the payout page's exact
API seams, which is why it needs the indexer. The wei-exact worked example over the isolated
fixture graph is [`contributions/local-testing.md`](./contributions/local-testing.md).

## 5. The indexer and the app

```bash
pnpm frontend dev      # :3000
pnpm indexer start    # :65421; production-mode Ponder, so a crash resumes its checkpoint
```

```bash
curl -s localhost:65421/instances | jq '.pagination.total, .instances[].name'
curl -s localhost:65421/vault/$(task --silent demo:id) | jq '{ethBalance, burn, unpaidRootsSinceLastPayment}'
```

Open `http://localhost:3000/networks/<id>`. The **proving tank** panel reads that vault endpoint: how
much is left, how fast it is going, and what happens when it runs out. It deliberately distinguishes
"nobody has funded this" from "the money ran out" — different situations, different fixes — and
shows a runway only when there is evidence for one.

If a page is empty, `task demo:report` will tell you why without opening a browser: it checks that
the score blob is retrievable through the gateway the indexer uses, and that the indexer is serving
`/network/<snapshot>`.

## 6. The claims worth demonstrating

These are the security properties, not the happy path.

**Params cannot drift from what was registered.** The read-only scan rebuilds every instance's
params **from its `InstanceCreated` event** and checks `params_hash(event params) ==
snapshot.paramsHash()`. It refuses to prove anything at all if a single instance fails:

```bash
task instances:scan
# 1 registered instance(s)
# …
# dry run: params self-check passed for every reconstructed instance
```

**Clones cannot cross-feed.** Create two networks and `trigger()` both before either has an
attestation — their checkpoints are then byte-identical (`acc = 0x0, leafCount = 0`). Prove one and
submit its proof to the other: it reverts `JournalMismatch` (`0x65099f97`), while submitting to its
own instance succeeds. The only thing separating them is `paramsHash`.

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

## Gotchas

Everything below cost someone real time.

- **anvil only mines on transactions, and 20 blocks is not enough.** An idle chain stops advancing
  Ponder's finalized head, and Ponder does not serve unfinalized blocks. It moves that head only
  when `latest >= finalized + 2 * N`, then sets finalized to `latest - N`; chain 31337 is not in its
  table so `N` falls through to the default **30**. The moment the demo stops, the last ~60 blocks —
  the attestations, the checkpoint and the root among them — sit one block short of visible, and the
  indexer looks perfectly healthy while the page stays empty. `task demo` ends with `demo:settle`,
  which mines 64. By hand: `cast rpc anvil_mine 0x40`. Better: `anvil --block-time 1`.
- **IPFS is not optional, and "pinned" is not the same as "readable".** A successful `add` only
  proves the API node took the bytes: if `[ipfs] api` and `IPFS_GATEWAY` are different nodes, the
  daemon reports `pinned` and readers get 504. The indexer records that root as pending, continues
  indexing unrelated events, and retries it from a durable queue every five blocks with bounded
  backoff; current-score APIs return 503 rather than presenting an older tree as current. The
  operator still reads the blob back through `[ipfs] gateway` before calling it published, and
  `task demo:report` prints whether the scores are actually retrievable.
- **Restarting anvil changes the chain even though its chain id stays 31337.** The indexer startup
  guard records a block hash independently of Ponder. An ordinary indexer restart reuses its
  checkpoint; a different local chain automatically gets a fresh index schema and clears the
  chain-id-keyed RPC cache plus derived off-chain tables. It also verifies historical state before
  starting, so an Anvil restored from a state-only snapshot fails with an actionable message
  instead of a `BlockOutOfRangeError` restart loop. Use `pnpm indexer start` for the demo: Ponder's
  `dev` mode intentionally rebuilds derived tables for hot reload. Do not bypass the package script
  with a raw `ponder` command or those guards do not run.
- **A restarted anvil also wedges the operator's journal.** A `WorkKey` is
  `(chain_id, instance_id, checkpoint_id)`; on a devnet the chain id is fixed, the instance id is
  `keccak(creator, name, salt)`, and a fresh chain counts checkpoints from 0 again. So the previous
  run's `settled: landed` record matches the new chain's first unit of work exactly and the journal
  refuses it — correctly, given what it knows — while `plan` re-proposes the same doomed `Prove`
  every tick. `task demo` clears `.demo/` first, and the refusal names which of the four causes it
  is. Driving the daemon by hand after a restart: `task demo:clean`.
- **Nothing here builds the guest ELFs, and everything here needs them.** Each prover invocation
  in `taskfile/demo.yml` exports `SP1_SKIP_PROGRAM_BUILD=true`, which makes `zk/prover/build.rs`
  emit the ELF _paths_ without producing the ELFs — the right trade when they exist (a rebuild per
  tick would be unusable) and a confusing one when they don't: the failure is a missing-file error
  from `include_elf!` naming a path under a `zk/*/target/` directory, minutes into a Rust build.
  `task zk:build` makes them; `demo:preflight` now checks for them and says so by name. The same
  applies after editing anything under `crates/` — `sp1_build` does not watch path deps, so cargo
  reuses the stale ELF and you debug a change that isn't in the binary.
- **Export the vkeys before deploying.** `SP1JournalVerifier` pins its vkey **immutably** at
  construction, so a stale `.env` value gives a stack that deploys cleanly and then refuses to prove
  anything (`{"action":"hold","hold":"verifier_rotated"}`). `task demo:deploy` derives them from the
  checkout rather than trusting the file; `task demo:vkeys` prints them.
- **…and don't let the vkeys change AFTER deploying.** The mirror image of the previous two: any
  prover invocation _without_ `SP1_SKIP_PROGRAM_BUILD=true` lets `build.rs` rebuild all the guest
  ELFs with the local toolchain — and a rebuild is not a no-op, because the ELF (hence the vkey) is
  a function of the toolchain that built it. One unguarded `cargo run` between `deploy` and `prove`
  (it was `contributions … paramshash`, inside `seed-round`) re-made every vkey four minutes after
  the verifiers pinned the old ones, and the daemon held **both** instances with `verifier_rotated`
  / `expected: 0x0` (run.rs zeroes the expected verifier when the on-chain vkey isn't the one its
  own guest produces). Every prover call in the taskfiles and the daemon's own spawned `cargo run`
  now pin the skip; if you add one, pin it too. Only `task zk:build` builds guests.
- **Attest before the first trigger.** §4, and
  [#15](https://github.com/JakeHartnell/trustgraphs/issues/15). The same rule is why `task demo`
  seeds the contribution round before `prove` writes the operator config: the daemon's first
  trigger on the round freezes both of its lanes, and a checkpoint frozen over an empty round is
  immutable.
- **The round's payouts are not local-testing's payouts, on purpose.**
  [`contributions/local-testing.md`](./contributions/local-testing.md) golden-locks the
  6-persona fixture over a graph containing only its six vouches. Inside `task demo` those six
  vouches land on top of the 21-edge community graph and rater reputation is computed over the
  whole thing, so every payout differs (EVE, unvouched in the fixture, has reputation here). If a
  number looks "wrong" against that guide, this is why. The structural facts still hold: the root
  verifies, the indexer independently re-derives it, and Σ payouts = pool − the 3% fee.
- **The round driver reads wagmi-generated contract addresses, so `demo:seed-round` regenerates
  them first — and then verifies it.** The driver's schema uids flow live from
  `config/networks.development.json`, but `packages/frontend/lib/contracts.ts` (the EAS, distributor and
  pool-token addresses) only changes when frontend codegen runs — so left stale it sends a
  current schema uid to a previous deploy's EAS, which dies as a bare no-data revert.
  `demo:seed-round` runs the codegen and then asserts the generated EAS address equals the one
  this deploy wrote, because the failure that motivated the check was codegen that silently
  no-opped: `pnpm --filter frontend …` matches nothing (the package is named
  `trust-graph-frontend`) and pnpm treats an empty filter match as success. By hand it's
  `pnpm frontend config:generate && pnpm frontend config:link && pnpm frontend wagmi:generate`.
- **`demo:payout` needs the indexer; everything before it does not.** Funding pins `expectedRoot`
  from the round API and each claim fetches its merkle bundle from it — the payout page's exact
  seams, which is the point of driving them. No indexer → the step skips itself and says how to
  run it later (`task demo:payout`). The indexer marks the round `verified` only once its own
  re-derivation matches the landed root. It selects the complete public tuple from
  `ContributionsParamsUpdated` history by the checkpoint's pinned `paramsHash`; no indexer
  sidecar is involved.
- **`task demo:govern` is only needed for later raw `demo:create` instances.** Browser-created
  instances emit `GovernedInstanceCreated`, so their Safe and module are discovered without a file
  edit or restart. The raw add-on task still writes two files, and they are not interchangeable: the frontend reads
  `config/networks.development.json`; Ponder reads `.docker/deployment_summary.json`. Updating only
  the first gives a UI with a governance tab over a module nobody indexed, which fails as `Query
data cannot be undefined` for `merkle_gov_module`. Restart the **indexer** as well as the app.
- **`registry_from_block` is not optional off-devnet.** Left at 0 against a registry deployed at
  block 21,000,000 the scan issues ~2,100 empty `eth_getLogs` calls, and most providers reject the
  range outright as an archive request — so the daemon gets _no catalog at all and every tick
  fails_. Startup alerts if you forget. Irrelevant on a fresh anvil, fatal on a real chain.
- **Deploy artifacts are not chain-scoped.** `.docker/*.json` and `config/networks.development.json`
  have fixed filenames, so deploying to a second chain overwrites the first's — and fails
  _confidently_, because the same deployer and nonce sequence produces the same addresses on both.
  One chain at a time.
- **`pnpm deploy:contracts` needs a platform-matched esbuild.** If `node_modules` was installed on a
  different OS you get `TransformError`; fetch the right `@esbuild/<platform>` tarball and point
  `ESBUILD_BINARY_PATH` at its binary. `pnpm add` fails outright on a store mismatch.
- **The indexer's database is disposable.** Everything it serves is derived from chain events, so
  losing Postgres costs a rebuild and nothing else: restart it, point Ponder at a fresh `--schema`,
  and the catalog and every network's scored members come back in seconds. Verified by killing
  Postgres mid-demo — 4 instances and the demo network's members, all recovered from the chain.
- **`pkill -f anvil` matches the shell running it** and will kill your own session. `pkill -x anvil`.
  Same trap with `pgrep -f`, which will tell you a dead service is alive. Check by port.
- **Proving is mocked locally, and here is exactly where that stops.** `SP1_PROVER=mock` runs the
  guest for real and commits its real public values; the dev gateway is a stub too. The params
  self-check, the exporter's re-fold proof, guest-vs-native byte equality, journal binding, the
  vault's payout arithmetic and the entire write path are production code either way. What is _not_
  demonstrated is that a real Groth16 proof verifies at Succinct's canonical gateway — that needs
  `SP1_PROVER=network` or a 16–32 GiB box, and it is the first thing a real deployment should do
  ([`DEVIATIONS`](../../research/DEVIATIONS.md) #20).

## Related

- [`create-a-network.md`](./create-a-network.md) — what the factory is, what it refuses, and why
- [`run-a-prover.md`](./run-a-prover.md) — the daemon: configure, run, alert, recover, self-host
- [`trust-graph/runbook.md`](./trust-graph/runbook.md) — proving a single instance by hand
- [`trust-graph/local-testing.md`](./trust-graph/local-testing.md) — the mainnet-fork rehearsal,
  where proofs are real
