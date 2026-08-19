#!/usr/bin/env bash
set -euo pipefail

# S4 production-surface rehearsal for the pinned Buzz fixture:
#   export/archive -> anchor -> checkpoint -> offline input -> execute/prove -> publish ->
#   submitProof, authenticated indexer pre-write validation, twice, followed by a
#   trust-compose source capture.
#
# The SNARK gateway alone is stubbed. SP1 executes the real detached guest and emits real public
# values; SP1JournalVerifier still decodes the proof blob, binds all 12 journal words, and pins the
# exact production vkey. Set TRUSTGRAPHS_PROVER_BIN to a witness-enabled debug binary for a faster
# local iteration, or use the release path below for the release rehearsal.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prover_bin="${TRUSTGRAPHS_PROVER_BIN:-$repo_dir/zk/prover/target/release/trustgraph-prover}"
rpc_port="${TRUSTGRAPHS_ANVIL_PORT:-18549}"
rpc_url="http://127.0.0.1:$rpc_port"
publish_port="${TRUSTGRAPHS_NOSTR_IPFS_PORT:-18649}"
dev_key="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
dev_address="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
recipient="0xbebebebebebebebebebebebebebebebebebebebe"
zero32="0x0000000000000000000000000000000000000000000000000000000000000000"
frozen_vkey="0x00475027871d7e096ae46d3059e73769642091af658febfef05271be59e343e3"
params_hash="0xaf83d14a8b8fe347e8a3d1465ce148ccd03b2bc2e32a6f53e6f1f6b97826a2bd"
community_node="0xbd02b91630293d28e9170a0df89a84d4ee57afd5cc94f72058a6f52e5237c95f"
agent_node="0xac7bf0b5126e15d062f11021e0c692dd56c7694d02f6220c2055a827b25b4bac"
agent_pubkey="462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b"
params="$repo_dir/test/fixtures/nostr/params.json"
fixture="$repo_dir/test/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3"

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

for tool in anvil cast forge jq node pnpm curl cmp sha256sum od; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
[[ -x "$prover_bin" ]] || fail "missing prover binary: $prover_bin"
"$prover_bin" nostr-witness --help >/dev/null 2>&1 ||
  fail "prover lacks witness-nostr; build with cargo build --release --features witness-nostr"

work_dir="$(mktemp -d /tmp/trustgraphs-nostr-s4.XXXXXX)"
anvil_pid=""
publisher_pid=""
cleanup() {
  if [[ -n "$publisher_pid" ]]; then
    kill "$publisher_pid" 2>/dev/null || true
    wait "$publisher_pid" 2>/dev/null || true
  fi
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" 2>/dev/null || true
    wait "$anvil_pid" 2>/dev/null || true
  fi
  case "$work_dir" in
    /tmp/trustgraphs-nostr-s4.*) rm -rf -- "$work_dir" ;;
    *) echo "refusing to remove unexpected work path: $work_dir" >&2 ;;
  esac
}
trap cleanup EXIT

deploy() {
  forge create --root "$repo_dir" --rpc-url "$rpc_url" --private-key "$dev_key" --broadcast \
    --json "$@" | jq -er .deployedTo
}

hex_file() {
  printf '0x'
  od -An -v -tx1 "$1" | tr -d ' \n'
}

field() {
  local name=$1
  local log=$2
  awk -v wanted="$name" '$1 == wanted { print $2; exit }' "$log"
}

manifest_for() {
  local archive=$1
  local variant=$2
  local count=$3
  local found=""
  while IFS= read -r -d '' candidate; do
    if jq -e --arg variant "$variant" --argjson count "$count" \
      '.commitmentVariant == $variant and .count == $count' "$candidate" >/dev/null; then
      [[ -z "$found" ]] || fail "multiple $variant/count=$count manifests in $archive"
      found=$candidate
    fi
  done < <(find "$archive" -type f -name manifest.json -print0)
  [[ -n "$found" ]] || fail "missing $variant/count=$count manifest in $archive"
  printf '%s\n' "$found"
}

export_epoch() {
  local source=$1
  local archive=$2
  "$prover_bin" nostr-witness export --source "$source" --params "$params" \
    --variant buzz-audit --archive-dir "$archive" --access member-scoped >/dev/null
  if [[ "$source" == *"/epoch2/"* ]]; then
    "$prover_bin" nostr-witness export --source "$source" --params "$params" \
      --variant self-log --authority "$agent_pubkey" --archive-dir "$archive" \
      --access member-scoped >/dev/null
  else
    "$prover_bin" nostr-witness export --source "$source" --params "$params" \
      --variant self-log --archive-dir "$archive" --access member-scoped >/dev/null
  fi
}

