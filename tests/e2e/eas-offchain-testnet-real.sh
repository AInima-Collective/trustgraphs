#!/usr/bin/env bash
#
# Scheduled/dispatch-only real Groth16 gate for an already dark-deployed hybrid testnet instance.
# It reconstructs every address and the params tuple from chain history, proves the next unproven
# checkpoint through the configured SP1 network, stores the score blob twice with exact readback,
# and submits through the snapshot's real SP1JournalVerifier.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

required() {
  local name="$1"
  [ -n "${!name:-}" ] || { printf 'FATAL: %s is required\n' "$name" >&2; exit 1; }
}
for name in TESTNET_RPC_URL TESTNET_INSTANCE_REGISTRY TESTNET_REGISTRY_FROM_BLOCK \
  TESTNET_INSTANCE_ID TESTNET_EXPECTED_CHAIN_ID \
  TESTNET_SUBMITTER_PRIVATE_KEY TESTNET_EXPECTED_VERIFIER TESTNET_EXPECTED_GATEWAY \
  TESTNET_EXPECTED_PROGRAM_VKEY TESTNET_ENVELOPE0_GATEWAYS TESTNET_SCORE_IPFS_API_A \
  TESTNET_SCORE_IPFS_API_B NETWORK_PRIVATE_KEY; do
  required "$name"
done
for tool in cast cargo jq curl cmp od sha256sum; do
  command -v "$tool" >/dev/null 2>&1 \
    || { printf "FATAL: '%s' is required\n" "$tool" >&2; exit 1; }
done
[ "$(cast chain-id --rpc-url "$TESTNET_RPC_URL")" = "$TESTNET_EXPECTED_CHAIN_ID" ] \
  || { printf 'FATAL: RPC chain id does not match TESTNET_EXPECTED_CHAIN_ID\n' >&2; exit 1; }
