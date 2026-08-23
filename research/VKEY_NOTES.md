# vkey reproducibility notes (lab measurements)

Measured vkey-rotation behavior, moved out of the public docs (`docs/concepts/networks-and-programs.md`) because it is an engineering field record, not product documentation. The values below are from the dev box; deployment-grade vkeys must be derived on the pinned toolchain recorded in the deploy runbook.

## Pre-testnet M2 cryptographic hardening batch — 2026-08-23

All guest workspaces were explicitly rebuilt after the generic envelope-0 authorization moved to
the registry-bound EIP-712 claim and contributions arithmetic gained the over-100% carve-out clamp.
This is one coordinated build/rotation record, not seven independently deployable migrations.

Toolchain: `cargo-prove sp1` commit `8252c29` (2026-06-25), `rustc +succinct 1.94.0-dev`, SP1
SDK/runtime `6.3.1`, on this x86_64 Linux workspace. `cargo prove vkey --elf` derived every value
directly from the rebuilt artifact. The public `trust-graph` host loads `trustgraph-program-v2`, so
its deployable key is the v2 row; the legacy row remains recorded for complete dependency-closure
evidence only.

| Guest | Rebuilt ELF SHA-256 | Previous recorded vkey | Rebuilt vkey | Result |
|---|---|---|---|---|
| trust-graph (legacy multi-bin) | `4e199a4bd60e580276bf19411de54dbc0e5871facdf4e72f90a5fb07e5e4bc9e` | `0x00723920a73c15a283366452b7c57249bcf50fe729ce554e59cc6048178ef81c` | `0x004d63aa5d25037c9ff63293efb56152b4f9de9735dbe8310e66b6cbf9026cf0` | rotated |
| signer-sync | `b77da9b47e5d39a541a8883dc47ad4b8ae2741f94d7fdec3d6dfac744682272b` | `0x001c86a2f4e7142e4ccce77ff222ec33728150c3479bd03aebfdf3000167c033` | `0x00cdf2fd7b8c5e143a00d9ebe4fb3ff12b6f1ffd28701b2ff898582cf9caa7c2` | rotated |
| hypercerts | `15986b78d78e2678e1f89c5ddc081da730115a527d56c19e0d580c94d88900ae` | `0x00226e75ae5db0e60a63045b161bb8f1f48aad68a0307f8bb82add90f1d6eabe` | `0x00226e75ae5db0e60a63045b161bb8f1f48aad68a0307f8bb82add90f1d6eabe` | unchanged; modified EAS code is unreachable |
| contributions | `0d5327faff8d0ef8ba9245dcc3ac45add66981d924febfcd4495c648dc9ec235` | `0x00e99c3dd09a7ccf7c669411f4e735817706c82bc7dbdc5273579c1c1d120274` | `0x00af1ddd4aa160f3627e462502537748522703857cff5a42365cc126974897c3` | rotated |
| atproto-conformance | `8cf03cf04b71e69ca113991fd389b9d6e46b38fdbde9687d149810836f6a5ded` | not previously recorded | `0x0081a37913724cf24987da9fac2561ba14fa94c7ef857e83cb8fe82226b66e19` | baseline recorded |
| trustgraph-program-v2 | `9ac8e79e3e2c4eda190bfc649766c62500876a5595d91f8c2257ec293f21ff04` | `0x009fd32b243328e6fc18cca955c291275421e3d521a46e4cd6f7139d2d00c32b` | `0x0075af868e1b7f0f4a174ca6016b483b6f96b2cd0470b2e7442e57eab778ce2a` | rotated |
| nostr-workspace | `8c7622ebbb9839e51b8b8b5e98688dee532d46347827902abb457529d4a0e0b5` | `0x005c0c02eea0c6525bac01ba2e8c7a24555018be59dce944354090a960115429` | `0x00a1d93b8f040284bf86841331064987bfb9fc282075963f153ec75ca87c1eed` | rotated |

The canonical trust-graph/signer golden params hash rotated from
`0xa27bc7ee11e51a36945dba9ffb9f4351e02d4c1c69509d357df39ffc314ca0f1` to
`0xa8ab5ec908b6a0ec70138497852a9ea2b351bda5c3d824b5a35a4489cc1a8b68`; it now pins a
nonzero minimum weight, two ordered envelope-domain separators, their non-empty domain-set hash,
and a nonzero lane-2 maximum head age.