execute_and_prove() {
  local epoch=$1
  local input=$2
  local out=$3
  env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
    "$prover_bin" nostr-workspace execute "$input" --out-dir "$out/execute" \
    | tee "$out/execute.log"
  env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
    "$prover_bin" nostr-workspace prove "$input" --groth16 --out-dir "$out/prove-a" \
    | tee "$out/prove-a.log"
  env -u DATABASE_URL -u TRUSTGRAPH_ANCHOR_KEY SP1_PROVER=mock \
    "$prover_bin" nostr-workspace prove "$input" --groth16 --out-dir "$out/prove-b" \
    >"$out/prove-b.log"
  cmp "$out/prove-a/nostr_workspace_public_values.bin" \
    "$out/prove-b/nostr_workspace_public_values.bin"
  for artifact in blob.json journal.json metadata.json skips.json; do
    cmp "$out/execute/nostr_workspace_$artifact" "$out/prove-a/nostr_workspace_$artifact"
    cmp "$out/prove-a/nostr_workspace_$artifact" "$out/prove-b/nostr_workspace_$artifact"
  done
  for restart in a b; do
    pnpm --dir "$repo_dir/indexer" exec tsx \
      scripts/validate-nostr-workspace-artifacts.ts \
      --blob "$out/execute/nostr_workspace_blob.json" \
      --journal "$out/execute/nostr_workspace_journal.json" \
      --sidecar "$out/execute/nostr_workspace_metadata.json" \
      --cid "$(field 'cid:' "$out/execute.log")" \
      --program "$program_id" --output-domain "$output_domain" \
      >"$out/indexer-acceptance-$restart.json"
  done
  cmp "$out/indexer-acceptance-a.json" "$out/indexer-acceptance-b.json"
  [[ "$(field 'anchorCount:' "$out/execute.log")" == "$epoch" ]] ||
    fail "unexpected live anchor count in epoch $epoch"
}

publish_blob() {
  local epoch=$1
  local cid=$2
  local expected_hash=$3
  local blob=$4
  local actual_hash
  actual_hash="0x$(sha256sum "$blob" | awk '{print $1}')"
  [[ "${actual_hash,,}" == "${expected_hash,,}" ]] || fail "epoch $epoch score blob hash mismatch"

  local port=$((publish_port + epoch))
  EXPECTED_CID="$cid" PORT="$port" node "$repo_dir/test/e2e/kubo-stub.mjs" \
    >"$work_dir/publisher-$epoch.log" 2>&1 &
  publisher_pid=$!
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null
  for _ in 1 2; do
    returned=$(curl -fsS -F "file=@$blob" \
      "http://127.0.0.1:$port/api/v0/add?cid-version=1&raw-leaves=true&pin=true" | jq -er .Hash)
    [[ "$returned" == "$cid" ]] || fail "publisher returned $returned, expected $cid"
  done
  curl -fsS "http://127.0.0.1:$port/ipfs/$cid" -o "$work_dir/published-$epoch.json"
  cmp "$blob" "$work_dir/published-$epoch.json"
  kill "$publisher_pid"
  wait "$publisher_pid" 2>/dev/null || true
  publisher_pid=""
}

submit_epoch() {
  local checkpoint=$1
  local out=$2
  local root ipfs cid total skipped proven_recipient proof
  root=$(field 'outputRoot:' "$out/execute.log")
  ipfs=$(field 'ipfsHash:' "$out/execute.log")
  cid=$(field 'cid:' "$out/execute.log")
  total=$(field 'totalValue:' "$out/execute.log")
  skipped=$(field 'skippedDigest:' "$out/execute.log")
  proven_recipient=$(field 'recipient:' "$out/execute.log")
  [[ "${proven_recipient,,}" == "${recipient,,}" ]] || fail "recipient binding changed"
  [[ "$(field 'instanceDomain:' "$out/execute.log")" == \
    "$(cast call --rpc-url "$rpc_url" "$snapshot" 'instanceDomain()(bytes32)')" ]] ||
    fail "guest instance domain differs from snapshot"
  proof=$(hex_file "$out/prove-a/nostr_workspace_proof.bin")
  publish_blob "$((checkpoint + 1))" "$cid" "$ipfs" "$out/prove-a/nostr_workspace_blob.json"
  cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" \
    'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' \
    "$checkpoint" "$root" "$ipfs" "$cid" "$total" "$skipped" "$proven_recipient" "$proof" \
    >/dev/null
  printf '%s\n' "$root"
}

