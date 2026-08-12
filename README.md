# TrustGraph

Attestation-based governance, proven in zero knowledge.

**Status: highly experimental.** Please experiment with us.

TrustGraph turns webs of attestations ("I vouch for this person") into governance weight.
Participants attest to each other directly against [EAS](https://attest.org), and a
**Trust-Aware PageRank** over that graph produces each account's score. The algorithm is
seeded by a curated set of trusted accounts, so Sybil rings stay isolated from real
influence. New here: the scores are not computed by a server or an operator committee.
Anyone can compute them and prove the computation correct with an **SP1 zero-knowledge
proof**; the chain verifies the proof and commits the `{account → score}` merkle root.
Governance, reward distribution, and even a Safe multisig's owner set consume that proven
root.

One property does most of the security work: **provers can't omit or invent attestations.**
The chain keeps a running commitment (an *accumulator*) over every attestation as it lands,
and a proof only verifies if it consumed exactly that input set. The same machinery
generalizes past vouching: TrustGraph is a **platform of ZK-proven graphs**. Each program
proves a different graph computation (trust scores, Safe signer selection, AT-Protocol
reputation, contribution-funding splits) with the same discipline — one canonical Rust core
per program, compiled into the SP1 guest and cross-checked byte-for-byte against Solidity
and TypeScript ports.

New to all of this? Start with the plain-language [`docs/learn/what-is-trustgraphs.md`](./docs/learn/what-is-trustgraphs.md).
The algorithm itself is specified in [`docs/concepts/algorithm.md`](./docs/concepts/algorithm.md), and the
ZK design in [`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md).

## Run it

Install the toolchains first — Docker, [go-task](https://taskfile.dev), `jq`, Node 21+ with pnpm,
[Foundry](https://getfoundry.sh), Rust, and SP1: [`docs/build/setup.md`](./docs/build/setup.md) walks through
each one. Then, once per checkout:

```bash
task -y setup      # pnpm install + forge install (Solidity deps resolve from node_modules/)
task zk:build      # compile the SP1 guest programs — minutes the first time, cached after
```

Don't skip `task zk:build` — the guests are the one thing a plain checkout doesn't come with, and
almost nothing else builds them for you. The demo and the operator harnesses all run with
`SP1_SKIP_PROGRAM_BUILD=true`, so they never pay for a guest rebuild per tick and never produce one
either; on a checkout where the guests have never been built, that surfaces as a missing-file error
deep in a Rust build rather than a useful message. Build them once, then pick a path:

**Fastest — the loop end-to-end, no config and no services:**

```bash
task e2e           # printing E2E PASS
```

It spins up its own anvil, deploys EAS + the resolver, creates attestations, freezes a checkpoint,
and reconstructs the prover's input from chain with `input-exporter`. The exporter self-checks by
rehashing the reconstructed attestation list and requiring it to reproduce the chain's accumulator
commitment; then the SP1 guest is cross-checked against the native implementation. (This one *will*
build the guests itself if they're missing — it just takes minutes instead of seconds.)

**The whole product — a funded network, a real graph, the scheduler, the payout:**

```bash
anvil --block-time 1     # task demo refuses to own your chain, or your services
task start-all-local       # IPFS + the ponder database, from docker-compose.dev.yml
task demo
```

One transaction creates a network and endows its proving tank; a daemon watches the chain, freezes
checkpoints on the contract's cadence, proves them, lands them, and collects the bounty.
[`docs/build/quickstart.md`](./docs/build/quickstart.md) is the walkthrough: what each step does,
the security properties worth demonstrating, and every gotcha that has cost someone an afternoon.

> **Note on proving.** Running the guest in the SP1 *executor* (to validate correctness) works
> anywhere, and both paths above do exactly that: `SP1_PROVER=mock` runs the real guest and commits
> its real public values, with only the SNARK itself stubbed. Generating a real STARK→Groth16
> *proof* needs ≥16–32 GiB of RAM or the Succinct prover network (`SP1_PROVER=network`). The
> mainnet-fork rehearsal where the proof is real — deployed contracts, the canonical SP1 gateway,
> indexer and frontend showing the scores — is
> [`docs/build/trust-graph/local-testing.md`](./docs/build/trust-graph/local-testing.md).

## Programs

[`docs/concepts/networks-and-programs.md`](./docs/concepts/networks-and-programs.md) is the authoritative index — per program: its
status, its *vkey* (program verification key — the on-chain fingerprint of the exact prover
binary), and its deployed instances. Status snapshot:

| Program | What it proves | Status | Docs |
|---|---|---|---|
| **trust-graph** | the `{account → score}` root over the EAS vouch graph | **Built** | [architecture](./docs/build/trust-graph/architecture.md) · [runbook](./docs/build/trust-graph/runbook.md) · [local testing](./docs/build/trust-graph/local-testing.md) |
| **signer-sync** | the top-N-by-score Safe owner set + threshold | **Built** | [architecture](./docs/build/signer-sync/architecture.md) · [runbook](./docs/build/signer-sync/runbook.md) |
| **hypercerts** | reputation over anchored AT-Protocol (atproto) repos | **Built** | [architecture](./docs/build/hypercerts/architecture.md) · [runbook](./docs/build/hypercerts/runbook.md) · [local testing](./docs/build/hypercerts/local-testing.md) |
| **contributions** | a rep-weighted funding split over contribution claims | **Built** | [architecture](./docs/build/contributions/architecture.md) · [runbook](./docs/build/contributions/runbook.md) · [local testing](./docs/build/contributions/local-testing.md) |

Running one program by hand — `trigger()` a checkpoint, reconstruct the input from chain, prove,
pin the score blob, `submitProof` — is step by step in each program's runbook, linked above. All
generated artifacts (reconstructed inputs, proofs, score blobs, witness archives) land under the
gitignored `.trustgraph/` directory, one subdirectory per program.

## Repository map

| Path | What lives there |
|---|---|
| `src/contracts/` | Solidity: EAS resolvers + attestation accumulator, `MerkleSnapshot`, the SP1 journal verifier (a *journal* is a proof's public output record), governance/reward/Zodiac modules |
| `packages/` | Rust cores — `zk-core` (shared encodings), `pagerank-core` (canonical algorithm), `hypercerts-core`, `contributions-core`, `envelopes` (atproto verification), `input-exporter` |
| `zk/program` · `zk/prover` | the SP1 guest bins and the `trustgraph-prover` host CLI |
| `frontend/` · `indexer/` | Next.js app and Ponder indexer (with a browser port of the algorithm for client-side recompute) |
| `docs/` | product docs — `learn/` (plain-language intros), `concepts/` ([`networks-and-programs.md`](./docs/concepts/networks-and-programs.md) index, the algorithm), `build/` ([`setup.md`](./docs/build/setup.md), [`production.md`](./docs/build/production.md), per-program `architecture`/`runbook`/`local-testing`), `verify/` (epoch reproduction) |
| `research/` | design provenance — why the architecture is what it is (`ZK_ARCHITECTURE.md`, program plans, the [`DEVIATIONS.md`](./research/DEVIATIONS.md) log, `archive/` for superseded designs) |
| `test/` | Solidity suites, golden vectors (`test/golden/`), atproto fixtures (`test/fixtures/atproto/`), the `task e2e` script |
| `paper/` | the governance research paper |

Cross-language parity is enforced per program with *golden vectors* — committed
input/output byte captures that lock the native Rust, SP1 guest, Solidity, and TypeScript
implementations to identical bytes (`task zk:parity PROGRAM=<name>`). Each program owns a
`test/golden/<program>.json`, except signer-sync, which shares `trust-graph.json` (same
attestation feed; its vectors live under that file's `signer` key).

## License

[MIT](./LICENSE)

## Acknowledgements

Many people have worked on trustgraphs over the years, it's part of the scenius atm.

We don't claim to be the first or have any ownership over the term.

We are grateful to all who came before for the work they've done.