SUBMITTER_ADDRESS="$(cast wallet address --private-key "$TESTNET_SUBMITTER_PRIVATE_KEY")"
REQUESTER_ADDRESS="$(cast wallet address --private-key "$NETWORK_PRIVATE_KEY")"
[ "$(printf '%s' "$SUBMITTER_ADDRESS" | tr '[:upper:]' '[:lower:]')" != \
  "$(printf '%s' "$REQUESTER_ADDRESS" | tr '[:upper:]' '[:lower:]')" ] \
  || { printf 'FATAL: proof submitter and SP1 requester keys must be distinct\n' >&2; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
REPORT_FILE="${TESTNET_REPORT_FILE:-$(pwd)/.trustgraph/eas-offchain/testnet-real-proof.json}"
CHECKPOINT_EVIDENCE_FILE="${TESTNET_CHECKPOINT_EVIDENCE_FILE:-${REPORT_FILE%.json}.checkpoint.json}"
mkdir -p "$(dirname "$REPORT_FILE")"
mkdir -p "$(dirname "$CHECKPOINT_EVIDENCE_FILE")"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
equal_address() { [ "$(lower "$1")" = "$(lower "$2")" ]; }
hex_file() { printf '0x'; od -An -v -tx1 "$1" | tr -d ' \n'; }
CONFIRMATIONS="${TESTNET_CONFIRMATIONS:-12}"
FINALITY_TIMEOUT="${TESTNET_FINALITY_TIMEOUT_SECONDS:-900}"
[[ "$CONFIRMATIONS" =~ ^[0-9]+$ ]] \
  || { printf 'FATAL: TESTNET_CONFIRMATIONS must be an integer\n' >&2; exit 1; }
[[ "$FINALITY_TIMEOUT" =~ ^[0-9]+$ ]] \
  || { printf 'FATAL: TESTNET_FINALITY_TIMEOUT_SECONDS must be an integer\n' >&2; exit 1; }
await_block() {
  local target="$1" label="$2" started head
  started="$(date +%s)"
  while true; do
    head="$(cast block-number --rpc-url "$RPC")"
    [ "$head" -ge "$target" ] && return
    [ $(( $(date +%s) - started )) -lt "$FINALITY_TIMEOUT" ] \
      || { printf 'FATAL: timed out waiting for %s finality at block %s\n' "$label" "$target" >&2; exit 1; }
    sleep 5
  done
}

RPC="$TESTNET_RPC_URL"
SCAN="$WORK/scan"
cargo run -q -p input-exporter --bin instance-scan -- \
  --rpc "$RPC" --registry "$TESTNET_INSTANCE_REGISTRY" --out-dir "$SCAN" \
  --from-block "$TESTNET_REGISTRY_FROM_BLOCK" --chunk "${TESTNET_LOG_CHUNK:-10000}" \
  >"$WORK/instance-scan.log"
jq --arg id "$(lower "$TESTNET_INSTANCE_ID")" \
  '.instances[] | select((.instanceId | ascii_downcase) == $id)' \
  "$SCAN/instances.json" >"$WORK/instance.json"
[ "$(jq -s length "$WORK/instance.json")" = 1 ] \
  || { printf 'FATAL: selected instance was not uniquely discovered\n' >&2; exit 1; }

SNAPSHOT="$(jq -r .snapshot "$WORK/instance.json")"
ACCUMULATOR="$(jq -r .accumulator "$WORK/instance.json")"
ANCHOR_REGISTRY="$(jq -r .anchorRegistry "$WORK/instance.json")"
EAS="$(jq -r .eas "$WORK/instance.json")"
PARAMS="$(jq -r .paramsPath "$WORK/instance.json")"
[ "$ANCHOR_REGISTRY" != 0x0000000000000000000000000000000000000000 ] \
  || { printf 'FATAL: selected instance is not hybrid\n' >&2; exit 1; }
[ "$(jq '.envelope0_domain_separators | length' "$PARAMS")" = 2 ] \
  || { printf 'FATAL: selected instance lacks the strict two-domain profile\n' >&2; exit 1; }

LIVE_VERIFIER="$(cast call "$SNAPSHOT" 'zkVerifier()(address)' --rpc-url "$RPC")"
equal_address "$LIVE_VERIFIER" "$TESTNET_EXPECTED_VERIFIER" \
  || { printf 'FATAL: snapshot verifier %s != expected %s\n' "$LIVE_VERIFIER" "$TESTNET_EXPECTED_VERIFIER" >&2; exit 1; }
LIVE_GATEWAY="$(cast call "$LIVE_VERIFIER" 'gateway()(address)' --rpc-url "$RPC")"
equal_address "$LIVE_GATEWAY" "$TESTNET_EXPECTED_GATEWAY" \
  || { printf 'FATAL: verifier gateway %s != expected %s\n' "$LIVE_GATEWAY" "$TESTNET_EXPECTED_GATEWAY" >&2; exit 1; }
LIVE_VKEY="$(cast call "$LIVE_VERIFIER" 'programVKey()(bytes32)' --rpc-url "$RPC")"
[ "$(lower "$LIVE_VKEY")" = "$(lower "$TESTNET_EXPECTED_PROGRAM_VKEY")" ] \
  || { printf 'FATAL: onchain program vkey does not match the approved vkey\n' >&2; exit 1; }
LOCAL_VKEY="$(SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  cargo run -q --release --manifest-path zk/prover/Cargo.toml -- trust-graph vkey)"
[ "$(lower "$LOCAL_VKEY")" = "$(lower "$LIVE_VKEY")" ] \
  || { printf 'FATAL: built guest vkey %s != onchain %s\n' "$LOCAL_VKEY" "$LIVE_VKEY" >&2; exit 1; }

CHECKPOINT_COUNT="$(cast call "$ACCUMULATOR" 'checkpointCount()(uint256)' --rpc-url "$RPC")"
HAS_APPLIED="$(cast call "$SNAPSHOT" 'hasAppliedCheckpoint()(bool)' --rpc-url "$RPC")"
if [ "$HAS_APPLIED" = true ]; then
  CHECKPOINT_ID=$(( $(cast call "$SNAPSHOT" 'lastAppliedCheckpoint()(uint256)' --rpc-url "$RPC") + 1 ))
else
  CHECKPOINT_ID=0
fi
[ "$CHECKPOINT_ID" -lt "$CHECKPOINT_COUNT" ] \
  || { printf 'FATAL: no unproven checkpoint is available (%s/%s)\n' "$CHECKPOINT_ID" "$CHECKPOINT_COUNT" >&2; exit 1; }
CHECKPOINT_RAW="$(cast call "$ACCUMULATOR" \
  --data "$(cast calldata 'getCheckpoint(uint256)' "$CHECKPOINT_ID")" --rpc-url "$RPC")"
CHECKPOINT_BLOCK="$(cast to-dec "0x${CHECKPOINT_RAW: -64}")"
await_block $((CHECKPOINT_BLOCK + CONFIRMATIONS)) "checkpoint $CHECKPOINT_ID"

GATEWAY_ARGS=()
IFS=',' read -r -a ENVELOPE_READERS <<<"$TESTNET_ENVELOPE0_GATEWAYS"
declare -A UNIQUE_READERS=()
for gateway in "${ENVELOPE_READERS[@]}"; do
  gateway="${gateway#"${gateway%%[![:space:]]*}"}"
  gateway="${gateway%"${gateway##*[![:space:]]}"}"
  gateway="${gateway%/}/"
  [ "$gateway" != / ] || continue
  UNIQUE_READERS["$gateway"]=1
  GATEWAY_ARGS+=(--envelope0-gateway "$gateway")
done
[ "${#UNIQUE_READERS[@]}" -ge 2 ] \
  || { printf 'FATAL: at least two distinct Envelope0 readers are required\n' >&2; exit 1; }

INPUT="$WORK/input.json"
cargo run -q -p input-exporter -- \
  --rpc "$RPC" --accumulator "$ACCUMULATOR" --eas "$EAS" \
  --checkpoint "$CHECKPOINT_ID" --params "$PARAMS" --snapshot "$SNAPSHOT" \
  --anchor-registry "$ANCHOR_REGISTRY" "${GATEWAY_ARGS[@]}" \
  --envelope0-cache "$WORK/envelope0-cache" --out "$INPUT" \
  >"$WORK/export.log"

# Record the exact mixed-lane size and the gas of anchor transactions newly frozen by this
# checkpoint. Reusing cumulative gas from an older checkpoint would make a lane-1-only epoch look
# like fresh hybrid exercise, so the scheduled gate requires at least one new lane-2 anchor.
LANE1_LEAVES="$(jq '.edges | length' "$INPUT")"
LANE2_ANCHORS="$(jq '.lane2.anchors | length' "$INPUT")"
LANE2_WORK="$(cast call "$SNAPSHOT" 'checkpointWorkCount(uint256)(uint64)' "$CHECKPOINT_ID" --rpc-url "$RPC")"
TOTAL_WORK=$((LANE1_LEAVES + LANE2_WORK))
BUNDLE_BYTES="$(jq '[.lane2.payloads[].payload | ((length - 2) / 2)] | add // 0' "$INPUT")"
[ "$LANE1_LEAVES" -gt 0 ] && [ "$LANE2_ANCHORS" -gt 0 ] && [ "$LANE2_WORK" -gt 0 ] \
  || { printf 'FATAL: real-proof checkpoint must contain both lanes\n' >&2; exit 1; }
[ "$BUNDLE_BYTES" -gt 0 ] \
  || { printf 'FATAL: strict input contains no measurable bundle bytes\n' >&2; exit 1; }

CURRENT_ANCHOR_COUNT="$LANE2_ANCHORS"
PREVIOUS_ANCHOR_COUNT=0
if [ "$CHECKPOINT_ID" -gt 0 ]; then
  PREVIOUS_ANCHOR_COUNT="$(
    cast call "$SNAPSHOT" 'anchorCheckpoints(uint256)(bytes32,uint64)' "$((CHECKPOINT_ID - 1))" --rpc-url "$RPC" \
      | tail -n 1
  )"
fi
[ "$CURRENT_ANCHOR_COUNT" -gt "$PREVIOUS_ANCHOR_COUNT" ] \
  || { printf 'FATAL: checkpoint contains no new lane-2 anchor since its predecessor\n' >&2; exit 1; }

ANCHOR_TOPIC="$(cast keccak 'HeadAnchored(uint64,bytes32,address,uint8,bytes32,bytes32,bytes32,uint64,bytes32,uint256,bytes)')"
cast logs "$ANCHOR_TOPIC" --rpc-url "$RPC" --address "$ANCHOR_REGISTRY" \
  --from-block "$TESTNET_REGISTRY_FROM_BLOCK" --to-block "$CHECKPOINT_BLOCK" \
  --query-size "${TESTNET_LOG_CHUNK:-10000}" --json >"$WORK/anchor-logs.json"
[ "$(jq length "$WORK/anchor-logs.json")" -ge "$CURRENT_ANCHOR_COUNT" ] \
  || { printf 'FATAL: canonical RPC omitted an anchored prefix log\n' >&2; exit 1; }
for ((index = 0; index < CURRENT_ANCHOR_COUNT; index++)); do
  fold_index="$(cast to-dec "$(jq -r ".[${index}].topics[1]" "$WORK/anchor-logs.json")")"
  [ "$fold_index" = "$index" ] \
    || { printf 'FATAL: anchor logs are not the contiguous canonical prefix at index %s\n' "$index" >&2; exit 1; }
done
jq --argjson start "$PREVIOUS_ANCHOR_COUNT" --argjson end "$CURRENT_ANCHOR_COUNT" \
  '.[$start:$end] | map(.transactionHash) | unique' "$WORK/anchor-logs.json" \
  >"$WORK/anchor-transactions.json"
[ "$(jq length "$WORK/anchor-transactions.json")" -gt 0 ] \
  || { printf 'FATAL: no anchor transaction hashes were recovered\n' >&2; exit 1; }
ANCHOR_GAS=0
while IFS= read -r anchor_tx; do
  anchor_receipt="$(cast receipt "$anchor_tx" --rpc-url "$RPC" --json)"
  [ "$(printf '%s' "$anchor_receipt" | jq -r .status)" = 0x1 ] \
    || { printf 'FATAL: anchor transaction %s is unavailable or failed\n' "$anchor_tx" >&2; exit 1; }
  anchor_gas="$(cast to-dec "$(printf '%s' "$anchor_receipt" | jq -r .gasUsed)")"
  ANCHOR_GAS=$((ANCHOR_GAS + anchor_gas))
done < <(jq -r '.[]' "$WORK/anchor-transactions.json")
[ "$ANCHOR_GAS" -gt 0 ] \
  || { printf 'FATAL: anchor transaction gas was not measurable\n' >&2; exit 1; }

PROOF_DIR="$WORK/proof"
EXEC_STARTED_AT="$(date +%s)"
EXEC_OUT="$(SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
  cargo run -q --release --features network --manifest-path zk/prover/Cargo.toml -- \
  trust-graph execute "$INPUT" --out-dir "$PROOF_DIR")"
