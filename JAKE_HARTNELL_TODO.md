- ~~Tag release~~ **done: v0.0.5** (`f64a4c7`; v0.0.4 predates every deploy fix)
- ~~Generate vkeys and elf digest~~ **done: published in the release**
- ~~Admin EOA~~ **done: `0x45CbC00e0618880bfB2dBDdEAed1ef1411dd5eeE`**
- ~~Fresh deployer key (with Sepolia ETH)~~ **done: `0x57cFdD9115da5DfB1C5Fc1E8Fe622C030E67bD30`, 0.5 ETH**
- [x] Sepolia RPC endpoint
- [x] NETWORK_PRIVATE_KEY — PROVE credit confirmed; throwaway key, decided; see 1.5
- [x] SUBMITTER_PRIVATE_KEY — funded: `0xf6161E3c…`, 0.2 ETH
- [ ] Metadata for the seeded network
- [ ] Trusted seeds for the seeded network
- [ ] Railway: indexer, operator, frontend
- [x] Etherscan API key — in `.env`; **nothing reads it yet**, see 5.1
- [ ] Postgres, IPFS pinning, DNS
- [ ] **Redeploy the verifier and the factory** — the live ones pin a local build's vkey, see below

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

## Read this first: the deploy already ran, and one contract has to be redone

Between roughly 14:27 and 14:32 UTC on 2026-08-25 the five-contract plan was broadcast to
Sepolia. All fifteen transactions succeeded, the wiring is right, the roles are what they were
designed to be. One number is wrong, and it is the one number that cannot be edited afterwards.

**The verifier pins a local build's vkey.** `SP1JournalVerifier` at
`0xF8A72bcc271F298b8E75d5Bb8D4C966680Ae1C36` carries

```
programVKey = 0x00d9bbffc7d47f8a808333359a60f3e213eabe45363d94fc837203b895e8404c
```

The release built at the pinned `DEPLOYMENT_COMMIT` publishes
`0x003c8e19b8e12c260e5450a068c61460180b5cf93f03dc1214187a9ad3bdde5e` for trust-graph. That is
from `v0.0.4`'s `guest-manifest.json`, downloaded from the release and read, not recalled.
`0x00d9bbff…` is the local non-`--docker` build — the single value the whole reproducible-build
chain in 1.1 exists to keep off-chain. **A proof from the released operator image will not
verify against this verifier.** Nothing in the system would have said so: it surfaces at the
first real proof request and nowhere earlier.

`programVKey` is `immutable`, and `TrustgraphsFactory.VERIFIER` is `immutable` as well, so this
is not a setting to correct. It is a new verifier and a new factory. The blast radius stops
there: `instances` is empty, so no network was ever created against it.

Your `.env` now holds the correct vkey, so whatever produced the wrong one is already fixed. The
on-chain artifact is the only thing left over.

**How it happened, because the fix follows from it.** `task demo:deploy` derives the guest vkeys
from the local checkout and exports them, which is correct for a demo: a local stack must pin the
guests it can actually prove against. It then ran a bare `pnpm deploy:contracts`, and that
command's `--stage` and `--chain` default to `$DEPLOY_STAGE` and `$DEPLOY_TARGET` out of `.env`.
With `.env` still release-shaped, the demo deployed the five-contract *Sepolia* plan to real
Sepolia, signed by the real deployer, pinning a laptop's vkey. `demo:preflight` gave no warning
because it probes `http://127.0.0.1:8545` while the deploy read `.env` — the check and the action
were looking at different chains.

Fixed in `f4c486d`: the demo now passes `--stage development --chain local --rpc-url` explicitly,
so `.env` cannot redirect it, and `development` plus a public chain is refused outright.
`preflight` also confirms the chain it probed is really 31337 and says so before anything is
signed. Two independent guards now stand between a demo and a public chain, and a third
(`8879915`) between any local vkey and a Sepolia deploy.

**What is live right now, all verified against the chain a few minutes ago:**

