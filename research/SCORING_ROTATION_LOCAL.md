# Local scoring-rotation evidence

This is the reproducible local evidence for the versioned scoring control plane. It is deliberately
separate from a mock-verifier unit test: both checkpoints below were reconstructed from Anvil logs,
then the compiled SP1 guest ELF executed over each complete witness and byte-asserted its public
journal against native `pagerank-core`.

## Recorded run — 2026-08-11

Environment: Anvil chain `31337`, current factory and registry bytecode, no external indexer. The
factory-created instance was:

```text
instance    0xcce78403e9b71481a2e052721ef3c0cb22510879bf4484c6f3b12d9c8a707544
snapshot    0x5e2f0E0Cca08B0E8bbe14f4dd8c355bf613fDC3a
accumulator 0x374f54E41063154B1bc6C526d9bAe452326e8B1A
```

Version 1 froze checkpoint 0 after 21 vouches. Version 2 changed damping from `0.85` to `0.8`, one
new vouch was folded, and checkpoint 1 froze. The chain pinned different, controller-published
hashes without changing operator or prover configuration:

```text
checkpoint 0 paramsHash 0xecf2bd395ceeac3b0c8f6525c72260cc92317374669797d036b233c166a064cd
checkpoint 1 paramsHash 0xef1d1587a2c90cf9503cb29052fc7e7915d574dfbafdf05be679416d6a96cd28
```

Each input was exported from its named checkpoint with `input-exporter`; its accumulator self-check
passed before execution. The guest was then run twice:

```bash
cd zk/prover
SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  target/release/trustgraph-prover trust-graph execute \
  ../../.trustgraph/rotation-proof/input-v1.json \
  --out-dir ../../.trustgraph/rotation-proof/v1

SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  target/release/trustgraph-prover trust-graph execute \
  ../../.trustgraph/rotation-proof/input-v2.json \
  --out-dir ../../.trustgraph/rotation-proof/v2
```

`SP1_PROVER=mock` here selects the non-SNARK backend; it does not replace the guest. The `execute`
subcommand calls `client.execute(guest_elf, stdin).run()`, reports real guest cycle counts, and fails
unless the guest's public bytes equal the independently computed native journal. No proof is claimed
by this command.

Observed public results:

| | Version 1 / checkpoint 0 | Version 2 / checkpoint 1 |
|---|---|---|
| Guest cycles | `3,843,226` | `3,666,971` |
| Guest/native | equal | equal |
| `paramsHash` | `0xecf2…64cd` | `0xef1d…cd28` |
| `journalDigest` | `0xd81288184cdad8b8e9319ffd7c4de8adf27b82805917fba373e739cc9f416d33` | `0x9ff4f4d21b7d9eddb2139fd45c3708203755a25f0fb8338f00f0a29b8c3a5d36` |
| `outputRoot` | `0xff92222d89ef045780c197cd645a22819a7710fa5c55d1b60b31d82b73194e0d` | `0xe0a39ece7f90227a27952f52812540cd94940d0b1669c58089f0b76ffcf690da` |

The printed guest `paramsHash` values exactly equal the corresponding on-chain
`checkpointParamsHash`. The journal digests differ, as they must: the second journal commits both to
the version-2 tuple and to the second checkpoint's 22-edge cutoff.

## Direct and timelocked authority exercise

The same local run created a second controller-backed demo. Version 2 changed trusted seeds and
damping through the direct owner. Ownership was then transferred with
`DeployParamsTimelock.s.sol`: the controller named the timelock as pending owner, the timelock
scheduled `acceptOwnership()`, and ownership changed only after that operation became ready. Version
3 was scheduled and executed through the timelock. After both updates, controller, snapshot, and
registry returned the same hash; the final value was:

```text
version 3 paramsHash 0x01c2f942922a8a7b5addfac45c2573a4903513b69d93d8d2b8200cb4ef413bff
```

For a fresh local controller owner, start the safe handoff with:

```bash
forge script contracts/script/DeployParamsTimelock.s.sol:DeployParamsTimelock \
  --sig 'run(address,uint256,string)' \
  "$PARAMS_CONTROLLER" 172800 0x0000000000000000000000000000000000000000 \
  --rpc-url "$RPC" --broadcast
```

The script writes the operation id, salt, and `acceptOwnership()` calldata to
`.trustgraph/params-timelock.json`. Execute that scheduled operation only after its minimum delay;
until then, the original controller owner remains active and recovery-safe.