EXEC_SECONDS=$(( $(date +%s) - EXEC_STARTED_AT ))
PROVE_STARTED_AT="$(date +%s)"
SP1_PROVER=network SP1_SKIP_PROGRAM_BUILD=true \
  cargo run -q --release --features network --manifest-path zk/prover/Cargo.toml -- \
  trust-graph prove "$INPUT" --groth16 --out-dir "$PROOF_DIR" \
  >"$WORK/prove.log"
PROOF_SECONDS=$(( $(date +%s) - PROVE_STARTED_AT ))
CYCLES="$(printf '%s\n' "$EXEC_OUT" | awk '/^guest cycles:/{print $3}')"
[ -n "$CYCLES" ] && [ "$CYCLES" -gt 0 ] \
  || { printf 'FATAL: guest cycle count was not emitted\n' >&2; exit 1; }

OUTPUT_ROOT="$(printf '%s\n' "$EXEC_OUT" | awk '/^outputRoot:/{print $2}')"
IPFS_HASH="$(printf '%s\n' "$EXEC_OUT" | awk '/^ipfsHash:/{print $2}')"
CID="$(printf '%s\n' "$EXEC_OUT" | awk '/^cid:/{print $2}')"
TOTAL_VALUE="$(printf '%s\n' "$EXEC_OUT" | awk '/^totalValue:/{print $2}')"
SKIPPED_DIGEST="$(printf '%s\n' "$EXEC_OUT" | awk '/^skippedDigest:/{print $2}')"
RECIPIENT="$(printf '%s\n' "$EXEC_OUT" | awk '/^recipient:/{print $2}')"
for value in OUTPUT_ROOT IPFS_HASH CID TOTAL_VALUE SKIPPED_DIGEST RECIPIENT; do required "$value"; done

