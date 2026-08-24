#!/usr/bin/env sh
#
# Where each guest's ELFs actually land, one directory per line.
#
# This exists because the answer is NOT "<guest dir>/target". A cargo target directory belongs to
# the WORKSPACE, and `zk/nostr-program/program` is a member of the workspace rooted at
# `zk/nostr-program` — so its ELFs land in `zk/nostr-program/target`, one level up from where the
# obvious guess looks. Assuming otherwise silently drops two programs out of the reproducibility
# table and breaks the CI step that archives the ELFs.
#
# Derived with `cargo locate-project --workspace`, which is what cargo itself would answer, rather
# than restated as a list that can drift. No jq: this also runs inside the operator's Docker build.
#
#   sh scripts/guest-elf-dirs.sh
#
# Paths are relative to the repository root: `tar` wants them that way, and it keeps a digest
# table comparable between two machines whose checkouts live at different absolute paths.
#
# Prints the reproducible (`--docker`) directory when one exists and the plain one otherwise, so a
# caller always gets the ELFs that are actually there.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

GUESTS="zk/program zk/trustgraph-program-v2 zk/weighted-program zk/composition-program zk/nostr-program/program"
TARGET="riscv64im-succinct-zkvm-elf/release"

for dir in $GUESTS; do
  manifest=$(cargo locate-project --workspace --message-format plain \
               --manifest-path "$dir/Cargo.toml") \
    || { echo "cannot locate the workspace for $dir" >&2; exit 1; }
  workspace=$(dirname -- "$manifest")
  base="${workspace#"$ROOT"/}/target/elf-compilation"
  if [ -d "$base/docker/$TARGET" ]; then
    printf '%s\n' "$base/docker/$TARGET"
  else
    printf '%s\n' "$base/$TARGET"
  fi
done | sort -u
