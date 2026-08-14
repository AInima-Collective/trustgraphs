# Create a network

You run a community and want a trust network for it. On trustgraphs, that means: your members
vouch for each other, a zero-knowledge proof turns those vouches into scores nobody has to take on
faith, and the proven scores drive score-weighted governance on your Safe and score-weighted reward
distribution. This page is how you get one, and exactly what the machinery underneath commits to.

**One transaction creates a working, DAO-owned network.** You fill in the create-a-network wizard,
sign once, and get an attestation accumulator, a vouching schema, a `MerkleSnapshot` bound to your
own `paramsHash`, an optional fund distributor, a Safe with an enabled Merkle voting module, and a
directory entry: no repo checkout, no config PR, no app redeploy. In trustgraphs terms your network
is an *instance* of the *trust-graph program* (one deployment of the proven scoring pipeline; the
distinction is defined in [`../concepts/networks-and-programs.md`](../concepts/networks-and-programs.md)).

Nothing is live in production yet; Ethereum mainnet is the target. Everything on this page runs
today on the local stack: [`./quickstart.md`](./quickstart.md) is the end-to-end walkthrough.

Design provenance: [`../../research/INSTANCE_FACTORY.md`](../../research/INSTANCE_FACTORY.md).
Program context: [`../concepts/networks-and-programs.md`](../concepts/networks-and-programs.md) —
the factory is what turns "adding an instance costs only a deployment" into "adding an instance
costs only a transaction."

## 1. The create call

`TrustgraphsFactory.createInstance` is the canonical deployment and catalog seam
(`src/contracts/factory/TrustgraphsFactory.sol`). It is permissionless and payable:

```solidity
function createInstance(CreateArgs calldata args)
    external
    payable
    returns (bytes32 instanceId, address snapshot, address resolver, address distributor, bytes32 schemaUid);
```

`msg.value` is optional prepay: it is forwarded into the new instance's account in the
`ProvingVault` (the factory emits `InstancePrepaid`). A balance alone is deliberately not a bounty:
the constitutional holder must also install a nonzero paid policy. The app uses the governed
factory in §6, which makes the deposit and that policy atomic. A direct base-factory caller must
call `setPolicy` itself and should not send value unless it can complete that setup. Sending nothing
is the normal unpaid/curated case. On a factory deployed without a vault, a non-zero `msg.value`
reverts `NoVaultConfigured` rather than being silently kept.

### 1.1 `CreateArgs`

```solidity
struct CreateArgs {
    string  name;             // short label; part of instanceId
    string  metadataURI;      // IPFS: presentation only
    ParamsCodec.Params params;// full struct; the three derived fields MUST be zero
    address admin;            // 0 => msg.sender
    uint64  epochLength;      // raised to EPOCH_FLOOR if lower
    bool    withDistributor;
    address distributorToken; // the app's default token pick; presentation only
    bytes32 salt;             // lets one creator reuse a name
}
```

`params.schemaUid`, `params.accumulator` and `params.chainId` are **derived** — submit them as zero.
The factory fills them and rejects anything else (`DerivedFieldNotZero`), because an instance cannot
be allowed to name its own identity: a params struct copy-pasted from another network would
otherwise bind the new snapshot to a foreign domain, which is the exact hazard §7 closes.

`distributorToken` carries no on-chain force. `MerkleFundDistributor` is multi-token
(`distribute(token, amount, …)` takes the token per distribution); this field records what the
community intends to pay out so the app's payout screen doesn't have to guess.

### 1.2 `instanceId`

```
instanceId = keccak256(abi.encode(creator, name, salt))
```

Mixing the creator in makes label squatting pointless — nobody can block "gitcoin" for anyone else —
and `salt` lets one creator reuse a name. The registry rejects a duplicate id, so re-running the same
`(creator, name, salt)` reverts rather than shadowing. `computeInstanceId(creator, name, salt)` is a
public pure function if you want the id before creating.

### 1.3 The canonical vouch schema

Every factory instance registers the same EAS schema string, revocable:

```
string comment,uint256 confidence
```

Uniform on purpose. A creator-customizable schema would fork `weightFieldIndex` and multiply the
surface the guest, indexer and frontend each have to handle, for a customization nobody has asked
for. `weightFieldIndex` is therefore fixed at 1 — `confidence` sits in ABI head slot 1.

### 1.4 `metadataURI` JSON

```json
{
  "name": "…",
  "description": "…",
  "criteria": "…",
  "image": "ipfs://…",
  "applicationUrl": "https://…"
}
```

