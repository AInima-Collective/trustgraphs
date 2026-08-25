- ~~Tag release~~ **done: v0.0.4**
- ~~Generate vkeys and elf digest~~ **done: published in the release**
- ~~Admin EOA~~ **done: `0x45CbC00e0618880bfB2dBDdEAed1ef1411dd5eeE`**
- ~~Fresh deployer key (with Sepolia ETH)~~ **done: `0x57cFdD9115da5DfB1C5Fc1E8Fe622C030E67bD30`, 0.5 ETH**
- [x] Sepolia RPC endpoint
- [x] NETWORK_PRIVATE_KEY — PROVE credit confirmed; throwaway key, decided; see 1.5
- [x] SUBMITTER_PRIVATE_KEY — funded: `0xf6161E3c…`, 0.2 ETH
- [ ] Metadata for the seeded network
- [ ] Trusted seeds for the seeded network
- [ ] Railway: indexer, operator, frontend
- [ ] Postgres, IPFS pinning, DNS, Etherscan key

==== long version...

# Sepolia deploy: what I need from you

Everything here needs a credential that must never touch the repo, an account only you can
open, or a judgment call that is yours. The engineering plan is in
[SEPOLIA_GOAL.md](SEPOLIA_GOAL.md); this is your half.

**Part 1 blocks everything.** Part 2 is decisions. Part 3 is economics, already decided,
read it and veto. Part 4 is accounts. Part 5 is deploy day.

**One rule:** no key, RPC URL, database URL, or API token goes into this repo, into
`deployments/sepolia.json`, or into a chat message. Variable names and where each value goes
are in [`.env.example`](.env.example). Send me addresses and public URLs only.

---

## What changed since the last version of this file

Two items are off your list.

**The vkeys are done and they are better than what I was going to ask you for.** The old 1.1
had you install an SP1 toolchain and build the guests locally. That would have produced a
number that was a fact about your laptop: Succinct's own docs say the plain build "may not
generate a reproducible ELF," and our `addresses-and-vkeys.md` had already recorded a
toolchain reinstall shifting vkeys with no source change. Pinning that into a verifier that
can never be edited was the risk. It is now built reproducibly by CI instead, and the values
below have been produced identically by three independent builds across three commits.

**The operator is hostable.** It used to shell out to `cargo run` at runtime, keep its state
in relative paths, and have no HTTP surface, so it needed a source tree and a compiler on the
box forever. That is fixed and released as a container image.

---

## Part 1: Blocks everything

### 1.1 Verification keys — DONE, nothing for you to do

