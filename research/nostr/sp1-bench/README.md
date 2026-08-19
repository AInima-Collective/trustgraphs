# Pinned Nostr/Buzz SP1 benchmark

Detached measurement workspace for SP1 `=6.3.1`. The guest lockfile pins
`patch-sha2-0.10.9-sp1-6.0.0` and `patch-k256-13.4-sp1-6.0.0`; it cannot rotate an existing
Trustgraphs program vkey.

The five guest bins measure BIP-340 prehash verification, complete NIP-01 verification, Buzz audit
folding, NIP-OA verification, and the source-derived live TGNW Option-A bundle. `results.json` is
the checked-in output. Full interpretation, environment, caps, and the reproduction command are
in [`../README.md`](../README.md).
