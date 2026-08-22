#!/usr/bin/env bash
# Read-only dark-deploy audit for one strict hybrid testnet instance.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

required() {
  local name="$1"
  [ -n "${!name:-}" ] || { printf 'FATAL: %s is required\n' "$name" >&2; exit 1; }
}
for name in TESTNET_RPC_URL TESTNET_INSTANCE_REGISTRY TESTNET_REGISTRY_FROM_BLOCK TESTNET_INSTANCE_ID \
  TESTNET_EXPECTED_CHAIN_ID TESTNET_EXPECTED_ADMIN TESTNET_RELAYER_A TESTNET_RELAYER_B \
  TESTNET_RELAY_URL_A TESTNET_RELAY_URL_B TESTNET_EXPECTED_VERIFIER TESTNET_EXPECTED_GATEWAY \
  TESTNET_EXPECTED_PROGRAM_VKEY TESTNET_EXPECTED_MAX_TOTAL_INPUTS TESTNET_INDEXER_API \
  TESTNET_OPERATOR_STATUS_URL TESTNET_CONFIRMATIONS; do
  required "$name"
done
for tool in cargo cast jq curl; do
  command -v "$tool" >/dev/null 2>&1 \
    || { printf "FATAL: '%s' is required\n" "$tool" >&2; exit 1; }
done

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
REPORT_FILE="${TESTNET_AUDIT_REPORT_FILE:-$(pwd)/.trustgraph/eas-offchain/testnet-dark-deploy.json}"
mkdir -p "$(dirname "$REPORT_FILE")"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
equal_address() { [ "$(lower "$1")" = "$(lower "$2")" ]; }
fail() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }
base_url() { printf '%s' "${1%/}"; }
immutable_evidence() {
  jq -en --arg value "$1" '
    ($value | test("^ipfs://b[a-z2-7]{20,}([/?#].*)?$"; "i")) or
    ($value | test("^ar://[A-Za-z0-9_-]{43}([/?#].*)?$")) or
    ($value | test("(^|[#?& ])sha256[:=][0-9a-f]{64}($|[& ])"; "i"))
  ' >/dev/null
}

for name in TESTNET_DEPLOYMENT_VERIFICATION_EVIDENCE TESTNET_RELAYER_CUSTODY_EVIDENCE \
  TESTNET_STORAGE_INDEPENDENCE_EVIDENCE TESTNET_ALERT_DELIVERY_EVIDENCE \
  TESTNET_BACKUP_RESTORE_EVIDENCE TESTNET_RECOVERY_EXPORT_EVIDENCE \
  TESTNET_FEATURE_HIDDEN_EVIDENCE; do
  required "$name"
  immutable_evidence "${!name}" \
    || fail "$name must be an immutable ipfs://, ar://, or sha256-bound evidence reference"
done

RPC="$TESTNET_RPC_URL"
[[ "$TESTNET_CONFIRMATIONS" =~ ^[1-9][0-9]*$ ]] \
  || fail "TESTNET_CONFIRMATIONS must be a positive integer from the selected chain finality policy"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$CHAIN_ID" = "$TESTNET_EXPECTED_CHAIN_ID" ] \
  || fail "chain id $CHAIN_ID != expected $TESTNET_EXPECTED_CHAIN_ID"

cargo run -q -p input-exporter --bin instance-scan -- \
  --rpc "$RPC" --registry "$TESTNET_INSTANCE_REGISTRY" --out-dir "$WORK/scan" \
  --from-block "$TESTNET_REGISTRY_FROM_BLOCK" --chunk "${TESTNET_LOG_CHUNK:-10000}" \
  >"$WORK/instance-scan.log"
jq --arg id "$(lower "$TESTNET_INSTANCE_ID")" \
  '.instances[] | select((.instanceId | ascii_downcase) == $id)' \
  "$WORK/scan/instances.json" >"$WORK/instance.json"
[ "$(jq -s length "$WORK/instance.json")" = 1 ] \
  || fail "selected instance was not uniquely discovered"

