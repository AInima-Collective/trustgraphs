# vkey reproducibility notes (lab measurements)

Measured vkey-rotation behavior, moved out of the public docs (`docs/concepts/networks-and-programs.md`) because it is an engineering field record, not product documentation. The values below are from the dev box; deployment-grade vkeys must be derived on the pinned toolchain recorded in the deploy runbook.

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