pin_exact() {
  local name="$1" api="$2" auth="$3" readback="$4"
  local auth_args=()
  if [ -n "$auth" ]; then auth_args=(-H "$auth"); fi
  local result
  result="$(curl --fail --silent --show-error "${auth_args[@]}" -X POST \
    -F "file=@$PROOF_DIR/blob.json;type=application/octet-stream" \
    "$api/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=true")"
  [ "$(printf '%s' "$result" | jq -r .Key)" = "$CID" ] \
    || { printf 'FATAL: %s returned the wrong score CID\n' "$name" >&2; exit 1; }
  curl --fail --silent --show-error "${auth_args[@]}" -X POST \
    "$api/api/v0/block/get?arg=$CID" -o "$readback"
  cmp -s "$PROOF_DIR/blob.json" "$readback" \
    || { printf 'FATAL: %s score readback was not byte exact\n' "$name" >&2; exit 1; }
}
SCORE_API_A="${TESTNET_SCORE_IPFS_API_A%/}"
SCORE_API_B="${TESTNET_SCORE_IPFS_API_B%/}"
[ "$SCORE_API_A" != "$SCORE_API_B" ] \
  || { printf 'FATAL: score publication APIs must be distinct\n' >&2; exit 1; }
pin_exact a "$SCORE_API_A" "${TESTNET_SCORE_IPFS_AUTH_A:-}" "$WORK/readback-a"
pin_exact b "$SCORE_API_B" "${TESTNET_SCORE_IPFS_AUTH_B:-}" "$WORK/readback-b"