Presentation only. Nothing here is consensus-relevant, nothing here is hashed, and the graph works
if it is missing entirely.

## 2. What one transaction deploys

The dependency chain is walked exactly once, in this order (the schema must precede the hash
because its UID binds the resolver, and the hash must precede the snapshot because the snapshot
stores it):

```
new EASIndexerResolver(EAS)                                  ← the instance's accumulator
  → SchemaRegistrar.register(VOUCH_SCHEMA, resolver, true)   ← UID binds the resolver, so it precedes the hash
  → resolver.bindSchema(schemaUid)                           ← never a window for foreign edges
  → params.{schemaUid, accumulator, chainId} = derived
  → paramsHash = ParamsCodec.hash(params)                    ← same encoder the golden vectors lock
  → new MerkleSnapshot(VERIFIER, paramsHash, resolver, factory, factory)
  → resolver.bindSnapshot(snapshot)                          ← trigger() is the only checkpoint minter
  → snapshot.setEpochLength(max(requested, EPOCH_FLOOR))
  → new TrustgraphsParamsController(instanceId, snapshot, registry, params, admin)
  → snapshot.grantRole(OPERATIONAL_ROLE, controller)          ← typed path only
  → snapshot.renounceRole(OPERATIONAL_ROLE, factory)
  → snapshot.grantRole(CONSTITUTIONAL_ROLE, admin)           ← GRANT
  → snapshot.renounceRole(CONSTITUTIONAL_ROLE, factory)      ← then RENOUNCE
  → [optional] new MerkleFundDistributor(admin, snapshot, admin, fee=0, allowlist=false)
  → InstanceRegistry.registerWithParamsAuthority(instanceId, record, controller)
  → [optional] VAULT.depositETH{value: msg.value}(instanceId) ← the prepay, after the registry row
  → emit InstanceCreated(…)
  → emit ParamsControllerCreated(…)
  → controller.publishInitialVersion()                       ← complete version 1
```

Two details are worth stating out loud:

**The factory holds a role for part of one transaction, and never again.** `setEpochLength` is
constitutional-only and is _not_ a constructor argument, which is the sole reason the factory ever
takes `CONSTITUTIONAL_ROLE`. The grant to the admin happens **before** the renounce — the role
administers itself, so the reverse order would leave the instance with no constitutional holder,
permanently. Post-condition: the factory holds zero roles on the snapshot, zero ownership of the
distributor, and only append-only `REGISTRAR_ROLE` on `InstanceRegistry`. This is enforced as a test
invariant, not a convention. A compromised factory can write directory garbage; it cannot touch one
existing instance.

**Distributor ownership is set outright, not via the 2-step handshake.** Two-step transfer protects
a _live_ owner from handing control to an address that cannot act; at construction there is no live
owner to protect, and a pending transfer would leave the factory owning every community's
distributor until each one remembered to call `acceptOwnership`. `transferOwnership` after
deployment is unchanged — still 2-step.
([`../../research/DEVIATIONS.md`](../../research/DEVIATIONS.md).)

### 2.1 `InstanceCreated` — the event is the interface

```solidity
event InstanceCreated(
    bytes32 indexed instanceId,
    address indexed creator,
    address indexed admin,
    string  name,
    string  metadataURI,
    address resolver,
    bytes32 schemaUid,
    address snapshot,
    address distributor,      // 0 when the creator declined one
    address distributorToken,
    uint64  epochLength,      // EFFECTIVE, i.e. after the floor
    ParamsCodec.Params params // the FINAL params, derived fields filled in
);
```

**The full params struct in the event is the trick the whole system rests on.** Because it is there:

- the prover reconstructs any instance's input from chain data alone (registry → addresses, event →
  params), self-checking `ParamsCodec.hash(event.params) == snapshot.paramsHash()`. That invariant
  always holds, and the proving loop treats a violation as a hard stop (§5);
- the indexer and UI can show what a community actually computes — seeds, damping, epoch — instead of
  an opaque 32-byte hash;
- anyone can audit a community's parameters without asking its operator for a JSON file.

Its shape is frozen. Treat it like a journal: additive changes only, and never in place.

## 3. What the factory refuses

Permissionless is not unvalidated. Creation and every typed controller update share the same
validator; a controller update also locks the version-1 identity fields. These are not opinions
about what makes a good community — they are the envelope the fixed-point guest is proven over,
plus the identity rules. Generic `setParamsHash(bytes32)` remains for legacy and other programs,
but the controller is the sole operational holder on new trust graphs.

