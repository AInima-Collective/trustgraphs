#!/usr/bin/env bash
set -euo pipefail

# Independent authorized-holder reproduction. This script intentionally starts from immutable
# archive manifests plus the on-chain checkpoint; it does not accept an input assembled by the
# original prover and it refuses a dirty checkout or ambient collection/anchor credentials.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prover_bin="${TRUSTGRAPHS_PROVER_BIN:-$repo_dir/zk/prover/target/release/trustgraph-prover}"
frozen_vkey="0x00475027871d7e096ae46d3059e73769642091af658febfef05271be59e343e3"

rpc_url=""
snapshot=""
checkpoint=""
params=""
recipient=""
expected_root=""
expected_cid=""
expected_vkey="$frozen_vkey"
from_block=0
out=""
manifests=()

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: nostr-workspace-clean-room-reproduce.sh \
  --rpc URL --snapshot 0x... --checkpoint N --params FILE --recipient 0x... \
  --manifest FILE [--manifest FILE ...] --expected-root 0x... --expected-cid CID \
  --out NEW_DIRECTORY [--from-block N] [--expected-vkey 0x...]
EOF
}

while (($#)); do
  case "$1" in
    --rpc) rpc_url=${2:-}; shift 2 ;;
    --snapshot) snapshot=${2:-}; shift 2 ;;
    --checkpoint) checkpoint=${2:-}; shift 2 ;;
    --params) params=${2:-}; shift 2 ;;
    --recipient) recipient=${2:-}; shift 2 ;;
    --manifest) manifests+=("${2:-}"); shift 2 ;;
    --expected-root) expected_root=${2:-}; shift 2 ;;
    --expected-cid) expected_cid=${2:-}; shift 2 ;;
    --expected-vkey) expected_vkey=${2:-}; shift 2 ;;
    --from-block) from_block=${2:-}; shift 2 ;;
    --out) out=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument $1" ;;
  esac
done

for tool in cast cmp git jq pnpm sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
[[ -x "$prover_bin" ]] || fail "missing witness-enabled release prover: $prover_bin"
[[ -n "$rpc_url" && -n "$snapshot" && -n "$checkpoint" && -n "$params" ]] ||
  fail "rpc, snapshot, checkpoint, and params are required"
[[ -n "$recipient" && -n "$expected_root" && -n "$expected_cid" && -n "$out" ]] ||
  fail "recipient, expected root/CID, and output directory are required"
((${#manifests[@]} > 0)) || fail "at least one immutable archive manifest is required"
[[ -f "$params" ]] || fail "params file is unavailable: $params"
for manifest in "${manifests[@]}"; do
  [[ -f "$manifest" ]] || fail "archive manifest is unavailable: $manifest"
done
[[ ! -e "$out" ]] || fail "output path already exists: $out"
[[ "$checkpoint" =~ ^[0-9]+$ && "$from_block" =~ ^[0-9]+$ ]] ||
  fail "checkpoint and from-block must be unsigned integers"
[[ -z "${DATABASE_URL:-}" && -z "${TRUSTGRAPH_ANCHOR_KEY:-}" ]] ||
  fail "clean-room reproduction refuses ambient database or anchor credentials"
[[ -z "$(git -C "$repo_dir" status --porcelain)" ]] ||
  fail "clean-room reproduction requires a clean checkout"

mkdir -p "$out/assemble-a" "$out/assemble-b" "$out/execute-a" "$out/execute-b"
manifest_args=()
for manifest in "${manifests[@]}"; do
  manifest_args+=(--manifest "$manifest")
done

actual_vkey=$(SP1_PROVER=mock "$prover_bin" nostr-workspace vkey)
[[ "${actual_vkey,,}" == "${expected_vkey,,}" ]] ||
  fail "release prover vkey $actual_vkey does not match expected $expected_vkey"

for run in a b; do
  env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY "$prover_bin" nostr-witness assemble \
    --rpc "$rpc_url" --snapshot "$snapshot" --checkpoint "$checkpoint" \
    --params "$params" "${manifest_args[@]}" --from-block "$from_block" \
    --recipient "$recipient" --out "$out/assemble-$run/input.json" \
    >"$out/assemble-$run.log"
done
cmp "$out/assemble-a/input.json" "$out/assemble-b/input.json"
cmp "$out/assemble-a/input.json.manifest.json" "$out/assemble-b/input.json.manifest.json"

for run in a b; do
  env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
    "$prover_bin" nostr-workspace execute "$out/assemble-$run/input.json" \
    --out-dir "$out/execute-$run" >"$out/execute-$run.log"
done
for artifact in blob.json journal.json metadata.json skips.json; do
  cmp "$out/execute-a/nostr_workspace_$artifact" "$out/execute-b/nostr_workspace_$artifact"
done

field() {
  awk -v wanted="$1" '$1 == wanted { print $2; exit }' "$2"
}

actual_root=$(field 'outputRoot:' "$out/execute-a.log")
actual_cid=$(field 'cid:' "$out/execute-a.log")
[[ "${actual_root,,}" == "${expected_root,,}" ]] ||
  fail "reproduced root $actual_root does not match landed root $expected_root"
[[ "$actual_cid" == "$expected_cid" ]] ||
  fail "reproduced CID $actual_cid does not match landed CID $expected_cid"

program_id=$(cast keccak 'nostr-workspace')
output_domain=$(cast keccak 'trustgraphs.output.nostr-member.v1')
pnpm --dir "$repo_dir/indexer" exec tsx scripts/validate-nostr-workspace-artifacts.ts \
  --blob "$out/execute-a/nostr_workspace_blob.json" \
  --journal "$out/execute-a/nostr_workspace_journal.json" \
  --sidecar "$out/execute-a/nostr_workspace_metadata.json" --cid "$actual_cid" \
  --program "$program_id" --output-domain "$output_domain" \
  >"$out/indexer-acceptance.json"

input_sha=$(sha256sum "$out/assemble-a/input.json" | awk '{print $1}')
journal_sha=$(sha256sum "$out/execute-a/nostr_workspace_journal.json" | awk '{print $1}')
git_sha=$(git -C "$repo_dir" rev-parse HEAD)
jq -n --sort-keys \
  --arg format 'trustgraphs.nostr.clean-room-reproduction.v1' \
  --arg gitSha "$git_sha" --arg vkey "$actual_vkey" --arg snapshot "$snapshot" \
  --arg checkpoint "$checkpoint" --arg root "$actual_root" --arg cid "$actual_cid" \
  --arg inputSha256 "0x$input_sha" --arg journalSha256 "0x$journal_sha" \
  --argjson manifestCount "${#manifests[@]}" \
  '{format:$format,gitSha:$gitSha,vkey:$vkey,snapshot:$snapshot,checkpoint:$checkpoint,
    root:$root,cid:$cid,inputSha256:$inputSha256,journalSha256:$journalSha256,
    manifestCount:$manifestCount}' >"$out/reproduction-evidence.json"

echo "clean-room reproduction passed: $actual_root $actual_cid"
echo "evidence: $out/reproduction-evidence.json"
