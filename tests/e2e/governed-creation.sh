#!/usr/bin/env bash
#
# M0 regression: creating a governed instance must never wedge the indexer.
#
#   create through GovernedTrustgraphsFactory  ->  (a) the indexer process stays up
#                                               ->  (b) GET /instances/:id is 200 with governance populated
#   trigger + submit a root (mock SP1 gateway)  ->  (c) the root indexes (/network/:snapshot is 200)
#   restart the indexer over the creation block ->  no crash-loop, catalog intact
#
# Why this exists: MerkleGovModule's constructor emits MerkleSnapshotContractUpdated before the
# wrapper emits GovernedInstanceCreated. Ponder's factory() child matching is block-granular, so
# the constructor log used to hit a bare merkle_gov_module UPDATE before any row existed:
# RecordNotFoundError, the whole creation block's transaction rolled back (including the
# InstanceCreated row), and every restart replayed the block and died again — a permanent wedge.
# The fix is the ensure-by-readback pattern in packages/indexer/src/gov.ts + gov-module-shared.ts; this
# script is its live proof, and (c) covers the second wedge (the module re-emits MerkleRootUpdated
# as a snapshot hook on the instance's first proof).
#
# Prerequisites (checked below):
#   - a dev chain at $RPC with the dev stack deployed:  pnpm deploy:full   (anvil, DEPLOY_STAGE=development)
#   - Postgres reachable at $DATABASE_URL — the indexer API requires it. No docker needed; e.g.:
#       npm install embedded-postgres   # in a scratch dir OUTSIDE the repo
#       node -e 'import("embedded-postgres").then(async ({default: EP}) => {
#         const pg = new EP({databaseDir: "./data", user: "postgres", password: "postgres",
#                            port: 5434, persistent: true});
#         await pg.initialise(); await pg.start(); await pg.createDatabase("trustgraphs");
#         console.log("ready"); })'
#       export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5434/trustgraphs
#   - node deps installed (pnpm install), forge/cast/jq on PATH.
#
# Env overrides: RPC (default http://127.0.0.1:8545), PK (default anvil key 0 — LOCAL ONLY),
#   INDEXER_PORT (default 42171), KUBO_STUB_PORT (default 42172), PARAMS_JSON (default params.json,
#   provisioned from tests/e2e/params.template.json if absent).
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

RPC="${RPC:-http://127.0.0.1:8545}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"  # anvil key 0
export FUNDED_KEY="$PK"
INDEXER_PORT="${INDEXER_PORT:-42171}"
STUB_PORT="${KUBO_STUB_PORT:-42172}"
API="http://127.0.0.1:${INDEXER_PORT}"
: "${DATABASE_URL:?DATABASE_URL is required (see the header for a docker-free embedded-postgres recipe)}"

for tool in forge cast jq pnpm node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: '$tool' not found in PATH"; exit 1; }
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "FATAL: no chain at $RPC"; exit 1; }
[ -f .docker/governed_factory_deploy.json ] || {
  echo "FATAL: .docker/governed_factory_deploy.json missing — run 'pnpm deploy:full' against $RPC first"
  exit 1
}
GOVERNED_FACTORY=$(jq -r .governed_factory .docker/governed_factory_deploy.json)

PARAMS="${PARAMS_JSON:-params.json}"
[ -f "$PARAMS" ] || cp tests/e2e/params.template.json "$PARAMS"

WORK="$(mktemp -d)"
INDEXER_PID=""
STUB_PID=""

kill_tree() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  kill_tree "$INDEXER_PID"
  kill_tree "$STUB_PID"
  rm -rf "$WORK"
}
trap cleanup EXIT

indexer_alive() { [ -n "$INDEXER_PID" ] && kill -0 "$INDEXER_PID" 2>/dev/null; }

start_indexer() {
  echo "== starting indexer on :$INDEXER_PORT =="
  env DATABASE_URL="$DATABASE_URL" DEPLOY_STAGE=development \
    RPC_URL="$RPC" PONDER_RPC_URL_31337="$RPC" PONDER_PORT="$INDEXER_PORT" \
    IPFS_GATEWAY="http://127.0.0.1:${STUB_PORT}/ipfs/" \
    pnpm -C indexer run start >"$WORK/indexer.log" 2>&1 &
  INDEXER_PID=$!
  for _ in $(seq 1 240); do
    curl -sf "$API/ready" >/dev/null 2>&1 && return 0
    indexer_alive || { echo "FATAL: indexer exited during startup"; tail -50 "$WORK/indexer.log"; exit 1; }
    sleep 1
  done
  echo "FATAL: indexer did not become ready"; tail -50 "$WORK/indexer.log"; exit 1
}

start_indexer

# --- create a governed instance (the reported crash repro) ----------------------------------
NAME="m0 governed e2e $(date +%s)"
echo "== creating governed instance through $GOVERNED_FACTORY =="
forge script contracts/script/GovernedCreationE2e.s.sol:CreateGovernedInstanceE2e \
  --sig "run(string,string,string)" "$GOVERNED_FACTORY" "$PARAMS" "$NAME" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --slow >"$WORK/create.log" 2>&1 \
  || { tail -30 "$WORK/create.log"; exit 1; }
INSTANCE_ID=$(jq -r .instance_id .docker/governed_creation_e2e.json)
SNAPSHOT=$(jq -r .snapshot .docker/governed_creation_e2e.json)
MODULE=$(jq -r .merkle_gov_module .docker/governed_creation_e2e.json)
echo "   instance: $INSTANCE_ID"
echo "   snapshot: $SNAPSHOT"

