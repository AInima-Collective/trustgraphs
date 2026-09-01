#!/usr/bin/env sh
#
# Build every SP1 guest ELF, reproducibly.
#
# The `--docker` flag is the whole point. Succinct's documentation says the plain path "may not
# generate a reproducible ELF which is necessary for verifying that your binary corresponds to
# given source code", and this repository has already measured that in its own words: a toolchain
# reinstall was observed to shift vkeys with zero source change. Since `SP1JournalVerifier` pins a
# vkey at construction and the factory pins the verifier, a vkey from a build nobody else can
# reproduce is a mistake that costs a new verifier AND a new factory to undo.
#
#   sh scripts/build-guests.sh                    # reproducible, needs Docker
#   TRUSTGRAPH_GUEST_BUILD=local sh scripts/build-guests.sh
#
# The escape hatch exists for a machine with no Docker. What it produces is a working guest and an
# UNTRUSTWORTHY vkey: fine for running tests, never for deriving a value that gets pinned on chain.

set -eu

# Run from the repository root whatever directory this was invoked from — the guest paths below
# are relative to it, and so is the bind mount.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

# Pinned deliberately and separately from the sp1-build crate version, so a dependency bump cannot
# silently change every vkey in the system. Moving it is a decision, and it is one that changes
# every deployed verifier.
SP1_DOCKER_TAG="${SP1_DOCKER_TAG:-v6.3.1}"

GUESTS="zk/program zk/trust-graph-program zk/weighted-program zk/composition-program"
LOCKED_GUESTS="zk/nostr-program/program"

command -v cargo-prove >/dev/null 2>&1 || {
  echo "✗ cargo-prove not found. The guests build with the SP1 \`succinct\` toolchain:" >&2
  echo "    curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version $SP1_DOCKER_TAG" >&2
  echo "    export PATH=\"\$HOME/.sp1/bin:\$PATH\"" >&2
  exit 1
}

DOCKER=no
if [ "${TRUSTGRAPH_GUEST_BUILD:-docker}" = "local" ]; then
  echo "⚠ building guests WITHOUT --docker. The resulting vkeys are a property of this machine" >&2
  echo "  as much as of the source, and must not be pinned into a verifier." >&2
else
  docker info >/dev/null 2>&1 || {
    echo "✗ Docker is not available, and reproducible guest builds run inside" >&2
    echo "  ghcr.io/succinctlabs/sp1:$SP1_DOCKER_TAG." >&2
    echo "  Start Docker, or set TRUSTGRAPH_GUEST_BUILD=local for a build whose vkeys are" >&2
    echo "  usable for tests and unusable for a deployment." >&2
    exit 1
  }
  # `--workspace-directory` is not optional here, whatever the flag's name suggests. sp1-build
  # bind-mounts a program's OWN cargo workspace and warns that "if the program dir has local
  # dependencies outside of the workspace, building with Docker will fail" — and every guest is
  # its own detached workspace whose path dependencies reach up into `crates/`. Without this, the
  # container sees only `zk/program` and `../../crates/contributions-core` resolves to
  # `/crates/contributions-core`, which is not there. That is exactly how the v0.0.1 release
  # failed.
  DOCKER=yes
  echo "→ building guests in ghcr.io/succinctlabs/sp1:$SP1_DOCKER_TAG (slower, and the same on every machine)"
  echo "  mounting $ROOT, because the guests depend on crates outside their own workspaces"
fi

# Every argument quoted, because $ROOT is a path someone else chose.
build_one() { # build_one <guest dir> [extra cargo prove args…]
  dir=$1
  shift
  echo "  $dir"
  if [ "$DOCKER" = yes ]; then
    ( cd "$dir" && cargo prove build "$@" \
        --docker --tag "$SP1_DOCKER_TAG" --workspace-directory "$ROOT" )
  else
    ( cd "$dir" && cargo prove build "$@" )
  fi
}

for dir in $GUESTS; do
  build_one "$dir"
done
for dir in $LOCKED_GUESTS; do
  build_one "$dir" --locked
done

# STALE-ELF DEFENCE: `sp1_build` does not watch path dependencies, so after an edit under crates/
# cargo will happily reuse an ELF that predates the change. Touching the host's build script is
# what forces it to pick up what was just built.
touch zk/prover/build.rs

echo "✓ guests built"
