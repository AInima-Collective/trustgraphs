# vkey reproducibility notes (lab measurements)

Measured vkey-rotation behavior, moved out of the public docs (`docs/concepts/networks-and-programs.md`) because it is an engineering field record, not product documentation. The values below are from the dev box; deployment-grade vkeys must be derived on the pinned toolchain recorded in the deploy runbook.

## Strict EAS envelope 0 / trust-graph v2 — 2026-08-20

The opt-in strict EAS off-chain statement is isolated in `crates/eas-offchain-v2`,
`crates/trustgraph-core`, and the detached `zk/trustgraph-program-v2` guest. The root-producer
host now loads that guest. The frozen `crates/envelopes`, `crates/pagerank-core`, and the entire
legacy multi-bin `zk/program` package (including its lockfile) are byte-identical to repository
HEAD, so signer-sync, contributions, Hypercerts, and the old lane-1 statement do not acquire the new
dependency graph.

- Toolchain: `cargo-prove sp1` commit `8252c29` (2026-06-25), `rustc +succinct 1.94.0-dev`.
- Strict guest lock: SP1 guest/runtime/slop crates remain on `6.3.1`; SHA-256 and k256 use the
  existing SP1 patch tags.
- Guest ELF SHA-256: `2501be0a68b65607b5db027b578b28477fa5196932f763aaf8b71fad404e8347`.
- Trust-graph vkey: `0x009fd32b243328e6fc18cca955c291275421e3d521a46e4cd6f7139d2d00c32b`.
- Executor evidence: the official-SDK two-anchor fixture completed in 736,128 cycles, matched native
  computation, and committed zero `skippedDigest`; the frozen lane-1 sample also matched native and
  retained its journal digest `0x35bd9bd4c23a17ccde035938c8457b2614f308e6edba46beece6f3fc9c2167d5`.

Raw ELF hashes from different checkout paths are not a valid non-rotation comparison here: Rust
embeds source paths in panic strings, shifting `.rodata`, code addresses, and the ELF entry point.
The companion-program check is therefore the stronger dependency-closure check above: their source,
manifest, and lock inputs are unchanged in the same checkout/toolchain.

> **vkeys:** a vkey identifies one exact guest binary, so it changes whenever the guest ELF
> changes — including refactors that don't change semantics (the platform reorg rotated the
> trust-graph and signer vkeys even though golden vectors stayed byte-identical). Re-derive with
> `task zk:vkey PROGRAM=…`.
> **Reproducibility caveat (measured):** the vkey also depends on the exact `succinct` toolchain
> build — a toolchain reinstall shifted the trust-graph/signer vkeys with zero source change, and
> adding a guest bin WITHOUT new crypto patches does NOT rotate sibling vkeys (byte-diff-verified
> both ways). Deployment-grade vkeys must be derived on the pinned toolchain recorded in the deploy
> runbook, not an arbitrary box; the values above are from this repo's dev box.
> Rotate live instances' vkeys in
> **batches** through the constitutional-timelock path — don't dribble one rotation per change.
>
> **params-schema v2 (2026-07-24), measured per program.** The instance factory appended
> `accumulator` + `chainId` to the trust-graph params (`docs/build/create-a-network.md` §1). ELFs were
> byte-diffed across the change on one toolchain, baseline vs. after:
>
> | Program | ELF | vkey |
> |---|---|---|
> | trust-graph | changed | `0x00aa4b4b…` → `0x0033a6fa…` |
> | signer-sync | changed (reuses the trust-graph `paramsHash`) | `0x005f28ed…` → `0x0075a449…` |
> | hypercerts | **byte-identical** — its params schema is its own | `0x00daa9ad…` (unchanged) |
> | contributions | changed — `compute::trust_params` builds a `pagerank_core::Params` | `0x0065cd06…` → `0x00ac5ded…` |
>
> Two of the four *baseline* values also differed from what this table previously recorded
> (signer-sync `0x00e06fc3…`, hypercerts `0x007b0fc9…`) with no source change between them — the
> reproducibility caveat above, observed again. Treat every value here as this box's, and derive
> deployment vkeys on the pinned toolchain in the deploy runbook.
>
> **journal v3 (2026-07-28).** The proof-scheduler build appended two words to the journal —
> `recipient` (the bounty payee) and `instanceDomain` (`keccak256(abi.encode(snapshot, chainId))`,
> rebuilt on-chain by `submitProof`). Because the shape lives in `pagerank_core::Journal` /
> `encode::journal_encoded`, which every program's guest commits, this rotated **all four** vkeys.
> The signer program is the odd one out and worth stating plainly: its own `SignerJournal` is
> untouched at six fields, and it stays outside the vault — its vkey moved purely by contagion,
> because `compute_signers` calls the shared `compute`.
>
> **The four values above are NOT a clean measurement of that change.** The `succinct` toolchain
> was reinstalled on this box in the same session, and the caveat above says exactly what that
> does. So the delta from the params-schema-v2 row mixes a source change with a toolchain change,
> and no conclusion should be drawn from comparing them. Derive deployment vkeys on the pinned
> toolchain in the deploy runbook.
>
> **Overflow backstop (2026-07-24, same build).** The instance-factory build's security review found that
> `zk_core::fixed::mul_div` truncated an over-256-bit quotient instead of failing, so a
> badly-tuned instance proved WRONG scores and disagreed with the browser's arbitrary-precision
> port. It now asserts, and the rank loop's accumulations are checked. Because `zk-core` is shared
> by every program, this rotated **all four** vkeys — unlike the params change above, hypercerts
> included. The values in the table are post-fix; the params-schema-v2-only values were
> trust-graph `0x0033a6fa…`, signer `0x0075a449…`, contributions `0x00ac5ded…`, hypercerts
> `0x00daa9ad…`.