Published in [v0.0.4](https://github.com/JakeHartnell/trustgraphs/releases/tag/v0.0.4), built
by a public workflow from commit `95faa6f`, agreed on by two cold runners before it shipped.

| Variable | Value |
| --- | --- |
| `SP1_PROGRAM_VKEY` | `0x003c8e19b8e12c260e5450a068c61460180b5cf93f03dc1214187a9ad3bdde5e` |
| `SP1_SIGNER_PROGRAM_VKEY` | `0x00d1b981df6bee1682be2b212151d2ac74c30108215d8e949a84a604ae4baadb` |
| `SP1_WEIGHTED_PROGRAM_VKEY` | `0x0027625a41e9d165ab50ca4ff9afbc134385b99688a5fd69cdf03d5056f5abb2` |
| `SP1_COMPOSITION_PROGRAM_VKEY` | `0x00e2847cc257d916a6422283094e8764296045e5f9ed8805b7aaa9b3dd6f7aed` |
| `SP1_PROGRAM_ELF_SHA256` | `1ad727e35139b7db669430052a376b6850352c2fc5792a0f6815c7da21b7059d` |

**Decide:** which commit we deploy from. It matters because `SP1JournalVerifier` pins its vkey
at construction and `TrustgraphsFactory` pins its verifier: changing a vkey afterwards means a
new verifier and a new factory.

My recommendation is now **a later tag, not `v0.0.4`**. Two deploy defects have been fixed
since it (`4735840`, `f021f97`), and the operator has substantial uncommitted work in flight.
None of that touches guest source, so **the vkeys in the table above are unchanged either
way** — a later tag republishes exactly these values. What changes is that the tag matches the
code we actually run. If we do cut one, `DEPLOYMENT_COMMIT` in `.env` moves to that commit.

If you want to check the values rather than trust them:

```bash
gh attestation verify oci://ghcr.io/jakehartnell/trustgraphs-operator:v0.0.4 \
  --repo JakeHartnell/trustgraphs
gh release download v0.0.4 -R JakeHartnell/trustgraphs -p guest-manifest.json
```

### 1.2 The admin EOA — DONE

```
0x45CbC00e0618880bfB2dBDdEAed1ef1411dd5eeE
```

Checked, so it is checked once rather than at broadcast time: EIP-55 checksum valid; no code
on Sepolia, so a plain EOA rather than a Safe; 1.0199 Sepolia ETH; nonce 11, so a live key
with history rather than a fresh one. Not the burned `0x3ED16f9…`, not a stock Anvil account,
and it appears nowhere in this repo. (Now 0.8198 ETH at nonce 12: this is the account that
funded the submitter in 1.5.)

**It holds:** `InstanceRegistry` `DEFAULT_ADMIN_ROLE` and `OPERATOR_ROLE`, set in the
constructor, so it holds them from the moment the registry exists. **It must not be the
deployer from 1.3**, which has to be a brand new key — this one has spent history and holds
funds.

**It does not hold the `ProvingVault`,** and an earlier version of this line said it did.
`DeployProvingVault` hardcodes the **deployer** as vault admin and fee-setter and accepts no
argument to point elsewhere, so without an explicit handoff the vault stays under a key made
for one afternoon. Step 5b of Part 5 is that handoff. The registry timelock this line also
referenced does not exist yet either; see the DECIDED block below.

Originally scoped as "EOA over Safe, right for a testnet". That framing is superseded by the
decision below.

What the key actually holds, checked against the contracts rather than summarised:

- **`ProvingVault` admin** sets fee bands and gas parameters — its entire privileged surface is
  `setFeePerRootUsd` and `setGasParams`. It **cannot** take depositors' funds: there is no admin
  sweep, and `withdrawCredit` pays out the caller's own credit. (Held by the deployer at deploy
  time, not by this key, until step 5b hands it over.)
- **`InstanceRegistry` OPERATOR_ROLE** can rewrite any instance's directory row and repoint
  any instance's params authority.

That second one deserves precision, because the registry is read on-chain and not only by
frontends. Every reader that could lose money or integrity already defends against a rewrite:

- `ProvingVault` binds an instance's snapshot at first deposit and caches it. `migrate()`
  re-reads the registry but is `onlyConstitutional`, gated on the **currently bound**
  snapshot's role, so a rewritten row cannot redirect anyone's prepaid balance.
- `CompositionSourceAdapter` pins the record at construction and reverts
  `RegistryRecordChanged` if it moves: composition **fails closed** rather than producing
  wrong scores.
- `TrustgraphsParamsController` cross-checks the registry against the snapshot's own
  `paramsHash` and reverts on mismatch.
- `MerkleGovModule` and `MerkleFundDistributor` never read the registry. Their snapshot is
  constructor-set and only movable by `onlyOwner`, which is the community's own Safe.
- No registry write can forge a root: that needs a valid SP1 proof against a vkey pinned at
  verifier construction.

