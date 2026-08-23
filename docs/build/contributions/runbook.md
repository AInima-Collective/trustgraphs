# Contributions — operator runbook

How to run a contribution-funding round: what a round is, the lifecycle, every
command with its env, how to verify a round independently, and who holds which
key. Local walkthrough with hard expected numbers:
[`local-testing.md`](./local-testing.md). Interfaces (frozen):
[`interfaces.md`](./interfaces.md). Design (normative):
[`../../../research/CONTRIBUTION_FUNDING.md`](../../../research/CONTRIBUTION_FUNDING.md).
Pre-launch security review of record:
[`research/audits/2026-07-M6.md`](../../../research/audits/2026-07-M6.md).

## What a round is

A round is a time window `[roundStart, roundEnd]` pinned — together with every
scoring parameter — by the snapshot's `paramsHash` (the 21-word tuple,
[`interfaces.md`](./interfaces.md) §3). During the window, people attest **claims** (their own
contributions, or nominations of others), **responses** (accept/reject being
named on a claim), and **valuations** (0–100 scores). All three go through EAS
against the `ContributionResolver`'s allowlisted schemas; the resolver folds
every record into the contribution accumulator (journal slot B). Reputation
comes from the trust program's vouch graph (slot A, read through the
`TrustAccumulatorMirror`), never from round activity.

The payout split is computed **inside the SP1 proof**: stage-1 Trust-Aware
PageRank reputation → stage-2 rep-weighted budgeted valuation with the §5
filters (self-valuations dropped, dust-rep raters dropped, collaborator
ratings discounted, out-of-window claims inert, rejected consent zeroed,
unaccepted shares halved) → the evaluator carve-out (β of the pool to
participating raters pro-rata reputation) → quantization to the integer pool.
The proven output is a merkle root over `(address, value)` leaves plus a
canonical blob pinned to IPFS. Claims are paid by `MerkleFundDistributor`
proportionally to the proven values.

## Lifecycle

```
configure → contribute/evaluate → trigger → prove → submit → fund → claim → (sweep)
```

Env used below (dev values; the dev round's addresses are in
`.docker/contributions_round_dev_deploy.json`, and any round's are served by the
indexer's `GET /contributions/instances`):

```bash
export RPC_URL=http://127.0.0.1:8545
SNAP=$(jq -r '.merkle_snapshot' .docker/contributions_round_dev_deploy.json)
export CONTRIBUTIONS_MERKLE_SNAPSHOT=$SNAP
export EAS_ADDRESS=$(jq -r '.eas.eas' .docker/deployment_summary.json)
```

### 0. Create the round (the parent network's authority)

A round is created in ONE transaction through `ContributionsFactory.createInstance`,
by a holder of the PARENT trust network's `CONSTITUTIONAL_ROLE` (for a governed
network, that means a proposal). The factory registers the three schemas
(adopting any squatted identical record), deploys the resolver, the mirror
(bound in the same transaction — the M6-1 guard), the two-lane snapshot, the
payout distributor (fee 0, fee recipient = the round admin), and the typed
params controller, then registers the round and publishes params version 1.
From the app: the parent network's **Settings → Contribution cycles → Start a
contribution round**. From a script: `contracts/script/CreateDevContributionsRound.s.sol`
is the dev-shaped example.

Cost, honestly: creation deploys seven contracts and registers three schemas —
about **9.4M gas** measured (`ContributionsFactory.t.sol`,
`test_CreateInstanceGasRecorded`). On Ethereum mainnet that is roughly 0.01 ETH
per 1 gwei of gas price (about 0.1 ETH at 10 gwei, plus proof costs later); on
a dev chain it is free. Budget accordingly — this is a per-round cost.

### 1. Configure (operational)

Set the round window and publish the complete tuple:

```bash
task contributions:open-round-window
# = edit params.contributions.json (round_start/round_end)
#   → ContributionsParamsController.updateParams(tuple, evidenceURI)
#   → atomically update snapshot + registry hashes
#   → emit ContributionsParamsUpdated(full tuple)
```

The dev round is owned by the network's initialized 1-of-1 Safe. The task therefore sends the
typed update through `Safe.execTransaction`, signed by the configured local deployer. It refuses
an EOA it does not control or a threshold greater than one; production multisigs and governed
Safes must use their normal proposal/signature flow.

`params.contributions.json` is only a local governance draft. Once submitted,
the controller event is the durable public preimage: scanners, the operator,
and the indexer reconstruct it from registry history and hard-fail if its
21-word hash differs from the checkpoint, snapshot, controller, or registry.

### Public reproduction (no sidecar)

