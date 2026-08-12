# Feasibility Dossier: Verifying Signed Off-Chain Attestations inside SP1

**Status:** Source dossier (substrate for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md); realized — see [`../../docs/concepts/networks-and-programs.md`](../../docs/concepts/networks-and-programs.md)).

> Source research for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md). Compiled 2026-07-10 · Grounded against this repo (SP1 pinned `=6.3.1` in `zk/program/Cargo.toml` and `zk/prover/Cargo.toml`; current guest ≈ **1.79M cycles** for the sample input, signer guest ≈ **1.85M cycles**, per `docs/build/trust-graph/runbook.md`).

**TL;DR:** In-guest signature verification is entirely feasible and is the dominant cost. At ~1k-account scale (N≈1,000 signatures) the added proving cost is **~0.2–0.5B cycles ≈ well under $1 and single-digit minutes** on the Succinct network — noise. At N=100,000 EIP-712 signatures it's **~20–45B cycles, roughly $2–45 and ~15–60 min** — feasible but worth optimizing. The AT Protocol model (one commit signature per attester + SHA-256 MST verification) is **~5–10× cheaper** than per-record EIP-712 at the same record count and composes naturally with SP1 recursion (cache one sub-proof per attester repo, re-aggregate per epoch). No prior art of atproto-in-a-zkVM was found — this would be novel.

---

## 1. SP1 precompile landscape as of July 2026

