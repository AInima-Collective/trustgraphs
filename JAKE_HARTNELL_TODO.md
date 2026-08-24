- Tag release
- Generate vkeys and elf digest
- Admin EOA
- Fresh deployer key (with Sepolia ETH) FUNDED_KEY
- Sepolia RPC endpoint
- NETWORK_PRIVATE_KEY (needs a topup of $PROVE)
- SUBMITTER_PRIVATE_KEY (doesn't need funds)
- Metadata for the seeded network
- Put indexer and operator on railway?


==== long version...

# Sepolia deploy: what I need from you

Everything in this file is something I cannot do from here, either because it needs a
toolchain this sandbox does not have, a credential that must never touch the repo, or a
judgment call that is yours. The engineering plan is in [GOAL.md](GOAL.md); this is only
your half.

Rough shape: **Part 1 blocks everything and is worth starting today.** Part 2 is answers,
no commands. Part 3 is accounts to open. Part 4 happens with me at deploy time.

**One rule throughout:** no key, RPC URL, database URL, or API token goes into this repo,
into `deployments/sepolia.json`, or into a chat message. The manifest validator actively
rejects secret-shaped keys, and it should stay that way. Put them in your secret manager
and hand me only addresses and public URLs.

---

## Part 1: Blocks everything

### 1.1 Derive the release verification keys and ELF digest

**Why:** `SP1JournalVerifier` pins its vkey at construction and never again, and
`TrustgraphsFactory` pins its verifier. A wrong or stale vkey produces a stack that looks
healthy and then refuses to prove anything, and the fix is redeploying the factory. Nothing
downstream of this is real until these values exist.

This sandbox has no SP1 toolchain at all (`cargo-prove` and `sp1up` are both absent), so
this one is yours by construction.

```bash
# Install the toolchain if you don't have it (pinned version matters):
curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"

# From a CLEAN checkout of the commit we are releasing:
task zk:build            # first run takes a few minutes, then it caches

task zk:vkey PROGRAM=trust-graph    # -> SP1_PROGRAM_VKEY
task zk:vkey PROGRAM=signer         # -> SP1_SIGNER_PROGRAM_VKEY

# The ELF digest that goes in the manifest:
sha256sum zk/trustgraph-program-v2/target/elf-compilation/*/release/trustgraph-program-v2
sha256sum zk/program/target/elf-compilation/*/release/trustgraph-signer-program
```

**Send me:** both vkeys, both ELF digests, and the exact commit you built from.

**Two warnings.** Do not rebuild the guests between deriving the vkey and generating the
first proof: `sp1_build` does not watch path dependencies, so any edit under `crates/`
silently invalidates the answer. And the signer vkey is only needed because you ruled that
visitors can create their own networks: `GovernedTrustgraphsFactory` takes a real signer
verifier in its immutable constructor.

### 1.2 Pick the admin EOA

**Why:** this address receives `InstanceRegistry` administrator and operator, plus the
`ProvingVault` administrator and fee-setter roles.

You ruled EOA over Safe, which is the right call for a testnet: it removes a setup step and
a signing ceremony from every administrative action, and the thing being protected is a
deployment we expect to throw away before mainnet.

**What that EOA actually holds**, so the choice is informed:

- `InstanceRegistry.update()` rewrites **any** instance's record, including repointing a
  network's snapshot or resolver, and `setParamsAuthority()` repoints who controls its
  parameters. Whoever holds this key can rewrite the discovery layer for every network on
  the deployment, including ones strangers created.
- `ProvingVault` admin sets fee bands and gas parameters. It cannot take depositors' funds:
  there is no admin sweep, and `withdrawCredit` pays out the caller's own credit.

So the realistic downside of a compromised key here is griefing and misdirection, not theft.
For mainnet this goes back to a Safe.

**Decide:** use a key that is *not* the deployer from 1.3. The deployer is a hot key that
signs a long broadcast session; the admin key should be one you keep in a hardware wallet
and touch rarely. If you would rather keep it to one key, that works too and the handoff
step simply becomes a no-op. Tell me which.

**Send me:** the admin address.

### 1.2b The one place a Safe is still mandatory

Not a decision, just a constraint you should know about before 2.2. If the seeded network
carries a fund, its distributor owner **must** be an initialized Safe:
`TrustgraphsFactory.sol:358` reverts with `InvalidDistributorSafe` when `withDistributor` is
true and the admin is an EOA. That was a deliberate audit fix, not an oversight, and it
applies at both creation and later attachment.

You do not need to go create one by hand. The cleanest path is to create the seeded network
through the **governed** factory, which mints its own Safe as part of the same transaction,
and has the side benefit of dogfooding the exact code path visitors will use. I will plan it
that way unless you object. If the seeded network carries no fund, none of this applies.

### 1.3 Fund a fresh deployer key

**Why:** `Common.s.sol` refuses the default Anvil key on a public chain, so there is no
fallback. This key signs every deployment transaction and then renounces its roles at the
end.

Generate a brand new key. **Do not reuse `0x3ED16f90e8EA54D9A1BAe67Ab2D6BDC177EadeeC`** or
its private key: the August audit found that key committed at `taskfile/trustgraph.yml:58`
under commit `6f5b260`, and it is burned permanently.

Fund it with Sepolia ETH. I will give you a measured number after the fork rehearsal (M8);
until then budget generously, since the run deploys a schema registrar, two verifiers, a
registry, a vault, a factory, a governed factory, and a seeded instance.

**Send me:** the deployer address only. The key goes in `FUNDED_KEY` in your environment.

### 1.4 A private Sepolia RPC endpoint

**Why:** the indexer needs `getLogs` capacity and historical calls back to the deployment
block, and the frontend proxies through a server-side URL. Public endpoints will rate-limit
the indexer into uselessness.

Alchemy, Infura, QuickNode, whatever you prefer, on a paid tier. It must serve logs and
historical state from the deployment block onward. An archive node back to genesis is not
required for a fresh deployment.

**Send me:** confirmation that it exists and its provider. The URL itself stays in secret
storage as `PONDER_RPC_URL_11155111` and the frontend's server-side RPC variable.

### 1.5 A funded Succinct prover network account

**Why:** you chose the prover network, so the operator requests proofs rather than
generating them. Without this there is no way to produce a root, and the whole system is a
vouching UI with no scores.

We are a **requester**, not a prover: there is no on-chain proving obligation. You need two
separate keys, per `docs/build/run-a-prover.md`:

| Variable | Purpose |
| --- | --- |
| `NETWORK_PRIVATE_KEY` | the Succinct prover network requester key |
| `SUBMITTER_PRIVATE_KEY` | pays submit gas on Sepolia; holds no value, rotatable |

They are deliberately separate because the payee is named in the journal, so the submitting
key never needs to hold funds beyond gas.

**Send me:** the submitter address (so I can check it is funded in preflight), and
confirmation the network account has credit.

---

## Part 2: Decisions I need, no commands

### 2.1 The seeded network's trusted seeds

**This is the one I would think hardest about.** The trusted seeds are the bootstrap of the
entire trust graph: scores flow outward from them, so whoever is in this list is the root of
authority for the seeded network.

`tests/e2e/params.template.json` currently lists the three default Anvil accounts, which are
obviously placeholders. For Sepolia I need real addresses.

**Decide:** which accounts seed the first public network, and how many.

### 2.2 The rest of the seeded network's identity

- Name, and a one-line description
- Metadata (I can pin it to IPFS once you give me the content)
- Whether it carries a fund (`MerkleFundDistributor`) at creation. See 1.2b: if yes, the
  network gets created through the governed factory so it comes with its own Safe.

### 2.3 Algorithm parameters: keep the defaults or change them?

The template values, decoded:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `damping_fp` | 0.85 | PageRank damping |
| `tolerance_fp` | 0.000001 | convergence tolerance |
| `max_iterations` | 100 | iteration cap |
| `max_weight_fp` | 100 | ceiling on a single vouch weight |
| `trust_share_fp` | 1.0 | share of rank flowing along trust edges |
| `trust_decay_fp` | 0.8 | decay per hop |

**Decide:** "defaults are fine" is a perfectly good answer. I am asking because these are
committed into the params hash at creation and are governance-rotatable afterward, not
free-form.

### 2.4 Vault economics and cadence

Decided, since you asked me to take it. Written up in full below as **Part 2.5**, including
the one number I found that is actively wrong for Sepolia. Read it and veto anything you
disagree with; otherwise I will build to it.

---

## Part 2.5: The economics, decided

You said it is just testnet and we are losing money on it. That framing is right, and it
points at something worth being precise about: **the money we lose is not the money the
system talks about.**

The vault prices proofs in USD and collects test USDC or Sepolia ETH. Both come from
faucets, so every fee we "earn" on this deployment is worth exactly zero. Meanwhile every
proof we produce spends real Succinct prover network credit. So on Sepolia the vault is not
a revenue mechanism at all, it is a **rehearsal** of one, and the only thing standing
between us and an unbounded bill is the operator's own budget ceiling.

That reframing drives every number below: price the vault for realism, and put the actual
spending limit in the operator.

### What a proof really costs

From the SP1 v6.3.1 calibration matrix, rerun today against the fresh guest ELFs. These are
measured guest cycles, not estimates, and they are post-fix: this morning's scoring-engine
program removed the quadratic rank loop, which is why 200 accounts costs cents here and
$2.67 in the older evidence file.

| Graph | Measured cycles | At our budget unit ($1/Gcycle) | Realistic hardware cost |
| --- | ---: | ---: | ---: |
| 3 accounts (demo) | 903,623 | $0.001 | negligible |
| 25 accounts | 2,335,137 | $0.002 | negligible |
| 100 accounts | 66,973,643 | $0.07 | $0.003 - $0.01 |
| 200 accounts | 244,915,295 | $0.25 | $0.01 - $0.04 |
| 400 accounts | 538,786,913 | $0.54 | $0.03 - $0.08 |

The right-hand column uses the $0.05 - $0.15 per billion cycles anchor from
`research/offchain/03-sp1-feasibility.md`. In practice there is also a fixed floor per
request: the auction and the Groth16 wrap cost the same whether the graph has 3 accounts or
400. Budget **$0.05 to $0.50 per proof** at any size we will plausibly see on a testnet, and
treat proof *frequency* as the thing that matters, not graph size.

### The decisions

**1. Fee bands stay exactly as they are: $5 / $10 / $15.** Not because we will collect
anything, but because zeroing them would leave the entire prepay path untested, and testing
it is the whole point of a testnet. Realistic numbers also make the UI show realistic
numbers. Understand what prepay is here: friction, not a financial gate, because anyone can
faucet the money.

**2. We seed the vault with nothing. Zero test USDC.** The vault holds each instance's own
deposits and pays our payee out of that instance's balance, so there is nothing for us to
pre-fund. Funding the seeded network's prepay would just be us paying ourselves.

**3. The seeded network is the entire free tier.** `curated.instances` gets exactly one
entry. The code refuses to have an unconditional free tier, and it is right to: a
permissionless factory plus free proving for all comers is unbounded liability, and you just
ruled that visitors can create networks.

**4. Everyone else goes through the paid path.** `paid.enabled = true`, pointed at the
deployed vault, with our EOA as recipient. This rehearses the mechanism and adds real
friction, since a visitor has to go get faucet USDC and deposit it.

**5. The real ceiling, and the number that actually matters:**

| Setting | Stock default | Sepolia | Why |
| --- | ---: | ---: | --- |
| `budget.global_usd_per_day` | 250 | **15** | The stock default is a $7,500/month ceiling. That is a runaway guard, not a testnet budget. |
| `budget.per_instance_usd_per_day` | 25 | **2** | Roughly 4 proofs/day of a 400-account graph. Above what the epoch floor permits, low enough that one network cannot eat the global cap. |
| `signer_sync.per_instance_usd_per_day` | 5 | **1** | Signer proofs only follow score roots, so they are already bounded. |
| `signer_sync.global_usd_per_day` | 50 | **5** | Same. |
| `budget.cents_per_billion_cycles` | 100 | **100, unchanged** | It over-prices real cost by roughly 7 to 20x. That is the safe direction for a halt guard: we stop early rather than late. Do not "correct" it. |
| `prover.cycle_limit` | 8B | **8B, unchanged** | Refuses jobs past ~3,467 inputs. On a testnet that refusal is correct: anything larger is either a deliberate experiment or an attack. |
| Factory `EPOCH_FLOOR` | 7,200 min | **7,200** | About one day at 12s blocks. This is the single biggest cost lever, because it caps each network at roughly one proof per day. |

**6. Alert at 80% of the global cap**, so we hear about a runaway before it halts us.

### The number to change on purpose

`cadence.subsidy_min_blocks` defaults to **216,000 blocks**, and it applies only to curated
instances, which after decision 3 means exactly one network: ours. At 12-second blocks that
is about **30 days**, and that is deliberate: the code comment and the prover runbook both
say "how often we will pay for a CURATED instance", meaning once a month.

That default is right for a production deployment subsidizing someone else's network. It is
wrong for our demo. The seeded network is the thing people will look at to decide whether
any of this works, and a network whose scores update monthly reads as abandoned.

**Set it to 7,200**, matching the epoch floor, so the seeded network updates about daily.
The cost of doing so is small and bounded: one network at roughly $0.50 a proof, once a day,
is about **$15 a month**, which fits inside the cap in decision 5 with room to spare.

This is a policy change, not a bug fix. If we later subsidize networks that are not ours,
the monthly default is the one to go back to.

### What this adds up to

Expected steady state: the seeded network at roughly one proof a day, plus however many
visitor networks are actually active.

- **The seeded network alone:** between **$1.50 and $15 a month**, depending on how big its
  graph gets. A handful of accounts is about $0.05 a proof; four hundred accounts is about
  $0.50.
- **Expected total while it is quiet:** **under $30 a month**. Twenty genuinely active
  visitor networks proving daily would be roughly $10 a day, which is when the cap starts to
  bind, and twenty active networks on a testnet would be a good problem.
- **Hard ceiling:** $15/day, so **about $450 a month** even if the cap is saturated every
  single day. Versus **$7,500 a month** under the stock defaults.

If someone deliberately grinds the cap by creating networks, the global budget halts
proving and alerts, which also stops the seeded network. The escalation lever is to set
`paid.enabled = false`: we then prove only for the curated network and strangers must prove
for themselves. That is the response to abuse, not the default, because the paid path is one
of the things we came here to test.

---

## Part 3: Accounts and infrastructure

None of these block the fork rehearsal. All of them block going public.

- [ ] **Postgres**, managed or backed up, for the indexer. A fresh writer schema
      (`trustgraph_sepolia_v1`) and a separate public views schema. Never share the old
      Optimism production schema.
- [ ] **IPFS pinning**, Pinata or equivalent, with credentials. Score blobs must be pinned
      and retrievable through the public gateway *before* their root transaction is sent, or
      the chain will carry a root whose scores nobody can read.
- [ ] **HTTPS hosting and DNS** for the Ponder API and the frontend.
- [ ] **An Etherscan API key.** Worth flagging: this repo has **no** contract-verification
      tooling today, no `--verify` in the deploy pipeline and no `etherscan` block in
      `foundry.toml`. I will build the verification step; you supply the key.
- [ ] **WalletConnect project configuration** with the deployed domain in its allowed
      origins.
- [ ] **Monitoring:** error tracking, uptime checks, root-freshness alerts, RPC and IPFS
      quota alerts, and a webhook the operator can post to.
- [ ] **A secret manager** holding: deployer key, submitter key, Succinct requester key,
      RPC URL, database URL, Pinata credentials, Etherscan key.

---

## Part 4: With me, at deploy time

These are the moments where you press the button, in order. I will have everything staged.

1. **Approve the release commit** and confirm the vkeys were derived from exactly it.
2. **Run preflight** and read the output. It fails closed on a wrong chain, a default key, a
   frozen SP1 route, a stale feed, a zero vkey, or a commit mismatch.
3. **Broadcast the deployment**, with your key. I never hold it.
4. **Confirm the role handoff** moved registry and vault administration to your admin EOA
   and that the deployer renounced. The verification script asserts this, but you should read
   it. If you decided in 1.2 to use one key for both, this step is a no-op and the script
   will say so rather than silently passing.
5. **Prove one real root** through the live Sepolia gateway. This is the last thing that can
   still surprise us, and it is the difference between "deployed" and "working".
6. **Walk the browser acceptance flow** on the public domain with a clean wallet before we
   tell anyone.

---

## Part 5: What I'm doing meanwhile

So you know where the line is. While you work Part 1, I build:

- The governed-creation lane in the release plan, including the fix that makes wizard-created
  DAO Safes usable in the Safe app (right now the script deploys its own singleton, which
  would make every user Safe invisible to app.safe.global)
- Feed and USDC validation in the vault deploy
- The release-capable seeded-instance script
- The role-handoff and post-deploy invariant scripts
- The executable preflight
- Contract verification tooling
- Frontend: the Sepolia config in the build path, the testnet label, the wrong-network
  prompt, and hardening the RPC and IPFS proxies before they face the public

Then the full dress rehearsal against a Sepolia fork, so the first real transaction is not
the first time any of it has run.

---

## One open question I am not closing for you

The ingress-admission finding from the August audit is still open. Lane F made the capacity
ceiling honest, but nothing stops someone reaching it for roughly 0.0027 ETH, and the
decision about who is allowed to add inputs to a network is a product decision, not a code
fix. Because you ruled that visitors can create their own networks, this testnet is exactly
the setting that surfaces it. It does not block the deploy. It does mean the first griefing
report will not be a surprise.