PROOF_HEX="$(hex_file "$PROOF_DIR/proof.bin")"
SUBMIT_JSON="$(cast send "$SNAPSHOT" \
  'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' \
  "$CHECKPOINT_ID" "$OUTPUT_ROOT" "$IPFS_HASH" "$CID" "$TOTAL_VALUE" \
  "$SKIPPED_DIGEST" "$RECIPIENT" "$PROOF_HEX" \
  --rpc-url "$RPC" --private-key "$TESTNET_SUBMITTER_PRIVATE_KEY" --json)"
TX_HASH="$(printf '%s' "$SUBMIT_JSON" | jq -r '.transactionHash // .hash')"
[ -n "$TX_HASH" ] && [ "$TX_HASH" != null ] \
  || { printf 'FATAL: proof submission returned no transaction hash\n' >&2; exit 1; }
RECEIPT="$(cast receipt "$TX_HASH" --rpc-url "$RPC" --json)"
[ "$(printf '%s' "$RECEIPT" | jq -r .status)" = 0x1 ] \
  || { printf 'FATAL: real proof transaction failed\n' >&2; exit 1; }
RECEIPT_BLOCK="$(cast to-dec "$(printf '%s' "$RECEIPT" | jq -r .blockNumber)")"
RECEIPT_BLOCK_HASH="$(printf '%s' "$RECEIPT" | jq -r .blockHash)"
await_block $((RECEIPT_BLOCK + CONFIRMATIONS)) "proof transaction $TX_HASH"
CANONICAL_BLOCK_HASH="$(cast block "$RECEIPT_BLOCK" --rpc-url "$RPC" --json | jq -r .hash)"
[ "$(lower "$CANONICAL_BLOCK_HASH")" = "$(lower "$RECEIPT_BLOCK_HASH")" ] \
  || { printf 'FATAL: proof receipt was removed by a reorg\n' >&2; exit 1; }
RECEIPT="$(cast receipt "$TX_HASH" --rpc-url "$RPC" --json)"
[ "$(printf '%s' "$RECEIPT" | jq -r .status)" = 0x1 ] \
  || { printf 'FATAL: finalized proof receipt is unavailable or failed\n' >&2; exit 1; }
[ "$(cast call "$SNAPSHOT" 'lastAppliedCheckpoint()(uint256)' --rpc-url "$RPC")" = "$CHECKPOINT_ID" ] \
  || { printf 'FATAL: snapshot did not apply checkpoint %s\n' "$CHECKPOINT_ID" >&2; exit 1; }
LIVE_STATE="$(cast call "$SNAPSHOT" \
  'getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))' --rpc-url "$RPC")"
LIVE_ROOT="$(printf '%s\n' "$LIVE_STATE" | grep -oE '0x[0-9a-fA-F]{64}' | head -1 || true)"
[ "$(lower "$LIVE_ROOT")" = "$(lower "$OUTPUT_ROOT")" ] \
  || { printf 'FATAL: latest snapshot root %s != proven %s\n' "$LIVE_ROOT" "$OUTPUT_ROOT" >&2; exit 1; }

