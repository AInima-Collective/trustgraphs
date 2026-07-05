# TrustGraph

Some next-gen attestation-based governance tools.

**Status:** HIGHLY EXPERIMENTAL! Please experiment with us.

Governance weights come from **Trust-Aware PageRank** over [EAS](https://attest.org) attestations. The
`{account → score}` merkle root is produced by a permissionless **SP1 zero-knowledge proof** of the
computation (no operator quorum) and committed on-chain via `MerkleSnapshot.submitProof`. See
[`ZK_ARCHITECTURE.md`](./ZK_ARCHITECTURE.md) and [`zk/RUNBOOK.md`](./zk/RUNBOOK.md).

## Usage

### 1. System setup

Follow the instructions in [README_SETUP.md](./README_SETUP.md) to ensure your system is setup with the necessary tools and dependencies.

Then install dependencies:

```bash
# Install packages (nodejs & submodules)
task -y setup
```

### 2. Solidity

This project utilizes both [submodules](./.gitmodules) and [node packages](./package.json) for Solidity dependencies.

```bash
# Build the contracts (`forge build` also works)
task build:forge

# Run the solidity tests
task test
```

### 3. PageRank core + ZK

The canonical Trust-Aware PageRank and every on-chain byte encoding live in `packages/pagerank-core`
(the single source of truth for the SP1 guest, the host, and the frontend port).

```bash
# Build and test the core crate (includes cross-language golden vectors)
cargo test -p pagerank-core
```

Generating a real proof (SP1 STARK → Groth16) requires ≥16–32 GiB of RAM or the Succinct prover
network — see [`zk/RUNBOOK.md`](./zk/RUNBOOK.md) for the guest/host build and proving commands.

### 4. Start backend services

> [!NOTE]
> This must remain running in your terminal. Use new terminals to run other commands. You can stop the services with `ctrl+c`. Some terminals require pressing it twice.

```bash docci-background docci-delay-after=5
# Create a .env file from the example
cp .env.example .env

# Start Anvil, IPFS, and WARG registry.
task -y start-all-local
```

### 5. Deploy contracts

This deploys the full contract set (EAS, resolvers, `MerkleSnapshot` + the SP1 verifier and accumulator,
the Zodiac `MerkleGovModule` Safe, timelocks, and the reward distributor):

```bash
pnpm deploy:full
```

### 6. Start frontend

**In a new terminal**, start the frontend:

```bash
pnpm frontend dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 7. Start indexer

**In another new terminal**, start the [Ponder.sh](https://ponder.sh) indexer:

```bash
pnpm indexer dev
```

### 8. Deploy Test Network of Attestations

Create a comprehensive test network with real attestations:

```bash
# Create 40+ real attestations across different network patterns
# Set TEST_ADDRESS to your wallet address (or use the one from the config)
TEST_ADDRESS=$(task config:wallet-address) task trustgraph:full-setup
```

This creates a realistic attestation network with:

- **Alice** (Central Hub) - 11 incoming connections
- **Diana** (Authority) - 565 total vouching weight
- **Charlie** (Bridge) - 7+ cross-group connections
- Multiple patterns: chains, clusters, mutual relationships

Perfect for testing PageRank-based reward algorithms!

### 9. Explore other functionality

```bash
task forge:update-rewards

task forge:query-rewards

task forge:claim-rewards

task forge:query-rewards-balance
```