echo "== start deterministic chain =="
anvil --port "$rpc_port" --chain-id 31337 --silent >"$work_dir/anvil.log" 2>&1 &
anvil_pid=$!
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$rpc_url" >/dev/null 2>&1 && break
  sleep 0.1
done
[[ "$(cast chain-id --rpc-url "$rpc_url")" == "31337" ]] || fail "wrong Anvil chain id"

echo "== authenticate program and deploy complete Nostr instance =="
vkey="${TRUSTGRAPHS_NOSTR_VKEY:-$(SP1_PROVER=mock "$prover_bin" nostr-workspace vkey)}"
[[ "${vkey,,}" == "${frozen_vkey,,}" ]] || fail "nostr-workspace vkey drift: $vkey"
empty_lane=$(deploy src/contracts/merkle/EmptyLaneAccumulator.sol:EmptyLaneAccumulator)
registry=$(deploy src/contracts/registry/AnchorRegistry.sol:AnchorRegistry \
  --constructor-args "$dev_address" 200000)
gateway=$(deploy test/mocks/MockSP1Gateway.sol:MockSP1Gateway)
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$gateway" \
  'setExpectedVKey(bytes32)' "$vkey" >/dev/null
verifier=$(deploy src/contracts/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
  --constructor-args "$gateway" "$vkey")
snapshot=$(deploy src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot --constructor-args \
  "$verifier" "$params_hash" "$empty_lane" "$dev_address" "$dev_address")
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" \
  'setAnchorRegistry(address)' "$registry" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$empty_lane" \
  'bindSnapshot(address)' "$snapshot" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$registry" \
  'bindSnapshot(address)' "$snapshot" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" \
  'enableStateProvenance()' >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$registry" \
  'registerNode(bytes32,uint8)' "$community_node" 3 >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$registry" \
  'registerNode(bytes32,uint8)' "$agent_node" 2 >/dev/null

instance_registry=$(deploy src/contracts/registry/InstanceRegistry.sol:InstanceRegistry \
  --constructor-args "$dev_address")
instance_id=$(cast keccak 'nostr-workspace-s4-two-epoch')
program_id=$(cast keccak 'nostr-workspace')
output_domain=$(cast keccak 'trustgraphs.output.nostr-member.v1')
authority=$(deploy src/contracts/factory/NostrWorkspaceParamsAuthority.sol:NostrWorkspaceParamsAuthority \
  --constructor-args "$instance_id" "$snapshot" "$params_hash")
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$instance_registry" \
  'registerWithParamsAuthority(bytes32,(bytes32,address,address,address,bytes32),address)' \
  "$instance_id" "($program_id,$snapshot,$verifier,$registry,$params_hash)" "$authority" >/dev/null
[[ "$(cast call --rpc-url "$rpc_url" "$instance_registry" 'isRegistered(bytes32)(bool)' "$instance_id")" == \
  "true" ]] || fail "instance registry did not retain the Nostr row"

echo "== epoch 1: reproducible A+C export and idempotent anchor =="
for archive in "$work_dir/e1-archive-a" "$work_dir/e1-archive-b"; do
  export_epoch "$fixture/source-corpus.json" "$archive"
done
a1=$(manifest_for "$work_dir/e1-archive-a" BuzzAuditV1 23)
c1=$(manifest_for "$work_dir/e1-archive-a" SelfLogV1 2)
a1b=$(manifest_for "$work_dir/e1-archive-b" BuzzAuditV1 23)
c1b=$(manifest_for "$work_dir/e1-archive-b" SelfLogV1 2)
cmp "$a1" "$a1b"
cmp "$c1" "$c1b"
cmp "${a1%manifest.json}bundle.tgnw" "$fixture/source-option-a.tgnw"
cmp "${c1%manifest.json}bundle.tgnw" "$fixture/source-option-c.tgnw"
export TRUSTGRAPH_ANCHOR_KEY="$dev_key"
"$prover_bin" nostr-witness anchor --manifest "$a1" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY >/dev/null
"$prover_bin" nostr-witness anchor --manifest "$a1" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY >/dev/null
"$prover_bin" nostr-witness anchor --manifest "$c1" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY >/dev/null
unset TRUSTGRAPH_ANCHOR_KEY
[[ "$(cast call --rpc-url "$rpc_url" "$registry" 'anchorCount()(uint64)')" == "2" ]] ||
  fail "idempotent anchor retry appended a duplicate"
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" 'trigger()' >/dev/null

