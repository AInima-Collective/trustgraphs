# signer-sync — Operator Runbook

> Internal operations guide. This page is not part of the public product documentation.

How the Safe **signer-sync** program (`signer`) is built, deployed, and run. It is a second,
independent SP1 proof that rotates a Zodiac Safe's owner set to the top-scored accounts. It reuses the
same `AttestationAccumulator` + `paramsHash` as the [`trust-graph`](../trust-graph/runbook.md) root
(so the score root and the signer set are consistent by construction — same inputs, same params, same
deterministic algorithm), but has its own guest bin, journal, verification key, and verifier instance
— `MerkleSnapshot` is untouched.

See [`architecture.md`](./architecture.md) (→ `research/SIGNER_SYNC_ZK_PLAN.md`) for the design and the
program index in [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md). The shared toolchain, core-crate build, and the
mainnet-fork harness are in the [`trust-graph` runbook](../trust-graph/runbook.md); this file covers
only the signer-specific deltas. The end-to-end local walkthrough (which exercises signer-sync
alongside the root loop) is [`../trust-graph/local-testing.md`](../trust-graph/local-testing.md).

## Components (signer-specific)

| Path | What it is |
|---|---|
| `zk/program` | Multi-bin SP1 guest crate. `trustgraph-signer-program` bin = this program (signer selection). |
| `zk/prover` | Host CLI `trustgraph-prover`, `signer {vkey\|selectionparamshash\|execute\|prove}` group. |
| `contracts/src/zodiac/SignerSyncZkModule.sol` | `submitSignerProof` write-gate + on-chain Safe owner-set diff. |
| `contracts/src/merkle/SP1JournalVerifier.sol` | Shared journal-agnostic adapter; the signer gets its own instance bound to the signer vkey. |
| `tests/golden/trust-graph.json` + `contracts/test/unit/golden/SignerGoldenVectors.t.sol` | The signer vectors ship in the same `trust-graph.json` family (root + signer), locked by their own `.t.sol`. |

## Build & test

Shared core build is in the trust-graph runbook. Signer-specific validation:

```bash
# Golden lock for the signer vectors (same trust-graph.json family, own test contract):
forge test --match-path 'contracts/test/unit/golden/SignerGoldenVectors.t.sol'

# Guest == native (no proof) for the signer selection:
cd zk/prover
SP1_PROVER=cpu cargo run --release -- signer execute signer_input.json   # guest == native
#   ≡ task zk:execute PROGRAM=signer  (omit the input to use the built-in sample)
```

## Determine the deploy constants

```bash
cd zk/prover
cargo run --release -- signer vkey                              # -> programVKey for the signer guest
#   ≡ task zk:vkey PROGRAM=signer
cargo run --release -- signer selectionparamshash signer_input.json   # -> selectionParamsHash
# signer_input.json is a serialized pagerank_core::SignerInput (edges + params + selection). Omit for the sample.
```