| contract | address | state |
| --- | --- | --- |
| SchemaRegistrar | `0x6094420aD64FF8ab5e1909222Dc1aa549fc89721` | fine, reusable |
| SP1JournalVerifier | `0xF8A72bcc271F298b8E75d5Bb8D4C966680Ae1C36` | **wrong vkey, replace** |
| InstanceRegistry | `0x66Af3e14552a845Ed0848f3ad4008265071bfD52` | fine; admin + `OPERATOR_ROLE` are your EOA |
| ProvingVault | `0xD1f54EFFe670D0F8f781BB2E92589F126363Fa0f` | fine, but still under the deployer |
| TrustgraphsFactory | `0xD5e29B116124AaD2bDbCbCc46D91214FA6f5cc38` | pins the bad verifier, replace |

**The other two findings are open on-chain exactly as predicted.** `REGISTRAR_ROLE` → factory is
**false**, so network creation would revert today. Vault `DEFAULT_ADMIN_ROLE` and
`FEE_SETTER_ROLE` are both **the deployer**, and your admin EOA holds neither. Both should be
done against the *replacement* factory rather than this one.

Everything else checked clean: the factory points at the right registry, vault, EAS and schema
registrar; `EPOCH_FLOOR` is 7200; the verifier's gateway is the canonical Sepolia SP1 gateway
`0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`.

**The guard that would have caught this now exists** (`8879915`). The checks in this path all
tested shape or freshness: a locally built vkey is well-formed bytes32, and the staleness guard
compared `.docker/zk_verifier_deploy.json` against `SP1_PROGRAM_VKEY` — which agreed, because
the same run wrote both. Planning a Sepolia deploy now also requires `guest-manifest.json` for
the pinned commit and refuses any vkey that is not in it. A vkey is a deterministic function of
the guest ELF, so the pair `(vkey, elf_sha256)` either appears in that release or this is not
that release.

**Two housekeeping notes.** `deployments/sepolia.json` in the tree is now the live (wrong)
record and is uncommitted — leave it, it regenerates on the redeploy. And `pnpm test:deploy`
reports one failure for that reason alone: the tracked manifest is a `planned` template and a
real deploy overwrites it in place. Not a code defect, but the test can never pass on a machine
that has deployed, which is worth fixing before it trains anyone to ignore a red suite.

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

