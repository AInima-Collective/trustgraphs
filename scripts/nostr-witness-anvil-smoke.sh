#!/usr/bin/env bash
set -euo pipefail

# Fresh-checkout S3 exit: deterministic A/C export, real AnchorRegistry preflight/submission,
# checkpoint reconstruction, byte-identical second assembly, and credential-free execute/prove.
# Requires Foundry plus a prover binary built with `--features witness-nostr`.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prover_bin="${TRUSTGRAPHS_PROVER_BIN:-$repo_dir/zk/prover/target/release/trustgraph-prover}"
rpc_port="${TRUSTGRAPHS_ANVIL_PORT:-18547}"
rpc_url="http://127.0.0.1:$rpc_port"
dev_key="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
dev_address="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
params="$repo_dir/test/fixtures/nostr/params.json"
source_corpus="$repo_dir/test/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/source-corpus.json"
community="01915f7a-6b4c-7d2e-8f10-112233445566"
a_head="b3fb658ab799cdb4ed09da4f5d9cd5c2dce8bd53639e50be19f1b60300822bbe"
c_head="6659cc9bc90ece1ec3d7180096c9c80805c31c4b75fdfb7e67d294e3450ce10e"

if [[ ! -x "$prover_bin" ]]; then
  echo "missing witness-enabled prover: $prover_bin" >&2
  echo "build with: cd $repo_dir/zk/prover && cargo build --release --features witness-nostr" >&2
  exit 1
fi

smoke_dir="$(mktemp -d /tmp/trustgraphs-nostr-s3.XXXXXX)"
anvil_pid=""
cleanup() {
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" 2>/dev/null || true
    wait "$anvil_pid" 2>/dev/null || true
  fi
  case "$smoke_dir" in
    /tmp/trustgraphs-nostr-s3.*) rm -rf -- "$smoke_dir" ;;
    *) echo "refusing to remove unexpected smoke path: $smoke_dir" >&2 ;;
  esac
}
trap cleanup EXIT

anvil --port "$rpc_port" --chain-id 31337 --silent >"$smoke_dir/anvil.log" 2>&1 &
anvil_pid=$!
for _ in $(seq 1 50); do
  if cast chain-id --rpc-url "$rpc_url" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
cast chain-id --rpc-url "$rpc_url" >/dev/null

deploy() {
  forge create --root "$repo_dir" --rpc-url "$rpc_url" --private-key "$dev_key" --broadcast "$@" \
    | awk '/Deployed to:/{print $3}'
}

empty_lane="$(deploy src/contracts/merkle/EmptyLaneAccumulator.sol:EmptyLaneAccumulator)"
registry="$(deploy src/contracts/registry/AnchorRegistry.sol:AnchorRegistry --constructor-args "$dev_address" 200000)"
snapshot="$(deploy src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot --constructor-args \
  0x0000000000000000000000000000000000000001 \
  0xaf83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd \
  "$empty_lane" "$dev_address" "$dev_address")"

cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" \
  'setAnchorRegistry(address)' "$registry" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$empty_lane" \
  'bindSnapshot(address)' "$snapshot" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$registry" \
  'bindSnapshot(address)' "$snapshot" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$registry" \
  'registerNode(bytes32,uint8)' 0xbd02b91630293d28e9170a0df89a84d4ee57afd5cc94f72058a6f52e5237c95f 3 >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$registry" \
  'registerNode(bytes32,uint8)' 0xac7bf0b5126e15d062f11021e0c692dd56c7694d02f6220c2055a827b25b4bac 2 >/dev/null

for archive in "$smoke_dir/archive-1" "$smoke_dir/archive-2"; do
  "$prover_bin" nostr-witness export --source "$source_corpus" --params "$params" \
    --variant buzz-audit --archive-dir "$archive" --access member-scoped >/dev/null
  "$prover_bin" nostr-witness export --source "$source_corpus" --params "$params" \
    --variant self-log --archive-dir "$archive" --access member-scoped >/dev/null
done

a_manifest_1="$smoke_dir/archive-1/$community/23/$a_head/manifest.json"
c_manifest_1="$smoke_dir/archive-1/$community/2/$c_head/manifest.json"
a_manifest_2="$smoke_dir/archive-2/$community/23/$a_head/manifest.json"
c_manifest_2="$smoke_dir/archive-2/$community/2/$c_head/manifest.json"
cmp "${a_manifest_1%manifest.json}bundle.tgnw" "${a_manifest_2%manifest.json}bundle.tgnw"
cmp "${c_manifest_1%manifest.json}bundle.tgnw" "${c_manifest_2%manifest.json}bundle.tgnw"
cmp "$a_manifest_1" "$a_manifest_2"
cmp "$c_manifest_1" "$c_manifest_2"

export TRUSTGRAPH_ANCHOR_KEY="$dev_key"
"$prover_bin" nostr-witness anchor --manifest "$a_manifest_1" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY
"$prover_bin" nostr-witness anchor --manifest "$a_manifest_1" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY
[[ "$(cast call --rpc-url "$rpc_url" "$registry" 'anchorCount()(uint64)')" == "1" ]]
"$prover_bin" nostr-witness anchor --manifest "$c_manifest_1" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY
unset TRUSTGRAPH_ANCHOR_KEY

cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" 'trigger()(uint256)' >/dev/null
for process in 1 2; do
  a_manifest_var="$smoke_dir/archive-$process/$community/23/$a_head/manifest.json"
  c_manifest_var="$smoke_dir/archive-$process/$community/2/$c_head/manifest.json"
  "$prover_bin" nostr-witness assemble --rpc "$rpc_url" --snapshot "$snapshot" --checkpoint 0 \
    --params "$params" --manifest "$a_manifest_var" --manifest "$c_manifest_var" --from-block 0 \
    --recipient 0xbebebebebebebebebebebebebebebebebebebebe --out "$smoke_dir/input-$process.json"
done
cmp "$smoke_dir/input-1.json" "$smoke_dir/input-2.json"

env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
  "$prover_bin" nostr-workspace execute "$smoke_dir/input-1.json" --out-dir "$smoke_dir/execute"
env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
  "$prover_bin" nostr-workspace prove "$smoke_dir/input-1.json" --groth16 --out-dir "$smoke_dir/prove"

echo "nostr witness S3 Anvil smoke passed"
