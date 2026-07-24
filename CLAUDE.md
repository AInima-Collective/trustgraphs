# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

Use `task --list-all` to see all available commands.

### Build Commands
- `task build:forge` - Build Solidity contracts
- `cargo build -p pagerank-core` - Build the canonical PageRank/encoding crate

### Test Commands
- `task test` - Run all Solidity tests
- `forge test -vvv` - Run tests with verbose output (use forge directly for flags)
- `cargo test -p pagerank-core` - Run the PageRank core + golden-vector tests

### Development Environment
- `task start-all-local` - Start anvil, IPFS, and the ponder database
- `pnpm deploy:contracts` - Deploy the contracts via Foundry
- `task setup` - Install initial dependencies (pnpm + forge)

### Lint and Format Commands
- `task fmt` - Format Solidity and Rust code

## Architecture Overview

TrustGraph implements attestation-based governance using EAS (Ethereum Attestation Service) and Trust-Aware PageRank. Trust attestations between accounts calculate governance weights and distribute rewards.

> **Root producer: ZK (not WAVS).** The `{account → score}` merkle root is produced by a permissionless
> **SP1 zero-knowledge proof** of correct fixed-point PageRank, not a WAVS operator quorum. See
> [`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md) for the design and
> [`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md) for build/deploy/run. The canonical algorithm + encodings live in `packages/pagerank-core` (compiled to
> the SP1 guest in `zk/program`, the host in `zk/prover`, and ported to the browser in
> `frontend/lib/pagerank`). **WAVS has been fully removed** — attestations are created directly against
> EAS and indexing is done by Ponder reading contract events directly. The Safe signer-sync capability
> was reimplemented as a ZK proof (`SignerSyncZkModule` + a signer guest in `zk/program`); see
> [`research/SIGNER_SYNC_ZK_PLAN.md`](./research/SIGNER_SYNC_ZK_PLAN.md). TrustGraph is a **multi-program
> platform**: [`docs/PROGRAMS.md`](./docs/PROGRAMS.md) indexes each SP1 program (trust-graph,
> signer-sync, hypercerts); shared byte encodings live in `packages/zk-core`, which `pagerank-core`
> re-exports.

The system consists of:

### Core Components Structure
- **Solidity Contracts** (`src/contracts/`): On-chain logic including attestation resolvers, governance, rewards, and the merkle snapshot
- **PageRank core** (`packages/pagerank-core/`): The canonical fixed-point Trust-Aware PageRank + all byte encodings, the single source of truth for the ZK guest, host, and frontend
- **ZK root producer** (`zk/`): The SP1 guest (`zk/program`) and host CLI (`zk/prover`) that prove the merkle root
- **Deployment Scripts** (`script/`): Foundry scripts for contract deployment
- **Frontend** (`frontend/`): Next.js application for interacting with the system
- **Indexer** (`indexer/`): Ponder indexer that reads each contract's events directly (EAS, MerkleSnapshot, gov, fund, Safe)

### Key Architectural Elements

#### Root producer: ZK

The `{account → score}` merkle root is produced off-chain by proving correct fixed-point PageRank in
the SP1 zkVM and committed on-chain via `MerkleSnapshot.submitProof`, verified by
`SP1JournalVerifier`. The canonical algorithm + encodings live in `packages/pagerank-core`
(compiled to the SP1 guest in `zk/program`, the host in `zk/prover`, and ported to the browser in
`frontend/lib/pagerank`). Input completeness is proven against an on-chain `AttestationAccumulator`
(a chained-hash mixin folded into `EASIndexerResolver`). See
[`research/ZK_ARCHITECTURE.md`](./research/ZK_ARCHITECTURE.md) and
[`docs/trust-graph/RUNBOOK.md`](./docs/trust-graph/RUNBOOK.md).

> **WAVS has been fully removed.** The former WAVS root producer (`trust-graph` / `merkler-pruner`),
> the non-producer WASI components (`eas-attest`, `aggregator`, `wavs-indexer`, `safe-signer-sync`),
> the operator/aggregator infrastructure, and the service-manager contracts are all gone. Attestations
> are created directly against EAS; indexing is done by Ponder reading contract events directly. The
> Safe signer-sync capability was reimplemented as a ZK proof — see
> [`research/SIGNER_SYNC_ZK_PLAN.md`](./research/SIGNER_SYNC_ZK_PLAN.md).

#### Attestation & governance flow
1. Users create/revoke EAS attestations directly against the EAS contract.
2. `EASIndexerResolver` (an EAS `SchemaResolver`) emits index events and folds each edge into the
   `AttestationAccumulator`.
3. The ZK host proves PageRank over a checkpointed input set and submits the root via
   `MerkleSnapshot.submitProof`.
4. Governance (`MerkleGovModule` on a Safe) and rewards (`MerkleFundDistributor`) consume the proven
   root via merkle proofs.

## Important Configuration

### Environment Variables
- Copy `.env.example` to `.env` before development
- `DEPLOY_ENV`: Set to DEV or PROD
- `RPC_URL`: RPC URL for the chain
- `FUNDED_KEY`: Private key with funds for contract deployment
- `PARAMS_HASH`, `SP1_PROGRAM_VKEY`, `SP1_VERIFIER_GATEWAY`: ZK deployment parameters (see `deploy/env.ts`)

### Rust / PageRank core rules
- `packages/pagerank-core` is the single source of truth for the algorithm and every byte encoding;
  the SP1 guest, host, Solidity golden tests, and frontend TS port must all agree byte-for-byte
- No floats and no non-deterministic iteration (use `BTreeMap`, not `HashMap`) — the guest must be
  reproducible
- When changing an encoding, update the golden vectors (`test/golden/trust-graph.json`, read by
  `test/unit/golden/TrustGraphGoldenVectors.t.sol` + `SignerGoldenVectors.t.sol`, and the frontend
  `golden.test.ts`) so cross-language parity stays enforced. Each program owns its own vector file; see
  [`docs/PROGRAMS.md`](./docs/PROGRAMS.md)
