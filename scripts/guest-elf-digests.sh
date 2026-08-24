#!/usr/bin/env sh
#
# The sha256 of every built SP1 guest ELF, one per line, in a stable order.
#
# This is the machine-comparable half of the reproducibility claim: two machines that built the
# same commit must print byte-identical output. The vkey half needs the prover host and lives in
# `trustgraph-prover manifest`; this one needs nothing but the files, so it also runs inside the
# operator's Docker build where no prover exists.
#
#   sh scripts/guest-elf-digests.sh            # from the repo root
#
# Exits non-zero when no guest has been built, because an empty table that looks like a pass is
# the one failure mode a digest comparison must not have.

set -eu

DIRS="zk/program zk/trustgraph-program-v2 zk/weighted-program zk/composition-program zk/nostr-program/program"
TARGET="riscv64im-succinct-zkvm-elf/release"

found=""
for dir in $DIRS; do
  # `cargo prove build --docker` and the plain path land in DIFFERENT directories. Prefer the
  # reproducible one; fall back to the plain one so a developer still gets a table, and so the
  # difference shows up in the paths rather than being silently averaged over.
  release="$dir/target/elf-compilation/docker/$TARGET"
  [ -d "$release" ] || release="$dir/target/elf-compilation/$TARGET"
  [ -d "$release" ] || continue
  # Only the ELFs themselves: `release/` also holds `deps/`, `.fingerprint/`, cargo lock files
  # and `.d` dependency lists, none of which are the artifact anyone is comparing.
  found="$found $(find "$release" -maxdepth 1 -type f ! -name '*.d' ! -name '.cargo-*' -print)"
done

# shellcheck disable=SC2086
set -- $found
if [ "$#" -eq 0 ]; then
  echo "no guest ELFs found. Build them first: task zk:build" >&2
  exit 1
fi

printf '%s\n' "$@" | sort | xargs sha256sum
