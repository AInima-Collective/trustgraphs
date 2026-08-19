# Isolated Nostr SP1 workspace

This directory is one detached workspace, isolated from both the root workspace and `zk/program`.
Its SP1 and crypto patches therefore cannot rotate any shipped Trustgraphs vkey. S1's
`nostr-conformance` bin compiles the goal-mandated `packages/envelopes/src/nostr/` verifier through
the isolated `nostr-envelope` package and commits `(nodeId, head, count, dataCommitment,
acceptedEventsDigest, skippedDigest)`. The host byte-compares that tuple with native verification
and requires a re-committed signed-byte mutation to exit nonzero in the guest.

S2 adds the production `nostr-workspace` bin, sharing `nostr-workspace-core` verbatim with native
execution. The pinned live conformance fixture measures 3,719,944 cycles / 4,767,269 PGU; the
mixed A+C production vector measures 6,845,293 cycles with SP1 6.3.1 in mock execution.

```sh
cd zk/nostr-program/program
PATH="$HOME/.sp1/bin:$PATH" cargo prove build --locked

cd ../host
SP1_PROVER=mock PATH="$HOME/.sp1/bin:$PATH" cargo run --release --locked
```
