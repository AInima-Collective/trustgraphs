#!/usr/bin/env bash
#
# The soak. What "survives a multi-day run" is actually a claim about, held to something.
#
# Not wall-clock. Three production days at a 60-second cadence is 4,320 quiet ticks and zero
# restarts, which is a long time to prove very little. What this harness accumulates instead is
# the things that actually break a daemon: it kills the process every 45 seconds, black-holes the
# RPC for 8 seconds out of every 70, and adds a graph edge every 25 seconds — so restarts, outages
# survived, and crashes inside the ambiguous window pile up in minutes rather than in days.
#
# Ticks do NOT accumulate faster, and it is worth knowing why before reading the count: under that
# abuse a tick costs several seconds rather than one, because every restart re-reads the chain
# from scratch and every black-holed read burns its full `rpc_timeout_seconds`.
#
#   bash tests/e2e/soak.sh                    # ~15 minutes, the default
#   MINUTES=90 bash tests/e2e/soak.sh         # longer, if you want more of everything
#
# What must hold at the end:
#
#   - every checkpoint was requested exactly once (the journal is the money record)
#   - the journal parses, line for line, after every kill
#   - a landing recorded is a landing that is still on chain
#   - the state directory grows with checkpoints, not with ticks
#
# Needs anvil, forge, cast, jq, node and the guest ELFs (SP1_PROVER=mock runs the guest for real).

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

MINUTES="${MINUTES:-15}"
RPC_PORT="${RPC_PORT:-8568}"
PROXY_PORT="${PROXY_PORT:-8569}"
IPFS_PORT="${IPFS_PORT:-8570}"
RPC="http://127.0.0.1:$RPC_PORT"
PROXY="http://127.0.0.1:$PROXY_PORT"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
WORK="${WORK:-/tmp/soak-e2e}"
CONFIG="$WORK/operator.toml"
LOG="$WORK/run.log"
MARKER="$WORK/rpc-down"