# A second snapshot sees the exact same input commitments and params. Replaying epoch 1 there can
# therefore fail only at journal-v3's instanceDomain word, not because its graph inputs differ.
twin_empty=$(deploy src/contracts/merkle/EmptyLaneAccumulator.sol:EmptyLaneAccumulator)
twin=$(deploy src/contracts/merkle/MerkleSnapshot.sol:MerkleSnapshot --constructor-args \
  "$verifier" "$params_hash" "$twin_empty" "$dev_address" "$dev_address")
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$twin" \
  'setAnchorRegistry(address)' "$registry" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$twin_empty" \
  'bindSnapshot(address)' "$twin" >/dev/null
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$twin" 'trigger()' >/dev/null

for process in a b; do
  "$prover_bin" nostr-witness assemble --rpc "$rpc_url" --snapshot "$snapshot" --checkpoint 0 \
    --params "$params" --manifest "$(manifest_for "$work_dir/e1-archive-$process" BuzzAuditV1 23)" \
    --manifest "$(manifest_for "$work_dir/e1-archive-$process" SelfLogV1 2)" --from-block 0 \
    --recipient "$recipient" --out "$work_dir/e1-input-$process.json" >/dev/null
done
cmp "$work_dir/e1-input-a.json" "$work_dir/e1-input-b.json"
jq -S 'del(.sourceManifests)' "$work_dir/e1-input-a.json.manifest.json" >"$work_dir/e1-receipt-a.json"
jq -S 'del(.sourceManifests)' "$work_dir/e1-input-b.json.manifest.json" >"$work_dir/e1-receipt-b.json"
cmp "$work_dir/e1-receipt-a.json" "$work_dir/e1-receipt-b.json"
mkdir -p "$work_dir/e1"
execute_and_prove 2 "$work_dir/e1-input-a.json" "$work_dir/e1"
proof1=$(hex_file "$work_dir/e1/prove-a/nostr_workspace_proof.bin")
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$gateway" \
  'setAccept(bool)' false >/dev/null
if cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" \
  'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' 0 \
  "$(field 'outputRoot:' "$work_dir/e1/execute.log")" \
  "$(field 'ipfsHash:' "$work_dir/e1/execute.log")" \
  "$(field 'cid:' "$work_dir/e1/execute.log")" "$(field 'totalValue:' "$work_dir/e1/execute.log")" \
  "$(field 'skippedDigest:' "$work_dir/e1/execute.log")" "$recipient" "$proof1" \
  >/dev/null 2>&1; then
  fail "gateway-rejected proof submission succeeded"
fi
[[ "$(cast call --rpc-url "$rpc_url" "$snapshot" 'getStateCount()(uint256)')" == "0" ]] ||
  fail "reverted proof submission changed snapshot state"
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$gateway" \
  'setAccept(bool)' true >/dev/null
root1=$(submit_epoch 0 "$work_dir/e1")
if cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" \
  'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' 0 \
  "$root1" "$(field 'ipfsHash:' "$work_dir/e1/execute.log")" \
  "$(field 'cid:' "$work_dir/e1/execute.log")" "$(field 'totalValue:' "$work_dir/e1/execute.log")" \
  "$(field 'skippedDigest:' "$work_dir/e1/execute.log")" "$recipient" "$proof1" \
  >/dev/null 2>&1; then
  fail "same-instance submission replay succeeded"
fi
if cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$twin" \
  'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' 0 \
  "$root1" "$(field 'ipfsHash:' "$work_dir/e1/execute.log")" \
  "$(field 'cid:' "$work_dir/e1/execute.log")" "$(field 'totalValue:' "$work_dir/e1/execute.log")" \
  "$(field 'skippedDigest:' "$work_dir/e1/execute.log")" "$recipient" "$proof1" \
  >/dev/null 2>&1; then
  fail "twin-instance proof replay succeeded"
fi

echo "== epoch 2: replacement/deletion/membership/job changes plus withheld C =="
for archive in "$work_dir/e2-archive-a" "$work_dir/e2-archive-b"; do
  export_epoch "$fixture/epoch2/source-corpus.json" "$archive"
