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

Want to see it run? [`DEMO.md`](./DEMO.md) is the local walkthrough: deploy the stack, create a
funded network in one transaction, and watch the proof scheduler keep its scores fresh with nobody
in the loop.

New to all of this? Start with the plain-language [`docs/ELI5.md`](./docs/ELI5.md).
The algorithm itself is specified in [`docs/ALGORITHM.md`](./docs/ALGORITHM.md), and the
ZK design in [`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md).

## Programs

[`docs/PROGRAMS.md`](./docs/PROGRAMS.md) is the authoritative index — per program: its
status, its *vkey* (program verification key — the on-chain fingerprint of the exact prover
binary), and its deployed instances. Status snapshot:

| Program | What it proves | Status | Docs |
|---|---|---|---|
| **trust-graph** | the `{account → score}` root over the EAS vouch graph | **Built** (a legacy v1 instance runs on Optimism, frozen — see [PROGRAMS.md](./docs/PROGRAMS.md)) | [architecture](./docs/trust-graph/ARCHITECTURE.md) · [runbook](./docs/trust-graph/RUNBOOK.md) · [local testing](./docs/trust-graph/LOCAL_TESTING.md) |
| **signer-sync** | the top-N-by-score Safe owner set + threshold | **Built** | [architecture](./docs/signer-sync/ARCHITECTURE.md) · [runbook](./docs/signer-sync/RUNBOOK.md) |
| **hypercerts** | reputation over anchored AT-Protocol (atproto) repos | **Built** | [architecture](./docs/hypercerts/ARCHITECTURE.md) · [runbook](./docs/hypercerts/RUNBOOK.md) · [local testing](./docs/hypercerts/LOCAL_TESTING.md) |
| **contributions** | a rep-weighted funding split over contribution claims | **Built** | [architecture](./docs/contributions/ARCHITECTURE.md) · [runbook](./docs/contributions/RUNBOOK.md) · [local testing](./docs/contributions/LOCAL_TESTING.md) |

## Try it in 30 seconds

See the whole trust-graph loop run end-to-end on a throwaway local chain — no config, no
running node:

```bash
task e2e
```

It spins up its own anvil, deploys EAS + the resolver, creates attestations, freezes a
checkpoint, and reconstructs the prover's input from chain with `input-exporter`. The
exporter self-checks by rehashing the reconstructed attestation list and requiring it to
reproduce the chain's accumulator commitment; then the SP1 guest is cross-checked against
the native implementation — printing `E2E PASS`.

Needs [Foundry](https://getfoundry.sh) (`anvil`/`forge`/`cast`), Rust (`cargo`), `jq`,
Node 21+ with pnpm, [go-task](https://taskfile.dev), and the SP1 toolchain — install
walkthrough in [`docs/SETUP.md`](./docs/SETUP.md). Run `task -y setup` first (the Solidity
dependencies resolve from `node_modules/`). No Docker needed for this one — the full-stack
flow below uses it for IPFS and Postgres. The first run builds the guest ELF, so give it a
few minutes; after that it's seconds.

> **Note on proving.** Running the guest in the SP1 *executor* (to validate correctness)
> works anywhere. Generating a real STARK→Groth16 *proof* needs ≥16–32 GiB of RAM or the
> Succinct prover network (`SP1_PROVER=network`). For a local dev loop, validate with
> `execute` and use the network for the final `prove` if you lack the hardware.

## Quickstart: a full local round

The complete walkthrough — mainnet-fork anvil, deployed contracts, real proof, indexer and
frontend showing the scores — is [`docs/trust-graph/LOCAL_TESTING.md`](./docs/trust-graph/LOCAL_TESTING.md).
The short version:

```bash
task -y setup             # pnpm install + forge install
task build:forge          # build the contracts
task test                 # Solidity tests incl. cross-language golden vectors

cp .env.example .env
task -y start-all-local   # anvil + IPFS + the ponder database (keep running)
pnpm deploy:full          # EAS + resolver/accumulator, MerkleSnapshot + SP1 verifiers,
                          # timelocks, distributor, Zodiac Safe + modules

pnpm frontend dev         # http://localhost:3000
pnpm indexer dev          # Ponder, indexing contract events directly

# seed a demo attestation network (40+ vouches):
TEST_ADDRESS=$(task config:wallet-address) task trustgraph:full-setup
```

From there, the **permissionless proving loop** — `trigger()` a checkpoint, reconstruct the
input from chain, prove, pin the score blob, `submitProof` — is step-by-step in the
[trust-graph runbook](./docs/trust-graph/RUNBOOK.md) (and the local-testing guide's
"Produce data the UI shows" section).
The signer-sync rotation loop is in the [signer-sync runbook](./docs/signer-sync/RUNBOOK.md).
A full contribution-funding round (claims → ratings → proven payout split, wei-exact) is in
[`docs/contributions/LOCAL_TESTING.md`](./docs/contributions/LOCAL_TESTING.md).

All generated artifacts (reconstructed inputs, proofs, score blobs, witness archives) land
under the gitignored `.trustgraph/` directory, one subdirectory per program.

## Repository map

| Path | What lives there |
|---|---|
| `src/contracts/` | Solidity: EAS resolvers + attestation accumulator, `MerkleSnapshot`, the SP1 journal verifier (a *journal* is a proof's public output record), governance/reward/Zodiac modules |
| `packages/` | Rust cores — `zk-core` (shared encodings), `pagerank-core` (canonical algorithm), `hypercerts-core`, `contributions-core`, `envelopes` (atproto verification), `input-exporter` |
| `zk/program` · `zk/prover` | the SP1 guest bins and the `trustgraph-prover` host CLI |
| `frontend/` · `indexer/` | Next.js app and Ponder indexer (with a browser port of the algorithm for client-side recompute) |
| `docs/` | operator docs: [`PROGRAMS.md`](./docs/PROGRAMS.md) index, per-program `ARCHITECTURE`/`RUNBOOK`/`LOCAL_TESTING`, [`SETUP.md`](./docs/SETUP.md), [`PRODUCTION.md`](./docs/PRODUCTION.md), [`DEVIATIONS.md`](./docs/DEVIATIONS.md) |
| `research/` | design provenance — why the architecture is what it is (`ZK_ARCHITECTURE.md`, program plans, `archive/` for superseded designs) |
| `test/` | Solidity suites, golden vectors (`test/golden/`), atproto fixtures (`test/fixtures/atproto/`), the `task e2e` script |
| `paper/` | the governance research paper |

Cross-language parity is enforced per program with *golden vectors* — committed
input/output byte captures that lock the native Rust, SP1 guest, Solidity, and TypeScript
implementations to identical bytes (`task zk:parity PROGRAM=<name>`). Each program owns a
`test/golden/<program>.json`, except signer-sync, which shares `trust-graph.json` (same
attestation feed; its vectors live under that file's `signer` key).

## License

[MIT](./LICENSE)
