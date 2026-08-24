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

FILES=$(sh scripts/guest-elf-dirs.sh --files)
[ -n "$FILES" ] || { echo "no guest ELFs found. Build them first: task zk:build" >&2; exit 1; }

printf '%s\n' "$FILES" | xargs sha256sum