## Scoring production release (M1 + M2 + M3a) — 2026-08-23

Clean release evidence was derived after explicitly rebuilding every guest workspace with
`cargo-prove sp1` commit `8252c29` (2026-06-25), `rustc +succinct 1.94.0-dev`, and SP1 SDK/runtime
`6.3.1`, on aarch64 Linux. Each of the seven production guests then executed in the real SP1
executor and byte-matched its native result. Trust-graph uses params schema v3; signer-sync uses
that same hash plus the five-field activity-aware selection tuple and the 13-word signer journal.

| Program | Guest ELF SHA-256 | vkey |
|---|---|---|
| trust-graph | `09beda18f28356114abe3d8411203824eeda65ec047365ae4a28064d71ea5d1d` | `0x00723920a73c15a283366452b7c57249bcf50fe729ce554e59cc6048178ef81c` |
| signer-sync | `d1ce5afc9e2a57fba0a218b4ef23293ecd0bc8537fc3ad40972cc8c606c3c2a8` | `0x001c86a2f4e7142e4ccce77ff222ec33728150c3479bd03aebfdf3000167c033` |
| hypercerts | `59422f5fd50b75c7176cfb0bacb5088a03e510ca388159cdd6de5c43df9704ba` | `0x00226e75ae5db0e60a63045b161bb8f1f48aad68a0307f8bb82add90f1d6eabe` |
| contributions | `96880549fbf9244e42d8f6fdd111ac1c9d73a4dfdee30e27878df3298b86f49f` | `0x00e99c3dd09a7ccf7c669411f4e735817706c82bc7dbdc5273579c1c1d120274` |
| trust-graph-weighted | `6c4808ab7760a93e3bd6ed124d31b44ec9d1ca4e2e10b252a8d1b9c1dd5fa308` | `0x0003d95a4a2b9272a55ad6a11f89cfa17b32e5c423a35dfb1257dd66ed68070b` |
| trust-compose | `16197b48b7435847ddf417dd0d9232df5498deb09c777e348c985a26c961389a` | `0x000a37e6e865fb6ddd924f048fecd1b8c54be44c1c959342d75bb0df27091744` |
| nostr-workspace | `5eac40adaf4107a15eae7f6a6e322c871d191e8fc71a7c895edbdcc237bfbaee` | `0x005c0c02eea0c6525bac01ba2e8c7a24555018be59dce944354090a960115429` |

The built-in execution fixtures bound these parameter hashes: trust-graph and signer-sync
`0xa27bc7ee11e51a36945dba9ffb9f4351e02d4c1c69509d357df39ffc314ca0f1`
(signer selection hash
`0xef1faf0e7ffab6f28cbc81990983481ccd18c327738cb770ad5fb3c296508c4b`), Hypercerts
`0xcc61c0925d7829b9ca7f830f250c1f93dbdab4d2ab36bda791ed616fd5faffd7`, contributions
`0x6306ab5e8e3059a992b74ba7c288b736a859b7e05ca1ee4c0585f38c81bc4377`, weighted
`0x4698fbef47b9c0fa994297d5d92f4cef94037c50ae6c9174891d95990c68953e`, composition
`0xd478cf921cb1705b099106a86ac1db696090ec4ec9e6d9dfae0ebad72ba6ea24`, and Nostr
`0xf57a0ca12178d48b0f35d325bf79e2392671bba1be469519e3e40ee3db951f8c`.

Golden-vector SHA-256 digests are trust-graph/signer
`93686d213ef22bf294d14e4c4506b2925e108270da973c1e9ad457f8438b49e4`, Hypercerts
`28fbfda4ab009333721e692ee9918fca5c0ba0009b0eeaf96ef542ef519081ec`, contributions
`bba3a8eb51a985375d7f7f39d7a7452334dce6280facdb7c8436e9dc0e265dcc`, weighted
`698ad0d53188484c8c8ea9566edd1d8fd527d78bdc2c35c6d4d88b1ddae1b923`, composition
`6c0ee55b8cf8278d7495d4dec934272c526ba512779b4348aa391b38fbf1796e`, and Nostr
`51fb9b5a58da908eae78e653fba901daabc8b9c52159859820cd06112b697dc2`.

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
