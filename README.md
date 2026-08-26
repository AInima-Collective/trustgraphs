# Trustgraphs

Turn a community's web of vouches into reputation scores that anyone can verify and fake
accounts can't inflate — no trusted operator, just a proof.

**Status: highly experimental.** Please experiment with us.

Every community already knows who it trusts. Trustgraphs makes that knowledge computable,
provable, and usable on-chain:

- **Vouch.** Members publicly vouch for each other ("I trust this account, this much"),
  recorded directly against [EAS](https://attest.org) (the Ethereum Attestation Service).
  Together the vouches form a graph — the trust graph the name comes from.
- **Score.** A **Trust-Aware PageRank** over that graph produces each account's score.
  Trust flows outward from a curated set of seed accounts, so a bot army vouching for
  itself is an island no trusted edge reaches: Sybil rings stay isolated from real
  influence.
- **Prove.** No server or operator committee computes the scores. Anyone can compute them
  and prove the computation correct with an **SP1 zero-knowledge proof**; the chain
  verifies the proof and commits the `{account → score}` merkle root.
- **Use.** Governance weight, reward distribution, and even a Safe multisig's owner set
  consume that proven root.

One property does most of the security work: **provers can't omit or invent attestations.**
The chain keeps a running commitment (an *accumulator*) over every attestation as it lands,
and a proof only verifies if it consumed exactly that input set. Whoever runs the prover,
you get the correct scores or no proof at all.

The same machinery generalizes past vouching: trustgraphs is a **platform of ZK-proven
graphs**. Each program proves a different graph computation (trust scores, Safe signer
selection, AT-Protocol reputation, contribution-funding splits) with the same discipline —
one canonical Rust core per program, compiled into the SP1 guest and cross-checked
byte-for-byte against Solidity and TypeScript ports.

New to all of this? Start with the plain-language
[`docs/learn/what-is-trustgraphs.md`](./docs/learn/what-is-trustgraphs.md); the
[`docs/`](./docs/README.md) tree runs shallow-to-deep from there. The algorithm itself is
specified in [`docs/concepts/algorithm.md`](./docs/concepts/algorithm.md), and the ZK
design in [`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md).

## Run it

Install the toolchains first — Docker, [go-task](https://taskfile.dev), `jq`, Node 21+ with pnpm,
[Foundry](https://getfoundry.sh), Rust, and SP1: [`docs/build/setup.md`](./docs/build/setup.md) walks through
each one. Then, once per checkout:

```bash
task setup         # pnpm install + forge install (Solidity deps resolve from node_modules/)
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

**The whole product — a funded network, a real graph, a live proof scheduler:**

```bash
anvil --block-time 1     # the demo refuses to own your chain, or your services
task start-all-local     # IPFS + the indexer's Postgres, from docker-compose.dev.yml
task demo:live           # deploy, seed, prove — then keep proving
```

One transaction creates a network and endows its proving tank; a daemon watches the chain, freezes
checkpoints on the contract's cadence, proves them, lands them, and collects the bounty. Once the
seeded roots are on chain, `demo:live` keeps that scheduler running in the foreground. Bring up the
app in two more terminals and watch it move:

```bash
pnpm indexer start     # the Ponder indexer, :65421
pnpm frontend dev      # the app, :3000
```

Open <http://localhost:3000>: the Demo Co-op, with real vouches and scored members. Vouch from the
app (or `bash taskfile/vouch.sh "Demo Co-op" 0 10 90 "hello"`) and the scheduler notices, proves the
next checkpoint, and lands the new root — nothing restarted. Two variations worth knowing:
`task demo` is the finite version (same deployment, exits once the seeded roots land), and the
funding payout for the seeded contribution round needs the indexer, so on a first run it skips
itself — `task demo:payout` completes it once the indexer is serving.
[`docs/build/quickstart.md`](./docs/build/quickstart.md) is the walkthrough: what each step does,
the security properties worth demonstrating, and every gotcha that has cost someone an afternoon.

> **Note on proving.** Running the guest in the SP1 *executor* (to validate correctness) works
> anywhere, and both paths above do exactly that: `SP1_PROVER=mock` runs the real guest and commits
> its real public values, with only the SNARK itself stubbed. Generating a real STARK→Groth16
> *proof* needs ≥16–32 GiB of RAM or the Succinct prover network (`SP1_PROVER=network`). The
> A local reproduction procedure is documented in
> [`docs/verify/reproduce-an-epoch.md`](./docs/verify/reproduce-an-epoch.md).

## Programs

[`docs/concepts/networks-and-programs.md`](./docs/concepts/networks-and-programs.md) explains the
program model and links to one public overview for each supported path:

| Program or extension | What it does | Docs |
|---|---|---|
| **trust-graph** | Produces address scores from an EAS vouch graph. | [Trust graph](./docs/build/trust-graph.md) |
| **trust-graph-weighted** | Adds a governance-controlled weighted starting allocation. | [Weighted prior](./docs/build/weighted-prior.md) |
| **trust-compose** | Combines complete proven score distributions. | [Score compositions](./docs/build/composition.md) |
| **signer-sync** | Aligns a Safe owner set with proven scores and activity. | [Signer sync](./docs/build/signer-sync.md) |
| **hypercerts** | Builds reputation from authenticated AT Protocol records. | [Hypercerts](./docs/build/hypercerts.md) |
| **nostr-workspace** | Builds scores from a member-scoped Nostr workspace. | [Nostr workspace](./docs/build/nostr-workspace.md) |
| **contributions** | Allocates funding using assessments weighted by proven reputation. | [Contributions](./docs/build/contributions.md) |

Generated inputs, proofs, score blobs, and witness archives are written under the gitignored
`.trustgraph/` directory.

## Repository map

| Path | What lives there |
|---|---|
| [`contracts/`](./contracts/) | Foundry codebase: production Solidity, contract tests, scripts, and TypeScript deployment helpers |
| [`crates/`](./crates/) | Root Cargo workspace: canonical Rust cores, shared encodings, and host-side tools |
| [`packages/`](./packages/) | pnpm workspaces: Next.js frontend, Ponder indexer, EAS offchain client, and relay |
| [`zk/`](./zk/) | Detached SP1 guest and host workspaces, including the prover and operator |
| [`tests/`](./tests/) | Cross-codebase end-to-end scripts, protocol fixtures, and golden vectors |
| `docs/` | product docs — `learn/` (plain-language intros), `concepts/` ([`networks-and-programs.md`](./docs/concepts/networks-and-programs.md) index, the algorithm), `build/` ([`setup.md`](./docs/build/setup.md), [`production.md`](./docs/build/production.md), per-program `architecture`/`runbook`/`local-testing`), `verify/` (epoch reproduction) |
| `research/` | design provenance — why the architecture is what it is (`ZK_ARCHITECTURE.md`, program plans, the [`DEVIATIONS.md`](./research/DEVIATIONS.md) log, `archive/` for superseded designs) |
| `paper/` | the governance research paper |

Cross-language parity is enforced per program with *golden vectors* — committed
input/output byte captures that lock the native Rust, SP1 guest, Solidity, and TypeScript
implementations to identical bytes (`task zk:parity PROGRAM=<name>`). Each program owns a
`tests/golden/<program>.json`, except signer-sync, which shares `trust-graph.json` (same
attestation feed; its vectors live under that file's `signer` key).

## Contributing

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the dev setup, the test matrix expected green
before a PR, and the copy-and-voice rules for anything a user reads. The short version:
`crates/` cores are the single source of truth for every byte, and an encoding change
without regenerated golden vectors in the same PR is a CI failure.

## License

[MIT](./LICENSE)

## Acknowledgements

Many people have worked on trust graphs over the years; the idea is part of a wider
scenius. We don't claim to be the first or to have any ownership over the term. We are
grateful to all who came before for the work they've done.

Special thanks to Gitcoin for sponsoring this work.
