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

# Pinned deliberately and separately from the sp1-build crate version, so a dependency bump cannot
# silently change every vkey in the system. Moving it is a decision, and it is one that changes
# every deployed verifier.
SP1_DOCKER_TAG="${SP1_DOCKER_TAG:-v6.3.1}"

GUESTS="zk/program zk/trustgraph-program-v2 zk/weighted-program zk/composition-program"
LOCKED_GUESTS="zk/nostr-program/program"

command -v cargo-prove >/dev/null 2>&1 || {
  echo "✗ cargo-prove not found. The guests build with the SP1 \`succinct\` toolchain:" >&2
  echo "    curl -L https://sp1up.succinct.xyz | bash && ~/.sp1/bin/sp1up --version $SP1_DOCKER_TAG" >&2
  echo "    export PATH=\"\$HOME/.sp1/bin:\$PATH\"" >&2
  exit 1
}

if [ "${TRUSTGRAPH_GUEST_BUILD:-docker}" = "local" ]; then
  echo "⚠ building guests WITHOUT --docker. The resulting vkeys are a property of this machine" >&2
  echo "  as much as of the source, and must not be pinned into a verifier." >&2
  MODE=""
else
  docker info >/dev/null 2>&1 || {
    echo "✗ Docker is not available, and reproducible guest builds run inside" >&2
    echo "  ghcr.io/succinctlabs/sp1:$SP1_DOCKER_TAG." >&2
    echo "  Start Docker, or set TRUSTGRAPH_GUEST_BUILD=local for a build whose vkeys are" >&2
    echo "  usable for tests and unusable for a deployment." >&2
    exit 1
  }
  MODE="--docker --tag $SP1_DOCKER_TAG"
  echo "→ building guests in ghcr.io/succinctlabs/sp1:$SP1_DOCKER_TAG (slower, and the same on every machine)"
fi

for dir in $GUESTS; do
  echo "  $dir"
  # shellcheck disable=SC2086
  ( cd "$dir" && cargo prove build $MODE )
done
for dir in $LOCKED_GUESTS; do
  echo "  $dir"
  # shellcheck disable=SC2086
  ( cd "$dir" && cargo prove build --locked $MODE )
done

# STALE-ELF DEFENCE: `sp1_build` does not watch path dependencies, so after an edit under crates/
# cargo will happily reuse an ELF that predates the change. Touching the host's build script is
# what forces it to pick up what was just built.
touch zk/prover/build.rs

echo "✓ guests built"