| Bound                          | Value                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| `dampingFp`                    | `0 < d < 1e18`                                                         |
| `toleranceFp`                  | `0 < t ≤ 1e15`                                                         |
| `maxIterations`                | `1 … 500`                                                              |
| weights                        | `maxWeightFp > 0`, `minWeightFp ≤ maxWeightFp`                         |
| `trustShareFp`, `trustDecayFp` | `≤ 1e18`                                                               |
| `trustMultiplierFp`            | `≤ 100e18` (defence in depth; the growth rule below is the real bound) |
| `precisionScale`               | exactly `1e18`                                                         |
| `totalPool`                    | `> 0` (a zero pool scores everyone zero, forever)                      |
| `weightFieldIndex`             | exactly `1`                                                            |
| `maxWeightFp`                  | `≤ 1e6 × S`                                                            |
| `trustedSeeds`                 | 1 … 64, no zero address, no duplicates                                 |
| rank growth                    | `(damping × multiplier)^maxIterations × S` must stay under 2²⁵⁶        |
| lane-2 fields                  | must be empty — the v1 bundle is lane-1-only                           |
| derived fields                 | must be zero                                                           |
| `name`                         | 1 … 64 bytes                                                           |
| `admin`                        | not the factory itself — see below                                     |
| `epochLength`                  | raised to `EPOCH_FLOOR`, never rejected                                |

Two of those are less obvious than they look, and both were caught by the factory's test battery:

- **`admin` may not be the factory.** Step 5 grants `CONSTITUTIONAL_ROLE` to the admin and then
  renounces the factory's own. Name the factory as admin and those become grant-then-revoke on the
  _same_ address, leaving an instance with no constitutional holder — permanently, because the role
  administers itself — while the factory keeps `OPERATIONAL_ROLE` and the distributor. Rejected with
  `InvalidAdmin()`.
- **`EPOCH_FLOOR` may not be zero** (`ZeroEpochFloor()` at construction). Zero is not "no minimum",
  it is "no schedule at all": `MerkleSnapshot` treats `epochLength == 0` as unscheduled, so every
  instance from such a factory would have prover-chosen epoch boundaries.

Note that `validateParams` cannot check `name` — it takes only the params struct, and `name` lives on
`CreateArgs`. A wizard's pre-flight check has to cover the name itself.

`validateParams(params)` is a view running the identical checks, so the wizard can show a problem
before asking for a signature.

Spam instances are inert: they cost their creator gas, hosted proving simply doesn't prove them, and
the app doesn't feature them. Impersonation is a curation problem — the creator's address is part of
the id and is shown in the UI.

**Enumerating the directory at scale.** `InstanceRegistry.getInstanceIds()` returns the whole array
in one call, which is fine at today's size and will not be at ten thousand instances. Paginate with
`instanceCount()` + `instanceIdAt(i)` instead; that pair is the intended read path and neither the
indexer nor the proving loop uses the bulk getter (both work from `InstanceCreated` events, which
paginate naturally by block range).

## 4. Choosing your parameters

The bounds above are the hard envelope; inside it, the choices are yours, and one of them dominates
everything else: **the trusted seeds.** Seeds are the accounts the algorithm anchors trust at, so
they decide whose vouches carry founding weight and how resistant your network is to fake-account
clusters. Pick the accounts your community would actually point to as its roots. For the intuition,
start at [`../learn/what-is-trustgraphs.md`](../learn/what-is-trustgraphs.md); for the exact
mechanics of damping, seed share and decay, read
[`../concepts/algorithm.md`](../concepts/algorithm.md); for the design work on seed selection,
[`../../research/GRAPH_SEEDING.md`](../../research/GRAPH_SEEDING.md).

`epochLength` is the other visible choice: how often scores are recounted and reproven. Shorter
epochs mean fresher scores and more proving spend; the factory's `EPOCH_FLOOR` (roughly 30 days of
blocks on mainnet, one block on a devnet) is the shortest cadence hosted proving commits to.

Parameters are not forever: the admin (your Safe, on a governed network) can rotate them later
through the typed params controller, inside the same validation envelope. See
[`../../research/UPGRADE_GOVERNANCE.md`](../../research/UPGRADE_GOVERNANCE.md).

## 5. Proving your network — chain is the config

