# System Requirements

Everything the stack needs, and what each piece is for: **Docker** (IPFS + Postgres for the
indexer in the full local stack — not needed for `task e2e`), **go-task** (the task runner
gluing the toolchains together), **jq** (deploy scripts), **Node 21+/pnpm** (frontend,
indexer, deploy scripts, Solidity deps via node_modules), **Foundry** (contracts + anvil),
**Rust** (the prover/core crates), and **SP1** (the zkVM toolchain).

## Linux

If on Linux (e.g. Ubuntu), install the essentials:

```bash
sudo apt update && sudo apt install build-essential
```

## Docker

- **MacOS**: `brew install --cask docker`
- **Linux**: `sudo apt -y install docker.io`
- **Windows WSL**: [docker desktop wsl](https://docs.docker.com/desktop/wsl/#turn-on-docker-desktop-wsl-2) & `sudo chmod 666 /var/run/docker.sock`
- [Docker Documentation](https://docs.docker.com/get-started/get-docker/)
- If `apt` reports a conflict with a preinstalled `containerd.io`, remove it first:
  `sudo apt remove containerd.io`

> **Note:** `sudo` is only used for Docker-related commands in this project. If you prefer not to use sudo with Docker, you can add your user to the Docker group with:
>
> ```bash
> sudo groupadd docker && sudo usermod -aG docker $USER
> ```
>
> After adding yourself to the group, log out and back in for changes to take effect.

> [!NOTE]
> If you are running on a Mac with an ARM chip, you will need to do the following:
>
> - Set up Rosetta: `softwareupdate --install-rosetta`
> - Enable Rosetta (Docker Desktop: Settings -> General -> enable "Use Rosetta for x86_64/amd64 emulation on Apple Silicon")
>
> Configure one of the following networking:
>
> - Docker Desktop: Settings -> Resources -> Network -> 'Enable Host Networking'
> - `brew install chipmk/tap/docker-mac-net-connect && sudo brew services start chipmk/tap/docker-mac-net-connect`

## Docker Compose

- **MacOS**: Already installed with Docker installer
  > `sudo apt remove docker-compose-plugin` may be required if you get a `dpkg` error
- **Linux + Windows WSL**: `sudo apt-get install docker-compose-v2`
- [Compose Documentation](https://docs.docker.com/compose/)

## Task (Taskfile)

- **MacOS**: `brew install go-task`
- **Linux + Windows WSL**: `npm install -g @go-task/cli`
- [Task Documentation](https://taskfile.dev/)

## JQ

- **MacOS**: `brew install jq`
- **Linux + Windows WSL**: `sudo apt -y install jq`
- [JQ Documentation](https://jqlang.org/download/)

## Node.js

- **Required Version**: v21+
- [Installation via NVM](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts
```

## pnpm

Install the latest version of pnpm: https://pnpm.io/installation

## Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash && $HOME/.foundry/bin/foundryup
```

## Rust v1.87+

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

rustup toolchain install stable
```

## SP1 (zkVM toolchain)

Required to build the ZK guest programs and run the prover. `sp1up` installs `cargo-prove` and
the `succinct` Rust toolchain (the RISC-V target the guests compile to). See the
[SP1 installation docs](https://docs.succinct.xyz/docs/sp1/getting-started/install):

```bash
curl -L https://sp1up.succinct.xyz | bash
~/.sp1/bin/sp1up --version v6.3.1
export PATH="$HOME/.sp1/bin:$PATH"      # put this in your shell profile
```

**Pin the version.** `zk/prover/Cargo.toml` pins the SP1 SDK to `=6.3.1`, and a bare `sp1up`
installs whatever is newest. Beyond the SDK/toolchain mismatch that invites, a vkey is a
fingerprint of the exact guest binary, so a different toolchain build produces different vkeys
from identical source — measured on this repo, twice. That is fine for local work and fatal for a
deploy, because `SP1JournalVerifier` pins its vkey immutably at construction. See the
reproducibility caveat in
[`networks-and-programs.md`](../concepts/networks-and-programs.md).

Budget several minutes: the `succinct` toolchain unpacks to over a gigabyte under `~/.sp1`.
`cargo prove --version` answering means it's done.

---

## Build the ZK guest programs

**One command, once per checkout, and nothing else does it for you:**

```bash
task setup         # pnpm install + forge install
task zk:build      # compile all SP1 guest ELFs + the prover host
```

Give the guest build a few minutes the first time; afterwards it's cached and incremental.

Why it's a separate step rather than something a `cargo build` picks up: `zk/prover/build.rs`
calls `sp1_build::build_program("../program")`, which *would* build the guests on any host
build — but the paths that invoke the prover repeatedly (`task demo` and its subtasks,
`tests/e2e/operator.sh`, `tests/e2e/fork.sh`) export `SP1_SKIP_PROGRAM_BUILD=true` so they aren't
paying for a guest rebuild on every tick. On a checkout where the guests have never been built,
that skip turns into a missing-file error from `include_elf!` naming a path under a
`zk/*/target/` directory — which reads like a broken repo and actually means "run `task zk:build`".
(`task e2e` is the exception: it leaves the flag unset and will build the guests itself, slowly.)

Two consequences worth knowing:

- **After editing anything under `crates/`, rebuild the guests.** `sp1_build` does not watch
  path dependencies, so cargo will reuse a stale ELF and you will debug a change that isn't in
  the binary. `task zk:build` handles this (it touches `zk/prover/build.rs` between the two
  steps). For a manual build, run each `cargo prove build` command listed in
  [`taskfile/zk.yml`](../../taskfile/zk.yml), then touch `zk/prover/build.rs`.
- **Rebuilding changes the vkeys**, whenever the ELF changes at all — including refactors with
  identical semantics. `task demo:vkeys` prints what your checkout currently produces, and
  `task demo:deploy` derives them fresh rather than trusting `.env`, precisely because a stale
  pinned vkey gives a stack that deploys cleanly and then refuses every proof.

## Verify the setup

```bash
task test          # Solidity suites, incl. the cross-language golden vectors
task e2e           # the whole loop on a throwaway anvil — no services, no Docker
```

`task e2e` printing `E2E PASS` means the toolchain, the contracts, the exporter and the guest are
all working together. From there, [`quickstart.md`](./quickstart.md) is the full
product demo.