ADMIN="$(jq -r .admin "$WORK/instance.json")"
SNAPSHOT="$(jq -r .snapshot "$WORK/instance.json")"
ACCUMULATOR="$(jq -r .accumulator "$WORK/instance.json")"
REGISTRY="$(jq -r .anchorRegistry "$WORK/instance.json")"
FACTORY="$(jq -r .factory "$WORK/instance.json")"
EAS="$(jq -r .eas "$WORK/instance.json")"
SCHEMA_UID="$(jq -r .schemaUid "$WORK/instance.json")"
PARAMS="$(jq -r .paramsPath "$WORK/instance.json")"
equal_address "$ADMIN" "$TESTNET_EXPECTED_ADMIN" \
  || fail "instance admin $ADMIN != expected $TESTNET_EXPECTED_ADMIN"
[ "$REGISTRY" != 0x0000000000000000000000000000000000000000 ] \
  || fail "selected instance is not hybrid"
equal_address "$TESTNET_RELAYER_A" "$TESTNET_RELAYER_B" \
  && fail "the two relayer addresses are identical"
[ "$(base_url "$TESTNET_RELAY_URL_A")" != "$(base_url "$TESTNET_RELAY_URL_B")" ] \
  || fail "the two relay URLs are identical"

LIVE_VERIFIER="$(cast call "$SNAPSHOT" 'zkVerifier()(address)' --rpc-url "$RPC")"
equal_address "$LIVE_VERIFIER" "$TESTNET_EXPECTED_VERIFIER" \
  || fail "snapshot verifier $LIVE_VERIFIER != expected $TESTNET_EXPECTED_VERIFIER"
LIVE_GATEWAY="$(cast call "$LIVE_VERIFIER" 'gateway()(address)' --rpc-url "$RPC")"
equal_address "$LIVE_GATEWAY" "$TESTNET_EXPECTED_GATEWAY" \
  || fail "verifier gateway $LIVE_GATEWAY != expected $TESTNET_EXPECTED_GATEWAY"
LIVE_VKEY="$(cast call "$LIVE_VERIFIER" 'programVKey()(bytes32)' --rpc-url "$RPC")"
[ "$(lower "$LIVE_VKEY")" = "$(lower "$TESTNET_EXPECTED_PROGRAM_VKEY")" ] \
  || fail "onchain program vkey does not match the approved vkey"
equal_address "$(jq -r .verifier "$WORK/instance.json")" "$LIVE_VERIFIER" \
  || fail "directory verifier disagrees with the snapshot verifier"
LIVE_CAP="$(cast call "$REGISTRY" 'maxTotalInputs()(uint64)' --rpc-url "$RPC")"
[ "$LIVE_CAP" = "$TESTNET_EXPECTED_MAX_TOTAL_INPUTS" ] \
  || fail "registry cap $LIVE_CAP != expected $TESTNET_EXPECTED_MAX_TOTAL_INPUTS"
EAS_VERSION="$(cast call "$EAS" 'version()(string)' --rpc-url "$RPC" | jq -r .)"
EAS_DOMAIN="$(jq -r '.envelope0_domain_separators[0]' "$PARAMS")"
HEAD_DOMAIN="$(jq -r '.envelope0_domain_separators[1]' "$PARAMS")"
[ "$(jq '.envelope0_domain_separators | length' "$PARAMS")" = 2 ] \
  || fail "reconstructed params do not contain exactly two strict domains"
[ "$(jq -r .lane2_max_head_age "$PARAMS")" = 0 ] \
  || fail "reconstructed params do not freeze lane2_max_head_age at zero"
[ "$(lower "$(jq -r .schema_uid "$PARAMS")")" = "$(lower "$SCHEMA_UID")" ] \
  || fail "reconstructed params schema disagrees with the factory instance"
equal_address "$(jq -r .accumulator "$PARAMS")" "$ACCUMULATOR" \
  || fail "reconstructed params accumulator disagrees with the directory"
[ "$(jq -r .chain_id "$PARAMS")" = "$CHAIN_ID" ] \
  || fail "reconstructed params chain id disagrees with the selected RPC"

ANCHORER_ROLE="$(cast keccak ANCHORER_ROLE)"
ZERO_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
[ "$(cast call "$REGISTRY" 'hasRole(bytes32,address)(bool)' "$ANCHORER_ROLE" "$TESTNET_RELAYER_A" --rpc-url "$RPC")" = true ] \
  || fail "relayer A lacks ANCHORER_ROLE"
