# Set up the repository

Trustgraphs uses several toolchains because the repository includes Solidity contracts, Rust
scoring and proving code, a TypeScript frontend and indexer, and local infrastructure.
The source code is available in the
[Trustgraphs repository on GitHub](https://github.com/JakeHartnell/trustgraphs).

## Requirements

Install:

- Git;
- Docker with Compose, for IPFS and Postgres;
- [go-task](https://taskfile.dev/), the repository task runner;
- `jq`;
- Node.js 21 or newer and pnpm;
- Foundry, including Anvil;
- Rust 1.87 or newer; and
- SP1 6.3.1.

On Linux, install a compiler toolchain first:

```bash
sudo apt update
sudo apt install build-essential
```

Platform-specific installers are available from the projects above. Confirm that each command is
on your `PATH` before continuing:

```bash
git --version
docker --version
task --version
jq --version
node --version
pnpm --version
forge --version
anvil --version
cargo --version
```

## Clone the repository

```bash
git clone https://github.com/JakeHartnell/trustgraphs.git
cd trustgraphs
```

## Install SP1

SP1 builds and proves the guest programs:

```bash
curl -L https://sp1up.succinct.xyz | bash
~/.sp1/bin/sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"
cargo prove --version
```

Use the pinned version. The verification key identifies an exact guest binary, and changing the
build toolchain can change that binary even when the source revision is the same.

## Install project dependencies

From the repository root:

```bash
task setup
```

This installs pnpm and Foundry dependencies.

## Build the guest programs

```bash
task zk:build
```

The first build may take several minutes. Run it again after changing scoring code under
`crates/`, guest code under `zk/`, or the pinned SP1 toolchain. A changed guest produces a new
verification key.

## Verify the setup

```bash
task test
task e2e
```

`task e2e` runs the core path on a temporary Anvil chain without the full Docker service stack.
Continue with [Run trustgraphs locally](./quickstart.md) to start the frontend, indexer, storage,
and demo network.
