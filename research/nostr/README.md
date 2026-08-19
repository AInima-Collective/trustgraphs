# Nostr / Buzz SP1 spike evidence (corrected and measured 2026-08-19)

Executable evidence behind [`../BUZZ_NOSTR_PLAN.md`](../BUZZ_NOSTR_PLAN.md) §8 and
[`../offchain/05-spike-results.md`](../offchain/05-spike-results.md) §4. The checked-in detached
[`sp1-bench/`](sp1-bench/) workspace measures the exact Nostr prehash path, Buzz audit hashing,
NIP-OA, and the pinned live Option-A bundle inside SP1.

## Corrected results

Marginal rows use `(N=100 - N=1) / 99` with distinct, deterministically generated valid inputs.
The full-event corpus includes every ASCII control escape plus Unicode; the event id supplied by
host `serde_json` must equal the id independently reconstructed by the guest before signature
verification.

| operation | cycles/op | PGU/op |
| --- | ---: | ---: |
| BIP-340 prehash verification | **30,842** | **55,182** |
| NIP-01 serialize + SHA-256 id + BIP-340 prehash verification | **44,734** | **70,149** |
| Buzz audit-entry hash and chain fold | **10,302** | **11,920** |
| NIP-OA exact tagged hash + conditions + owner prehash verification | **35,964** | **61,246** |

The source-derived live database export was also run without marginal subtraction:

| live workload | cycles | PGU |
| --- | ---: | ---: |
| 35 signature-only checks | 1,084,335 | 1,943,205 |
| 35 complete Nostr events | 1,616,933 | 2,516,403 |
| 30-entry Buzz audit prefix | 325,355 | 387,604 |
| 3 NIP-OA credentials | 108,550 | 188,750 |
| complete 20,297-byte TGNW Option-A round trip | **2,519,703** | **3,631,054** |

The whole-fixture bin binds data commitment
`872093fcdc876464c5c98f4349e090bc86a70da8bef7ef105ccdb5a532033a5d`, strictly decodes the
bounded TGNW bundle, re-folds all 30 audit entries, requires every audited object among all 35
event rows, verifies all NIP-01 ids/signatures, and verifies all three OA credentials. It measures
the envelope verification workload, not the later S2 graph semantics.

## Production S1 conformance result

The reusable verifier in `packages/envelopes/src/nostr/` (compiled by the isolated
`nostr-envelope` package so the legacy `envelopes` crate identity does not change) and the isolated
`zk/nostr-program/program` conformance guest run the full S1 contract: strict TGNW decoding and
byte re-encoding, Option-A/Option-C head verification, NIP-01 and NIP-OA signatures, roster
eligibility, replacement, deletion, and accepted/skipped outcome digests. On the same live Option-A
fixture the current locked production guest measures **3,719,944 cycles / 4,767,269 PGU**. It commits:

- `dataCommitment = 872093fcdc876464c5c98f4349e090bc86a70da8bef7ef105ccdb5a532033a5d`
- `acceptedEventsDigest = 0f19891df43eae1cd874fcbfd5d7f64c33211fbdfb7bcc72dc51c04e16d620b9`
- `skippedDigest = 46b01e4c9ce37c375e0faf4a0a607ba0f33c204ebc900ff72e0a47bdf44d1a47`

Its host byte-compares all six committed words with native verification, then re-commits a bundle
whose final signed byte was changed and requires both native and SP1 execution to reject it. The
smaller 3.63M-PGU benchmark above remains the frozen S0 cost baseline; its guest intentionally does
not compute S1 state dispositions.

## Production S2 result

The mixed Option-A/Option-C production program resolves 24 authenticated rows into four semantic
edges, three nonzero scores, and five skips. Native and SP1 journal bytes agree at **6,845,293
cycles**. The four-way vector freezes params hash
`af83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd`, output root
`c4de11709437734678cc026014c6162ffb7cda01b5aac93c8ba5a8091bd96678`, journal digest
`968b9db02f485c1e77c5742540eb5521c8061d36ad9a47509d0385211cced979`, and CID
`bafkreia7b4rsfrkctdvwvhtmp4chtj23lsekxccdlzwc7himq4hvu2rsx4`. The production vkey is
`0x00475027871d7e096ae46d3059e73769642091af658febfef05271be59e343e3`.

