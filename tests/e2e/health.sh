#!/usr/bin/env bash
#
# The read-only health listener, held to its claim.
#
# `curl /ready` has to fail while the daemon is wedged and succeed while it is ticking. That is
# only worth testing against a REAL wedge: the chain reads hang, the process stays perfectly
# responsive, and the last completed tick goes stale. A killed chain does not test it — the daemon
# gets connection-refused, handles it in milliseconds, and keeps ticking.
#
#   bash tests/e2e/health.sh
#
# Needs anvil, forge, node, curl, jq and a built operator. The only contract it deploys is an
# empty InstanceRegistry, so the tick loop runs end to end in about a second with nothing to prove
# — this test is about the listener, not about proving.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RPC_PORT="${RPC_PORT:-8562}"
PROXY_PORT="${PROXY_PORT:-8563}"
HEALTH_PORT="${HEALTH_PORT:-8564}"
WORK="${WORK:-/tmp/health-e2e}"
MARKER="$WORK/wedge"
READY_AFTER=5

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"
cleanup() {
  [ -n "${OP_PID:-}" ]    && kill "$OP_PID"    2>/dev/null
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null
  return 0
}
# INT and TERM as well as EXIT: under `timeout`, bash takes the signal and skips an
# EXIT-only trap, which leaves a daemon holding the listener port and the next run's chain.
trap cleanup EXIT INT TERM

# Refuse to start on top of another run. Two of these sharing a port is not a clean failure: the
# second daemon cannot bind, exits, and the first one keeps writing to a log file the second one
# already deleted — which reads as "the daemon went silent" and is nothing of the kind.
port_free() { # port_free <port> <what>
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
    exec 3<&- 3>&-
    die "port $1 ($2) is already in use. Another run of this script is probably still going."
  fi
  return 0
}
port_free "${RPC_PORT}" "the chain"
port_free "${PROXY_PORT}" "the proxy"
port_free "${HEALTH_PORT}" "the health listener"

say "== chain on :$RPC_PORT, wedgeable proxy on :$PROXY_PORT =="
anvil --silent --port "$RPC_PORT" & ANVIL_PID=$!
for _ in $(seq 1 40); do
  cast block-number --rpc-url "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1 && break
  sleep 0.25
done
cast block-number --rpc-url "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1 || die "anvil did not start"

PORT="$PROXY_PORT" UPSTREAM="$RPC_PORT" MARKER="$MARKER" \
  node tests/e2e/rpc-blackhole.mjs >"$WORK/proxy.log" 2>&1 & PROXY_PID=$!
for _ in $(seq 1 40); do
  cast block-number --rpc-url "http://127.0.0.1:$PROXY_PORT" >/dev/null 2>&1 && break
  sleep 0.25
done
cast block-number --rpc-url "http://127.0.0.1:$PROXY_PORT" >/dev/null 2>&1 \
  || die "the proxy is not forwarding: $(cat "$WORK/proxy.log")"

PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPLOYER=$(cast wallet address --private-key "$PK")
REGISTRY=$(forge create contracts/src/registry/InstanceRegistry.sol:InstanceRegistry \
  --rpc-url "http://127.0.0.1:$RPC_PORT" --private-key "$PK" --broadcast --json \
  --constructor-args "$DEPLOYER" | jq -r .deployedTo)
[ -n "$REGISTRY" ] && [ "$REGISTRY" != "null" ] || die "could not deploy an empty registry"
say "   registry=$REGISTRY (empty)"

# The secrets the projection must never publish. They are put in the config precisely so the test
# can go looking for them in the body.
WEBHOOK="http://127.0.0.1:9/alerts-SECRET-WEBHOOK-TOKEN"
cat > "$WORK/operator.toml" <<EOF
rpc      = "http://127.0.0.1:$PROXY_PORT"
registry = "$REGISTRY"
chain_id = 31337

[cadence]
tick_seconds = 1

[prover]
backend = "mock"

[ops]
state_dir           = "."
listen              = "127.0.0.1:$HEALTH_PORT"
ready_after_seconds = $READY_AFTER
alert_webhook       = "$WEBHOOK"
log_format          = "json"
EOF

BASE="http://127.0.0.1:$HEALTH_PORT"
code() { curl -s -o "$WORK/body.txt" -w '%{http_code}' --max-time 5 "$BASE$1" 2>/dev/null || echo 000; }
wait_for() { # wait_for <path> <code> <seconds>
  local deadline=$((SECONDS + $3))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(code "$1")" = "$2" ] && return 0
    sleep 0.5
  done
  return 1
}

say "== start the daemon =="
SUBMITTER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
SP1_SKIP_PROGRAM_BUILD=true \
  cargo run -q --release --manifest-path zk/operator/Cargo.toml -- \
    --config "$WORK/operator.toml" >"$WORK/run.log" 2>&1 &
OP_PID=$!

wait_for /health 200 180 || die "the listener never answered /health: $(tail -5 "$WORK/run.log")"
say "   ${GREEN}/health 200 ✓${NC}"

wait_for /ready 200 30 || die "/ready never went green: $(tail -5 "$WORK/run.log")"
say "   ${GREEN}/ready 200 while ticking ✓${NC}"

# --- what the body may and may not contain -------------------------------------------
[ "$(code /status)" = "200" ] || die "/status did not answer 200"
BODY=$(cat "$WORK/body.txt")
printf '%s' "$BODY" | jq -e '.head_block != null and .tick_at != null and .instances != null' \
  >/dev/null || die "/status is not the heartbeat shape: $BODY"
for SECRET in "SECRET-WEBHOOK-TOKEN" "$PROXY_PORT" "$WORK" "alerts" "unresolved"; do
  printf '%s' "$BODY" | grep -qF -- "$SECRET" \
    && die "the heartbeat published something it must not: found '$SECRET' in $BODY"
done
say "   ${GREEN}/status carries the heartbeat and none of the endpoints, paths or alerts ✓${NC}"

# --- read-only, three routes ----------------------------------------------------------
[ "$(code /journal.jsonl)" = "404" ] || die "an unlisted route answered"
[ "$(code /)" = "404" ] || die "the root answered"
POST=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$BASE/status" 2>/dev/null)
[ "$POST" = "405" ] || die "a write method was not refused (got $POST)"
say "   ${GREEN}three routes, GET only ✓${NC}"

# --- the wedge -------------------------------------------------------------------------
say "== wedge the chain reads: the process stays up, the work stops =="
touch "$MARKER"
if ! wait_for /ready 503 $((READY_AFTER * 6 + 20)); then
  die "/ready stayed green while the daemon could not read the chain: $(cat "$WORK/body.txt")"
fi
WEDGED=$(cat "$WORK/body.txt")
[ "$(code /health)" = "200" ] \
  || die "/health must stay 200 for a wedged process — it reports the process, not the work"
say "   ${GREEN}/ready 503 while wedged, /health still 200 ✓${NC}"
say "   $WEDGED"

say "== lift the wedge =="
rm -f "$MARKER"
wait_for /ready 200 60 || die "/ready did not recover: $(tail -5 "$WORK/run.log")"
say "   ${GREEN}/ready 200 again ✓${NC}"

say ""
say "${GREEN}HEALTH E2E PASS — /ready tracks whether the daemon is doing its job, /health tracks${NC}"
say "${GREEN}whether it is running, and the heartbeat publishes nothing an operator would not.${NC}"