So the real downside of a compromise is **misdirection of discovery** (a UI pointed at a
snapshot of the attacker's choosing), **seizure of any instance's params authority**, and
**denial** (making composition adapters and params rotations revert). Not theft, not forged
scores, not redirection of governance or fund distribution.

**DECIDED: rehearse the mainnet custody shape, not a testnet shortcut.** Your call, and it
turned out to be worth more than the question that prompted it. I said "give OPERATOR_ROLE to
the operational timelock, which is already being deployed." I was wrong about the second half.

**There is no platform-level timelock anywhere in this repo.** `DeployTimelocks.s.sol` exists,
but the timelocks it deploys are **per-network** and hold `CONSTITUTIONAL_ROLE` /
`OPERATIONAL_ROLE` on a single `MerkleSnapshot`. Nothing holds `InstanceRegistry.OPERATOR_ROLE`
except whatever address is passed as the registry admin, and the Sepolia profile deploys five
contracts with no timelock among them. So the `InstanceRegistry` NatSpec, which says this role
is "held by the operational timelock", describes an intention that no deploy path implements
— on any chain, including production.

That makes this the right thing to find on a testnet rather than after mainnet. Building it is
mine, and I have added it to the plan. **What I need from you is two numbers and one shape:**

- **Delays.** Mainnet defaults elsewhere in this repo are 14 days constitutional, 2 days
  operational. My recommendation is to use the real operational delay of **2 days** on Sepolia
  rather than a token one. The delay is the part that changes how you operate: it forces every
  registry fix to be planned two days ahead, and finding out whether we can live with that is
  the whole reason you chose this. The number is trivially changeable later; the habit is not.
- **Proposer and executor.** Your admin EOA to start. A Safe as proposer is the fuller mainnet
  shape and I would add it before mainnet rather than now, because it mostly constrains
  signing, whereas the timelock constrains operations.

The EOA still holds `ProvingVault` admin and fee-setter directly. Those are parameters, and
putting a two-day delay on a fee band would make the testnet worse at the thing it is for.

Not doing: renouncing `OPERATOR_ROLE` outright to make rows append-only forever. Mainnet will
not do that, so rehearsing it teaches us nothing, and a mistyped row would become unfixable
short of a new `instanceId` and asking every affected community to call `migrate()`.

**Settled:** a key that is *not* the deployer from 1.3, which is why 1.3 generated a fresh one.
Address given and checked above.

### 1.3 The deployer key — DONE

```
0x57cFdD9115da5DfB1C5Fc1E8Fe622C030E67bD30
```

Checked: EIP-55 checksum valid; no code on Sepolia; **nonce 0**, so genuinely unused, which is
the property a deployer needs and the one worth verifying rather than assuming. Distinct from
the admin key in 1.2, not the burned `0x3ED16f9…`, absent from this repo.

The private key goes in `FUNDED_KEY` in your environment. `.env` is gitignored and only
`.env.example` is tracked, so that path is safe — worth stating in a repo that has leaked a
key before.

**Funded: 0.5 ETH, from a faucet.** The admin key's balance is unchanged, so it stayed cold.

The budget, measured rather than guessed. I summed the gas from prior broadcast receipts of
the same scripts: **54.1M gas** for the full set (EAS schema registrar 3.9M, ZK verifier 0.2M,
registry 0.9M, vault 4.6M, factory 14.8M, governed factory 13.0M, timelocks 8.7M, seeded
instance 8.0M). I plan against **62M**, because Sepolia drops two local-only costs (we register
schemas against canonical EAS instead of deploying it, and use the real feed and USDC instead
of mocks) but adds the signer verifier and the platform registry timelock.

Sepolia base fee was **1.05 gwei** when this was written, stable and with negligible tips, so
0.5 ETH is roughly eight full runs. **The number to watch is 8 gwei:** above that, 0.5 stops
covering a single complete run. Sepolia spikes harder than mainnet because no real fee market
disciplines it, so if a rehearsal coincides with a busy period, top up before broadcasting
rather than during.

Running dry mid-broadcast is the failure worth avoiding: it leaves a half-deployed stack with
the deployer still holding bootstrap roles and nothing renounced, and the resume logic
currently trusts local artifacts rather than on-chain state (a known gap, SEPOLIA_GOAL M4).

This key is hot: it signs a long broadcast session and renounces its roles at the end. It
stays separate from the admin, which is why we generated a new one rather than reusing 1.2.

### 1.4 A private Sepolia RPC endpoint — DONE

Alchemy, Infura, QuickNode, paid tier. Must serve logs and historical state from the
deployment block onward; an archive node back to genesis is not required.

This is the binding constraint on the indexer, not Railway. Ponder's historical backfill is
heavy and a rate-limited public endpoint will stall it.

**Done.** Alchemy, in the `.env` as `PONDER_RPC_URL_11155111`; the deploy dry run reads the
chain through it. Still needed when the frontend goes up: the same URL as `RPC_URL_11155111`
for its server side.

### 1.5 A funded Succinct prover network account — DONE

We are a **requester**, not a prover: no on-chain proving obligation. Two separate keys:

| Variable | Purpose |
| --- | --- |
| `NETWORK_PRIVATE_KEY` | Succinct prover network requester key, needs PROVE credit |
| `SUBMITTER_PRIVATE_KEY` | pays submit gas on Sepolia, holds no value, rotatable |

Separate on purpose: the payee is named in the proof journal, so the submitting key never
needs to hold funds beyond gas.

**Both settled, 2026-08-25.**

**`SUBMITTER_PRIVATE_KEY` — funded.** `0xf6161E3c1e83EF8297690153120462633570B8D1`, **0.2 ETH**,
verified on chain. It needed it: "holds no value" means it never custodies anything, not that
it runs on nothing, and it signs every checkpoint and `submitProof`. At the measured ~0.6M gas
per `submitProof` ([PROOF_SCHEDULER §216](research/PROOF_SCHEDULER.md)) and today's ~1.08 gwei
that is on the order of **300 submissions**, so it will not be what stops us. Watch it if
Sepolia gas spikes: at 20 gwei the same 0.2 ETH is closer to 16.

**`NETWORK_PRIVATE_KEY` is the admin EOA's key, and that is the decision.** It derives to
`0x45CbC00e0618880bfB2dBDdEAed1ef1411dd5eeE`, the same key as `INSTANCE_REGISTRY_ADMIN`. You
ruled it a throwaway holding little value, to be handled carefully anyway. Recorded here
because the consequence is not obvious from the variable name: `SP1_PROVER=network` means
sp1-sdk reads it **inside the operator container**, so the key with `DEFAULT_ADMIN_ROLE` and
`OPERATOR_ROLE` over the registry lives in a long-running hosted service's environment. Part
4.1 was written assuming the opposite.

Being careful with it, concretely — three things, none of which cost time:

1. **The operator service is admin-privileged.** It gets its own secrets, not a set shared with
   the indexer or the frontend, and nobody gets a shell on it casually.
2. **Both roles rotate together.** If that key is ever exposed, it is not enough to rotate the
   Succinct account: the registry's `DEFAULT_ADMIN_ROLE` has to move too, or the exposure
   outlives the rotation.
3. **This shape does not travel to mainnet.** On mainnet the registry admin is a timelock and
   the Succinct requester is a separate funded key. Filed as a deviation, not a pattern.

The ceiling, so the risk is a known size rather than a worry. If that box is taken, the key can
rewrite any instance's registry record (misdirecting discovery), seize any instance's
`paramsAuthority`, and grant itself further roles. It **cannot** steal funds, forge scores, or
redirect governance or fund distribution: `ProvingVault` caches its binding and gates
`migrate()` on `onlyConstitutional`, `CompositionSourceAdapter` fails closed with
`RegistryRecordChanged`, and the gov module and fund distributor never read the registry.
Denial and misdirection on a testnet. Not theft.

**PROVE credit: confirmed 2026-08-25.** Part 1 is closed; nothing in it is waiting on you.

**One thing to eyeball, because I cannot check it from here and nothing else will.** Credit is
tied to the *requesting key*, so the balance has to sit under
`0x45CbC00e0618880bfB2dBDdEAed1ef1411dd5eeE` specifically. Depositing under a different Succinct
account is an easy mistake and produces a state that looks exactly like "we have credit" right
up until the first request fails. Worth ten seconds on the dashboard.

The reason it is worth those ten seconds: **there is no PROVE-balance check anywhere in the
system.** The operator checks the submitter's *ETH* balance at startup and alerts on zero
(`zk/operator/src/run.rs:87`), and that check has no PROVE counterpart in the operator, the
prover CLI, any script, or preflight. So the first thing that would tell us the credit is under
the wrong account is a failed proof request during step 6 of deploy day.

`sp1-sdk` 6.3.1 exposes `NetworkProver::get_balance()` (`network/prover.rs:219`), so the guard
is small and mirrors the ETH one exactly. I have **not** written it: `run.rs` has uncommitted
changes from the operator session right now, and a second hand in that file buys a merge
conflict for a check that a dashboard glance covers today. Flagged there instead.

---

## Part 2: Decisions, no commands

### 2.1 The seeded network's trusted seeds

**The one I would think hardest about.** Scores flow outward from the seeds, so this list is
the root of authority for the seeded network. `tests/e2e/params.template.json` currently has
the three default Anvil accounts, which are placeholders.

**Decide:** which accounts, and how many.

### 2.2 The seeded network's identity

- Name and a one-line description
- Metadata, which I can pin once you give me the content
- Whether it carries a fund at creation

On that last one: if it carries a fund, its distributor owner **must** be an initialized Safe
(`TrustgraphsFactory.sol:358` reverts `InvalidDistributorSafe` for an EOA — a deliberate audit
fix). You do not need to make one by hand. I will create the seeded network through the
**governed** factory, which mints its own Safe in the same transaction and dogfoods the exact
path visitors use, unless you object.

### 2.3 Algorithm parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `damping_fp` | 0.85 | PageRank damping |
| `tolerance_fp` | 0.000001 | convergence tolerance |
| `max_iterations` | 100 | iteration cap |
| `max_weight_fp` | 100 | ceiling on a single vouch weight |
| `trust_share_fp` | 1.0 | share of rank flowing along trust edges |
| `trust_decay_fp` | 0.8 | decay per hop |

**Decide:** "defaults are fine" is a good answer. Asking only because these go into the params
hash at creation and are governance-rotatable afterward, not free-form.

---

## Part 3: The economics, decided

You said it is just testnet and we are losing money on it. That is right, and it points at
the thing to be precise about: **the money we lose is not the money the system talks about.**
The vault collects faucet USDC, worth zero. Every proof spends real Succinct credit. So on
Sepolia the vault is a *rehearsal* of a revenue mechanism, and the only thing between us and
an unbounded bill is the operator's own budget ceiling.

**What a proof costs.** Measured guest cycles against the current ELFs, post the
scoring-engine fix that removed the quadratic rank loop:

| Graph | Cycles | Realistic hardware cost |
| --- | ---: | ---: |
| 25 accounts | 2,335,137 | negligible |
| 100 accounts | 66,973,643 | $0.003 - $0.01 |
| 200 accounts | 244,915,295 | $0.01 - $0.04 |
| 400 accounts | 538,786,913 | $0.03 - $0.08 |

There is a fixed floor per request too: the auction and Groth16 wrap cost the same at any
size. Budget **$0.05 to $0.50 per proof**, and treat proof *frequency* as the thing that
matters, not graph size.

**The decisions:**

1. **Fee bands stay $5 / $10 / $15.** Zeroing them leaves the prepay path untested, and
   testing it is the point of a testnet. Prepay here is friction, not a financial gate.
2. **We seed the vault with nothing.** It holds each instance's own deposits; funding the
   seeded network's prepay would be paying ourselves.
3. **The seeded network is the entire free tier.** `curated.instances` gets exactly one
   entry. A permissionless factory plus free proving for all comers is unbounded liability.
4. **Everyone else goes through the paid path**, pointed at the deployed vault.

**The numbers that actually bind:**

| Setting | Stock | Sepolia | Why |
| --- | ---: | ---: | --- |
| `budget.global_usd_per_day` | 250 | **15** | Stock is a $7,500/month ceiling: a runaway guard, not a budget |
| `budget.per_instance_usd_per_day` | 25 | **2** | ~4 proofs/day of a 400-account graph |
| `signer_sync.per_instance_usd_per_day` | 5 | **1** | Signer proofs only follow score roots |
| `signer_sync.global_usd_per_day` | 50 | **5** | Same |
| `budget.cents_per_billion_cycles` | 100 | **unchanged** | Over-prices real cost 7-20x. Safe direction for a halt guard. Do not "correct" it |
| `prover.cycle_limit` | 8B | **unchanged** | Refuses past ~3,467 inputs, which on a testnet is correct |
| Factory `EPOCH_FLOOR` | 7,200 | **7,200** | ~1 day at 12s blocks. The biggest cost lever |
| `cadence.subsidy_min_blocks` | 216,000 | **7,200** | See below |

**The one number to change on purpose.** `subsidy_min_blocks` defaults to ~30 days and applies
only to curated instances, which after decision 3 means exactly one network: ours. That
default is right for subsidizing someone else's network in production. It is wrong for our
demo: a network whose scores update monthly reads as abandoned. At 7,200 it updates daily for
about $15 a month.

Alert at 80% of the global cap, so we hear about a runaway before it halts us.

**What it adds up to:** under **$30/month** while quiet, hard ceiling **$450/month** even if
the cap saturates every day, versus $7,500 under stock defaults. If someone grinds the cap,
proving halts and alerts. The escalation lever is `paid.enabled = false`: we then prove only
for the curated network and strangers prove for themselves. That is the abuse response, not
the default, because the paid path is one of the things we came here to test.

---

## Part 4: Accounts and hosting

None of this blocks the fork rehearsal. All of it blocks going public.

### 4.1 Railway

Four services off this repo. All three of the long-running ones now fit.

| service | root | start | public |
| --- | --- | --- | --- |
| Postgres | managed plugin | | no |
| `ponder` (writer) | `packages/indexer` | `pnpm run start` | no |
| `ponder-server` (reader) | `packages/indexer` | `pnpm run serve` | yes |
| `operator` | image below | default entrypoint | no |

Keep the writer/reader split: it is what lets the public API keep serving the last completed
views schema while a backfill runs. The `erc8004-metadata` worker in `docker-compose.prod.yml`
is not part of this release.

**The operator is now a published image**, so it needs no source tree, no toolchain, and no
build step:

```
ghcr.io/jakehartnell/trustgraphs-operator:v0.0.4
```

One config file, two secrets, one volume. Full instructions in
[`docs/build/run-a-prover.md`](docs/build/run-a-prover.md). Three things to get right:

- **Attach a named volume at `/data`.** `journal.jsonl` is the only file whose loss costs real
  money, because a fresh journal re-requests proofs we already paid for. An unnamed volume is
  orphaned when the container is replaced, which is what a deploy is. It needs a backup, not
  just persistence.
- **Never raise the replica count.** Two operators on one journal request every proof twice
  and double the bill. A Railway volume forces the old deployment down before the new one
  starts, which here is exactly what we want.
- **Two hot keys live in that service's environment** (`NETWORK_PRIVATE_KEY`,
  `SUBMITTER_PRIVATE_KEY`), and on Sepolia the first of them **is** the admin EOA from 1.2 —
  a deliberate testnet call on a throwaway key, recorded in 1.5 and filed as DEVIATIONS #41.
  This line used to say to keep the admin EOA nowhere near this box; that remains the right
  rule and is what mainnet will do. It means this service gets its own secrets rather than a
  set shared with the indexer or frontend, and that a leak here rotates the registry's
  `DEFAULT_ADMIN_ROLE` as well as the Succinct account.