`task zk:parity PROGRAM=nostr-workspace` passes Rust, guest, Solidity, and TypeScript parity. A
same-absolute-path clean-HEAD audit also produced byte-identical trustgraph, signer, atproto
conformance, hypercerts, and contributions ELFs; see
[`docs/build/nostr-workspace/local-testing.md`](../../docs/build/nostr-workspace/local-testing.md).

Environment: SP1 v6.3.1 (`sp1-zkvm`/`sp1-sdk` `=6.3.1`, cargo-prove `8252c29`), Succinct
toolchain `rustc 1.94.0-dev`, `SP1_PROVER=mock`, linux/arm64. Patch tags:
`patch-k256-13.4-sp1-6.0.0` and `patch-sha2-0.10.9-sp1-6.0.0`.

## Files and reproduction

- `bench_schnorr.rs`: `(event_id32, sig64, xonly-pk32)` through `PrehashVerifier`.
- `bench_nostr_event.rs`: serde-compatible NIP-01 serialization, id, and signature.
- `bench_audit.rs`: exact Buzz audit preimages and a gap-free prefix fold.
- `bench_oa.rs`: exact NIP-OA preimage, conditions, and owner signature.
- `bench_envelope.rs`: raw live TGNW Option-A round trip.
- `sp1-bench/results.json`: machine-readable raw and derived results.

```sh
cd research/nostr/sp1-bench/guest
PATH="$HOME/.sp1/bin:$PATH" cargo prove build

cd ../host
SP1_PROVER=mock PATH="$HOME/.sp1/bin:$PATH" cargo run --release -- \
  ../../../../test/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/live/live-export.json \
  ../results.json \
  ../../../../test/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/live/live-option-a.tgnw
```

The host prints `RESULT,<label>,<count>,<cycles>,<pgu>` and
`MARGINAL,<label>,<denominator>,<cycles/op>,<pgu/op>`.

## S0 work model and caps

The conservative preflight estimate is:

```text
estimated_pgu = 2 * (
    24 * bundle_bytes
  + 12_000 * audit_entries
  + 71_000 * nip01_signature_checks
  + 62_000 * oa_signature_checks
  + 1_000_000
)
```

The factor 24 charges every bundle byte twice at the measured patched SHA-256 rate, once for the
data commitment and once for NIP-01/event-related hashing. The outer factor two covers decode,
coverage, state-rule, input-shape, and measurement variance. It estimates both the 3.63M-PGU S0
baseline and 4.55M-PGU production S1 live runs at 9.04M PGU. At the joint hard circuit maxima—12
MiB TGNW, 4,096 audit entries, 640 NIP-01
signatures, and 256 OA signatures—it is 826.9M PGU, below the 1B-PGU default with 17% headroom.

The pilot operational ceiling is stricter: 4 MiB bundle, 2,048 audit entries, 512 unique Nostr
events, 640 total NIP-01 checks including heads, 128 OA checks, and `estimated_pgu <= 400M`. All
limits are checked before proving spend and covered by `paramsHash`; production execution still
enforces the hard circuit caps independently.

## Retired 2026-08-16 result

The older 31,747-cycle/56,521-PGU signature row and 48,858-cycle/75,696-PGU event row used k256's
message-level `Verifier`, which SHA-256s its input. Rust-nostr/libsecp signs the already-hashed
32-byte event id and requires `PrehashVerifier`. The pinned Buzz corpus accepts via
`verify_prehash(event_id, sig)` and rejects via `verify(event_id, sig)`, so those older values must
not be used for caps or pricing.

## Caveats

1. The guest serializer matches `serde_json` for all control bytes and escapes tag strings as
   well as content. PostgreSQL `jsonb` rejects U+0000 in stored tag JSON, so that one case remains
   a signed serializer-only vector; every other live stored event is covered by the round trip.
2. The sp1-patches `k256` fork explicitly patches the `schnorr` module and routes verification
   through the secp256k1 precompiles. Succinct's public feature table does not advertise Schnorr,
   so re-measure on any patch-tag or SP1 major bump.
3. The sp1-patches C `secp256k1` fork does not accelerate Schnorr. Rust-nostr's own
   `Event::verify` path remains host-only; the guest uses patched `sha2` and k256's
   `PrehashVerifier` directly.
4. This is execute-only (`SP1_PROVER=mock`). Prover-network clearing price and proving wall-clock
   still require an authorized network run; neither affects deterministic cycles/PGU.