A factory-minted network needs **zero per-instance prover configuration**. The proving loop takes an
RPC endpoint and the `InstanceRegistry` address, and nothing else: the daemon reconstructs every
instance from the chain and proves whatever is due. If your network is curated or its vault is
funded, roots simply start landing; [`./run-a-prover.md`](./run-a-prover.md) is the operator's view
(self-prove, curated, and funded tiers), and what follows is the seam it consumes.

```bash
task instances:scan                       # read-only: rebuild + self-check every instance
task instances:prove-all                  # the loop, for every instance that is due
task instances:prove-all ONLY=0x<id>      # one instance
task instances:prove-all PROVER=network   # a real proof (default is the mock backend)
REGISTRY=0x… RPC=https://… bash taskfile/instances.sh    # no go-task needed
```

`instances:scan` is safe to run against anything — it sends no transaction.

### How an instance is reconstructed

```
getInstanceIds()               → every instanceId, in registration order
getInstance(id)                → program, snapshot, verifier, accumulator, paramsHash
InstanceRegistered log         → the TRANSACTION that registered the id
that transaction's receipt     → the factory's InstanceCreated log (§2.1) = the full params struct
  the log's emitter            → the factory itself, hence factory.EAS() for the exporter
```

Nothing is read from a file. There is no per-instance config anywhere, and no parameter is typed in
by hand — the same reason `InstanceCreated` carries the whole struct.

### The self-check is a hard stop

Before an instance is proven, `pagerank_core::encode::params_hash(InstanceCreated.params)` must equal
the live `snapshot.paramsHash()`. This is the canonical **Rust** encoder re-deriving what
`ParamsCodec.hash` (Solidity) wrote at creation, over params decoded from the event: a disagreement
means the event, the two codec ports, and the snapshot no longer describe the same instance. A
mismatch **aborts the entire run** — not just that instance — because the honest reading of it is
"something about params encoding is wrong here", and the failure mode it guards is the §7 one where
a proof is valid for a network it was not built for. It is never a warning and never skippable.

### Per instance, per pass

```
trigger()          → freeze this epoch's inputs (permissionless; the contract picks the boundary)
input-exporter     → rebuild the checkpoint's exact edge set, self-checked by re-folding to `acc`
prover execute     → run the guest, byte-assert guest == native, read the journal fields
prover prove       → proof.bin + the score blob
pin blob.json      → kubo `/api/v0/add`; a warning if unreachable — the UI needs it, submitProof does not
submitProof(…)     → and then assert the on-chain root equals the proven one
```

Everything lands in **`.trustgraph/trust-graph/<instanceId>/`** (`input.json`, `blob.json`,
`proof.bin`, `public_values.bin`, `params.json`). The prover's default output directory is
per-_program_, so without the per-instance `--out-dir` the second instance of a pass would overwrite
the first one's proof — hence `zk/prover`'s `--out-dir` flag on both `execute` and `prove`. The scan
plan itself is written to `.trustgraph/trust-graph/instances.json`.

### What gets skipped, and why that is not a failure

One unprovable instance must never stop the other N-1, so each of these is a logged skip:

| Skip                                        | Meaning                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| program label ≠ `keccak256("trust-graph")`  | another SP1 program owns this instance                                           |
| no `InstanceCreated` in the registration tx | registered outside the factory; its params are not on chain                      |
| epoch boundary not reached                  | `trigger()` would revert `EpochNotElapsed` — the schedule is the contract's call |
| no new edges since the last checkpoint      | `trigger()` would revert `NoNewInputs()`                                         |
| no attestations yet                         | a created-but-unused instance; there is nothing to prove                         |

A run that proves nothing therefore exits 0. Only a _failed_ instance (a reverted submit, a bad
export) exits non-zero, and even then the remaining instances are still attempted.

### Scope

This is the enumeration seam and only that. The operator daemon, the prepay vault, proving bounties
and commit-reveal submission are [`./run-a-prover.md`](./run-a-prover.md) and
[`../../research/PROOF_SCHEDULER.md`](../../research/PROOF_SCHEDULER.md); the scheduler's §2
consumes exactly this seam.

### Local caveats