**Current version:** SP1 **v6.3.1** (released 2026-06-25; verified via `gh api repos/succinctlabs/sp1/releases/latest`). This is exactly what TrustGraph pins, so no upgrade needed. Recent releases (v6.2.x–6.3.x) added: `no_std` guest support, mprotect, private stdin for the network (v6.2.1), Rust 1.94 toolchain, DAG-native GPU prover, and market-based PGU pricing defaults. The current prover backend generation is **SP1 Hypercube** (multilinear/jagged PCS), live on mainnet since late 2025 ([blog](https://blog.succinct.xyz/sp1-hypercube-is-now-live-on-mainnet/)).

**Full syscall list** (verified from `crates/core/executor/src/syscall_code.rs` on `succinctlabs/sp1@main`):

| Domain | Syscalls |
|---|---|
| Hashing | `SHA_EXTEND` (0x00300105), `SHA_COMPRESS` (0x00010106), `KECCAK_PERMUTE` (0x00010109), **`POSEIDON2` (0x00000133 — new in v6.x)** |
| secp256k1 | `SECP256K1_ADD`, `SECP256K1_DOUBLE`, `SECP256K1_DECOMPRESS` |
| **secp256r1 / P-256: yes, real precompiles** | `SECP256R1_ADD` (0x0001012C), `SECP256R1_DOUBLE` (0x0001012D), `SECP256R1_DECOMPRESS` (0x0001012E) — shipped in SP1 v4.0 |
| Ed25519 | `ED_ADD`, `ED_DECOMPRESS` |
| Pairing curves | `BN254_*`, `BLS12381_*` (add/double/fp/fp2 families) |
| Bigint (RSA etc.) | `UINT256_MUL`, `UINT256_ADD_CARRY`, `UINT256_MUL_CARRY`, `U256XU2048_MUL` (2048-bit, built for RSA) |
| Recursion | `VERIFY_SP1_PROOF` (0x0000001B), `COMMIT_DEFERRED_PROOFS` |

**Patched crates** (from [docs.succinct.xyz precompiles page](https://docs.succinct.xyz/docs/sp1/optimizing-programs/precompiles), tags for the 6.x line): `sha2` (`patch-sha2-0.10.9-sp1-6.0.0`), `sha3`, `tiny-keccak` (`patch-2.0.2-sp1-6.0.0`), `k256`/`secp256k1` (`patch-k256-13.4-sp1-6.0.0`), **`p256` (`patch-p256-13.2-sp1-6.0.0`)**, `curve25519-dalek`, `bls12_381`, `substrate-bn`, `rsa` (`patch-0.9.6-sp1-6.0.0`), `crypto-bigint`. The SP1 repo's `patch-testing/` tree confirms p256 patches cover **both verify and ecdsa-recovery** paths (`p256_low_sig_recovery`, `p256_low_sig_verify`, etc.).

**Per-op cycle costs (best available anchors — flagged where stale):**

| Op (patched) | Cycles | Source / confidence |
|---|---|---|
| secp256k1 `recover_address_from_prehash` (ecrecover) | **~218k cycles** | Measured in RSP/reth guest, [raiko issue #280](https://github.com/taikoxyz/raiko/issues/280). SP1 v1-era measurement; v4–v6 patches are the same design, so treat 150–250k as the range. **Medium confidence.** |
| keccak256 of an Ethereum tx (~100–500 B, incl. encoding) | 3.6k–14.6k cycles | Same RSP measurements. Implies ~10–30 cycles/byte all-in for keccak-hashing small structured payloads. |
| P-256 ECDSA verify (patched) | ~200–450k cycles (est. 1–2× k256; verify needs 2 scalar muls vs ~1.5 for recover) | **Estimate — no published number found.** Contrast: unpatched pure-Rust P-256 verify ≈ **11.8M cycles** ([zk-X509 paper](https://arxiv.org/abs/2603.25190)), i.e. the precompile is worth ~30–50×. |
| Ed25519 verify (patched dalek) | ~100–300k cycles (est.) | No current published figure; same order as k256. Not needed for atproto (commits are k256/p256). |
| SHA-256 (precompile) | ~1 `SHA_EXTEND`+`SHA_COMPRESS` pair per 64-B block; order 10²–10³ cycles-equivalent/block in prover cost | **Low precision.** Raw cycle counts under-represent precompile cost (see PGU note below). |
| BLS12-381 sig verify | ~100k cycles/sig amortized (512 sync-committee sigs: 6B → 50M cycles) | [Succinct precompiles blog](https://blog.succinct.xyz/succinctshipsprecompiles/) |

**Important metric caveat — PGUs, not cycles.** Since v4.1.4 SP1 bills by **Prover Gas Units (PGUs)**: a regression model over trace areas, "roughly calibrated to be of a similar magnitude to RISC-V cycle count," introduced precisely because precompile-heavy code lies about its cost in cycles — the docs' own example: **"ECDSA recovery requires double the proving time of keccak256 despite having fewer cycles"** ([prover-gas docs](https://docs.succinct.xyz/docs/sp1/optimizing-programs/prover-gas)). For an ecrecover-heavy guest, budget **PGU ≈ 1.5–2× cycles**. `ProverClient::execute()` returns PGUs in the `ExecutionReport`, so you can measure exactly before committing to a design.

**Prover-network pricing (ballpark, market-based — inherently uncertain):**
- Fee model: `total = base fee + bid_price_per_PGU × PGUs`, reverse auction denominated in $PROVE ([network architecture blog](https://blog.succinct.xyz/network/introducing-the-succinct-network-architecture-and-the-prove-token/)). The SDK uses a server-supplied market price with a 1.2× buffer (`DEFAULT_MAX_PRICE_PER_PGU_BUFFER = 120` in `crates/sdk/src/network/mod.rs`); default limits: cycle limit 10¹² on mainnet, PGU limit 10⁹ (raise it for big runs), timeout 4h.
- $PROVE ≈ **$0.19** (July 2026, [CoinGecko](https://www.coingecko.com/en/coins/succinct)).
- Hardware floor: Hypercube proves 99.7% of Ethereum blocks (~200–400M cycles) in <12s on **16× RTX 5090** ([blog](https://blog.succinct.xyz/real-time-proving-16-gpus/)) → ~25–30M cycles/s per prover → raw hardware cost on the order of **$0.05–0.15 per billion cycles**. 2024-era public anchor: "~a tenth of a cent proving cost per transaction" for Ethereum blocks ([SP1 benchmarks 8/6/24](https://blog.succinct.xyz/sp1-benchmarks-8-6-24/)) ≈ $0.4–0.6/B cycles, and costs have fallen ~5× since ([Hypercube](https://blog.succinct.xyz/sp1-hypercube/)).
- **Working assumption: $0.1–1.0 per billion PGUs** market clearing price. Flag: no authoritative published average; measure with a live request on the explorer ([explorer.succinct.xyz](https://explorer.succinct.xyz)).

## 2. Cost model: EIP-712 secp256k1 (and P-256) in-guest

Per EIP-712 record: keccak struct-hash + domain digest (~1–5k cycles; domain separator precomputable) + ecrecover (~220k) + deserialization (~few k) ≈ **~225k cycles ≈ ~0.4M PGU** per signature. This is ~125× the *entire current PageRank guest* (1.79M cycles) — signatures dominate everything.

| Scenario | Cycles | PGUs (est.) | Network cost @ $0.1–1/B PGU | Wall-clock (single Hypercube-class prover, ~29M cyc/s) |
|---|---|---|---|---|
| Current guest (baseline, 1k accounts) | 1.8M | ~2M | <$0.01 | seconds |
| **N=1,000 secp256k1** | ~0.23B | ~0.4B | **$0.04–0.4** | ~10–20s compute; 1–4 min end-to-end incl. auction + Groth16 wrap |
| **N=100,000 secp256k1** | ~22.5B | ~40B | **$4–40** | ~15–30 min compute; well under the 4h default timeout |
| N=1,000 P-256 | ~0.3–0.45B | ~0.6–0.9B | $0.06–0.9 | ~1–4 min |
| N=100,000 P-256 | ~30–45B | ~50–90B | **$5–90** | ~25–60 min |

All scenarios fit comfortably inside SP1's envelope (guidance: aggregation only needed past ~120B cycles / ~2GB memory, [proof-aggregation docs](https://docs.succinct.xyz/docs/sp1/writing-programs/proof-aggregation)). Input size at N=100k: ~20MB of stdin — trivial (see §6). **Uncertainty flags:** the 218k ecrecover figure is a 2024 measurement; the PGU multiplier and network clearing price are estimates. A 1-hour spike (patched `k256` in a toy guest + `execute()`) would pin cycles and PGUs exactly — recommended before the architecture doc freezes numbers.

Note the fit with EAS: EAS already defines **off-chain attestations as EIP-712 signed objects**, so "EAS offchain + in-guest ecrecover" keeps the existing schema/tooling.

## 3. AT Protocol repo proofs in-guest

**What must be verified per attester repo:** (a) one commit signature — atproto commits are signed with secp256k1 *or* NIST P-256 (low-S mandated) over the SHA-256 of the dag-cbor commit object; (b) MST inclusion **and completeness** for the relevant collection (e.g. `app.trustgraph.vouch.*`): re-hash records → CIDs, re-build/walk the SHA-256 MST subtree to the signed root; (c) DID→signing-key binding.

**Cost anatomy (per attester with r records, ~300–500B/record incl. MST node overhead):**
- Commit signature: ~220k cycles (k256) / ~200–450k (p256) — **once per attester**, not per record.
- SHA-256 hashing: ~8 blocks/record ≈ ~1–3k cycles/record (precompile).
- dag-cbor decode (`serde_ipld_dagcbor` — **no_std-compatible**, v0.6.4 May 2026, deps `cbor4ii` + `ipld-core`, [docs.rs](https://docs.rs/serde_ipld_dagcbor); `cid`/`multihash` also build no_std) — plain RISC-V, no precompile: est. **5–20k cycles/record**. Decoding, not hashing, is likely the largest non-signature cost; a stripped hand-rolled MST-node parser (atproto nodes are a narrow CBOR schema) could cut this several-fold.
- Completeness within a repo is *native*: the MST is deterministic and canonical, so enumerating the full collection subtree against the signed root proves nothing was omitted. Global completeness (which attesters count) still needs a set commitment (§7).

**Comparison at 1,000 attesters / 100,000 records:**

| Design | Signature cycles | Hash+decode cycles | Total |
|---|---|---|---|
| Per-record EIP-712 | 100k × 225k ≈ 22.5B | ~0.5B (keccak) | **~23B** |
| Per-attester atproto commit | 1k × ~250k ≈ 0.25B | ~0.6–2.5B (sha256 + dag-cbor) | **~1–3B** |

**≈5–10× cheaper**, and it gets better: unchanged repos can reuse cached sub-proofs (§5), making steady-state cost proportional to *churn*, not corpus size.

**Risks / caveats:** did:plc is a centralized directory with key rotation — the guest needs a pinned DID→key mapping or an audited PLC log commitment (this is the real trust decision, not the crypto); records must be pinned to a specific commit `rev` to avoid TOCTOU across attesters' repos; p256 support doubles the curve surface.

**Prior art: none found.** Multiple searches ("atproto zk", "bluesky zkVM/SP1/RISC Zero", "zkPDS", "zk MST") surfaced no project verifying atproto MSTs or commits inside a SNARK/zkVM as of 2026-07. Closest: **zkLabeler** (Fan Zhang), which attaches verifiable Bluesky labels using zkTLS/DECO — external-data-to-Bluesky, not Bluesky-repo-in-circuit ([Stanford Blockchain Review](https://review.stanfordblockchain.xyz/p/74-cryptography-research-spotlight)). Verifying MSTs in SP1 would be new territory (novelty upside, no reference implementation to crib from).

## 4. Prior art: ZK over externally-signed / web data

- **zkEmail** — DKIM RSA-2048 + SHA-256 + regex over emails. Exists both as circom circuits and an official **SP1 port** ([zkemail/sp1-zkEmail](https://github.com/zkemail/sp1-zkEmail)); RISC Zero equivalent ([r0-zkEmail](https://github.com/risc0-labs/r0-zkEmail)). SP1 added the `U256XU2048_MUL` precompile essentially for this workload. Lesson: **zkVM + patched crates has replaced hand-rolled circuits for signed-data verification**; per-item proofs are seconds-scale ("~10s client-side, sub-second server-side" per [zk.email](https://zk.email/blog/zkemail)).
- **TLSNotary / zkTLS (Reclaim, zkPass, Opacity)** — prove TLS-session data via MPC/proxy notaries ([TLSNotary on public verifiability](https://tlsnotary.org/blog/2026/06/17/public-verifiability/), [Reclaim](https://blog.reclaimprotocol.org/posts/zk-in-zktls)). Lesson: they exist because the *server's* signature isn't verifiable offline. **Atproto data is self-authenticating (signed Merkle repos), so you don't need zkTLS at all** — a major architectural advantage of the atproto path. zkTLS also doesn't batch to 100k items; it's per-session.
- **OpenPassport → Self / zkPassport** — ECDSA P-256 + RSA passport chains in circom/Noir. Lesson: P-256 in ZK is production-grade, but they run **one proof per user client-side** and aggregate set membership on-chain (merkle registries) — i.e., push signature verification to the data owner, aggregate commitments centrally.
- **zkLogin (Sui)** — RSA JWT verification per login proof; same per-user pattern.
- **Semaphore / zk-creds** — don't verify external signatures in-circuit at all; they verify once at registration into a merkle set, then prove membership. This is the archetype for §7's "pre-verified committed set."

**Transferable patterns:** (1) verify-once-then-commit beats verify-every-time; (2) per-owner sub-proofs + aggregation is how everyone scales; (3) hash/sig precompiles are the deciding cost factor; (4) *completeness* (nothing omitted) is the part none of these solve for you — inclusion is easy, exhaustiveness needs a canonical committed set, which atproto's MST gives per-repo and nothing gives globally for free.

## 5. Recursion / aggregation in SP1 (2026)

Mechanism ([docs](https://docs.succinct.xyz/docs/sp1/writing-programs/proof-aggregation)): guest calls `sp1_zkvm::lib::verify::verify_sp1_proof(vk_digest, pv_digest)` (verified in `crates/zkvm/lib/src/verify.rs`: a thin `VERIFY_SP1_PROOF` syscall over the two digests); proofs must be **compressed** (constant-size STARKs) and are fed via the proof input stream, not stdin bytes. In-guest cycle cost is trivial (syscall + committing digests); the real cost is prover-side, where each deferred proof adds recursion-tree work (roughly one extra recursion node, seconds of GPU each). Docs' guidance, verbatim: *"Generally proving a single program is faster and more cost-effective than generating multiple proofs and aggregating them"* — aggregation is for >~120B cycles, >~2GB memory, multi-party proofs, or pipelining.

**Verdict for TrustGraph:**
- **N ≤ ~100k signatures: monolithic guest wins.** 23–45B cycles is inside single-proof territory; aggregation overhead (per-attester setup ~ fixed millions of cycles + recursion nodes + orchestration) would exceed the savings for a one-shot proof.
- **Aggregation becomes the right answer for *incremental epochs*:** one compressed sub-proof per attester repo (`vk_attester`, public values = `(did, signingKeyDigest, commitRev, edgesDigest)`), cached until the repo's `rev` changes; the root guest verifies A digests via `verify_sp1_proof` + runs PageRank over the union of `edgesDigest`-committed edge lists. Steady-state proving cost ∝ churned repos, not corpus. At A=1,000 sub-proofs the root aggregation is still modest (in-guest: thousands of cycles per proof; prover-side: est. ~1–3 GPU-seconds per deferred proof — **estimate, unpublished**; use a 32-ary aggregation tree if flat aggregation strains prover memory). This mirrors OP Succinct's production pattern (parallel range proofs → single hourly aggregate on-chain, [blog](https://blog.succinct.xyz/op-succinct/)).
- Bonus: sub-proofs can be produced permissionlessly by different parties (even attesters themselves via the network), matching TrustGraph's permissionless-prover ethos.

## 6. Input-size / memory limits

- **Guest memory:** ~2GB usable (32-bit address space; docs cite "~2GB memory limit" as the aggregation trigger). Default bump allocator never frees; the optional `embedded` allocator (v4.2.0+) frees memory but caps **total input reads at 1GB** ([advanced docs](https://docs.succinct.xyz/docs/sp1/generating-proofs/advanced)).
- **Stdin:** no hard documented byte cap below memory limits; network requests upload stdin as an artifact (private stdin supported since v6.2.1). N=100k EIP-712 records ≈ **20MB** — trivial. A 1k-attester atproto witness (repo subtrees) ≈ 30–60MB — fine. Deserializing with `sp1_zkvm::io::read_vec` + zero-copy parsing avoids doubling memory; `serde`-based `io::read()` (what the current guest uses) costs extra cycles and RAM at these sizes — switch to `read_vec` + manual decode for big witnesses.
- **Cycle ceilings:** SDK mainnet default cycle limit 10¹² (`MAINNET_DEFAULT_CYCLE_LIMIT`), default PGU limit 10⁹ (must be raised explicitly past ~1B PGUs); default network timeout 4h. 100k-signature runs (~40B PGU) need `.gas_limit(...)` bumped but are otherwise routine.

## 7. Alternative: keep signatures out of the guest

| Design | Marginal cost per attestation | Trust added | Notes |
|---|---|---|---|
| **Status quo:** on-chain EAS + keccak accumulator | ~100–200k L2 gas (~$0.001–0.01) | none | Guest just re-hashes the chain (~cheap). The thing you're trying to escape. |
| **Thin on-chain registrar:** off-chain EIP-712, contract runs `ecrecover` (3k gas) + folds hash into the accumulator | ~30–80k gas incl. calldata | none | ~2–5× cheaper than full EAS; guest unchanged. The "boring" middle option — worth pricing seriously. |
| **AVS/operator pre-verification** (WAVS/EigenLayer/Symbiotic-style quorum signs a batch root; guest consumes root) | ~0 per attestation | economic quorum honesty | Reintroduces exactly the operator trust TrustGraph removed when it dropped WAVS. |
| **TEE pre-verification** (incl. SP1's own TEE integration — the v6 SDK ships TEE endpoints for two-factor proving) | ~0 | TEE vendor | Good as *2FA* alongside ZK, weak as sole verifier. |
| **Optimistic:** post set-commitment + fraud window; ZK only for PageRank | ~0 | 1-of-N watcher liveness | Adds latency (challenge window) to every root update. |
| **Poseidon2 accumulator (new option):** any pre-verification layer commits the accepted set with Poseidon2; guest re-hashes via the new `POSEIDON2` syscall | ~0 in guest | whatever the pre-verifier is | The v6 `POSEIDON2` precompile makes in-guest set re-commitment nearly free vs keccak — relevant whichever layer does sig checking. **Flag:** recent syscall; confirm patched-crate/API maturity before depending on it. |

**Assessment:** given §2's numbers, outsourcing signature verification buys little at this scale — even 100k in-guest signatures cost tens of dollars per epoch, and 1k costs cents. The strongest reason to keep signatures **in-guest** is that it preserves TrustGraph's zero-added-trust story; the strongest hybrid is per-attester **sub-proofs** (§5), which are still ZK, still trustless, and make cost proportional to churn.

---

## Recommendation snapshot

1. **Phase 1 (1k scale):** monolithic guest, EAS-offchain EIP-712 records verified in-guest with patched `k256` + `tiny-keccak`. Completeness via a committed set (thin registrar accumulator or DA blob hash). Cost delta: negligible (<$1, minutes).
2. **Phase 2 (atproto):** per-attester guest verifying commit sig (k256+p256) + MST collection-subtree enumeration with patched `sha2` + `serde_ipld_dagcbor` (no_std); compressed sub-proofs cached per repo `rev`; root guest aggregates via `verify_sp1_proof` + PageRank. Decide the DID/PLC trust anchor explicitly — it's the weakest link, not the cryptography.
3. **Before freezing the doc:** run a 1-day empirical spike (toy guest + `execute()`) to replace the three softest numbers here: patched ecrecover cycles on v6.3.1, patched p256 verify cycles, and PGU multipliers; then one live network request to observe the actual clearing price per B-PGU.

**Key sources:** [SP1 releases](https://github.com/succinctlabs/sp1/releases) · [precompiles docs](https://docs.succinct.xyz/docs/sp1/optimizing-programs/precompiles) · [prover-gas docs](https://docs.succinct.xyz/docs/sp1/optimizing-programs/prover-gas) · [proof aggregation docs](https://docs.succinct.xyz/docs/sp1/writing-programs/proof-aggregation) · [advanced/allocator docs](https://docs.succinct.xyz/docs/sp1/generating-proofs/advanced) · [raiko cycle tracking #280](https://github.com/taikoxyz/raiko/issues/280) · [Hypercube 16-GPU real-time proving](https://blog.succinct.xyz/real-time-proving-16-gpus/) · [network + $PROVE](https://blog.succinct.xyz/network/introducing-the-succinct-network-architecture-and-the-prove-token/) · [PROVE price](https://www.coingecko.com/en/coins/succinct) · [sp1-zkEmail](https://github.com/zkemail/sp1-zkEmail) · [serde_ipld_dagcbor](https://docs.rs/serde_ipld_dagcbor) · [zkLabeler / zkTLS spotlight](https://review.stanfordblockchain.xyz/p/74-cryptography-research-spotlight) · [zk-X509 (unpatched P-256 baseline)](https://arxiv.org/abs/2603.25190) · [BLS precompiles blog](https://blog.succinct.xyz/succinctshipsprecompiles/) · [OP Succinct](https://blog.succinct.xyz/op-succinct/) · syscall list verified from `succinctlabs/sp1:crates/core/executor/src/syscall_code.rs`; SDK pricing constants from `crates/sdk/src/network/mod.rs`.