SUBMISSION_GAS="$(cast to-dec "$(printf '%s' "$RECEIPT" | jq -r .gasUsed)")"
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n \
  --arg generatedAt "$OBSERVED_AT" \
  --arg chainId "$(cast chain-id --rpc-url "$RPC")" \
  --arg instanceId "$TESTNET_INSTANCE_ID" --arg snapshot "$SNAPSHOT" \
  --arg verifier "$LIVE_VERIFIER" --arg gateway "$LIVE_GATEWAY" --arg programVKey "$LIVE_VKEY" \
  --arg checkpointId "$CHECKPOINT_ID" \
  --arg checkpointBlock "$CHECKPOINT_BLOCK" --arg confirmations "$CONFIRMATIONS" \
  --arg outputRoot "$OUTPUT_ROOT" --arg cid "$CID" \
  --arg transactionHash "$TX_HASH" --arg observedAt "$OBSERVED_AT" \
  --argjson lane1Leaves "$LANE1_LEAVES" --argjson lane2Anchors "$LANE2_ANCHORS" \
  --argjson lane2Work "$LANE2_WORK" --argjson workCount "$TOTAL_WORK" \
  --argjson executeSeconds "$EXEC_SECONDS" --argjson proofSeconds "$PROOF_SECONDS" \
  --argjson cycles "$CYCLES" --argjson bundleBytes "$BUNDLE_BYTES" \
  --argjson anchorGas "$ANCHOR_GAS" --argjson submissionGas "$SUBMISSION_GAS" \
  --slurpfile anchorTransactions "$WORK/anchor-transactions.json" \
  '{generatedAt:$generatedAt,chainId:$chainId,instanceId:$instanceId,snapshot:$snapshot,
    verifier:$verifier,gateway:$gateway,programVKey:$programVKey,checkpointId:$checkpointId,
    checkpointBlock:$checkpointBlock,confirmations:$confirmations,
    lane1Leaves:$lane1Leaves,lane2Anchors:$lane2Anchors,lane2Work:$lane2Work,workCount:$workCount,
    executeSeconds:$executeSeconds,proofSeconds:$proofSeconds,cycles:$cycles,bundleBytes:$bundleBytes,
    anchorGas:$anchorGas,submissionGas:$submissionGas,anchorTransactions:$anchorTransactions[0],
    outputRoot:$outputRoot,cid:$cid,storageExactReaders:2,transactionHash:$transactionHash,
    status:"verified-onchain",
    checkpoint:{checkpointId:$checkpointId,instanceId:$instanceId,observedAt:$observedAt,
      verifiedOnchain:true,transactionHash:$transactionHash,outputRoot:$outputRoot,cid:$cid,
      proofBackend:"sp1-network-groth16",cycles:$cycles,proofSeconds:$proofSeconds,
      anchorGas:$anchorGas,submissionGas:$submissionGas,bundleBytes:$bundleBytes,
      lane1Leaves:$lane1Leaves,lane2Anchors:$lane2Anchors,lane2Work:$lane2Work,
      workCount:$workCount}}' \
  >"$REPORT_FILE"
jq '.checkpoint' "$REPORT_FILE" >"$CHECKPOINT_EVIDENCE_FILE"
CHECKPOINT_EVIDENCE_SHA256="$(sha256sum "$CHECKPOINT_EVIDENCE_FILE" | awk '{print $1}')"
CHECKPOINT_EVIDENCE="sha256:$CHECKPOINT_EVIDENCE_SHA256"
jq --arg evidence "$CHECKPOINT_EVIDENCE" \
  --arg file "$(basename "$CHECKPOINT_EVIDENCE_FILE")" \
  '.checkpoint.evidence = $evidence |
   .checkpointEvidence = {evidence:$evidence,file:$file}' \
  "$REPORT_FILE" >"$WORK/final-report.json"
mv "$WORK/final-report.json" "$REPORT_FILE"
jq -e '
  .checkpoint as $checkpoint |
  ($checkpoint.checkpointId | type == "string") and
  ($checkpoint.instanceId | test("^0x[0-9a-fA-F]{64}$")) and
  ($checkpoint.transactionHash | test("^0x[0-9a-fA-F]{64}$")) and
  ($checkpoint.outputRoot | test("^0x[0-9a-fA-F]{64}$")) and
  ($checkpoint.cid | test("^bafkrei[a-z2-7]{52}$")) and
  ($checkpoint.evidence | test("^sha256:[0-9a-f]{64}$")) and
  ($checkpoint.verifiedOnchain == true) and
  ($checkpoint.proofBackend == "sp1-network-groth16") and
  ($checkpoint.cycles > 0) and ($checkpoint.proofSeconds > 0) and
  ($checkpoint.anchorGas > 0) and ($checkpoint.submissionGas > 0) and
  ($checkpoint.bundleBytes > 0) and ($checkpoint.lane1Leaves > 0) and
  ($checkpoint.lane2Anchors > 0) and ($checkpoint.lane2Work > 0) and
  ($checkpoint.workCount == $checkpoint.lane1Leaves + $checkpoint.lane2Work)
' "$REPORT_FILE" >/dev/null \
  || { printf 'FATAL: generated checkpoint artifact violates the soak-ledger field contract\n' >&2; exit 1; }
printf 'REAL STRICT EAS OFFCHAIN GROTH16 PASS: %s\n' "$TX_HASH"
