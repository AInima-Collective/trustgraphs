# Nostr workspace local testing

For privileged collection, immutable archives, anchoring, and offline checkpoint assembly, see
[`witness-operations.md`](./witness-operations.md). Its disposable Anvil smoke test is the S3
end-to-end gate.

The S4 gate runs two checkpoints through every production boundary above the SNARK gateway:

```sh
task zk:nostr-workspace-e2e
```

It exports each epoch independently twice, checks immutable bytes, retries export/anchor/prove/
publication, submits through the real `SP1JournalVerifier`, and runs the production indexer's
authenticated pre-write boundary twice over each guest blob/journal/sidecar. It rejects
same-instance and exact-input twin-instance replay, lands a different epoch-2 root with one
withheld C head, and captures the accepted provenance through a real `CompositionSourceAdapter`.
`MockSP1Gateway` is the only contract stub.

The detached guest uses SP1 6.3.1 and the Succinct `rustc 1.94.0-dev` toolchain. Build the guest
before running host commands; `SP1_SKIP_PROGRAM_BUILD=true` makes the prover consume that exact ELF.

```sh
cd zk/nostr-program/program
PATH="$HOME/.sp1/bin:$PATH" cargo prove build --locked
cd ../../..

cargo test -p nostr-envelope -p nostr-workspace-core
cargo test --locked --manifest-path zk/nostr-program/Cargo.toml

SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  cargo run --locked --manifest-path zk/nostr-program/Cargo.toml \
  -p trustgraphs-nostr-conformance-host

task zk:parity PROGRAM=nostr-workspace
task zk:vkey PROGRAM=nostr-workspace
```

The 2026-08-19 frozen execution results are:

| check | result |
| --- | --- |
| conformance guest | 3,719,944 cycles / 4,767,269 PGU; valid fixture equals native; signed-byte mutation rejected |
| production guest | 6,845,293 cycles; journal equals native |
| production vkey | `0x00475027871d7e096ae46d3059e73769642091af658febfef05271be59e343e3` |
| params hash | `0xaf83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd` |
| output root | `0xc4de11709437734678cc026014c6162ffb7cda01b5aac93c8ba5a8091bd96678` |
| journal digest | `0x968b9db02f485c1e77c5742540eb5521c8061d36ad9a47509d0385211cced979` |
| score CID | `bafkreia7b4rsfrkctdvwvhtmp4chtj23lsekxccdlzwc7himq4hvu2rsx4` |
| golden SHA-256 | `d27bec7c0e164975d41aa35d815eff80a7b526dac6874e174520728559db9990` |
| detached lock SHA-256 | `44399e5143f0d87b14fd49aaf4e0649f54b0877019c17aee11198eca9c50ab04` |

The two-epoch S4 fixture adds one member, replaces a vouch, deletes the reciprocal vouch, flips a
forum vote, and completes another J1 lifecycle. With its newer Option-C head anchored but withheld,
the production guest executes in 8,477,214 cycles and emits root
`0xf262dbe32bec8dc313f731ba1276cf4959d852eb36b9715461720a213171462f`, score CID
`bafkreid7z7on33y5y3j3xlczar2ng35egxcvzzwr2gwtdbg2jrvpbgqwse`, and one `DROPPED` preimage.
Live journal/skip digests additionally bind the disposable chain's anchor timestamps and snapshot.

The vector contains 24 resolved authenticated events, four final edges, three scores, and five
deterministic skips. The generic parity target regenerates it, checks Rust, all Solidity golden
suites, the frontend TypeScript suite, and production guest/native equality.

## Legacy-vkey compatibility audit

Build-path strings affect Rust ELFs, so comparing artifacts from two different checkout paths is
invalid. S2 built clean `HEAD` and the working tree sequentially at one temporary absolute path.
All five legacy ELFs were byte-identical:

| guest | shared-path ELF SHA-256 |
| --- | --- |
| trustgraph | `708ee623f2c415ee64f2b1522b76e266c5cb5e030dd10cbb5bde9b34cd04e7e0` |
| signer | `793f64d00f792c7db813359335bf543529be98cac5e66400d7da97980af93eb0` |
| atproto conformance | `16f986b9a214b06aece5f50d86a60dcf487a307e9dc75a955c643af7e36daea1` |
| hypercerts | `b52dbdc1732f4e072f40f9517fe438ab628215ff2fd1e342ad4ddee55ba7cba9` |
| contributions | `579b11365f4f0d584307be4df28c0ad6f4452d22e10013cc6ef47dfe50ec46d6` |

Because the ELFs are identical, their verification keys are identical. The temporary clean
checkouts and build outputs were deleted after the audit; they are reproducible from `git archive
HEAD` and the commands above.

## Vkey-safe lint policy

Guest-reachable Rust source text is part of the SP1 build input, so even a lint-only source edit can
rotate an ELF and its vkey. The final strict-Clippy pass therefore preserves frozen source spellings
and records narrowly scoped lint policy in the affected package `Cargo.toml` files. A sequential
before/after rebuild at the same absolute paths confirmed byte-identical ELFs for trustgraph,
signer-sync, AT Protocol conformance, Hypercerts, contributions, weighted prior, trust-compose,
Nostr conformance, and `nostr-workspace`.

Do not replace those manifest allowances with guest-reachable source rewrites as routine cleanup.
Any such rewrite must follow the benchmark, same-path ELF comparison, reviewed lockfile, and vkey
rotation procedure required by
[`research/plans/nostr-workspace.md`](../../../research/plans/nostr-workspace.md).