- `SP1_PROVER=mock` (the default) runs the guest for real and commits its real public values, but the
  SNARK itself is a stub. `PROVER=network` (or `cpu` on a 16-32 GiB box with `--features
native-gnark`) is the real thing.
- `SP1_VERIFIER_GATEWAY` names Succinct's real per-chain deployment, which has **no code** on a
  plain anvil — so `submitProof` used to revert inside the verifier before any of its own checks
  ran. The dev deploy now stands up a `MockSP1Gateway` for you (`DeployMockGateway`, wired into
  `deploy/env.ts`); set `DEV_MOCK_SP1_GATEWAY=false` on a mainnet fork, where the real gateway is
  part of forked state and the script refuses to stub over it. `task instances:dev-mock-gateway`
  remains for patching a stack that was deployed before this existed.

## 6. Safe-owned networks: the governed factory

For a DAO the right owner of a network is the DAO, not a deployer wallet, and it should be the
owner from the first block. That is what `GovernedTrustgraphsFactory.createGovernedInstance` does
(`src/contracts/factory/GovernedTrustgraphsFactory.sol`), and it is the path the create wizard in the
app uses:

```solidity
struct InitialPolicy {
    uint64 minPaidIntervalBlocks;
    uint96 maxPerRootUsd; // 8-decimal oracle USD; fee + gas combined
}

function createGovernedInstance(
    TrustgraphsFactory.CreateArgs calldata requested,
    InitialPolicy calldata policy
)
    external
    payable
    returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot);
```

The wrapper creates a temporary bootstrap Safe, makes that Safe the base-factory caller and `admin`
(`requested.admin` is deliberately ignored), installs the snapshot-specific `MerkleGovModule` as an
enabled module and snapshot hook, then removes itself as Safe owner. The creator wallet remains the
Safe's initial break-glass signer, but the Safe — not that wallet — owns the params controller,
snapshot authority, distributor, and governance settings from the creation transaction. Because the
Safe is the actual factory caller, it is also the `creator` inside `instanceId`. Any `msg.value` is
routed through the Safe into the base factory. Before the wrapper removes itself as bootstrap
owner, it has that same Safe call `ProvingVault.setPolicy`, so a funded network is payable from the
first valid checkpoint and a partially configured creation reverts in full.

The creation guardrails are intentionally stricter than later DAO governance:

- no ETH means the exact zero/zero unpaid policy; a nonzero policy without funds reverts;
- ETH requires a nonzero policy, and the minimum paid interval cannot be shorter than the
  factory-clamped score epoch;
- the initial cap must cover the deployment's band-1 fee and may not exceed $10,000 per root;
- band 1 must already be priced by the global fee setter. The wizard displays that fee as a
  deployment prerequisite rather than accepting money into an unpriced service.

The wizard also shows the effective cadence, combined fee/gas cap, initial size band, a conservative
refresh count at the current ETH/USD answer, and the vault withdrawal notice before asking for the
single signature. The DAO Safe may change its policy later through the normal constitutional path.

Governed instances emit `GovernedInstanceCreated` alongside the base factory's `InstanceCreated`,
which is how the indexer discovers the Safe and module with no file edit or restart.

## 7. The frozen identity: params schema v2

Three things are load-bearing across the prover, the indexer, the frontend and any third party
auditing a community's graph: the params schema, `CreateArgs` (§1.1), and `InstanceCreated` (§2.1).
This section is the params half: why the derived fields exist at all.

`pagerank_core::Params` / `ParamsCodec.Params` / the TS `Params` all carry **17** fields. The last
two were appended for the factory:

| #   | Field                   | Why                                 |
| --- | ----------------------- | ----------------------------------- |
| 16  | `accumulator` (address) | The instance's `EASIndexerResolver` |
| 17  | `chainId` (uint64)      | `block.chainid` at creation         |

The journal is **untouched** by this change — domain separation lives in the params, not the journal.

### What this actually buys (measured, and narrower than the design doc claimed)

`INSTANCE_FACTORY.md` §6.1 says two clones with identical seeds, params and edge sets accept each
other's proofs. **For two factory instances on one chain, that was already false before v2**, and
the reason is worth knowing: EAS derives a schema UID as
`keccak256(abi.encodePacked(schema, resolver, revocable))`, so the resolver address is _inside_
`schemaUid` — and `schemaUid` has been part of `paramsHash` since v1. Two instances always get their
own resolver, hence their own UID, hence their own hash. The same-chain clone hazard was covered by
accident.

Three cases it was **not** covered for, which is what the two fields are for:

1. **A cross-chain mirror (`chainId`).** Contract addresses come from `keccak(deployer, nonce)`, so
   the same deployer running the same sequence on two chains produces _the same_ resolver address.
   Measured: deploying this repo's EAS battery on chain 31337 and on chain 1 gave byte-identical
   addresses (`0xDD3F09d7…`, `0x6e5Ef4EE…`). Identical resolver ⇒ identical schema UID ⇒ **identical
   v1 `paramsHash`**, with nothing anywhere in the 15 fields naming a chain. Verified on a real
   instance's params: the v1 hash is `0x9d188d20…` on both chains, while the v2 hash is
   `0xdb7f2ec1…` on 31337 and `0x4ccc0994…` on 1.
2. **A re-pointed accumulator (`accumulator`).** `setAccumulator` is a constitutional knob. After a
   re-point, `schemaUid` names a resolver that is no longer the instance's input source, and a v1
   `paramsHash` would not register the change at all. v2 pins the accumulator the guest must read.
3. **Two snapshots over one accumulator.** They share a resolver, therefore a schema UID. The
   contributions program already has this shape (`TrustAccumulatorMirror`).

Verified on the live stack, both by `JournalMismatch` on a real `submitProof`:
a proof built for one instance is refused by its clone, and — with `schemaUid` and every knob held
constant so only the new field moves — a proof whose params differ **solely** in `accumulator` is
refused by the instance it was otherwise built for.

Consequences, all already applied: golden vectors regenerated
(`../../test/golden/trust-graph.json`); the program vkeys rotated (current values in
[`../concepts/networks-and-programs.md`](../concepts/networks-and-programs.md)); `params.json`
gained `accumulator` and `chain_id`; `input-exporter` fills both from the connection it is actually
reading and **errors** if the file names a different instance.

## 8. Standing the factory up

This section is for the platform operator standing up a chain, not for a community creating a
network: a creator only ever sends §1's one transaction.

`EPOCH_FLOOR` is an immutable chosen per chain: roughly 30 days of blocks on mainnet (what hosted
proving commits to), one block on a devnet so a local proving loop is never waiting on the schedule.

```bash
forge script script/DeployInstanceRegistry.s.sol:DeployInstanceRegistry --sig 'run(string,string)' '' '' …
forge script script/DeployFactory.s.sol:DeployFactory \
  --sig 'run(string,string,string,string,uint64)' \
  <eas> <schemaRegistrar> <zkVerifier> <instanceRegistry> <epochFloorBlocks> …
forge script script/DeployGovernedTrustgraphsFactory.s.sol:DeployGovernedTrustgraphsFactory \
  --sig 'run(string)' <factory> …
```

`DeployFactory` also grants the factory `REGISTRAR_ROLE` on the registry (skip with
`GRANT_REGISTRAR=false` once the registry admin is controlled by governance — the grant then becomes
a governance action). `update()` stays with the global registry operator, while each controller may
change only its own row's `paramsHash`; a factory bug can add rows but never rewrite one.

Locally, `pnpm deploy:contracts` does all of it. `script/CreateDevInstances.s.sol` creates the
dev-seed networks through the canonical factory; `DeployZodiacSafes` then transfers each typed
params controller and both module authorities to that network's Safe before deployment completes.
The browser uses the governed wrapper so the equivalent ownership is atomic in one transaction.

## 9. Cold run

[`./quickstart.md`](./quickstart.md) is the end-to-end runbook, and `task demo` is all of it in one
command: every service you need, the create → vouch → prove → pay loop, four security
demonstrations (params self-check, replay separation, squat resistance and foreign-schema
rejection), and the gotchas that actually bite — chief among them that restarting anvil silently
poisons the indexer's RPC cache _and_ wedges the proof scheduler's request journal.

## 10. Related

- [`./integrate-scores.md`](./integrate-scores.md) — reading your network's proven scores from an
  app or contract, once roots are landing.
- [`../../research/INSTANCE_FACTORY.md`](../../research/INSTANCE_FACTORY.md) — the design, incl. the
  security §6 this implements.
- [`./quickstart.md`](./quickstart.md) — the verified demo runbook (create → vouch → prove → pay, on
  a laptop).
- [`./trust-graph/runbook.md`](./trust-graph/runbook.md) — building, proving and submitting for a
  single instance.
- [`./run-a-prover.md`](./run-a-prover.md) — the hosted proving operator (daemon, vault, bounties).
  It consumes the enumeration seam this build provides; none of it lives in the factory.
- [`../../research/UPGRADE_GOVERNANCE.md`](../../research/UPGRADE_GOVERNANCE.md) — `setParams(struct)`
  and the freeze-only guardian, both of which matter more once N instances exist.