Set `[ops] listen` so Railway's healthcheck has something to probe, and point the frontend's
`OPERATOR_STATUS_URL` at the same service.

### 4.2 The accounts themselves

- [ ] **Postgres**, managed or backed up. Fresh writer schema (`trustgraph_sepolia_v1`) and a
      separate public views schema. Never share the old Optimism production schema.
- [ ] **IPFS pinning** (Pinata or equivalent) with credentials. Score blobs must be pinned and
      retrievable through the public gateway *before* their root transaction is sent, or the
      chain carries a root whose scores nobody can read.
- [ ] **HTTPS hosting and DNS** for the Ponder API and the frontend.
- [ ] **A volume** on the operator service, with a backup.
- [ ] **An Etherscan API key.** Flagging: this repo has **no** verification tooling today, no
      `--verify` in the pipeline and no `etherscan` block in `foundry.toml`. I build the step;
      you supply the key.
- [ ] **WalletConnect** configured with the deployed domain in its allowed origins.
- [ ] **Monitoring:** error tracking, uptime, root-freshness alerts, RPC and IPFS quota
      alerts, and a webhook the operator can post to.
- [ ] **A secret manager** holding: deployer key, submitter key, Succinct requester key, RPC
      URL, database URL, Pinata credentials, Etherscan key.

