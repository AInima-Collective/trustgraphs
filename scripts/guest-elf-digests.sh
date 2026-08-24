#!/usr/bin/env sh
#
# The sha256 of every built SP1 guest ELF, one per line, in a stable order.
#
# This is the machine-comparable half of the reproducibility claim: two machines that built the
# same commit must print byte-identical output. The vkey half needs the prover host and lives in
# `trustgraph-prover manifest`; this one needs nothing but the files, so it also runs inside the
# operator's Docker build where no prover exists.
#
#   sh scripts/guest-elf-digests.sh            # from anywhere
#
# Exits non-zero when a guest is missing, rather than printing a shorter table. An empty or
# incomplete table that two machines agree on is the one failure mode a digest comparison must not
# have: both sides would be agreeing about nothing.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

DIRS=$(sh scripts/guest-elf-dirs.sh)
EXPECTED=$(printf '%s\n' "$DIRS" | wc -l | tr -d ' ')

found=""
present=0
for release in $DIRS; do
  if [ ! -d "$release" ]; then
    echo "no guest ELFs in $release" >&2
    echo "Build them first: task zk:build" >&2
    exit 1
  fi
  present=$((present + 1))
  # Only the ELFs themselves: `release/` also holds `deps/`, `.fingerprint/`, cargo lock files
  # and `.d` dependency lists, none of which are the artifact anyone is comparing.
  found="$found $(find "$release" -maxdepth 1 -type f ! -name '*.d' ! -name '.cargo-*' -print)"
done

if [ "$present" -ne "$EXPECTED" ]; then
  echo "expected $EXPECTED guest workspaces, found $present" >&2
  exit 1
fi

# shellcheck disable=SC2086
set -- $found
if [ "$#" -eq 0 ]; then
  echo "guest directories exist but hold no ELFs. Build them first: task zk:build" >&2
  exit 1
fi

printf '%s\n' "$@" | sort | xargs sha256sum
