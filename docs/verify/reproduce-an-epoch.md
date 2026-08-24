# Reproduce a public EAS epoch

This walkthrough covers the standard `trust-graph` program with onchain lane-1 EAS inputs. Those
records are recoverable from public chain history, so an independent reader can reconstruct the
checkpoint and recompute its output.

It does not cover strict offchain EAS, weighted prior, Contributions, Hypercerts, Nostr,
composition, or signer sync. Those programs require additional manifests, anchors, envelopes, or
program-specific witnesses. In general, an accepted output can be reproduced only while the exact
committed witness and build inputs remain available.

## Identify the accepted statement

For one standard checkpoint, collect:

- the primary accumulator commitment, record count, and freeze block;
- the parameter hash pinned by `checkpointParamsHash(checkpointId)`;
- the snapshot's instance domain;
- the accepted output root, blob digest, CID, and total value; and
- the verifier address, code hash, and program verification key used at submission.

The checkpoint pins inputs and parameters, not the verifier. On a provenance-enabled factory
deployment, `getAcceptedCheckpoint(checkpointId)` returns both the exact accepted state and the
submission-time verifier record. Do not substitute the snapshot's current verifier when auditing
an older root.

Useful reads include:

```bash
cast call "$MERKLE_SNAPSHOT" \
  "checkpointParamsHash(uint256)(bytes32)" "$CHECKPOINT_ID" --rpc-url "$RPC_URL"

cast call "$MERKLE_SNAPSHOT" \
  "instanceDomain()(bytes32)" --rpc-url "$RPC_URL"

cast call "$MERKLE_SNAPSHOT" \
  "provenanceEnabled()(bool)" --rpc-url "$RPC_URL"

cast call "$MERKLE_SNAPSHOT" \
  "getAcceptedCheckpoint(uint256)((uint256,uint256,bytes32,bytes32,string,uint256),(uint256,uint256,uint64,bytes32,address,bytes32,bytes32))" \
  "$CHECKPOINT_ID" --rpc-url "$RPC_URL"
```

Legacy deployments without checkpoint provenance require the corresponding proof-submission and
verifier-update events to reconstruct which verifier accepted a historical root.

## Export the lane-1 witness

Build the guest and host tools from the source revision associated with the accepted program:

```bash
task zk:build
```

Export the exact checkpoint inputs from chain events:

```bash
cargo run -p input-exporter -- \
  --rpc "$RPC_URL" \
  --accumulator "$ACCUMULATOR" \
  --eas "$EAS" \
  --checkpoint "$CHECKPOINT_ID" \
  --params ./params.json \
  --snapshot "$MERKLE_SNAPSHOT"
```

The exporter re-folds the ordered event history and refuses an input set that does not match the
onchain accumulator and record count. The supplied parameter file must hash to the checkpoint's
pinned parameter hash.

## Execute the guest and compare

Run the native computation and the real guest ELF through the SP1 executor:

```bash
SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  cargo run --release --manifest-path zk/prover/Cargo.toml -- \
  trust-graph execute ./.trustgraph/trust-graph/input.json
```

This command checks guest-versus-native output equality. It does not request or verify a
cryptographic proof.

Compare the reported root, output-file digest, CID, total value, parameter hash, and instance
domain with `getAcceptedCheckpoint`. Then build the accepted guest's verification key and compare
it with the recorded `programVKey`:

```bash
task zk:vkey PROGRAM=trust-graph
```

A byte-for-byte match shows that the public witness and recorded program reproduce the accepted
output independently of the original operator.

## Interpret a mismatch

A mismatch can come from the wrong instance or checkpoint, incomplete event history, the wrong
parameter version, a different guest build or toolchain, or unavailable output bytes. Check the
deployment block, accumulator count, pinned parameter hash, accepted verifier provenance, source
revision, and guest digest before comparing outputs.

See [Golden vectors](./golden-vectors.md) for implementation parity and [Addresses and verification
keys](./addresses-and-vkeys.md) for checking a deployed verifier.