Published in [v0.0.5](https://github.com/AInima-Collective/trustgraphs/releases/tag/v0.0.5), built
by a public workflow from commit `f64a4c7`, agreed on by two cold runners before it shipped.

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

> That sentence stopped being hypothetical on 2026-08-25. The morning's broadcast pinned
> `0x00d9bbff…`, a local build, and the verifier and factory now have to be replaced. See the
> section at the top of this file. The table above is still the right table; it just has to be
> the one that reaches the chain. Planning a Sepolia deploy now checks it against the release.

**Decided, and already in `.env`: we deploy from `v0.0.5`**, commit
`f64a4c7c9b5e552e2392894a2e0d6f6c40973549`. That was the only line that moved. Every value in
the table above is byte-identical between v0.0.4 and v0.0.5 — all seven programs, vkey and ELF
digest alike — which was predicted from the diff and then checked against the published asset
rather than assumed. No guest source changed between the tags: the only `zk/` path touched is
`zk/operator`, the trust-graph closure is `crates/pagerank-core` plus `crates/trustgraph-core`
and both are untouched, and the two `Cargo.toml` edits are `repository =` URLs that reach no
binary because nothing in the workspace reads `CARGO_PKG_*`.

What v0.0.5 buys is that the tag matches the code we actually run: the two deploy defects
(`4735840`, `f021f97`), the release-vkey guard, the demo's chain pin, and the operator
hardening are all inside it. v0.0.4 predates every one of them.

One wrinkle worth remembering for the next org-level change. The release failed its final job the
first time — not on anything in the code, but on "pull the image with no credentials at all". A
GHCR package created by `GITHUB_TOKEN` is private by default even on a public repo, and moving the
repo to the org created a **brand-new package**, so the visibility flip had to be made again under
`AInima-Collective`. Everything upstream had already passed. The check is doing exactly its job:
it exists so the self-hosting instructions cannot quietly go back to "clone the repo and install a
RISC-V toolchain", and it caught precisely that.

**Checked, 2026-08-25.** You ran the attestation verify and it passed: the image
`sha256:347345b4…` was built and signed by `.github/workflows/release.yml@refs/tags/v0.0.5` in
`AInima-Collective/trustgraphs`, via GitHub's OIDC issuer, with build repo and signer repo the
same. The detail that matters is `refs/tags/v0.0.5` rather than a branch: the artifact is bound
to the tag, so it cannot have come from an arbitrary push. That closes the last link in the
chain a stranger has to trust — two independent guest builds agreed, the vkey table came from
them, the published image re-derives the same vkeys inside itself, it pulls with no credentials,
its provenance is signed, and the deploy planner refuses any vkey that is not in that manifest.

To re-check either half later:

```bash
gh attestation verify oci://ghcr.io/ainima-collective/trustgraphs-operator:v0.0.5 \
  --repo AInima-Collective/trustgraphs
gh release download v0.0.5 -R AInima-Collective/trustgraphs -p guest-manifest.json
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
is small and mirrors the ETH one exactly. I have **not** written it. It was blocked while
`run.rs` had uncommitted changes; `f4c7953` has since landed and re-checked — still absent —
so it is now just a small unrequested change to a module that was committed minutes before we
tag. Say the word and it goes in; otherwise the dashboard glance covers deploy day and this is
the right thing to add in the first quiet moment after.

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
ghcr.io/ainima-collective/trustgraphs-operator:v0.0.5
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

## Part 5: Deploy day, take two

The first broadcast has already happened; see the section at the top of this file for what
landed and what is wrong with it. This is the corrected run.

**The simplest correct move is to re-run all five and abandon today's addresses.** The verifier
and the factory must be replaced, and only the registry, vault and schema registrar could in
principle be reused. Reusing them means threading three existing addresses through a plan built
to deploy them, for a saving of about 12M gas — roughly 0.013 ETH at today's ~1.1 gwei, against
a deployer holding 0.5. A clean full run costs ~24.4M gas, leaves one internally consistent
manifest, and is the version I can dry-run end to end beforehand. Nothing points at today's
five: `instances` is empty.

1. **Confirm the pin.** `SP1_PROGRAM_VKEY` in `.env` must read
   `0x003c8e19b8e12c260e5450a068c61460180b5cf93f03dc1214187a9ad3bdde5e`. It does now. The
   planner also checks it against `guest-manifest.json` for `DEPLOYMENT_COMMIT` and refuses to
   plan if they disagree, so this is belt and braces rather than the only line of defence — but
   it is the line that failed last time.
2. **Fetch the release manifest** next to the checkout, because the planner needs it:
   `gh release download v0.0.5 -R AInima-Collective/trustgraphs -p guest-manifest.json`
   (or point `GUEST_MANIFEST` at a copy). Already done: the checkout holds v0.0.5's.
3. **Clear `.docker/*_deploy.json`.** Gitignored scratch shared with every local anvil run, and
   it currently holds a dev stack from 14:35 today — including `zk_verifier_deploy.json` with
   the local vkey. A clean full run overwrites each file before the next step reads it, so this
   only bites a resumed or partial run, but starting clean is one command.
4. **Preflight, then dry run.** `bash scripts/sepolia-preflight.sh` is 22 read-only checks over
   the release pin, the vkeys, the chain, the keys, the gas at this moment, the contracts we
   reuse and the gateway route (5.2). `pnpm deploy:contracts --dry-run` then validates the plan
   and prints it in order without touching the chain. Neither can broadcast.
5. **Broadcast**, with your key. I never hold it.
6. **Grant the new factory `REGISTRAR_ROLE`, signed by the admin EOA.** A real step, not a
   formality: the registry is constructed with your admin EOA as its admin from birth — the
   mainnet shape you asked for — so the deployer cannot make this grant. Until it lands, every
   network creation reverts. This is why it is `false` on-chain right now. The deploy prints the
   exact `cast send` and the two `hasRole` checks that confirm it, including the negative one:
   the factory must hold `REGISTRAR_ROLE` and must **not** hold `OPERATOR_ROLE`, because the
   second would let it rewrite existing records rather than only appending its own.

   (Until 2026-08-25 the deploy tried to make this grant itself and reverted at step 5 of 5.
   Fixed in `4735840`, reproduced on anvil first.)
7. **Hand the vault over, signed by the deployer.** `DeployProvingVault` hardcodes the deployer
   as both `DEFAULT_ADMIN_ROLE` and `FEE_SETTER_ROLE` and the plan has no handoff step, so left
   alone a key generated for one afternoon permanently holds the vault's fee authority — which
   is what the live vault looks like today. The exposure is narrow: `setFeePerRootUsd` and
   `setGasParams`, nothing that moves funds, so mispricing and denial rather than theft. It is
   still the wrong key to leave it under, and rehearsing the handoff is much of why we are doing
   this on Sepolia in the mainnet shape. The deploy prints the three sends — grant admin, grant
   fee-setter, renounce admin — and the checks confirming the deployer holds nothing afterwards.
   **Order matters:** grant first, renounce second. Reversed, the vault has no admin at all and
   the roles can never be granted again.
8. **Prove one real root** through the live Sepolia gateway. The last thing that can surprise
   us, and the difference between "deployed" and "working". This is also the step that would
   have exposed the vkey, three contracts too late. Needs the submitter funded (1.5).
9. **Walk the browser flow** on the public domain with a clean wallet before we tell anyone.

### 5.0 The dress rehearsal, already run and green

Before any of the above touches Sepolia for real, the whole thing was run against a **fork of
Sepolia at block 11,564,866** — real state, real deployer balance, real canonical EAS and SP1
gateway, no real ETH. It ran in an isolated git worktree so it could not touch `.docker/`,
`broadcast/` or `deployments/sepolia.json` in your checkout.

Every step of Part 5 executed, in order, and every post-condition was checked rather than
assumed:

| check | result |
| --- | --- |
| verifier `programVKey` | `0x003c8e19…` — the release vkey, not a local build |
| factory → verifier | points at the verifier just deployed |
| registry `REGISTRAR_ROLE` → factory | true |
| registry `OPERATOR_ROLE` → factory | false (the one that must stay false) |
| vault admin + fee-setter → your EOA | true, true |
| vault admin + fee-setter → deployer | false, false |
| **creating a network through it** | succeeded, `instanceCount` 1, tank funded |

The last row is the one worth having. `REGISTRAR_ROLE` exists so the factory can register, and
until a network is actually created through the deployed stack, that grant is only theory. It
now has a real `createInstance` behind it, on Sepolia state.

**The gas number is better than I told you.** Measured from the rehearsal's receipts, the five
scripts cost **19.94M gas**, not the ~24.4M I estimated:

| script | txs | gas |
| --- | --- | --- |
| DeployEAS | 1 | 170,400 |
| DeployZkVerifier | 1 | 230,101 |
| DeployInstanceRegistry | 1 | 935,719 |
| DeployProvingVault | 8 | 3,876,164 |
| DeployFactory | 5 | 14,730,205 |
| **total** | **16** | **19,942,589** |

At Sepolia's recent ~1.1 gwei that is about **0.022 ETH** against a deployer holding 0.478. The
margin only gets interesting if gas spikes: at 20 gwei the same run costs 0.399 ETH, which is
most of the balance. Worth a glance at the base fee before broadcasting rather than a rule.
Creating a network afterwards is a further 6.95M gas.

### 5.1 Etherscan verification — built, and today's contracts are verified

`ETHERSCAN_API_KEY` is in `.env` and it is fine there. Until today it was read by nothing: no
`--verify` in the deploy pipeline, no `[etherscan]` block in `foundry.toml`, no script.

`pnpm verify:contracts` is that step now. It runs **after** a deploy rather than inside one,
because the deploy loop has no try/catch around a step: an explorer rate-limit or a propagation
delay on contract two would abort contracts three through five *after* their predecessors had
landed on-chain. Trading a deploy-day abort for a cosmetic nicety is a bad trade. Run afterwards
and the worst case is a retry. It also holds no private key and signs nothing, so it cannot
broadcast a transaction however it fails.

Constructor arguments are recovered, not remembered: a creation transaction's input is the
artifact's creation bytecode with the arguments appended, so stripping the known prefix leaves
exactly the encoding the explorer wants. That beats `--guess-constructor-args`, which asks the
explorer to infer what we already know, and beats reading them out of the deploy scripts, which
would be a second source able to disagree with the chain. If a creation input does not start
with this checkout's creation bytecode, it says so rather than skipping: that means the local
build is not the build that produced the on-chain code.

**Already run: 9/9 verified on Sepolia**, over this morning's deployment. So the five contracts
and the four factory deployer libraries are readable source on Etherscan right now, and the tool
is proven against the real explorer rather than only in a dry run. It is also how the argument
recovery was checked: `SP1JournalVerifier`'s recovered arguments decode to the canonical gateway
plus `0x00d9bbff…`, independently confirming the wrong vkey from a different direction.

One housekeeping note: the value got echoed into my terminal while I was checking whether
anything read it. An Etherscan key is a read-only rate-limit token, so the exposure is
somewhere between nil and mild, but it is your key and rotating it costs a minute if you would
rather not think about it.

### 5.2 The preflight, now one command

`bash scripts/sepolia-preflight.sh`

It reads and it prints. It broadcasts nothing, writes nothing, and echoes no key, RPC URL or API
token: it derives addresses from the keys in `.env` and shows you those. Its exit code is the
number of failed checks, so it chains with `&&` in front of a deploy. **22 checks, all passing
right now.**

What it covers, in the order a deploy would trip over them: the checkout is the release we mean
(`DEPLOYMENT_COMMIT` is v0.0.5); every one of the four vkeys is the one that release published,
and the ELF digest describes the same build; no leftover `.docker/*_deploy.json` can be picked up
mid-run; `.env` still points at Sepolia in production stage; the RPC really answers 11155111; the
three keys with their balances and nonces; the cost of the broadcast at the base fee at the
moment you run it, against what the deployer holds; the five contracts the plan reuses rather
than deploys all have code; the gateway will route our proofs; and whether the record this deploy
overwrites still matters.

Current numbers: base fee 1.03 gwei, so 19.94M gas is about **0.021 ETH** against 0.478 held.
Deployer nonce 16, admin 12, submitter 0. `deployments/sepolia.json` is back to `planned`, so the
run writes a clean record.

**The gas check demands threefold headroom, not enough-right-now.** The risk is not the price
when you start, it is a spike partway through sixteen transactions, which strands the deploy
half-finished.

### 5.3 The one thing preflight could not settle, now settled

The verifier holds the SP1 gateway address in an immutable, and the gateway dispatches proofs by
a four-byte selector carried inside each proof. If our selector had no route, or a frozen one,
proofs could never verify and the only remedy would be a new verifier and therefore a new
factory: exactly the redeploy we are already doing, done twice.

It turns out this is derivable offline. The selector is the first four bytes of the sha256 of the
Groth16 verifying key that ships inside the `sp1-verifier` crate the prover pins, so no proof and
no gas are needed to know it. For sp1 6.3.1 it is **`0x4388a21c`**, and on Sepolia that route is
**live and not frozen**, served by the v6.1.0 verifier at `0xb69f2584…`. The check is now step 9
of the preflight, deriving the selector from your local crate artifacts when they are unpacked
and falling back to the pinned value otherwise, and reading the route from the chain either way.

The gateway carries six routes. Two are frozen: the v3.0.0 one, and one of two that both report
v6.1.0. That second freeze looks alarming until you check which crate versions produce it, which
is worth doing rather than assuming: sp1-verifier 6.1.0, 6.2.0, 6.3.0 and 6.3.1 all hash to the
live selector, so no published version produces the frozen one. Succinct appears to have
deployed a verifier built against pre-release artifacts, frozen it, and replaced it eight minutes
later. The freeze protected people rather than endangering them, and we are not near it.

The practical consequence for us is smaller than the check: our selector is stable across the
whole 6.1.0 to 6.3.1 range, so a patch bump of sp1 would not move it. A minor bump might, and
that is the moment to rerun this before pinning anything immutable.

---

## Part 6: What I'm doing meanwhile

- Governed-creation lane, including the fix that makes wizard-created DAO Safes visible in
  app.safe.global (the script currently deploys its own singleton)
- Feed and USDC validation in the vault deploy
- The release-capable seeded-instance script
- Role-handoff and post-deploy invariant scripts
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
