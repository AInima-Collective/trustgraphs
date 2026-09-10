# Envelope0PayloadV1 SP1 benchmark

This detached workspace measures the complete frozen payload path with SP1 `=6.3.1`: exact-byte
SHA-256, bounded decode, UID reproduction, log fold, every EAS EIP-712 recovery, and the typed head
recovery. It uses the same `eas_offchain::payload` code the strict trust-graph guest imports.

The all-attest cases are the conservative work-accounting path. Because revoke-before-attest is
invalid, “revoke dense” means an attest prefix followed by a revoke for every UID (50% of entries
are revokes), the maximum valid revoke density without log compaction.

Reproduce from `host/`:

```sh
PATH="$HOME/.sp1/bin:$PATH" SP1_PROVER=mock cargo run --release -- ../results.json
```

The guest pins the SP1 v6.3.1 SHA-256 and k256 patch tags. This research binary is separate from the
deployed trust-graph guest and cannot rotate an existing vkey.
