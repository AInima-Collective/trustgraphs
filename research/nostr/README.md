# Nostr / BIP340 schnorr spike evidence (2026-08-16)

Executable evidence behind [`../BUZZ_NOSTR_PLAN.md`](../BUZZ_NOSTR_PLAN.md) §8 and
[`../offchain/05-spike-results.md`](../offchain/05-spike-results.md) §4: BIP340 schnorr
verification and full Nostr event verification measured inside the SP1 guest on this
project's exact stack.

## What was measured

| op | cycles/op (marginal) | PGU/op | unpatched cycles | speedup |
|---|---:|---:|---:|---|
| BIP340 schnorr verify (`k256::schnorr`, patched) | **31,747** | **56,521** | 1,124,346 | 35.4× cyc / 19.6× PGU |
| full Nostr event verify (NIP-01 serialize 398 B + sha256 id + schnorr) | **48,858** | **75,696** | 1,173,158 | 24.0× cyc |

Environment: SP1 v6.3.1 (`sp1-zkvm`/`sp1-sdk` `=6.3.1`, cargo-prove `8252c29`), succinct
toolchain, `SP1_PROVER=mock` (executor cycles/PGU are backend-independent), linux/arm64.
Patch tags: `patch-k256-13.4-sp1-6.0.0`, `patch-sha2-0.10.9-sp1-6.0.0` — the same tags
`zk/program/Cargo.toml` pins. Method identical to the 05-spike crypto track: marginal
`(N=100 − N=1)/99` with distinct host-generated cases, results committed so work cannot
be optimized away. Shared rows (noop, ecrecover, sha256) reproduced the 05-spike numbers
exactly before the new bins were trusted.

## Files

- `bench_schnorr.rs` — verifies (msg32, sig64, xonly-pk32) triples via `k256::schnorr`
  (the exact verify a Nostr event needs after computing its id).
- `bench_nostr_event.rs` — hand-rolled NIP-01 canonical serialization → patched sha256
  event id → patched schnorr verify; the full per-event pipeline of the planned envelope.

## Reproduce

Rebuild the pruned `spike/crypto/` harness from git commit `9ea5006`, drop these two bins
into `guest/src/bin/`, ensure the guest's `k256` dependency enables the `schnorr` feature
(a k256 0.13 default), then `cd host && SP1_PROVER=mock cargo run --release` and grep
`RESULT,<label>,<cycles>,<pgu>`.

## Caveats

1. **The serializer in `bench_nostr_event.rs` implements the NIP-01 spec text** (seven
   named escapes, all other bytes verbatim). The de-facto ecosystem canonical form is
   what signers actually run — `serde_json` (rust-nostr, hence buzz) and `JSON.stringify`
   (nostr-tools), both of which additionally emit `\u00XX` for ASCII control characters
   outside the seven shorthands and escape tag strings the same way as content. For
   well-formed content the outputs are byte-identical; a production envelope serializer
   MUST implement the serde_json semantics and treat raw-control-byte events as a
   deterministic skip. Do not vendor this bin's `esc()` as-is.
2. The sp1-patches `k256` fork explicitly patches the `schnorr` module (diff touches
   `schnorr.rs`, `schnorr/{signing,verifying}.rs`; verify rides `lincomb` → the
   secp256k1 precompile MSM), and Succinct's own `patch-testing/k256` proves a
   schnorr guest in CI — but Succinct's docs only advertise ECDSA for k256. Re-measure
   on any patch-tag or SP1 major bump.
3. The sp1-patches C `secp256k1` fork does **not** accelerate schnorr (`src/schnorr.rs`
   is byte-identical to upstream; it falls through to cross-compiled C libsecp256k1).
   Consequently rust-nostr's own `Event::verify` path (pinned `secp256k1 0.30` +
   `bitcoin_hashes`) is the ~1.1M-cycle class in-guest — use it host-side only.