---

## Part 5: Deploy day, with me

Where you press the button, in order. I will have everything staged.

The plan is **five contracts**, and I have run it as a dry run against your `.env`: EAS schema
registrar, ZK verifier, InstanceRegistry, ProvingVault, TrustgraphsFactory. No timelocks, no
governed factory, no weighted or compose lane, no instance — those are outside the first
testnet gate. Two consequences worth knowing now: the gas is **~24.4M, not the ~54M I budgeted
before** (the old number summed steps this plan does not run), so 0.5 ETH covers roughly twenty
full attempts at today's ~1.1 gwei; and **creating the seeded network is a separate step after
this**, so 2.1 and 2.2 do not block the button.

1. **Approve the release commit** and confirm the vkeys in 1.1 are the ones we pin.
2. **Clear `.docker/*_deploy.json`.** It is gitignored scratch shared with every local anvil
   run, and it currently holds yesterday's dev stack — including a `program_vkey` from a local
   non-docker build, the exact value that must never be pinned. A clean full run overwrites
   each file before the next step reads it, so this only bites a resumed or partial run. The
   manifest now refuses to be written if that vkey disagrees with the pinned one, so the
   failure is loud, but starting clean is one command.
3. **Run preflight** and read it. Fails closed on a wrong chain, a default key, a frozen SP1
   route, a stale feed, a zero vkey, or a commit mismatch.
