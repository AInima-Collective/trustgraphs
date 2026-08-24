# Reproduce an epoch

Every accepted score root can be recomputed from its committed inputs. Reproduction checks the
operator's output independently; the proof ensures the contract performed the same check before
accepting it.

## What the chain commits

An epoch identifies:

- the complete input accumulator and record count;
- the checkpoint block;
- the scoring parameter hash;
- the proving program through its verification key; and
- the output root, score-file digest, and CID.

Changing an input, omitting a record, or using different parameters changes those commitments.

## Recompute a trust-graph epoch

Build the pinned guest and host tools:

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

The exporter re-folds the event history and refuses an input set that does not match the onchain
accumulator.

Execute the proving program locally without requesting a cryptographic proof:

```bash
SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  cargo run --release --manifest-path zk/prover/Cargo.toml -- \
  trust-graph execute ./.trustgraph/trust-graph/input.json
```

Compare the reported output root, score-file digest, CID, total, parameter hash, and instance
domain with the accepted state:

```bash
cast call "$MERKLE_SNAPSHOT" \
  "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))"
```

To reproduce an older epoch, query that checkpoint's accepted state rather than the latest one.

## Interpret a mismatch

A mismatch means either the reconstructed input does not match the checkpoint, the wrong program
or parameters were used, or the published output does not follow from those inputs. Check the
instance ID, checkpoint ID, deployment block, parameter version, and verification key before
comparing output bytes.

See [Golden vectors](./golden-vectors.md) for cross-language fixtures and
[Addresses and vkeys](./addresses-and-vkeys.md) for checking a deployed verifier.