# How often the driver does each thing, in seconds.
RESTART_EVERY="${RESTART_EVERY:-45}"
OUTAGE_EVERY="${OUTAGE_EVERY:-70}"
OUTAGE_LENGTH="${OUTAGE_LENGTH:-8}"
ATTEST_EVERY="${ATTEST_EVERY:-25}"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; [ -f "$LOG" ] && tail -12 "$LOG" >&2; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"
cleanup() {
  [ -n "${OP_PID:-}" ]    && kill "$OP_PID"    2>/dev/null
  [ -n "${MINER_PID:-}" ] && kill "$MINER_PID" 2>/dev/null
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null
  [ -n "${KUBO_PID:-}" ]  && kill "$KUBO_PID"  2>/dev/null
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
port_free "${IPFS_PORT}" "the publication stub"

say "== chain on :$RPC_PORT, wedgeable proxy on :$PROXY_PORT =="
anvil --silent --port "$RPC_PORT" & ANVIL_PID=$!
for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not start"
DEPLOYER=$(cast wallet address --private-key "$PK")

PORT="$PROXY_PORT" UPSTREAM="$RPC_PORT" MARKER="$MARKER" \
  node tests/e2e/rpc-blackhole.mjs >"$WORK/proxy.log" 2>&1 & PROXY_PID=$!
for _ in $(seq 1 40); do cast block-number --rpc-url "$PROXY" >/dev/null 2>&1 && break; sleep 0.25; done
cast block-number --rpc-url "$PROXY" >/dev/null 2>&1 || die "the proxy is not forwarding"

PORT="$IPFS_PORT" node tests/e2e/kubo-stub.mjs >"$WORK/kubo.log" 2>&1 & KUBO_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$IPFS_PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$IPFS_PORT/health" >/dev/null \
  || die "the publication stub did not start: $(cat "$WORK/kubo.log")"

say "== deploy EAS + resolver + schema + snapshot =="
forge script contracts/script/DeployEasResolver.s.sol:DeployEasResolver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "DeployEasResolver failed"
EAS=$(jq -r .eas tests/e2e/deploy.json)
RESOLVER=$(jq -r .resolver tests/e2e/deploy.json)
SCHEMA=$(jq -r .schema_uid tests/e2e/deploy.json)
SNAPSHOT=$(jq -r .snapshot tests/e2e/deploy.json)
REGISTRY=$(forge create contracts/src/registry/InstanceRegistry.sol:InstanceRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$DEPLOYER" \
  | jq -r .deployedTo)
forge script contracts/script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$SCHEMA" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "E2eAttest failed"
jq --arg s "$SCHEMA" '.schema_uid = $s' tests/e2e/params.template.json > "$WORK/params.json"

say "== pin a real verifier to the guest vkey =="
VKEY=$( cd zk/prover && SP1_PROVER=mock SP1_SKIP_PROGRAM_BUILD=true cargo run -q --release -- trust-graph vkey )
[ -n "$VKEY" ] || die "could not derive the trust-graph vkey"
GATEWAY=$(forge create contracts/test/mocks/MockSP1Gateway.sol:MockSP1Gateway \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
cast send "$GATEWAY" "setExpectedVKey(bytes32)" "$VKEY" --rpc-url "$RPC" --private-key "$PK" >/dev/null
VERIFIER=$(forge create contracts/src/merkle/SP1JournalVerifier.sol:SP1JournalVerifier \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --constructor-args "$GATEWAY" "$VKEY" | jq -r .deployedTo)
cast send "$SNAPSHOT" "setZkVerifier(address)" "$VERIFIER" --rpc-url "$RPC" --private-key "$PK" >/dev/null

# Deliberately pointed at the PROXY, not the chain: the outages below are what an RPC provider
# actually does under load — accept the connection and never answer — rather than a clean refusal.
cat > "$CONFIG" <<EOF
rpc      = "$PROXY"
registry = "$REGISTRY"

[[manifest]]
program    = "trust-graph"
snapshot   = "$SNAPSHOT"
params     = "$WORK/params.json"
eas        = "$EAS"
from_block = 0

[cadence]
tick_seconds = 1
subsidy_min_blocks = 0

[finality]
confirmations = 1

[signer_sync]
enabled = false

[gas]
max_basefee_gwei = 10000

[prover]
backend = "mock"
groth16 = true
timeout_s = 120

[ipfs]
min_success = 1
retry_seconds = 1
[[ipfs.targets]]
name = "soak-stub"
api = "http://127.0.0.1:$IPFS_PORT"
gateway = "http://127.0.0.1:$IPFS_PORT/ipfs/"

[ops]
state_dir           = "."
log_format          = "json"
ready_after_seconds = 30
EOF

say "== build the daemon =="
# The binary, not `cargo run`: this harness kills the daemon dozens of times, and killing cargo
# would leave the operator it spawned running against the same journal. Two daemons on one journal
# is the one thing the runbook says never to do.
SP1_SKIP_PROGRAM_BUILD=true cargo build -q --release --manifest-path zk/operator/Cargo.toml \
  || die "could not build the operator"
OPERATOR=zk/operator/target/release/operator

start_daemon() {
  SUBMITTER_PRIVATE_KEY="$PK" SP1_SKIP_PROGRAM_BUILD=true \
    "$OPERATOR" --config "$CONFIG" >>"$LOG" 2>&1 &
  OP_PID=$!
}
stop_daemon() {
  [ -n "${OP_PID:-}" ] || return 0
  kill "$OP_PID" 2>/dev/null
  wait "$OP_PID" 2>/dev/null
  OP_PID=""
}

# The journal is the money record. It is checked after EVERY kill rather than once at the end,
# because "it was corrupt at some point in the middle" and "it is fine now" are different
# outcomes and only one of them is acceptable.
check_journal() { # check_journal <where>
  local where="$1" line n=0
  [ -f "$WORK/journal.jsonl" ] || return 0
  while IFS= read -r line; do
    n=$((n + 1))
    [ -z "$line" ] && continue
    printf '%s' "$line" | jq -e . >/dev/null 2>&1 \
      || die "journal line $n is not valid JSON after $where: $line"
  done < "$WORK/journal.jsonl"
}

say "== soak for $MINUTES minute(s) =="
say "   restart every ${RESTART_EVERY}s · ${OUTAGE_LENGTH}s RPC outage every ${OUTAGE_EVERY}s · new edge every ${ATTEST_EVERY}s"
start_daemon
( while true; do cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null 2>&1; sleep 0.5; done ) &
MINER_PID=$!

DEADLINE=$((SECONDS + MINUTES * 60))
NEXT_RESTART=$((SECONDS + RESTART_EVERY))
NEXT_OUTAGE=$((SECONDS + OUTAGE_EVERY))
NEXT_ATTEST=$((SECONDS + ATTEST_EVERY))
RESTARTS=0; OUTAGES=0; EDGES=0; NONCE=0
EMPTY_UID=0x0000000000000000000000000000000000000000000000000000000000000000

while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if [ "$SECONDS" -ge "$NEXT_RESTART" ]; then
    stop_daemon
    check_journal "restart $((RESTARTS + 1))"
    start_daemon
    RESTARTS=$((RESTARTS + 1))
    NEXT_RESTART=$((SECONDS + RESTART_EVERY))
  fi

  if [ "$SECONDS" -ge "$NEXT_OUTAGE" ]; then
    touch "$MARKER"; sleep "$OUTAGE_LENGTH"; rm -f "$MARKER"
    OUTAGES=$((OUTAGES + 1))
    NEXT_OUTAGE=$((SECONDS + OUTAGE_EVERY))
  fi

  if [ "$SECONDS" -ge "$NEXT_ATTEST" ]; then
    # A genuinely new edge each time. Replaying an identical vouch moves the append-only
    # accumulator but reconciles to the same graph, for which an identical root is correct — and
    # a soak that never changes the answer is not exercising anything.
    NONCE=$((NONCE + 1))
    DATA=$(cast abi-encode "f(string,uint256)" "soak edge $NONCE" "$NONCE")
    RECIPIENT=$(cast wallet address --private-key "$(cast keccak "soak-$NONCE")" 2>/dev/null)
    if [ -n "$RECIPIENT" ]; then
      cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' \
        "($SCHEMA,($RECIPIENT,0,true,$EMPTY_UID,$DATA,0))" \
        --rpc-url "$RPC" --private-key "$PK" >/dev/null 2>&1 && EDGES=$((EDGES + 1))
    fi
    NEXT_ATTEST=$((SECONDS + ATTEST_EVERY))
  fi

  sleep 2
done

stop_daemon
kill "$MINER_PID" 2>/dev/null; MINER_PID=""
check_journal "the final stop"

# ---------------------------------------------------------------------------------------------
say ""
say "== what the run produced =="
TICKS=$(grep -c '"event":"tick"' "$LOG" || echo 0)
FAILED_TICKS=$(grep -c '"event":"tick_failed"' "$LOG" || echo 0)
APPLIED=$(cast call "$SNAPSHOT" "lastAppliedCheckpoint()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo 0)
CHECKPOINTS=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
say "   $TICKS ticks ($FAILED_TICKS failed) · $RESTARTS restarts · $OUTAGES RPC outages · $EDGES new edges"
say "   $CHECKPOINTS checkpoint(s) frozen, last applied root = $APPLIED"

[ "$TICKS" -gt 0 ] || die "the daemon never completed a tick"
[ "$RESTARTS" -gt 0 ] || die "the soak never restarted the daemon; it proved nothing about restarts"
[ "$OUTAGES" -gt 0 ] || die "the soak never took the RPC away; it proved nothing about outages"

# --- exactly one request per checkpoint -------------------------------------------------
# The claim the journal exists to support. A restart mid-proof, or an outage between the intent
# and the request, must re-attach — never re-request. Anything else is paying twice.
say ""
say "== no checkpoint was paid for twice =="
DUPES=$(grep '"kind":"intent"' "$WORK/journal.jsonl" \
  | jq -c '.key' | sort | uniq -d)
[ -z "$DUPES" ] || die "these checkpoints were requested more than once:
$DUPES"
INTENTS=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
UNIQUE=$(grep '"kind":"intent"' "$WORK/journal.jsonl" | jq -c '.key' | sort -u | wc -l | tr -d ' ')
say "   ${GREEN}$INTENTS intent(s) over $UNIQUE distinct checkpoint(s) ✓${NC}"
[ "$INTENTS" = "$UNIQUE" ] || die "intents and distinct checkpoints disagree"

# --- a recorded landing is a landing that survived ---------------------------------------
say ""
say "== every recorded landing is on chain =="
LANDED=$(grep -c '"outcome":"landed"' "$WORK/journal.jsonl" || echo 0)
HIGHEST=$(grep '"outcome":"landed"' "$WORK/journal.jsonl" \
  | jq -r '.key.checkpoint_id' | sort -n | tail -1)
if [ -n "$HIGHEST" ]; then
  [ "$HIGHEST" -le "$APPLIED" ] \
    || die "the journal records checkpoint $HIGHEST as landed but the chain's last applied is $APPLIED"
  say "   ${GREEN}$LANDED landing(s), highest = $HIGHEST, chain agrees ✓${NC}"
else
  say "   (nothing landed in this run)"
fi

# --- what a restart-heavy run actually converges to ----------------------------------------
# Killing the daemon during a proof lands inside the ambiguous window: the intent is fsynced
# before the request and the handle is recorded after it returns, so the window is as wide as the
# proving call rather than milliseconds. The daemon then holds `RequestOutcomeUnknown` and waits
# for a human, which is exactly right and also means the instance stops doing new work. A
# restart-heavy soak therefore stalls ITSELF, and saying so is the difference between a soak that
# reports coverage and one that reports wall-clock.
say ""
say "== unresolved requests: the safe stop a restart-heavy run converges to =="
UNRESOLVED=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
RESOLVED=$(grep -c '"kind":"requested"' "$WORK/journal.jsonl" || echo 0)
STUCK=$((UNRESOLVED - RESOLVED))
if [ "$STUCK" -gt 0 ]; then
  say "   $STUCK request(s) ended with an unknown outcome and are waiting on a human."
  say "   ${GREEN}That is the designed stop, not a failure — but it means the instance did no${NC}"
  say "   ${GREEN}further work after it, so read the counts above as a floor. ✓${NC}"
  grep -q 'request_outcome_unknown' "$LOG" \
    || die "an intent has no request record but the daemon never held RequestOutcomeUnknown"
else
  say "   ${GREEN}none: every request this run made resolved one way or the other ✓${NC}"
fi

# --- the journal survived every kill ------------------------------------------------------
say ""
say "== the journal still opens =="
# `--once --dry-run` re-reads the journal end to end and decides against it without spending.
SUBMITTER_PRIVATE_KEY="$PK" SP1_SKIP_PROGRAM_BUILD=true \
  "$OPERATOR" --config "$CONFIG" --once --dry-run >"$WORK/reopen.log" 2>&1 \
  || die "the daemon could not re-open its own journal: $(tail -3 "$WORK/reopen.log")"
say "   ${GREEN}re-opened and re-planned against ✓${NC}"

# --- growth is bounded by work, not by time -----------------------------------------------
say ""
say "== growth is bounded by checkpoints, not by ticks =="
JOURNAL_BYTES=$(wc -c < "$WORK/journal.jsonl" | tr -d ' ')
STATE_BYTES=$(du -sk "$WORK" | cut -f1)
LINES=$(wc -l < "$WORK/journal.jsonl" | tr -d ' ')
say "   journal $JOURNAL_BYTES bytes over $LINES lines · state directory ${STATE_BYTES} KiB · $TICKS ticks"
# Every journal line is caused by a checkpoint reaching a stage, never by a tick. A daemon that
# appended per tick would show thousands of lines here and a journal that outgrows any volume.
[ "$LINES" -lt "$TICKS" ] \
  || die "the journal grew with ticks ($LINES lines for $TICKS ticks), not with work"
if [ "$UNIQUE" -gt 0 ]; then
  PER_CHECKPOINT=$((JOURNAL_BYTES / UNIQUE))
  say "   ${GREEN}~$PER_CHECKPOINT journal bytes per checkpoint ✓${NC}"
fi

say ""
say "${GREEN}SOAK PASS — $TICKS ticks, $RESTARTS restarts and $OUTAGES RPC outages later, the${NC}"
say "${GREEN}journal is still an exact record: one request per checkpoint, no landing it cannot${NC}"
say "${GREEN}point at on chain, and growth that follows the work rather than the clock.${NC}"