[ "$(cast call "$REGISTRY" 'hasRole(bytes32,address)(bool)' "$ANCHORER_ROLE" "$TESTNET_RELAYER_B" --rpc-url "$RPC")" = true ] \
  || fail "relayer B lacks ANCHORER_ROLE"
[ "$(cast call "$REGISTRY" 'hasRole(bytes32,address)(bool)' "$ZERO_ROLE" "$ADMIN" --rpc-url "$RPC")" = true ] \
  || fail "instance admin lacks DEFAULT_ADMIN_ROLE"
[ "$(cast call "$REGISTRY" 'hasRole(bytes32,address)(bool)' "$ZERO_ROLE" "$TESTNET_RELAYER_A" --rpc-url "$RPC")" = false ] \
  || fail "relayer A unexpectedly has DEFAULT_ADMIN_ROLE"
[ "$(cast call "$REGISTRY" 'hasRole(bytes32,address)(bool)' "$ZERO_ROLE" "$TESTNET_RELAYER_B" --rpc-url "$RPC")" = false ] \
  || fail "relayer B unexpectedly has DEFAULT_ADMIN_ROLE"

for item in factory snapshot accumulator registry eas verifier gateway; do
  case "$item" in
    factory) address="$FACTORY" ;;
    snapshot) address="$SNAPSHOT" ;;
    accumulator) address="$ACCUMULATOR" ;;
    registry) address="$REGISTRY" ;;
    eas) address="$EAS" ;;
    verifier) address="$LIVE_VERIFIER" ;;
    gateway) address="$LIVE_GATEWAY" ;;
  esac
  code="$(cast code "$address" --rpc-url "$RPC")"
  [ "$code" != 0x ] || fail "$item has no deployed code at $address"
  size=$(( (${#code} - 2) / 2 ))
  jq -n --arg name "$item" --arg address "$address" --argjson size "$size" \
    '{name:$name,address:$address,codeSize:$size}' >>"$WORK/contracts.ndjson"
done
jq -s '.' "$WORK/contracts.ndjson" >"$WORK/contracts.json"

for relay in a b; do
  if [ "$relay" = a ]; then
    url="$(base_url "$TESTNET_RELAY_URL_A")"
    expected_relayer="$TESTNET_RELAYER_A"
  else
    url="$(base_url "$TESTNET_RELAY_URL_B")"
    expected_relayer="$TESTNET_RELAYER_B"
  fi
  curl --fail --silent --show-error "$url/healthz" >"$WORK/relay-$relay-health.json"
  [ "$(jq -r .status "$WORK/relay-$relay-health.json")" = ok ] || fail "relay $relay is unhealthy"
  curl --fail --silent --show-error "$url/metrics" >"$WORK/relay-$relay-metrics.json"
  metrics="$WORK/relay-$relay-metrics.json"
  [ "$(jq -r .chainId "$metrics")" = "$CHAIN_ID" ] \
    || fail "relay $relay reports another chain"
  equal_address "$(jq -r .registry "$metrics")" "$REGISTRY" \
    || fail "relay $relay reports another registry"
  equal_address "$(jq -r .relayerAddress "$metrics")" "$expected_relayer" \
    || fail "relay $relay is not bound to its expected relayer key"
  equal_address "$(jq -r .easAddress "$metrics")" "$EAS" \
    || fail "relay $relay reports another EAS deployment"
  [ "$(jq -r .easVersion "$metrics")" = "$EAS_VERSION" ] \
    || fail "relay $relay reports another EAS version"
  [ "$(lower "$(jq -r .schemaUid "$metrics")")" = "$(lower "$SCHEMA_UID")" ] \
    || fail "relay $relay reports another schema"
  jq -e '(.storageTargetCount | type == "number" and . >= 2) and
    (.storageQuorumRequired | type == "number" and . >= 2) and
    (.storageQuorumRequired <= .storageTargetCount)' "$metrics" >/dev/null \
    || fail "relay $relay does not expose a valid two-store exact-read quorum"
done

INDEXER="$(base_url "$TESTNET_INDEXER_API")"
curl --fail --silent --show-error "$INDEXER/eas-offchain/$REGISTRY/config" >"$WORK/indexer-config.json"
curl --fail --silent --show-error "$INDEXER/eas-offchain/$REGISTRY/utilization" >"$WORK/indexer-utilization.json"
equal_address "$(jq -r .lane.registry "$WORK/indexer-config.json")" "$REGISTRY" \
  || fail "indexer returned another registry"
equal_address "$(jq -r .lane.factory "$WORK/indexer-config.json")" "$FACTORY" \
  || fail "indexer returned another creating factory"
[ "$(lower "$(jq -r .lane.instanceId "$WORK/indexer-config.json")")" = "$(lower "$TESTNET_INSTANCE_ID")" ] \
  || fail "indexer returned another instance id"
[ "$(jq -r .lane.chainId "$WORK/indexer-config.json")" = "$CHAIN_ID" ] \
  || fail "indexer returned another chain id"
equal_address "$(jq -r .lane.eas "$WORK/indexer-config.json")" "$EAS" \
  || fail "indexer returned another EAS deployment"
[ "$(jq -r .lane.easVersion "$WORK/indexer-config.json")" = "$EAS_VERSION" ] \
  || fail "indexer returned another EAS version"
[ "$(lower "$(jq -r .lane.schemaUid "$WORK/indexer-config.json")")" = "$(lower "$SCHEMA_UID")" ] \
  || fail "indexer returned another schema"
[ "$(lower "$(jq -r .lane.domainSeparator "$WORK/indexer-config.json")")" = "$(lower "$EAS_DOMAIN")" ] \
  || fail "indexer returned another EAS domain"
[ "$(lower "$(jq -r .lane.headDomainSeparator "$WORK/indexer-config.json")")" = "$(lower "$HEAD_DOMAIN")" ] \
  || fail "indexer returned another head-signature domain"
[ "$(jq -r .lane.maxTotalInputs "$WORK/indexer-config.json")" = "$LIVE_CAP" ] \
  || fail "indexer config cap disagrees with the registry"
[ "$(jq -r .maxTotalInputs "$WORK/indexer-utilization.json")" = "$LIVE_CAP" ] \
  || fail "indexer cap disagrees with the registry"

OPERATOR="$(base_url "$TESTNET_OPERATOR_STATUS_URL")"
curl --fail --silent --show-error --max-time 10 --max-filesize 1048576 \
  "$OPERATOR" >"$WORK/operator-status.json"
jq -e 'type == "object"' "$WORK/operator-status.json" >/dev/null \
  || fail "operator status is not a JSON object"
OPERATOR_TICK="$(jq -r .tick_at "$WORK/operator-status.json")"
[[ "$OPERATOR_TICK" =~ ^[0-9]+$ ]] || fail "operator heartbeat tick_at is not an integer"
NOW="$(date +%s)"
OPERATOR_MAX_AGE="${TESTNET_OPERATOR_MAX_AGE_SECONDS:-180}"
[[ "$OPERATOR_MAX_AGE" =~ ^[1-9][0-9]*$ ]] \
  || fail "TESTNET_OPERATOR_MAX_AGE_SECONDS must be a positive integer"
[ "$OPERATOR_TICK" -le $((NOW + 300)) ] \
  || fail "operator heartbeat is more than five minutes in the future"
[ $((NOW - OPERATOR_TICK)) -le "$OPERATOR_MAX_AGE" ] \
  || fail "operator heartbeat is stale"
[ "$(jq -r .chain_id "$WORK/operator-status.json")" = "$CHAIN_ID" ] \
  || fail "operator heartbeat reports another chain"
jq --arg id "$(lower "$TESTNET_INSTANCE_ID")" \
  '[.instances[] | select((.instance_id | ascii_downcase) == $id)]' \
  "$WORK/operator-status.json" >"$WORK/operator-instance.json"
[ "$(jq length "$WORK/operator-instance.json")" = 1 ] \
  || fail "operator heartbeat does not uniquely report the rollout instance"
equal_address "$(jq -r '.[0].snapshot' "$WORK/operator-instance.json")" "$SNAPSHOT" \
  || fail "operator heartbeat reports another snapshot"
[ "$(jq -r '.[0].program' "$WORK/operator-instance.json")" = trust-graph ] \
  || fail "operator heartbeat reports another program"
[ "$(jq -r '.[0].curated' "$WORK/operator-instance.json")" = true ] \
  || fail "rollout instance is not curated by the operator"
[ "$(jq -r '.[0].input_capacity' "$WORK/operator-instance.json")" = "$LIVE_CAP" ] \
  || fail "operator input capacity disagrees with the registry"
jq -e --argjson cap "$LIVE_CAP" \
  '.[0].input_work | type == "number" and . >= 0 and . <= $cap' \
  "$WORK/operator-instance.json" >/dev/null \
  || fail "operator input work is missing or exceeds the registry cap"
jq -e '.[0].envelope0_validation_failed == false and
  (.[0].unprovable_age_blocks == null or .[0].unprovable_age_blocks == 0)' \
  "$WORK/operator-instance.json" >/dev/null \
  || fail "operator reports unavailable or invalid strict input"
jq -e --argjson confirmations "$TESTNET_CONFIRMATIONS" '
  .settings.prover_backend == "network" and .settings.groth16 == true and
  .settings.track_block_hash == true and .settings.confirmations == $confirmations and
  .settings.publishes_scores == true and .settings.verifies_score_readback == true and
  (.settings.publication_target_count | type == "number" and . >= 2) and
  (.settings.publication_min_success | type == "number" and . >= 2) and
  (.settings.publication_min_success <= .settings.publication_target_count) and
  (.unresolved | type == "array" and length == 0) and
  (.alerts | type == "array" and length == 0)
' "$WORK/operator-status.json" >/dev/null \
  || fail "operator policy/readers/finality or active-alert state is not rollout-safe"

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg chainId "$CHAIN_ID" \
  --arg instanceId "$TESTNET_INSTANCE_ID" --arg admin "$ADMIN" \
  --arg relayerA "$TESTNET_RELAYER_A" --arg relayerB "$TESTNET_RELAYER_B" \
  --arg verifier "$LIVE_VERIFIER" --arg gateway "$LIVE_GATEWAY" --arg programVKey "$LIVE_VKEY" \
  --arg maxTotalInputs "$LIVE_CAP" --arg easDomain "$EAS_DOMAIN" --arg headDomain "$HEAD_DOMAIN" \
  --arg deploymentVerification "$TESTNET_DEPLOYMENT_VERIFICATION_EVIDENCE" \
  --arg relayerCustody "$TESTNET_RELAYER_CUSTODY_EVIDENCE" \
  --arg storageIndependence "$TESTNET_STORAGE_INDEPENDENCE_EVIDENCE" \
  --arg alertDelivery "$TESTNET_ALERT_DELIVERY_EVIDENCE" \
  --arg backupRestore "$TESTNET_BACKUP_RESTORE_EVIDENCE" \
  --arg recoveryExports "$TESTNET_RECOVERY_EXPORT_EVIDENCE" \
  --arg featureHidden "$TESTNET_FEATURE_HIDDEN_EVIDENCE" \
  --slurpfile instance "$WORK/instance.json" --slurpfile params "$PARAMS" \
  --slurpfile contracts "$WORK/contracts.json" --slurpfile relayA "$WORK/relay-a-metrics.json" \
  --slurpfile relayB "$WORK/relay-b-metrics.json" \
  --slurpfile indexerConfig "$WORK/indexer-config.json" \
  --slurpfile indexer "$WORK/indexer-utilization.json" \
  --slurpfile operator "$WORK/operator-status.json" \
  '{generatedAt:$generatedAt,chainId:$chainId,instanceId:$instanceId,status:"dark-deploy-gate-passed",
    instance:($instance[0] | del(.paramsPath,.outDir)),params:$params[0],
    authority:{admin:$admin,relayers:[$relayerA,$relayerB]},
    proof:{verifier:$verifier,gateway:$gateway,programVKey:$programVKey},
    domains:{eas:$easDomain,head:$headDomain},
    capacity:{maxTotalInputs:$maxTotalInputs},contracts:$contracts[0],
    indexer:{config:$indexerConfig[0],utilization:$indexer[0]},
    relays:{a:$relayA[0],b:$relayB[0]},operator:$operator[0],requiredEvidence:{
      deploymentVerification:$deploymentVerification,relayerCustody:$relayerCustody,
      storageIndependence:$storageIndependence,alertDelivery:$alertDelivery,
      backupRestore:$backupRestore,recoveryExports:$recoveryExports,featureHidden:$featureHidden}}' \
  >"$REPORT_FILE"

printf 'STRICT EAS OFFCHAIN DARK-DEPLOY GATE PASS: %s\n' "$REPORT_FILE"