# (a)+(b): the indexer survives the creation block and serves the instance with governance.
echo "== waiting for GET /instances/:id with governance populated =="
INSTANCE_OK=""
for _ in $(seq 1 120); do
  indexer_alive || { echo "FAIL (a): indexer process died on the creation block"; tail -50 "$WORK/indexer.log"; exit 1; }
  BODY=$(curl -sf "$API/instances/$INSTANCE_ID" 2>/dev/null || true)
  if [ -n "$BODY" ]; then
    GOT_MODULE=$(echo "$BODY" | jq -r '.instance.contracts.merkleGovModule // empty' | tr '[:upper:]' '[:lower:]')
    GOT_SAFE=$(echo "$BODY" | jq -r '.instance.contracts.safe.proxy // empty')
    if [ "$GOT_MODULE" = "$(echo "$MODULE" | tr '[:upper:]' '[:lower:]')" ] && [ -n "$GOT_SAFE" ]; then
      INSTANCE_OK=1; break
    fi
  fi
  sleep 1
done
[ -n "$INSTANCE_OK" ] || { echo "FAIL (b): /instances/$INSTANCE_ID never returned governance"; tail -50 "$WORK/indexer.log"; exit 1; }
echo "   OK: indexer up, instance served with merkleGovModule + safe"

# (c): a subsequent root submission indexes. The blob is served through the kubo stub so the
# ingestion path (fetch, root recomputation, member list) runs for real without an IPFS daemon.
CID="bafym0governedcreatione2e"
CREATOR=$(cast wallet address --private-key "$PK" | tr '[:upper:]' '[:lower:]')
BLOB="$WORK/scores.json"
printf '{"%s":"100"}' "$CREATOR" >"$BLOB"
ROOT_JSON=$(node --import tsx tests/e2e/compute-dev-root.mjs "$BLOB")
ROOT=$(echo "$ROOT_JSON" | jq -r .root)
TOTAL=$(echo "$ROOT_JSON" | jq -r .totalValue)
IPFS_HASH=$(cast keccak "$(cat "$BLOB")")

echo "== serving blob via kubo stub on :$STUB_PORT =="
EXPECTED_CID="$CID" PORT="$STUB_PORT" node tests/e2e/kubo-stub.mjs >"$WORK/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 20); do curl -sf "http://127.0.0.1:$STUB_PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf -X POST -F "file=@$BLOB" "http://127.0.0.1:$STUB_PORT/api/v0/add?pin=true" >/dev/null

echo "== trigger + submit root $ROOT =="
# The instance's effective epoch is 1 block and anvil only mines on demand, so the creation block
# is still the head: mine one block so trigger()'s epoch gate passes in forge's simulation too.
cast rpc evm_mine --rpc-url "$RPC" >/dev/null 2>&1 || true
forge script contracts/script/GovernedCreationE2e.s.sol:SubmitDevRootE2e \
  --sig "run(string,bytes32,bytes32,string,uint256)" "$SNAPSHOT" "$ROOT" "$IPFS_HASH" "$CID" "$TOTAL" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --slow >"$WORK/submit.log" 2>&1 \
  || { tail -30 "$WORK/submit.log"; exit 1; }

ROOT_OK=""
for _ in $(seq 1 120); do
  indexer_alive || { echo "FAIL (c): indexer process died on the root submission"; tail -50 "$WORK/indexer.log"; exit 1; }
  if curl -sf "$API/network/$SNAPSHOT" >/dev/null 2>&1; then ROOT_OK=1; break; fi
  sleep 1
done
[ -n "$ROOT_OK" ] || { echo "FAIL (c): /network/$SNAPSHOT never became available after the root submission"; tail -50 "$WORK/indexer.log"; exit 1; }
echo "   OK: root indexed, member list built"

# Restart over the creation block: the historical crash-loop case.
echo "== restarting the indexer over the creation block =="
kill_tree "$INDEXER_PID"; INDEXER_PID=""
sleep 2
start_indexer
# /ready reports backfill-to-finalized only. Crash recovery rolls unfinalized rows back to the
# finalized tag (which anvil holds ~32 blocks behind the head), and realtime sync only walks the
# gap when a NEW head arrives — which a quiescent dev chain never produces. Mine a nudge block so
# the creation block genuinely REPLAYS through the live path (this is exactly the historical
# crash-loop scenario), then poll.
RESTART_OK=""
for i in $(seq 1 120); do
  indexer_alive || { echo "FAIL: indexer died after restart (the crash-loop case)"; tail -50 "$WORK/indexer.log"; exit 1; }
  if curl -sf "$API/instances/$INSTANCE_ID" 2>/dev/null | jq -e '.instance.contracts.merkleGovModule' >/dev/null 2>&1; then
    RESTART_OK=1; break
  fi
  # Every few seconds, produce a block so a dev chain's realtime sync has a head to react to.
  [ $((i % 5)) -eq 1 ] && cast rpc evm_mine --rpc-url "$RPC" >/dev/null 2>&1 || true
  sleep 1
done
[ -n "$RESTART_OK" ] || { echo "FAIL: instance lost after restart"; tail -50 "$WORK/indexer.log"; exit 1; }
echo "   OK: restart survives, catalog intact"

echo "PASS: governed creation e2e — indexer survived creation, served governance, indexed a root, and survived a restart"
