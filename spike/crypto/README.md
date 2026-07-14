# spike/crypto — SP1 6.3.1 crypto micro-benchmarks

Throwaway spike for GOAL.md M1 (Phase-A). Measures MARGINAL SP1 executor cycles + Prover Gas
Units (PGUs) for the crypto ops that dominate off-chain-attestation verification, replacing the
estimates in `research/offchain/03-sp1-feasibility.md`. Results land in
`research/offchain/05-spike-results.md`.

## Reproduce

```bash
cd spike/crypto/host
SP1_PROVER=mock PATH="$HOME/.sp1/bin:$PATH" cargo run --release
```

First run builds two guest crates for `riscv64im-succinct-zkvm-elf` (several minutes; needs network
to fetch the SP1 patch crates). `SP1_PROVER=mock` is mandatory — the cpu backend OOMs an 11 GiB box,
and `execute()` needs no proving backend anyway. Grep `RESULT,<label>,<cycles>,<pgu>` for the table.

## Layout

- `guest/` — one crate, patched bins: `noop`, `bench-memfill`, `bench-ecrecover`,
  `bench-p256-verify`, `bench-keccak`, `bench-sha256`. `[patch.crates-io]` redirects
  k256/p256/sha2/tiny-keccak to the SP1 precompile forks.
- `guest-nopatch/` — same source, NO patch section, bins `bench-ecrecover-nopatch`,
  `bench-sha256-nopatch` (patched-vs-unpatched delta).
- `host/` — executor CLI; generates vectors natively, runs `execute()`, prints cycles + PGU.

## Patch tags (SP1 6.x line, verified present 2026-07-14)

- sha2:        `github.com/sp1-patches/RustCrypto-hashes`  `patch-sha2-0.10.9-sp1-6.0.0`
- tiny-keccak: `github.com/sp1-patches/tiny-keccak`        `patch-2.0.2-sp1-6.0.0`
- k256:        `github.com/sp1-patches/elliptic-curves`    `patch-k256-13.4-sp1-6.0.0`
- p256:        `github.com/sp1-patches/elliptic-curves`    `patch-p256-13.2-sp1-6.0.0`