A third party needs only an RPC URL, the chain's `InstanceRegistry`, and its
deployment/start block. The scanner enumerates contributions rows, follows each
`paramsAuthority`, selects the complete event tuple by hash, and writes a
machine-derived proving plan:

```bash
cargo run -q -p input-exporter --bin instance-scan -- \
  --rpc "$RPC_URL" --registry "$INSTANCE_REGISTRY" \
  --program contributions --from-block "$REGISTRY_START_BLOCK" \
  --out-dir /tmp/contributions-public

ROW=$(jq -r '.instances[] | select(.paramsPath != null) | @base64' \
  /tmp/contributions-public/instances.json | head -1)
field() { printf '%s' "$ROW" | base64 -d | jq -r ".$1"; }

SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release --features fetch \
  --manifest-path zk/prover/Cargo.toml -- contributions fetch \
  --rpc "$RPC_URL" --snapshot "$(field snapshot)" --eas "$(field eas)" \
  --checkpoint "$CHECKPOINT" --params "$(field paramsPath)" \
  --from-block "$REGISTRY_START_BLOCK" --out /tmp/contributions-public/input.json
```

Running `contributions execute /tmp/contributions-public/input.json` rebuilds
the canonical allocation/root. Compare `outputRoot` with the accepted snapshot
state for that checkpoint. Any known tuple/commitment mismatch aborts before
input construction or proving.

### 2. Contribute / evaluate (users)

Users act through the frontend screens (contribute / respond / rate on the
contributions network page); everything is a plain EAS attestation against the
three registered schemas. The seed driver
(`packages/frontend/scripts/contribution-round.ts`) drives the same code path headless.

### 3. Trigger (permissionless, epoch-gated)

```bash
task contributions:trigger        # cast send $SNAP "trigger()"
```

One `trigger()` freezes BOTH lanes at the same block: the mirror checkpoints
the trust accumulator's live `(acc, leafCount)`, and the snapshot freezes the
resolver's `(anchorAcc, anchorCount)` under the same checkpoint id.
`epochLength` (blocks) paces triggers; the epoch boundary is contract-fixed,
never prover-chosen. A late trigger records the real freeze block in its checkpoint but consumes the
fixed boundary for that epoch, so the following boundary does not slide with the caller.

### 4. Prove (permissionless)

```bash
task contributions:prove-round [ID=<checkpoint>]
```

Which is, by hand (run from `zk/prover`, built `--release --features fetch`):

```bash
cargo run --release --features fetch -- contributions fetch \
  --rpc $RPC_URL --snapshot $SNAP --eas $EAS_ADDRESS \
  --checkpoint <id> --params ../../params.contributions.json \
  --trust-schema-uid <vouching schema uid>
# (writes .trustgraph/contributions/contributions_input.json; override with --out)
SP1_PROVER=mock cargo run --release --features fetch -- contributions execute ../../.trustgraph/contributions/contributions_input.json
cargo run --release --features fetch -- contributions prove ../../.trustgraph/contributions/contributions_input.json --groth16
curl -sF file=@../../.trustgraph/contributions/contributions_blob.json "http://127.0.0.1:5001/api/v0/add?cid-version=1&raw-leaves=true"
```

`fetch` re-derives the input from the `EdgeFolded` logs and self-checks by
re-folding to the checkpointed accumulators. `execute` byte-asserts guest ==
native and prints the submit args. `prove` writes
`.trustgraph/contributions/contributions_proof.bin` = `abi.encode(publicValues, seal)`. Real proving
(not the dev mock gateway): `SP1_PROVER=cpu` + `--features native-gnark`
(~16 GiB) or `SP1_PROVER=network` with `NETWORK_PRIVATE_KEY`.

### 5. Submit (permissionless)

```bash
task contributions:submit-proof
# = cast send $SNAP "submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)" \
#     <checkpointId> <outputRoot> <ipfsHash> <cid> <totalValue> 0x00…00 <recipient> <proof>
```

The contract reconstructs the journal digest from its own checkpointed
storage + the `paramsHash` pinned at that checkpoint's `trigger()` + the
submitted outputs + `recipient` + an `instanceDomain` derived from its own
address and chain id, and verifies the proof against the contributions vkey.
`skippedDigest` is always zero for this program (v1). `recipient` is the
journal-v3 bounty payee and must echo exactly what the guest committed;
`fetch --recipient` sets it and `execute` prints it back. Checkpoint ids must
be strictly increasing across applied proofs.

### 6. Fund (anyone with the pool tokens)

