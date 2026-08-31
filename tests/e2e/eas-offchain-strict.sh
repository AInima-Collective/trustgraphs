#!/usr/bin/env bash
#
# Fast strict two-lane acceptance:
# factory discovery -> on-chain EAS predecessor -> official-SDK off-chain replacement/revoke ->
# two real relay processes -> four independent raw-CID stores -> dynamic instance scan -> strict
# checkpoint export -> native guest-core execution -> omission/availability failure drills.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RPC="${RPC:-http://127.0.0.1:18545}"
DEPLOYER_KEY="${EAS_OFFCHAIN_E2E_DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
RELAYER_A_KEY="${EAS_OFFCHAIN_E2E_RELAYER_A_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
RELAYER_B_KEY="${EAS_OFFCHAIN_E2E_RELAYER_B_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"
BASE_PORT="${EAS_OFFCHAIN_E2E_BASE_PORT:-15100}"
BROWSER_MODE="${EAS_OFFCHAIN_E2E_BROWSER:-0}"

CREATED_WORK=0
if [ -z "${WORK:-}" ]; then
  WORK="$(mktemp -d)"
  CREATED_WORK=1
else
  mkdir -p "$WORK"
fi

PIDS=()
KUBO_PIDS=()
INDEXER_PID=""
RELAY_A_PID=""
RELAY_B_PID=""
FRONTEND_CONFIG_REPLACED=0
FRONTEND_CONFIG_FILE="$(pwd)/packages/frontend/config.development.json"
FRONTEND_CONFIG_TEMPLATE="$(pwd)/packages/frontend/config.typecheck.json"
FRONTEND_CONTRACTS_FILE="$(pwd)/packages/frontend/lib/contracts.ts"
FRONTEND_ABIS_FILE="$(pwd)/packages/frontend/lib/contract-abis.ts"
FRONTEND_CONFIG_EXISTED=0
FRONTEND_WAGMI_REPLACED=0
FRONTEND_DIST_PATH=""
FRONTEND_TSCONFIG_PATH=""
SUMMARY_REPLACED=0
SUMMARY_EXISTED=0
SUMMARY_FILE="$(pwd)/.docker/deployment_summary.json"
NETWORKS_CATALOG_CREATED=0
NETWORKS_CATALOG_FILE="$(pwd)/config/networks.development.json"
kill_tree() {
  local pid="$1" children
  [ -n "$pid" ] || return 0
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill_tree "$pid"; done
  if [ "$FRONTEND_CONFIG_REPLACED" = 1 ]; then
    if [ "$FRONTEND_CONFIG_EXISTED" = 1 ]; then
      cp "$WORK/frontend-config.original.json" "$FRONTEND_CONFIG_FILE"
    else
      rm -f "$FRONTEND_CONFIG_FILE"
    fi
  fi
  if [ "$FRONTEND_WAGMI_REPLACED" = 1 ]; then
    cp "$WORK/frontend-contracts.original.ts" "$FRONTEND_CONTRACTS_FILE"
    cp "$WORK/frontend-contract-abis.original.ts" "$FRONTEND_ABIS_FILE"
  fi
  if [ -n "$FRONTEND_DIST_PATH" ]; then
    rm -rf -- "$FRONTEND_DIST_PATH"
  fi
  if [ -n "$FRONTEND_TSCONFIG_PATH" ]; then
    rm -f -- "$FRONTEND_TSCONFIG_PATH"
  fi
  if [ "$SUMMARY_REPLACED" = 1 ]; then
    if [ "$SUMMARY_EXISTED" = 1 ]; then
      cp "$WORK/deployment-summary.original.json" "$SUMMARY_FILE"
    else
      rm -f "$SUMMARY_FILE"
    fi
  fi
  if [ "$NETWORKS_CATALOG_CREATED" = 1 ]; then
    rm -f "$NETWORKS_CATALOG_FILE"
  fi
  if [ -n "${DEPLOY_FILE:-}" ]; then rm -f "$DEPLOY_FILE"; fi
  if [ "$CREATED_WORK" = 1 ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
for tool in forge cast anvil cargo jq node pnpm curl pgrep; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required"
done
if [ "$BROWSER_MODE" = 1 ]; then
  [ "${EAS_OFFCHAIN_E2E_INDEXER:-0}" = 1 ] \
    || die "EAS_OFFCHAIN_E2E_BROWSER=1 requires EAS_OFFCHAIN_E2E_INDEXER=1"
  pnpm --dir packages/frontend exec playwright --version >/dev/null 2>&1 \
    || die "Playwright is required for the browser acceptance gate"
fi

if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  RPC_PORT="${RPC##*:}"
  say "== start Anvil on $RPC_PORT =="
  anvil --silent --port "$RPC_PORT" >"$WORK/anvil.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 50); do
    cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 0.1
  done
fi
cast block-number --rpc-url "$RPC" >/dev/null || die "no chain at $RPC"

RELAYER_A="$(cast wallet address --private-key "$RELAYER_A_KEY")"
RELAYER_B="$(cast wallet address --private-key "$RELAYER_B_KEY")"
# Foundry scripts may only write under the repository's configured fs_permissions. Keep this one
# transient deploy handoff in the gitignored project artifact directory even when WORK is /tmp.
mkdir -p .trustgraph/e2e
DEPLOY_FILE="$(pwd)/.trustgraph/e2e/deploy-$$.json"
DRIVER_OUTPUT="$WORK/driver.json"

say "== deploy a factory-created strict hybrid =="
FUNDED_KEY="$DEPLOYER_KEY" EAS_OFFCHAIN_E2E_DEPLOY_FILE="$DEPLOY_FILE" \
  forge script contracts/script/DeployEasOffchainE2E.s.sol:DeployEasOffchainE2E \
  --sig 'run(string,string)' "$RELAYER_A" "$RELAYER_B" \
  --rpc-url "$RPC" --broadcast --skip-simulation >"$WORK/deploy.log"

CHAIN_ID="$(jq -r .chain_id "$DEPLOY_FILE")"
REGISTRY="$(jq -r .anchor_registry "$DEPLOY_FILE")"
EAS="$(jq -r .eas "$DEPLOY_FILE")"
EAS_VERSION="$(jq -r .eas_version "$DEPLOY_FILE")"
SCHEMA="$(jq -r .schema_uid "$DEPLOY_FILE")"
DIRECTORY="$(jq -r .instance_registry "$DEPLOY_FILE")"
FACTORY="$(jq -r .factory "$DEPLOY_FILE")"
GOVERNED_FACTORY="$(jq -r .governed_factory "$DEPLOY_FILE")"
SIGNER_SYNC_DEPLOYER="$(jq -r .signer_sync_deployer "$DEPLOY_FILE")"
SCHEMA_REGISTRY="$(jq -r .schema_registry "$DEPLOY_FILE")"
SCHEMA_REGISTRAR="$(jq -r .schema_registrar "$DEPLOY_FILE")"

KUBO_PORTS=()
for offset in 1 2 3 4; do
  port=$((BASE_PORT + offset))
  KUBO_PORTS+=("$port")
  PORT="$port" node tests/e2e/eas-offchain-kubo.mjs >"$WORK/kubo-$offset.log" 2>&1 &
  PIDS+=("$!")
  KUBO_PIDS+=("$!")
done
for port in "${KUBO_PORTS[@]}"; do
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:$port/health" >/dev/null || die "Kubo stub $port did not start"
done

GATEWAYS="http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/,http://127.0.0.1:${KUBO_PORTS[1]}/ipfs/,http://127.0.0.1:${KUBO_PORTS[2]}/ipfs/,http://127.0.0.1:${KUBO_PORTS[3]}/ipfs/"

if [ "${EAS_OFFCHAIN_E2E_INDEXER:-0}" = 1 ]; then
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is required for the live indexer gate"
  if [ ! -f "$NETWORKS_CATALOG_FILE" ]; then
    cp config/networks.development.template.json "$NETWORKS_CATALOG_FILE"
    NETWORKS_CATALOG_CREATED=1
  fi
  if [ -f "$SUMMARY_FILE" ]; then
    cp "$SUMMARY_FILE" "$WORK/deployment-summary.original.json"
    SUMMARY_EXISTED=1
  fi
  jq -n --arg factory "$FACTORY" --arg registry "$DIRECTORY" \
    --arg governed "$GOVERNED_FACTORY" --arg signerSyncDeployer "$SIGNER_SYNC_DEPLOYER" \
    '{networks:[],factory:{factory:$factory,instance_registry:$registry},governedFactory:{governed_factory:$governed,signer_sync_deployer:$signerSyncDeployer}}' \
    >"$WORK/deployment-summary.e2e.json"
  cp "$WORK/deployment-summary.e2e.json" "$SUMMARY_FILE"
  SUMMARY_REPLACED=1

  INDEXER_PORT=$((BASE_PORT + 21))
  INDEXER_API="http://127.0.0.1:$INDEXER_PORT"
  say "== start the live Ponder indexer/API =="
  env DATABASE_URL="$DATABASE_URL" DEPLOY_STAGE=development RPC_URL="$RPC" \
    PONDER_RPC_URL_31337="$RPC" PONDER_START_BLOCK=1 PONDER_PORT="$INDEXER_PORT" \
    PONDER_VIEWS_SCHEMA=eas_offchain_e2e EAS_OFFCHAIN_GATEWAYS="$GATEWAYS" \
    IPFS_GATEWAY="http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/" \
    pnpm --dir packages/indexer start >"$WORK/indexer.log" 2>&1 &
  INDEXER_PID=$!
  PIDS+=("$INDEXER_PID")
  for _ in $(seq 1 180); do
    curl -fsS "$INDEXER_API/ready" >/dev/null 2>&1 && break
    kill -0 "$INDEXER_PID" 2>/dev/null \
      || die "indexer exited during startup: $(tail -40 "$WORK/indexer.log")"
    sleep 1
  done
  curl -fsS "$INDEXER_API/ready" >/dev/null \
    || die "indexer did not become ready: $(tail -40 "$WORK/indexer.log")"
fi

RELAY_A_PORT=$((BASE_PORT + 11))
RELAY_B_PORT=$((BASE_PORT + 12))
IPFS_A="[{\"name\":\"relay-a-primary\",\"apiUrl\":\"http://127.0.0.1:${KUBO_PORTS[0]}\"},{\"name\":\"relay-a-secondary\",\"apiUrl\":\"http://127.0.0.1:${KUBO_PORTS[1]}\"}]"
IPFS_B="[{\"name\":\"relay-b-primary\",\"apiUrl\":\"http://127.0.0.1:${KUBO_PORTS[2]}\"},{\"name\":\"relay-b-secondary\",\"apiUrl\":\"http://127.0.0.1:${KUBO_PORTS[3]}\"}]"

start_relays() {
  local target_registry="$1" log_suffix="$2" port log
  say "== start two relays for $target_registry with distinct keys and stores =="
  env RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" REGISTRY_ADDRESS="$target_registry" EAS_ADDRESS="$EAS" \
    EAS_VERSION="$EAS_VERSION" SCHEMA_UID="$SCHEMA" RELAYER_PRIVATE_KEY="$RELAYER_A_KEY" \
    IPFS_TARGETS_JSON="$IPFS_A" STORAGE_QUORUM=2 NODE_REQUESTS_PER_MINUTE=20 \
    HOST=127.0.0.1 PORT="$RELAY_A_PORT" \
    ./node_modules/.bin/tsx packages/eas-offchain-relay/src/main.ts \
    >"$WORK/relay-a-$log_suffix.log" 2>&1 &
  RELAY_A_PID=$!
  PIDS+=("$RELAY_A_PID")
  env RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" REGISTRY_ADDRESS="$target_registry" EAS_ADDRESS="$EAS" \
    EAS_VERSION="$EAS_VERSION" SCHEMA_UID="$SCHEMA" RELAYER_PRIVATE_KEY="$RELAYER_B_KEY" \
    IPFS_TARGETS_JSON="$IPFS_B" STORAGE_QUORUM=2 NODE_REQUESTS_PER_MINUTE=20 \
    HOST=127.0.0.1 PORT="$RELAY_B_PORT" \
    ./node_modules/.bin/tsx packages/eas-offchain-relay/src/main.ts \
    >"$WORK/relay-b-$log_suffix.log" 2>&1 &
  RELAY_B_PID=$!
  PIDS+=("$RELAY_B_PID")
  for port in "$RELAY_A_PORT" "$RELAY_B_PORT"; do
    if [ "$port" = "$RELAY_A_PORT" ]; then log="$WORK/relay-a-$log_suffix.log"; else log="$WORK/relay-b-$log_suffix.log"; fi
    for _ in $(seq 1 80); do
      curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
      sleep 0.1
    done
    curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null \
      || die "relay $port did not start: $(tail -20 "$log")"
  done
}

stop_relays() {
  for pid in "$RELAY_A_PID" "$RELAY_B_PID"; do
    [ -n "$pid" ] || continue
    kill_tree "$pid"
    wait "$pid" 2>/dev/null || true
  done
  RELAY_A_PID=""
  RELAY_B_PID=""
}

start_relays "$REGISTRY" factory-created

if [ "$BROWSER_MODE" = 1 ]; then
  APP_PORT=$((BASE_PORT + 31))
  APP_URL="http://127.0.0.1:$APP_PORT"
  FRONTEND_DIST_NAME=".next-eas-offchain-e2e-$$"
  FRONTEND_DIST_PATH="$(pwd)/packages/frontend/$FRONTEND_DIST_NAME"
  FRONTEND_TSCONFIG_NAME=".tsconfig-eas-offchain-e2e-$$.json"
  FRONTEND_TSCONFIG_PATH="$(pwd)/packages/frontend/$FRONTEND_TSCONFIG_NAME"
  if [ -f "$FRONTEND_CONFIG_FILE" ]; then
    cp "$FRONTEND_CONFIG_FILE" "$WORK/frontend-config.original.json"
    FRONTEND_CONFIG_EXISTED=1
  else
    # Fresh CI checkouts do not contain the ignored deployment output. The tracked typecheck
    # template has the complete config shape; the jq patch below replaces every live E2E address.
    cp "$FRONTEND_CONFIG_TEMPLATE" "$FRONTEND_CONFIG_FILE"
  fi
  FRONTEND_CONFIG_REPLACED=1
  jq --arg ponder "$INDEXER_API" --arg eas "$EAS" \
    --arg schemaRegistry "$SCHEMA_REGISTRY" --arg schemaRegistrar "$SCHEMA_REGISTRAR" \
    --arg factory "$FACTORY" --arg governedFactory "$GOVERNED_FACTORY" \
    --arg gateway "http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/" \
    '.apis.ponder = $ponder | .apis.ipfsGateway = $gateway | .contracts.EAS = $eas | .contracts.SchemaRegistry = $schemaRegistry | .contracts.SchemaRegistrar = $schemaRegistrar | .contracts.TrustgraphsFactory = $factory | .contracts.GovernedTrustgraphsFactory = $governedFactory' \
    "$FRONTEND_CONFIG_FILE" >"$WORK/frontend-config.e2e.json"
  cp "$WORK/frontend-config.e2e.json" "$FRONTEND_CONFIG_FILE"
  cp "$FRONTEND_CONTRACTS_FILE" "$WORK/frontend-contracts.original.ts"
  cp "$FRONTEND_ABIS_FILE" "$WORK/frontend-contract-abis.original.ts"
  FRONTEND_WAGMI_REPLACED=1
  pnpm --dir packages/frontend wagmi:generate >"$WORK/frontend-wagmi.log" 2>&1 \
    || die "frontend contract address generation failed: $(tail -80 "$WORK/frontend-wagmi.log")"
  cp packages/frontend/tsconfig.json "$FRONTEND_TSCONFIG_PATH"
  RPC_WEBSOCKET="${EAS_OFFCHAIN_E2E_WEBSOCKET:-${RPC/http:/ws:}}"
  PUBLIC_RELAYS="http://127.0.0.1:$RELAY_A_PORT,http://127.0.0.1:$RELAY_B_PORT"
  PUBLIC_RELAYER_ADDRESSES="$RELAYER_A,$RELAYER_B"
  IPFS_PIN_API="http://127.0.0.1:${KUBO_PORTS[0]}/api/v0/add?pin=true"

  say "== build and start the production frontend for browser acceptance =="
  env NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR="$FRONTEND_DIST_NAME" \
    NEXT_TSCONFIG_PATH="$FRONTEND_TSCONFIG_NAME" \
    NEXT_PUBLIC_RPC_URL_31337="$RPC" \
    NEXT_PUBLIC_WEBSOCKET_URL_31337="$RPC_WEBSOCKET" \
    NEXT_PUBLIC_EAS_OFFCHAIN_RELAYER_ADDRESSES="$PUBLIC_RELAYER_ADDRESSES" \
    NEXT_PUBLIC_EAS_OFFCHAIN_RELAY_URLS="$PUBLIC_RELAYS" \
    NEXT_PUBLIC_EAS_OFFCHAIN_GATEWAYS="$GATEWAYS" \
    pnpm --dir packages/frontend exec next build >"$WORK/frontend-build.log" 2>&1 \
    || die "frontend build failed: $(tail -80 "$WORK/frontend-build.log")"
  env NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR="$FRONTEND_DIST_NAME" \
    NEXT_TSCONFIG_PATH="$FRONTEND_TSCONFIG_NAME" \
    IPFS_PIN_API="$IPFS_PIN_API" \
    NEXT_PUBLIC_RPC_URL_31337="$RPC" \
    NEXT_PUBLIC_WEBSOCKET_URL_31337="$RPC_WEBSOCKET" \
    NEXT_PUBLIC_EAS_OFFCHAIN_RELAYER_ADDRESSES="$PUBLIC_RELAYER_ADDRESSES" \
    NEXT_PUBLIC_EAS_OFFCHAIN_RELAY_URLS="$PUBLIC_RELAYS" \
    NEXT_PUBLIC_EAS_OFFCHAIN_GATEWAYS="$GATEWAYS" \
    pnpm --dir packages/frontend exec next start --hostname 127.0.0.1 --port "$APP_PORT" \
    >"$WORK/frontend.log" 2>&1 &
  FRONTEND_PID=$!
  PIDS+=("$FRONTEND_PID")
  for _ in $(seq 1 120); do
    curl -fsS "$APP_URL" >/dev/null 2>&1 && break
    kill -0 "$FRONTEND_PID" 2>/dev/null \
      || die "frontend exited during startup: $(tail -60 "$WORK/frontend.log")"
    sleep 1
  done
  curl -fsS "$APP_URL" >/dev/null \
    || die "frontend did not become ready: $(tail -60 "$WORK/frontend.log")"
fi

say "== official SDK -> relay race -> retained mixed-lane revoke =="
EAS_OFFCHAIN_E2E_DEPLOY_FILE="$DEPLOY_FILE" \
EAS_OFFCHAIN_E2E_OUTPUT_FILE="$DRIVER_OUTPUT" \
EAS_OFFCHAIN_E2E_DEPLOYER_KEY="$DEPLOYER_KEY" \
EAS_OFFCHAIN_E2E_RELAYER_A="$RELAYER_A" EAS_OFFCHAIN_E2E_RELAYER_B="$RELAYER_B" \
EAS_OFFCHAIN_E2E_RELAYS="http://127.0.0.1:$RELAY_A_PORT,http://127.0.0.1:$RELAY_B_PORT" \
EAS_OFFCHAIN_E2E_GATEWAYS="$GATEWAYS" RPC="$RPC" \
  pnpm exec tsx tests/e2e/eas-offchain-strict.ts

if [ "${EAS_OFFCHAIN_E2E_INDEXER:-0}" = 1 ]; then
  say "== verify live factory discovery, CID health, history, and revoked current state =="
  INSTANCE_ID="$(jq -r .instanceId "$DRIVER_OUTPUT")"
  NODE_ID="$(jq -r .nodeId "$DRIVER_OUTPUT")"
  FIRST_COMMITMENT="$(jq -r .firstCommitment "$DRIVER_OUTPUT")"
  REVOKE_COMMITMENT="$(jq -r .revokeCommitment "$DRIVER_OUTPUT")"
  INDEXED=0
  for attempt in $(seq 1 180); do
    if curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/utilization" >"$WORK/indexer-utilization.json" 2>/dev/null \
      && [ "$(jq -r .anchorCount "$WORK/indexer-utilization.json")" = 2 ] \
      && [ "$(jq -r .workCount "$WORK/indexer-utilization.json")" = 10 ]; then
      INDEXED=1
      break
    fi
    kill -0 "$INDEXER_PID" 2>/dev/null \
      || die "indexer exited while ingesting strict events: $(tail -60 "$WORK/indexer.log")"
    if [ $((attempt % 5)) = 0 ]; then cast rpc evm_mine --rpc-url "$RPC" >/dev/null; fi
    sleep 1
  done
  [ "$INDEXED" = 1 ] || die "strict events did not reach the API: $(tail -60 "$WORK/indexer.log")"

  curl -fsS "$INDEXER_API/instances/$INSTANCE_ID" >"$WORK/indexer-instance.json"
  curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/config" >"$WORK/indexer-config.json"
  curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/nodes" >"$WORK/indexer-nodes.json"
  curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/nodes/$NODE_ID/history" >"$WORK/indexer-history.json"
  curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/nodes/$NODE_ID/mutations" >"$WORK/indexer-mutations.json"
  curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/cids/$FIRST_COMMITMENT" >"$WORK/indexer-first-cid.json"
  curl -fsS "$INDEXER_API/eas-offchain/$REGISTRY/cids/$REVOKE_COMMITMENT" >"$WORK/indexer-revoke-cid.json"
  [ "$(jq -r .instance.offchainLane.registry "$WORK/indexer-instance.json" | tr '[:upper:]' '[:lower:]')" = "${REGISTRY,,}" ] \
    || die "instance API did not publish authenticated strict provenance"
  [ "$(jq -r .lane.registry "$WORK/indexer-config.json" | tr '[:upper:]' '[:lower:]')" = "${REGISTRY,,}" ] \
    || die "strict config API returned another registry"
  [ "$(jq '[.nodes[] | select(.verified == true and .count == "2")] | length' "$WORK/indexer-nodes.json")" = 1 ] \
    || die "node API did not publish the verified newest head"
  [ "$(jq '.history | length' "$WORK/indexer-history.json")" = 2 ] \
    || die "history API omitted an anchored head"
  [ "$(jq '.mutations | length' "$WORK/indexer-mutations.json")" = 0 ] \
    || die "revoked newest payload still exposed an active mutation"
  [ "$(jq '.logEntries | length' "$WORK/indexer-mutations.json")" = 2 ] \
    || die "indexer dropped the strict revoke tombstone needed for cross-lane reconciliation"
  [ "$(jq -r '.logEntries[0].kind' "$WORK/indexer-mutations.json")" = 0 ] \
    && [ "$(jq -r '.logEntries[1].kind' "$WORK/indexer-mutations.json")" = 1 ] \
    || die "strict mutation API did not preserve attest/revoke log order"
  for cid_file in "$WORK/indexer-first-cid.json" "$WORK/indexer-revoke-cid.json"; do
    [ "$(jq -r .healthy "$cid_file")" = true ] || die "indexer reported an unhealthy retained CID"
  done
fi

say "== discover the live hybrid from InstanceRegistry + factory events =="
SCAN_DIR="$WORK/scan"
cargo run -q -p input-exporter --bin instance-scan -- \
  --rpc "$RPC" --registry "$DIRECTORY" --out-dir "$SCAN_DIR" >"$WORK/scan.log"
PLAN="$SCAN_DIR/instances.json"
[ "$(jq -r .readyCount "$PLAN")" = 1 ] || die "hybrid instance was not dynamically ready"
PLAN_REGISTRY="$(jq -r '.instances[0].anchorRegistry' "$PLAN")"
[ "${PLAN_REGISTRY,,}" = "${REGISTRY,,}" ] || die "factory discovery returned $PLAN_REGISTRY, expected $REGISTRY"
PARAMS="$(jq -r '.instances[0].paramsPath' "$PLAN")"
ACCUMULATOR="$(jq -r '.instances[0].accumulator' "$PLAN")"
SNAPSHOT="$(jq -r '.instances[0].snapshot' "$PLAN")"

say "== strict availability preflight, then checkpoint =="
PREFLIGHT=(cargo run -q -p input-exporter --bin envelope0-preflight -- \
  --rpc "$RPC" --registry "$PLAN_REGISTRY" --params "$PARAMS" \
  --envelope0-cache "$WORK/preflight-cache")
"${PREFLIGHT[@]}" \
  --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/" \
  --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[2]}/ipfs/" \
  >"$WORK/preflight.json"

publish_checkpoint() {
  local checkpoint="$1" expected_anchors="$2" expected_work="$3"
  local input="$WORK/input-$checkpoint.json"
  local score_blob="$WORK/score-$checkpoint.json"
  local native_log="$WORK/native-$checkpoint.log"
  local output_root ipfs_hash score_cid total_value skipped_digest current_root

  say "== freeze, reconstruct, execute, publish, and submit checkpoint $checkpoint =="
  cast send "$SNAPSHOT" 'trigger()' --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
  CHECKPOINT_WORK="$(cast call "$SNAPSHOT" 'checkpointWorkCount(uint256)(uint64)' "$checkpoint" --rpc-url "$RPC")"
  [ "$CHECKPOINT_WORK" = "$expected_work" ] \
    || die "checkpoint $checkpoint work $CHECKPOINT_WORK != $expected_work"

  cargo run -q -p input-exporter -- \
    --rpc "$RPC" --accumulator "$ACCUMULATOR" --eas "$EAS" --checkpoint "$checkpoint" \
    --params "$PARAMS" --snapshot "$SNAPSHOT" --anchor-registry "$PLAN_REGISTRY" \
    --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/" \
    --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[2]}/ipfs/" \
    --envelope0-cache "$WORK/export-cache-$checkpoint" --out "$input" \
    >"$WORK/export-$checkpoint.log"
  [ "$(jq '.lane2.anchors | length' "$input")" = "$expected_anchors" ] \
    || die "checkpoint $checkpoint exported incomplete anchor history"
  [ "$(jq '.lane2.payloads | length' "$input")" = 1 ] \
    || die "checkpoint $checkpoint exported an incomplete newest payload set"
  cargo run -q -p input-exporter --bin strict-input-check -- \
    --input "$input" --score-blob "$score_blob" >"$native_log"
  grep -q "^anchorCount: $expected_anchors$" "$native_log" \
    || die "checkpoint $checkpoint native execution did not bind every anchor"

  output_root="$(sed -n 's/^outputRoot: //p' "$native_log")"
  ipfs_hash="$(sed -n 's/^ipfsHash: //p' "$native_log")"
  score_cid="$(sed -n 's/^cid: //p' "$native_log")"
  total_value="$(sed -n 's/^totalValue: //p' "$native_log")"
  skipped_digest="$(sed -n 's/^skippedDigest: //p' "$native_log")"
  for port in "${KUBO_PORTS[0]}" "${KUBO_PORTS[2]}"; do
    curl -fsS -F "file=@$score_blob" \
      "http://127.0.0.1:$port/api/v0/block/put?format=raw&mhtype=sha2-256" \
      >"$WORK/score-$checkpoint-put-$port.json"
    [ "$(jq -r .Key "$WORK/score-$checkpoint-put-$port.json")" = "$score_cid" ] \
      || die "score store $port derived another CID for checkpoint $checkpoint"
  done
  cast send "$SNAPSHOT" \
    'submitProof(uint256,bytes32,bytes32,string,uint256,bytes32,address,bytes)' \
    "$checkpoint" "$output_root" "$ipfs_hash" "$score_cid" "$total_value" "$skipped_digest" \
    0x0000000000000000000000000000000000000000 0x \
    --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null

  if [ "${EAS_OFFCHAIN_E2E_INDEXER:-0}" = 1 ]; then
    INDEXED_ROOT=0
    for attempt in $(seq 1 90); do
      if curl -fsS "$INDEXER_API/merkle/$SNAPSHOT/current" \
        >"$WORK/indexer-merkle-$checkpoint.json" 2>/dev/null; then
        current_root="$(jq -r '.tree.root // empty' "$WORK/indexer-merkle-$checkpoint.json")"
        if [ "${current_root,,}" = "${output_root,,}" ]; then
          INDEXED_ROOT=1
          break
        fi
      fi
      kill -0 "$INDEXER_PID" 2>/dev/null \
        || die "indexer exited while ingesting checkpoint $checkpoint: $(tail -80 "$WORK/indexer.log")"
      if [ $((attempt % 5)) = 0 ]; then cast rpc evm_mine --rpc-url "$RPC" >/dev/null; fi
      sleep 1
    done
    [ "$INDEXED_ROOT" = 1 ] \
      || die "checkpoint $checkpoint root did not reach the normal API: $(tail -80 "$WORK/indexer.log")"
    curl -fsS "$INDEXER_API/network/$SNAPSHOT" >"$WORK/indexer-network-$checkpoint.json"
  fi

  LAST_CHECKPOINT="$checkpoint"
  LAST_INPUT="$input"
  LAST_SCORE_BLOB="$score_blob"
  LAST_OUTPUT_ROOT="$output_root"
  LAST_SCORE_CID="$score_cid"
}

publish_checkpoint 0 2 10
INPUT="$LAST_INPUT"
if [ "${EAS_OFFCHAIN_E2E_INDEXER:-0}" = 1 ]; then
  [ "$(jq '.attestations | length' "$WORK/indexer-network-0.json")" = 0 ] \
    || die "normal network API resurrected the revoked lane-1 predecessor"
fi

if [ "$BROWSER_MODE" = 1 ]; then
  INSTANCE_ID="$(jq -r .instanceId "$DRIVER_OUTPUT")"
  BROWSER_ACCOUNT="$(cast wallet address --private-key "$DEPLOYER_KEY")"
  BROWSER_RECIPIENT="0x4444444444444444444444444444444444444444"
  BROWSER_NETWORK_NAME="browser-created-strict-eas-e2e"

  run_browser_phase() {
    local phase="$1" output="$2" expected_cid="${3:-}" expected_count="${4:-}"
    env EAS_OFFCHAIN_BROWSER_PHASE="$phase" \
      EAS_OFFCHAIN_BROWSER_APP_URL="$APP_URL" RPC="$RPC" \
      EAS_OFFCHAIN_BROWSER_INSTANCE_ID="$INSTANCE_ID" \
      EAS_OFFCHAIN_BROWSER_ACCOUNT="$BROWSER_ACCOUNT" \
      EAS_OFFCHAIN_BROWSER_RECIPIENT="$BROWSER_RECIPIENT" \
      EAS_OFFCHAIN_BROWSER_NETWORK_NAME="$BROWSER_NETWORK_NAME" \
      EAS_OFFCHAIN_BROWSER_OUTPUT_FILE="$output" \
      EAS_OFFCHAIN_BROWSER_EXPECTED_CID="$expected_cid" \
      EAS_OFFCHAIN_BROWSER_EXPECTED_COUNT="$expected_count" \
      node tests/e2e/eas-offchain-browser.mjs
  }

  say "== browser creates a hybrid through the standard app wizard =="
  APP_CREATE_OUTPUT="$WORK/browser-create-network.json"
  run_browser_phase create-network "$APP_CREATE_OUTPUT"
  APP_INSTANCE_ID="$(jq -r .instanceId "$APP_CREATE_OUTPUT")"
  APP_REGISTRY="$(jq -r .registry "$APP_CREATE_OUTPUT")"
  [ "$(jq -r .defaultMode "$APP_CREATE_OUTPUT")" = onchain ] \
    || die "the standard app wizard was not on-chain-only by default"
  [ "$(jq -r .selectedMode "$APP_CREATE_OUTPUT")" = hybrid ] \
    || die "the app did not opt into the hybrid factory path"
  [ "${APP_REGISTRY,,}" != "${REGISTRY,,}" ] \
    || die "the app creation did not emit a fresh strict registry"
  [ "$(cast call "$APP_REGISTRY" 'EAS()(address)' --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')" = "${EAS,,}" ] \
    || die "the app-created registry is bound to another EAS contract"
  APP_SCHEMA="$(cast call "$APP_REGISTRY" 'schemaUid()(bytes32)' --rpc-url "$RPC")"
  [ "$APP_SCHEMA" != 0x0000000000000000000000000000000000000000000000000000000000000000 ] \
    || die "the app-created registry has no EAS schema"
  ANCHORER_ROLE="$(cast call "$APP_REGISTRY" 'ANCHORER_ROLE()(bytes32)' --rpc-url "$RPC")"
  for relayer in "$RELAYER_A" "$RELAYER_B"; do
    [ "$(cast call "$APP_REGISTRY" 'hasRole(bytes32,address)(bool)' "$ANCHORER_ROLE" "$relayer" --rpc-url "$RPC")" = true ] \
      || die "the app-created hybrid omitted configured relayer $relayer"
  done

  APP_INDEXED=0
  for attempt in $(seq 1 180); do
    if curl -fsS "$INDEXER_API/instances/$APP_INSTANCE_ID" >"$WORK/indexer-app-instance.json" 2>/dev/null \
      && [ "$(jq -r '.instance.offchainLane.registry // empty' "$WORK/indexer-app-instance.json" | tr '[:upper:]' '[:lower:]')" = "${APP_REGISTRY,,}" ]; then
      APP_INDEXED=1
      break
    fi
    kill -0 "$INDEXER_PID" 2>/dev/null \
      || die "indexer exited while discovering the app-created hybrid: $(tail -80 "$WORK/indexer.log")"
    if [ $((attempt % 5)) = 0 ]; then cast rpc evm_mine --rpc-url "$RPC" >/dev/null; fi
    sleep 1
  done
  [ "$APP_INDEXED" = 1 ] \
    || die "app-created hybrid did not reach the normal instance API: $(tail -80 "$WORK/indexer.log")"

  say "== independently discover the app-created hybrid from factory events =="
  APP_SCAN_DIR="$WORK/app-scan"
  cargo run -q -p input-exporter --bin instance-scan -- \
    --rpc "$RPC" --registry "$DIRECTORY" --out-dir "$APP_SCAN_DIR" >"$WORK/app-scan.log"
  APP_PLAN="$APP_SCAN_DIR/instances.json"
  [ "$(jq --arg id "${APP_INSTANCE_ID,,}" '[.instances[] | select((.instanceId | ascii_downcase) == $id)] | length' "$APP_PLAN")" = 1 ] \
    || die "factory scanning did not find exactly one app-created hybrid"
  [ "$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .status' "$APP_PLAN")" = skipped ] \
    || die "the empty app-created hybrid was unexpectedly proof-ready"
  [ "$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .reason' "$APP_PLAN")" = "neither input lane has entries yet — nothing to prove" ] \
    || die "the empty app-created hybrid was skipped for an unexpected reason"
  PLAN_REGISTRY="$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .anchorRegistry' "$APP_PLAN")"
  [ "${PLAN_REGISTRY,,}" = "${APP_REGISTRY,,}" ] \
    || die "app success and independent factory discovery disagree on the registry"
  PARAMS="$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .paramsPath' "$APP_PLAN")"
  ACCUMULATOR="$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .accumulator' "$APP_PLAN")"
  SNAPSHOT="$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .snapshot' "$APP_PLAN")"
  INSTANCE_ID="$APP_INSTANCE_ID"
  REGISTRY="$APP_REGISTRY"
  SCHEMA="$APP_SCHEMA"
  FINAL_INSTANCE_ID="$APP_INSTANCE_ID"

  say "== retarget relays to the app-created immutable registry =="
  stop_relays
  start_relays "$APP_REGISTRY" app-created

  say "== browser uses the unchanged wallet-paid on-chain EAS flow =="
  run_browser_phase onchain-create "$WORK/browser-onchain-create.json"
  [ "$(cast call "$ACCUMULATOR" 'leafCount()(uint64)' --rpc-url "$RPC")" = 1 ] \
    || die "browser on-chain vouch did not append exactly one accumulator leaf"
  cargo run -q -p input-exporter --bin instance-scan -- \
    --rpc "$RPC" --registry "$DIRECTORY" --out-dir "$WORK/app-ready-scan" \
    >"$WORK/app-ready-scan.log"
  [ "$(jq -r --arg id "${APP_INSTANCE_ID,,}" '.instances[] | select((.instanceId | ascii_downcase) == $id) | .status' "$WORK/app-ready-scan/instances.json")" = ready ] \
    || die "the app-created hybrid did not become proof-ready after its on-chain vouch"
  ONCHAIN_INDEXED=0
  for attempt in $(seq 1 120); do
    if curl -fsS "$INDEXER_API/account/${BROWSER_ACCOUNT,,}/attestations" \
      >"$WORK/indexer-onchain-attestations.json" 2>/dev/null \
      && [ "$(jq --arg schema "${APP_SCHEMA,,}" --arg recipient "${BROWSER_RECIPIENT,,}" \
        '[.attestations[] | select((.schema | ascii_downcase) == $schema and (.recipient | ascii_downcase) == $recipient and .revocationTime == "0")] | length' \
        "$WORK/indexer-onchain-attestations.json")" = 1 ]; then
      ONCHAIN_INDEXED=1
      break
    fi
    kill -0 "$INDEXER_PID" 2>/dev/null \
      || die "indexer exited while ingesting the browser on-chain vouch: $(tail -80 "$WORK/indexer.log")"
    if [ $((attempt % 5)) = 0 ]; then cast rpc evm_mine --rpc-url "$RPC" >/dev/null; fi
    sleep 1
  done
  [ "$ONCHAIN_INDEXED" = 1 ] \
    || die "browser on-chain vouch did not reach the normal attestation API"

  say "== browser replaces it with a gasless vouch and no member transaction =="
  CREATE_BUNDLE="$WORK/browser-create-bundle.json"
  run_browser_phase create "$CREATE_BUNDLE" "" 1
  CREATE_CID="$(jq -r .cid "$CREATE_BUNDLE")"
  [ "$(jq -r .message.count "$CREATE_BUNDLE")" = 1 ] \
    || die "browser create did not append the first strict head"

  say "== preflight and publish the app-created cross-lane checkpoint =="
  cargo run -q -p input-exporter --bin envelope0-preflight -- \
    --rpc "$RPC" --registry "$PLAN_REGISTRY" --params "$PARAMS" \
    --envelope0-cache "$WORK/app-preflight-cache" \
    --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/" \
    --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[2]}/ipfs/" \
    >"$WORK/app-preflight.json"
  publish_checkpoint 0 1 5
  [ "$(jq '.attestations | length' "$WORK/indexer-network-0.json")" = 1 ] \
    || die "browser-created current vouch was absent from the normal network API"
  [ "$(jq -r '.attestations[0].provenance.source' "$WORK/indexer-network-0.json")" = off-chain-eas ] \
    || die "browser-created vouch lost its off-chain provenance"
  [ "$(jq -r '.attestations[0].provenance.cid' "$WORK/indexer-network-0.json")" = "$CREATE_CID" ] \
    || die "browser-created vouch exposed another CID"
  [ "$(jq -r '.attestations[0].provenance.storageHealthy' "$WORK/indexer-network-0.json")" = true ] \
    || die "browser-created vouch was not independently storage-verified"

  say "== browser renders exact provenance and appends the in-log revoke =="
  REVOKE_BUNDLE="$WORK/browser-revoke-bundle.json"
  run_browser_phase render-revoke "$REVOKE_BUNDLE" "$CREATE_CID" 2
  [ "$(jq -r .message.count "$REVOKE_BUNDLE")" = 2 ] \
    || die "browser revoke did not append strict count 2"
  publish_checkpoint 1 2 10
  INPUT="$LAST_INPUT"
  [ "$(jq '.attestations | length' "$WORK/indexer-network-1.json")" = 0 ] \
    || die "browser revoke resurrected an older vouch in the normal network API"

  say "== browser renders the published no-resurrection state =="
  run_browser_phase render-final "$WORK/browser-final.json"
fi

say "== malicious omission and total reader loss fail closed =="
jq '.lane2.payloads = []' "$INPUT" >"$WORK/omitted.json"
if cargo run -q -p input-exporter --bin strict-input-check -- --input "$WORK/omitted.json" \
  >"$WORK/omitted.log" 2>&1; then
  die "native execution accepted an omitted newest payload"
fi
if cargo run -q -p input-exporter --bin envelope0-preflight -- \
  --rpc "$RPC" --registry "$PLAN_REGISTRY" --params "$PARAMS" \
  --envelope0-cache "$WORK/missing-cache" --envelope0-gateway http://127.0.0.1:1/ipfs/ \
  >"$WORK/missing.log" 2>&1; then
  die "strict preflight accepted total reader loss"
fi
grep -q 'E0_AVAILABILITY' "$WORK/missing.log" || die "reader loss lacked E0_AVAILABILITY"

say "== one reader loss still reconstructs from the independent store =="
kill "${KUBO_PIDS[0]}" 2>/dev/null || true
wait "${KUBO_PIDS[0]}" 2>/dev/null || true
cargo run -q -p input-exporter --bin envelope0-preflight -- \
  --rpc "$RPC" --registry "$PLAN_REGISTRY" --params "$PARAMS" \
  --envelope0-cache "$WORK/failover-cache" \
  --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[0]}/ipfs/" \
  --envelope0-gateway "http://127.0.0.1:${KUBO_PORTS[1]}/ipfs/" \
  >"$WORK/failover.json"

if [ "${EAS_OFFCHAIN_E2E_ZK:-0}" = 1 ]; then
  say "== SP1 mock execute + Groth16 proof =="
  SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
    cargo run -q --release --manifest-path zk/prover/Cargo.toml -- trust-graph execute "$INPUT"
  SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
    cargo run -q --release --manifest-path zk/prover/Cargo.toml -- trust-graph prove "$INPUT" --groth16
  if SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true \
    cargo run -q --release --manifest-path zk/prover/Cargo.toml -- trust-graph execute "$WORK/omitted.json"; then
    die "SP1 guest accepted malicious lane omission"
  fi
fi

say "STRICT EAS OFFCHAIN E2E PASS"
say "  instance=${FINAL_INSTANCE_ID:-$(jq -r .instanceId "$DRIVER_OUTPUT")}"
say "  registry=$PLAN_REGISTRY checkpoint=$LAST_CHECKPOINT work=$CHECKPOINT_WORK"
say "  artifacts=$WORK"
