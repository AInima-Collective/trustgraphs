#!/usr/bin/env bash
set -euo pipefail

# Local S5 hardening rehearsal. This is not pilot evidence: it uses the pinned synthetic fixture
# and mock SNARK gateway. It does exercise every required stop/recovery class before a real pilot.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo '== collection/archive failures: audit gap, relay drift, self-log equivocation, caps, tamper =='
CARGO_BUILD_JOBS=1 cargo test --manifest-path "$repo_dir/zk/prover/Cargo.toml" \
  --features witness-nostr --lib witness::nostr::tests

echo '== consensus failures: missing audited events, signature/key drift, bounded decoding =='
cargo test --manifest-path "$repo_dir/Cargo.toml" \
  -p nostr-envelope --test nostr_conformance

echo '== rule-Phi and work-bound failures: carry/drop, withheld archive, unsafe params =='
cargo test --manifest-path "$repo_dir/Cargo.toml" \
  -p nostr-workspace-core --test compute_fixture

echo '== durable operator recovery: proof/publication/submission restart states =='
cargo test --manifest-path "$repo_dir/Cargo.toml" -p operator-core

echo '== index replay/domain/root validation and content-free API =='
pnpm --dir "$repo_dir/indexer" test

echo '== live local recovery: withheld archive, rejected proof, reverted submit, index replay =='
SP1_SKIP_PROGRAM_BUILD=true "$repo_dir/scripts/nostr-workspace-two-epoch-e2e.sh"

echo 'nostr-workspace local hardening drills passed (synthetic pre-pilot evidence only)'