> **vkey:** the current signer vkey is recorded in [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md) (it rotates
> whenever the guest ELF changes, even for refactors that don't change semantics).

`SignerSyncZkModule` is deployed + enabled by the governed factory, reusing the MerkleSnapshot's
accumulator and pinned params while binding the sibling `MerkleGovModule` as its authenticated
activity source. The deployer validates the signer verifier's program vkey and hashes the complete
selection/liveness tuple. The production defaults are top 5, minimum threshold 2, 50% target,
151,200 inactive blocks, and two activity witnesses.

```bash
cd zk/prover
export SP1_SIGNER_PROGRAM_VKEY=$(cargo run -q --release -- signer vkey)
cd ../..
```

## Rotate the Safe signer set (the signer-sync loop)

Build the signer input, validate, then run the loop:

```bash
# Direct votes checkpoint automatically. If no vote happened recently, refresh the immutable
# reference block without inventing activity (rate-limited by the governance module):
cast send $MERKLE_GOV_MODULE "checkpointSignerActivity()"

# Reconstruct score inputs, the complete activity chain, and the Safe pre-state from chain:
cargo run -p input-exporter -- \
  --rpc $RPC --accumulator $ACCUMULATOR --eas $EAS \
  --checkpoint $CHECKPOINT_ID --params params.json \
  --signer --selection selection.json --module $SIGNER_SYNC_MODULE
# (writes .trustgraph/signer-sync/signer_input.json; override with --out)
# --module is REQUIRED (audit M-3): it is half of the instanceDomain journal word that
# submitSignerProof rebuilds from address(this) + block.chainid, so an input exported without it
# proves nothing any module will accept. No --snapshot / --recipient here: the signer journal
# carries no bounty word (SignerSyncZkModule pays none).

cd zk/prover
SP1_PROVER=cpu cargo run --release -- signer execute ../../.trustgraph/signer-sync/signer_input.json   # guest == native (no proof)
cargo run --release -- signer prove ../../.trustgraph/signer-sync/signer_input.json --groth16
# (writes .trustgraph/signer-sync/signer_proof.bin)
#   ≡ task zk:prove PROGRAM=signer
```

```bash
# 1. Freeze a checkpoint (same trigger() as the root):
cast send $MERKLE_SNAPSHOT "trigger()"
# 2. Submit. ACTIVITY_CHECKPOINT_ID is recorded in signer_input.json; SIGNERS are ascending:
cast send $SIGNER_SYNC_MODULE \
  "submitSignerProof(uint256,uint256,address[],uint256,bytes)" \
  $CHECKPOINT_ID $ACTIVITY_CHECKPOINT_ID "[$SIGNERS]" $THRESHOLD \
  $(xxd -p -c0 .trustgraph/signer-sync/signer_proof.bin)
```

`submitSignerProof` rebuilds the signer journal digest from the chain-pinned checkpoint + stored
`paramsHash`/`selectionParamsHash`, the current activity-chain checkpoint, the Safe's live owner
root and threshold, the submitted `signerSetRoot`/`targetThreshold`, and an
`instanceDomain = keccak256(abi.encode(address(this), block.chainid))` it derives itself (audit
M-3 — a proof made for one module cannot be replayed against a same-params sibling or a mirrored
deployment on another chain), verifies, then
diffs the proven set against the Safe's **live** owner linked list on-chain (correct `prevOwner`
pointers; `1 ≤ threshold ≤ ownerCount` preserved at every intermediate add/remove/swap).

The five-field selection/liveness rule is governance-pinned as `selectionParamsHash`. Governance
changes it through `setSelectionParams(...)`, which revalidates the two-witness and threshold floors
and derives the hash on-chain.

## Rotating the signer vkey (guest change runbook)

Any change to the signer guest — including a change to `pagerank-core` it compiles in — rotates the
signer program vkey. The 2026-08-13 M-3 fix (instanceDomain journal word) is such a rotation. The
sequence, per the batching rule (one rotation per program, all guest edits grouped):

1. Land every signer-guest-affecting change in one batch; regenerate the golden vectors
   (`cargo run -p pagerank-core --example export_golden > tests/golden/trust-graph.json`) in the
   same commit and confirm guest==native (`signer execute`), Solidity
   (`SignerGoldenVectors.t.sol`), and the frontend TS golden test are all green.
2. `cargo run --release -- signer vkey` → the new `SP1_SIGNER_PROGRAM_VKEY`.
3. Deploy a new signer verifier: `SP1JournalVerifier(gateway, newSignerVkey)`.
4. Point the module at it: `setZkVerifier(newVerifier)` (module owner — the timelock in
   production). Old proofs (old journal shape / old vkey) stop verifying at that instant.
5. Re-export inputs (`input-exporter --signer --module …`) and prove with the new guest; record
   the new vkey in [`networks-and-programs.md`](../../../docs/concepts/networks-and-programs.md).

## Governance

`SignerSyncZkModule`: its `owner` (set a `TimelockController` in production) governs `setZkVerifier`,
`setAccumulator`, `setActivitySource`, and `setSelectionParams`. `setParamsHash` is held by a separate
`paramsAuthority` — initialized to the owner, handed off by the owner via a two-step
transfer/accept — so params rotation can sit with a different governance lane than the
truth-defining knobs. Deploy a new
signer verifier (`SP1JournalVerifier(gateway, newSignerVkey)`) + `setZkVerifier` when the signer
guest changes.