4. **Broadcast the deployment** with your key. I never hold it.
5. **Grant the factory `REGISTRAR_ROLE`, signed by the admin EOA.** This is a real step, not a
   formality, and it is new: the registry is constructed with your admin EOA as its admin from
   birth — the mainnet shape you asked for — so the deployer cannot make this grant. Until it
   lands, **every network creation reverts**. The deploy prints the exact `cast send` and the
   two `hasRole` checks that confirm it, including the negative one: the factory must hold
   `REGISTRAR_ROLE` and must **not** hold `OPERATOR_ROLE`, because the second would let it
   rewrite existing records instead of only appending its own.

   (Until 2026-08-25 the deploy tried to make this grant itself and would have reverted at step
   5 of 5, after the other four had landed. Fixed in `4735840`; reproduced on anvil first.)
6. **Prove one real root** through the live Sepolia gateway. The last thing that can surprise
   us, and the difference between "deployed" and "working". Needs the submitter funded (1.5).
7. **Walk the browser flow** on the public domain with a clean wallet before we tell anyone.

An earlier version of this list said the deploy "moves registry and vault administration to
your admin EOA and the deployer renounces". Half of that is now true by construction and half
of it does not happen at all:

- **Registry:** correct, and better than described. `InstanceRegistry` is constructed with your
  admin EOA as admin, so there is no window in which the deployer holds it and nothing to
  renounce. That is why step 5 exists.
