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
# Selects Docker artifacts by default. Local artifacts require TRUSTGRAPH_GUEST_BUILD=local;
# missing release artifacts never silently fall back to another toolchain's output.
#
set -eu

MODE=dirs
[ "${1:-}" = "--files" ] && MODE=files

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"

GUESTS="zk/program zk/trust-graph-program zk/weighted-program zk/composition-program zk/nostr-program/program"
TARGET="riscv64im-succinct-zkvm-elf/release"
case "${TRUSTGRAPH_GUEST_BUILD:-docker}" in
  docker) BUILD_PREFIX=docker/ ;;
  local) BUILD_PREFIX= ;;
  *) echo "TRUSTGRAPH_GUEST_BUILD must be docker or local" >&2; exit 1 ;;
esac
if [ "${TRUSTGRAPHS_RELEASE_BUILD:-0}" = 1 ] && [ -z "$BUILD_PREFIX" ]; then
  echo "Release builds require Docker guest artifacts" >&2; exit 1
fi

# Accumulate before printing so no error can be hidden by a downstream pipe's exit status.
listing=$(mktemp)
trap 'rm -f "$listing"' EXIT HUP INT TERM
for dir in $GUESTS; do
  manifest=$(cargo locate-project --workspace --message-format plain \
               --manifest-path "$dir/Cargo.toml") \
    || { echo "cannot locate the workspace for $dir" >&2; exit 1; }
  workspace=$(dirname -- "$manifest")
  base="${workspace#"$ROOT"/}/target/elf-compilation"
  release="$base/$BUILD_PREFIX$TARGET"
  if [ "$MODE" = dirs ]; then
    printf '%s\n' "$release" >> "$listing"
    continue
  fi
  # All guests declare explicit [[bin]] targets. Enumerate those names rather than stale files
  # left by a renamed/removed target. Missing or empty targets are fatal, including the last one.
  names=$(awk '
    /^\[\[bin\]\]/ { bin = 1; next }
    /^\[/ { bin = 0 }
    bin && /^name *= *"/ { sub(/^name *= *"/, ""); sub(/".*/, ""); print }
  ' "$dir/Cargo.toml")
  [ -n "$names" ] || { echo "no explicit guest binaries in $dir/Cargo.toml" >&2; exit 1; }
  for name in $names; do
    elf="$release/$name"
    [ -s "$elf" ] || { echo "missing or empty guest ELF: $elf" >&2; exit 1; }
    magic=$(od -An -tx1 -N4 "$elf" | tr -d ' \n')
    [ "$magic" = 7f454c46 ] || { echo "not an ELF: $elf" >&2; exit 1; }
    printf '%s\n' "$elf" >> "$listing"
  done
done
sort -u "$listing"
