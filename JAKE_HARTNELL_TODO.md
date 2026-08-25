- ~~Tag release~~ **done: v0.0.4**
- ~~Generate vkeys and elf digest~~ **done: published in the release**
- Admin EOA
- Fresh deployer key (with Sepolia ETH) FUNDED_KEY
- Sepolia RPC endpoint
- NETWORK_PRIVATE_KEY (needs a topup of $PROVE)
- SUBMITTER_PRIVATE_KEY (doesn't need funds)
- Metadata for the seeded network
- Trusted seeds for the seeded network
- Railway: indexer, operator, frontend
- Postgres, IPFS pinning, DNS, Etherscan key

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

**Decide:** that we deploy from the `v0.0.4` commit, or say the word and I cut a later tag.
That is the only choice left here, and it matters because `SP1JournalVerifier` pins its vkey
at construction and `TrustgraphsFactory` pins its verifier: changing a vkey afterwards means
a new verifier and a new factory.

If you want to check the values rather than trust them:

```bash
gh attestation verify oci://ghcr.io/jakehartnell/trustgraphs-operator:v0.0.4 \
  --repo JakeHartnell/trustgraphs
gh release download v0.0.4 -R JakeHartnell/trustgraphs -p guest-manifest.json
```

### 1.2 Pick the admin EOA

Receives `InstanceRegistry` administrator and operator, plus `ProvingVault` administrator and
fee-setter. You ruled EOA over Safe, which is right for a testnet.

What the key actually holds, checked against the contracts rather than summarised:

- **`ProvingVault` admin** sets fee bands and gas parameters. It **cannot** take depositors'
  funds: there is no admin sweep, and `withdrawCredit` pays out the caller's own credit.
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

**Decide:** use a key that is *not* the deployer from 1.3. The deployer is hot and signs a
long broadcast session; this one should live in a hardware wallet. One key for both also
works and makes the handoff step a no-op. Tell me which.

**Send me:** the admin address.

### 1.3 Fund a fresh deployer key

`Common.s.sol` refuses the default Anvil key on a public chain, so there is no fallback.

Generate a **brand new** key. Do not reuse `0x3ED16f90e8EA54D9A1BAe67Ab2D6BDC177EadeeC` or
its private key: the August audit found it committed at `taskfile/trustgraph.yml:58` under
commit `6f5b260`, and it is burned permanently.

Fund with Sepolia ETH. I will give you a measured number after the fork rehearsal; until then
budget generously, since the run deploys a schema registrar, two verifiers, a registry, a
vault, a factory, a governed factory, and a seeded instance.

**Send me:** the deployer address only. The key goes in `FUNDED_KEY` in your environment.

### 1.4 A private Sepolia RPC endpoint

Alchemy, Infura, QuickNode, paid tier. Must serve logs and historical state from the
deployment block onward; an archive node back to genesis is not required.

This is the binding constraint on the indexer, not Railway. Ponder's historical backfill is
heavy and a rate-limited public endpoint will stall it.

**Send me:** confirmation it exists and the provider. The URL stays in secret storage as
`PONDER_RPC_URL_11155111`, and as `RPC_URL_11155111` for the frontend's server side.

### 1.5 A funded Succinct prover network account

We are a **requester**, not a prover: no on-chain proving obligation. Two separate keys:

| Variable | Purpose |
| --- | --- |
| `NETWORK_PRIVATE_KEY` | Succinct prover network requester key, needs PROVE credit |
| `SUBMITTER_PRIVATE_KEY` | pays submit gas on Sepolia, holds no value, rotatable |

Separate on purpose: the payee is named in the proof journal, so the submitting key never
needs to hold funds beyond gas.

**Send me:** the submitter address (so preflight can check it is funded), and confirmation
the network account has credit.

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
  `SUBMITTER_PRIVATE_KEY`). Good reason to keep the admin EOA from 1.2 nowhere near that box.

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

1. **Approve the release commit** and confirm the vkeys in 1.1 are the ones we pin.
2. **Run preflight** and read it. Fails closed on a wrong chain, a default key, a frozen SP1
   route, a stale feed, a zero vkey, or a commit mismatch.
3. **Broadcast the deployment** with your key. I never hold it.
4. **Confirm the role handoff** moved registry and vault administration to your admin EOA and
   that the deployer renounced. The script asserts this; you should still read it. If you
   chose one key for both in 1.2, this is a no-op and the script says so rather than silently
   passing.
5. **Prove one real root** through the live Sepolia gateway. The last thing that can surprise
   us, and the difference between "deployed" and "working".
6. **Walk the browser flow** on the public domain with a clean wallet before we tell anyone.

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