- **Vault:** not correct. `DeployProvingVault` hardcodes the **deployer** as both
  `DEFAULT_ADMIN_ROLE` and `FEE_SETTER_ROLE`, and the Sepolia plan has no handoff step. Left
  alone, a key generated for one afternoon's deploy permanently holds the vault's fee
  authority. Step 5b below is the fix.

**5b. Hand the vault over, signed by the deployer.** Narrow but real: `FEE_SETTER_ROLE` is the
vault's entire privileged surface — `setFeePerRootUsd` and `setGasParams`, nothing that can
move funds — so the exposure is mispricing and denial, not theft. It is still the wrong key to
leave it under, and rehearsing the handoff is a large part of why we are doing this on Sepolia
in the mainnet shape at all. The deploy prints the three sends (grant admin, grant fee-setter,
renounce admin) and the checks that confirm the deployer holds nothing afterwards.

---

## Part 6: What I'm doing meanwhile

- Governed-creation lane, including the fix that makes wizard-created DAO Safes visible in
  app.safe.global (the script currently deploys its own singleton)
- Feed and USDC validation in the vault deploy
- The release-capable seeded-instance script
- Role-handoff and post-deploy invariant scripts
- The executable preflight
- Contract verification tooling
- Frontend: Sepolia in the build path, testnet label, wrong-network prompt, and hardening the
  RPC and IPFS proxies before they face the public
- One last operator item: walking the published image on a clean machine, start to finish, as
  a stranger would. Everything else in that program is done.

Then the full dress rehearsal against a Sepolia fork, so the first real transaction is not the
first time any of it has run.

---

## One open question I am not closing for you

The ingress-admission finding from the August audit is still open. Lane F made the capacity
ceiling honest, but nothing stops someone reaching it for roughly 0.0027 ETH, and who is
allowed to add inputs to a network is a product decision, not a code fix. Because you ruled
that visitors can create their own networks, this testnet is exactly the setting that
surfaces it. It does not block the deploy. It does mean the first griefing report will not be
a surprise.