done
a2=$(manifest_for "$work_dir/e2-archive-a" BuzzAuditV1 30)
c2=$(manifest_for "$work_dir/e2-archive-a" SelfLogV1 3)
a2b=$(manifest_for "$work_dir/e2-archive-b" BuzzAuditV1 30)
c2b=$(manifest_for "$work_dir/e2-archive-b" SelfLogV1 3)
cmp "$a2" "$a2b"
cmp "$c2" "$c2b"
cmp "${a2%manifest.json}bundle.tgnw" "$fixture/epoch2/source-option-a.tgnw"
cmp "${c2%manifest.json}bundle.tgnw" "$fixture/epoch2/source-option-c.tgnw"
export TRUSTGRAPH_ANCHOR_KEY="$dev_key"
"$prover_bin" nostr-witness anchor --manifest "$a2" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY >/dev/null
"$prover_bin" nostr-witness anchor --manifest "$c2" --params "$params" \
  --rpc "$rpc_url" --registry "$registry" --private-key-env TRUSTGRAPH_ANCHOR_KEY >/dev/null
unset TRUSTGRAPH_ANCHOR_KEY
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$snapshot" 'trigger()' >/dev/null
for process in a b; do
  # C2 is anchored but intentionally unavailable to this prover. H-5 prevents falling back to C1;
  # the guest lands a deterministic DROPPED entry while A2 supplies the complete workspace state.
  "$prover_bin" nostr-witness assemble --rpc "$rpc_url" --snapshot "$snapshot" --checkpoint 1 \
    --params "$params" --manifest "$(manifest_for "$work_dir/e2-archive-$process" BuzzAuditV1 30)" \
    --from-block 0 --recipient "$recipient" --out "$work_dir/e2-input-$process.json" >/dev/null
done
cmp "$work_dir/e2-input-a.json" "$work_dir/e2-input-b.json"
mkdir -p "$work_dir/e2"
execute_and_prove 4 "$work_dir/e2-input-a.json" "$work_dir/e2"
jq -e 'map(select(.reason == 2)) | length == 1' \
  "$work_dir/e2/execute/nostr_workspace_skips.json" >/dev/null ||
  fail "epoch 2 did not commit exactly one withheld-head DROPPED preimage"
root2=$(submit_epoch 1 "$work_dir/e2")
[[ "${root1,,}" != "${root2,,}" ]] || fail "epoch mutation did not change the root"
[[ "$(cast call --rpc-url "$rpc_url" "$snapshot" 'getStateCount()(uint256)')" == "2" ]] ||
  fail "both proven states were not retained"

echo "== capture authenticated Nostr provenance as a trust-compose source =="
adapter_factory=$(deploy src/contracts/composition/CompositionSourceAdapter.sol:CompositionSourceAdapterFactory)
source_id=$(cast keccak 'buzz-s4-source')
family_id=$(cast keccak 'nostr-workspace-member-v1')
output_kind=$(cast keccak 'allocation')
deployment_provenance=$(cast keccak 'pinned-buzz-a362fecc-s4')
adapter=$(cast call --rpc-url "$rpc_url" --from "$dev_address" "$adapter_factory" \
  'create(address,bytes32,bytes32,bytes32,bytes32,bytes32)(address)' \
  "$instance_registry" "$instance_id" "$source_id" "$family_id" "$output_kind" \
  "$deployment_provenance")
cast send --rpc-url "$rpc_url" --private-key "$dev_key" "$adapter_factory" \
  'create(address,bytes32,bytes32,bytes32,bytes32,bytes32)(address)' \
  "$instance_registry" "$instance_id" "$source_id" "$family_id" "$output_kind" \
  "$deployment_provenance" >/dev/null
[[ "$(cast call --rpc-url "$rpc_url" "$adapter_factory" 'isAdapter(address)(bool)' "$adapter")" == \
  "true" ]] || fail "composition adapter was not authenticated by its factory"
[[ "$(cast call --rpc-url "$rpc_url" "$adapter" 'programId()(bytes32)')" == "$program_id" ]] ||
  fail "composition capture relabeled the Nostr program"
capture=$(cast call --rpc-url "$rpc_url" "$adapter" \
  'readLatest()((uint64,uint64,bytes32,bytes32,bytes32,uint128,uint256,uint64,bytes32,address,bytes32,bytes32))')
grep -qi "${root2#0x}" <<<"$capture" || fail "composition capture omitted the latest Nostr root"
grep -qi "${vkey#0x}" <<<"$capture" || fail "composition capture omitted the Nostr vkey"

echo "nostr-workspace two-epoch S4 Anvil e2e passed"