```bash
task contributions:fund-round AMOUNT=<base units> [DEADLINE=<unix ts>]
```

ERC-20 `approve` + `distribute(token, amount, expectedRoot[, claimDeadline])`
with the proven root pinned — a root rotation between read and send reverts
`UnexpectedMerkleRoot` instead of paying against the wrong split. A
factory-created round has **no fee at creation** (the round admin can set one,
and the fee recipient is the admin); when set, the fee goes to the fee
recipient at distribution time. With
`claimDeadline` set, claims close strictly after it and the remainder becomes
sweepable; without it, claims stay open forever (and quantization dust is
stranded by design).

### 7. Claim (anyone, for any account)

```bash
task contributions:claim-payouts INDEX=<distribution> [AS=SEED,ALICE,…]
```

Claims pay `mulDiv(amountFunded − feeAmount, value, totalMerkleValue)` to the
**leaf's account** (open-claim: any sender may execute a claim, funds always
go to the account in the leaf). Proof bundles come from the indexer:
`GET /contributions/:snapshot/payout/:account` → `{value, proof[]}` →
`claim(index, account, value, proof)`.

### 8. Sweep (anyone; funds to the funder)

```bash
task contributions:sweep INDEX=<distribution>
```

Only for deadline-carrying distributions, only after the deadline, only once:
returns `amountFunded − feeAmount − amountDistributed` to the distribution's
funder. Claims are accepted while `timestamp <= claimDeadline` and sweep only
when `timestamp > claimDeadline`, so a sweep can never race a valid claim.

## Verifying a round independently

A third party holding only chain data + the IPFS blob re-derives every payout:

1. `GET /contributions/:snapshot/round` (or read the `MerkleRootUpdated`
   event) → `root`, `ipfsHash`, `cid`, `totalValue`.
2. Fetch the blob at `cid`; check `sha256(blob) == ipfsHash`; rebuild the OZ
   standard tree over `keccak256(bytes.concat(keccak256(abi.encode(address,
   value))))` leaves and check it reproduces `root`; check Σ values ==
   `totalValue`.
3. Re-derive the values themselves from raw chain data:
   `contributions fetch` (which re-folds the resolver + trust logs to the
   checkpointed accumulators — completeness is not taken on faith) then
   `contributions execute`, and compare the emitted blob byte-for-byte.
4. Spot-check the semantics against the indexer's audit view
   (`/contributions/:snapshot/audit/:claimUID`) — every filtered, discounted,
   and superseded valuation is listed with its reason. The indexer itself only
   publishes rows after its own recompute reproduced the proven root
   (mismatch ⇒ the round is marked unverified and the API answers 409).

The 6-persona worked example in [`local-testing.md`](./local-testing.md) §§4–6
is the canonical worked verification: golden-locked inputs, hand-checkable
filters, and wei-exact expected outputs for every step.

## Roles & permissions

| power | holder | notes |
|---|---|---|
| `CONSTITUTIONAL_ROLE` (snapshot) | the round admin (the creating parent authority, unless it named another) | verifier, pre-checkpoint input wiring, epoch schedule, hooks, and two-step authority handoff; final holder cannot disappear |
| Contributions controller owner | the round admin | typed `updateParams` — per-round window + params rotation |
| `OPERATIONAL_ROLE` (snapshot) | Contributions controller only | atomically applies the typed tuple's hash; no EOA raw-hash bypass |
| resolver schema admin | the factory (one-shot, consumed inside the creating transaction) | `setSchemas` allowlist |
| mirror binder | the factory (one-shot, consumed inside the creating transaction) | `bindSnapshot`; only the bound snapshot can checkpoint the mirror |
| distributor owner | the round admin | fee config, pause, allowlist toggle |
| fee recipient | the round admin (fee is 0 at creation) | receives the fee at each `distribute` once one is set |
| `trigger` / prove / `submitProof` | **anyone** | permissionless; epoch gate paces triggers, the vkey gates proofs |
| `distribute` | anyone (dev: allowlist disabled) | the caller funds the round and is the sweep beneficiary |
| `claim` / `sweep` | anyone | funds always go to the leaf account / the funder respectively |

**Params rotation is operational, deliberately.** Per-round typed `updateParams`
(window + weights) is controller-owner action so rounds can be cadenced without
constitutional ceremony while retaining a complete public history. Which governance lane should own that key in
production — and the timelock/veto shape around it — is out of scope here
pending the [`UPGRADE_GOVERNANCE.md`](../../../research/UPGRADE_GOVERNANCE.md)
review; until then the dev default (deployer holds it) is a known
centralization point, acceptable for local/pilot rounds only.
