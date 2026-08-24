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
#   sh scripts/guest-elf-dirs.sh            # one release directory per line
#   sh scripts/guest-elf-dirs.sh --files    # the ELF files inside them
#
# Paths are relative to the repository root: `tar` wants them that way, and it keeps a digest
# table comparable between two machines whose checkouts live at different absolute paths.
#
# Prints the reproducible (`--docker`) directory when one exists and the plain one otherwise, so a
# caller always gets the ELFs that are actually there.
#
# One caveat for `--files`, and it only bites locally: this lists what is ON DISK, not what the
# manifests declare. A working tree that has been rebuilt across a layout change can still hold an
# ELF for a binary that is no longer a target — `zk/program` held a `trustgraph-program` months
# after it stopped being one. A fresh checkout cannot, which is why the reproducibility gate
# compares two cold CI builds and not a developer's tree against a release asset.

set -eu

MODE=dirs
[ "${1:-}" = "--files" ] && MODE=files

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
done | sort -u | {
  if [ "$MODE" = dirs ]; then
    cat
    exit 0
  fi
  # The ELFs themselves, and nothing else in the directory: `deps/`, `.fingerprint/`,
  # `incremental/` and the `.d` dependency lists are build state, not artifacts. Tarring the
  # directories instead of the files is the difference between a 4.7 MB archive and an 800 MB one,
  # downloaded again by every job that needs the guests.
  while IFS= read -r release; do
    [ -d "$release" ] || { echo "no guest ELFs in $release" >&2; exit 1; }
    find "$release" -maxdepth 1 -type f ! -name '*.d' ! -name '.cargo-*' -print
  done | sort
}
