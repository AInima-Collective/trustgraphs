#!/usr/bin/env bash
#
# A real reorg, against a running daemon.
#
# The runbook's §7 said this was covered by "a synthetic unit test on the block-hash check only".
# That is a test of the arithmetic, not of the daemon: the anchor memory that makes the check able
# to fire at all (`seen_anchors`) is per-RUN state, so a reorg is only detectable by a process that
# was already running when the chain changed under it. A `--once` tick can never notice one.
#
# Two things have to hold, and they are different code paths:
#
#   A. A checkpoint the daemon already decided to spend on is replaced by a reorg. It must NOT
#      prove against the vanished block — it must drop the checkpoint, re-anchor, and recover.
#   B. A submit that already landed is reorged out. It must NOT journal `Settled{Landed}`; it must
#      notice, alert, and resubmit the proof it is still holding. Journaling a landing that did not
#      survive is how a journal stops being a record of what happened.
#
#   bash tests/e2e/reorg.sh
#
# Needs anvil, forge, cast, jq and the guest ELFs (SP1_PROVER=mock runs the guest for real).

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RPC_PORT="${RPC_PORT:-8566}"
RPC="http://127.0.0.1:$RPC_PORT"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
HEALTH_PORT="${HEALTH_PORT:-8567}"
WORK="${WORK:-/tmp/reorg-e2e}"
CONFIG="$WORK/operator.toml"
LOG="$WORK/run.log"
CONFIRMATIONS=3

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; dump; exit 1; }
dump() {
  # The daemon's own answer to "what are you doing?", which a silent log cannot give.
  echo "--- /ready: $(curl -s --max-time 5 "http://127.0.0.1:$HEALTH_PORT/ready" 2>&1) ---" >&2
  echo "--- head=$(head_block 2>&1) checkpoints=$(cast call "${RESOLVER:-0x0}" 'checkpointCount()(uint256)' --rpc-url "$RPC" 2>&1) ---" >&2
  echo "--- submitter nonce=$(cast nonce "${DEPLOYER:-0x0}" --rpc-url "$RPC" 2>&1) ---" >&2
  [ -f "$LOG" ] && { echo "--- last 8 log lines ---" >&2; tail -8 "$LOG" >&2; }
  return 0
}

rm -rf "$WORK"; mkdir -p "$WORK"
cleanup() {
  [ -n "${MINER_PID:-}" ] && kill "$MINER_PID" 2>/dev/null
  [ -n "${OP_PID:-}" ]    && kill "$OP_PID"    2>/dev/null
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
port_free "${HEALTH_PORT}" "the health listener"

rpc()      { cast rpc --rpc-url "$RPC" "$@" 2>/dev/null; }
snapshot() { rpc evm_snapshot | tr -d '"'; }
revert()   { rpc evm_revert "$1" | tr -d '"'; }
mine()     { rpc anvil_mine "${1:-1}" >/dev/null; }
head_block() { cast block-number --rpc-url "$RPC"; }

# Waits are generous on purpose. A tick is not cheap here: the daemon re-derives every guest
# vkey on every pass, which is tens of seconds of CPU, so a sequence of five decisions is minutes
# of wall clock rather than seconds. A tight timeout in this script reads as "the daemon hung"
# and means "the box was busy".
await_log() { # await_log <pattern> <seconds>
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -q "$1" "$LOG" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

await_for_second() { # await_for_second <pattern> <seconds> — wait for a SECOND occurrence
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(grep -c "$1" "$LOG" 2>/dev/null || echo 0)" -ge 2 ] && return 0
    sleep 1
  done
  return 1
}

say "== chain on :$RPC_PORT =="
anvil --silent --port "$RPC_PORT" & ANVIL_PID=$!
for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not start"
DEPLOYER=$(cast wallet address --private-key "$PK")

say "== deploy EAS + resolver + schema + snapshot =="
RPC_URL="$RPC" forge script contracts/script/DeployEasResolver.s.sol:DeployEasResolver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "DeployEasResolver failed"
EAS=$(jq -r .eas tests/e2e/deploy.json)
RESOLVER=$(jq -r .resolver tests/e2e/deploy.json)
SCHEMA=$(jq -r .schema_uid tests/e2e/deploy.json)
SNAPSHOT=$(jq -r .snapshot tests/e2e/deploy.json)
REGISTRY=$(forge create contracts/src/registry/InstanceRegistry.sol:InstanceRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$DEPLOYER" \
  | jq -r .deployedTo)
say "   snapshot=$SNAPSHOT registry=$REGISTRY (empty)"

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

cat > "$CONFIG" <<EOF
rpc      = "$RPC"
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

# The whole point. With confirmations = 0 a submit is journaled the instant it lands and there is
# no window in which a reorg could be noticed at all.
[finality]
confirmations    = $CONFIRMATIONS
track_block_hash = true

[signer_sync]
enabled = false

[gas]
max_basefee_gwei = 10000

[prover]
backend = "mock"
groth16 = true

[ops]
state_dir  = "."
log_format = "json"
# So a stuck test can ask the daemon what it is doing rather than guessing from a silent log.
listen              = "127.0.0.1:$HEALTH_PORT"
ready_after_seconds = 30
EOF

say "== a snapshot of the chain BEFORE anything was proven =="
BEFORE_TRIGGER=$(snapshot)
[ -n "$BEFORE_TRIGGER" ] || die "anvil would not take a snapshot"
say "   snapshot=$BEFORE_TRIGGER at block $(head_block)"

# One long-running daemon, for the whole test. `seen_anchors` is per-run memory: restarting between
# steps would re-observe the new chain as if it had always been that way, and the detector could
# never fire. This is the difference between testing the daemon and testing the arithmetic.
#
# The BINARY, not `cargo run`: killing cargo leaves the operator it spawned running, and a stray
# daemon that reconnects to the next run's chain and writes into the same log makes a test that
# fails for reasons nobody can read.
say "== build the daemon and its tools =="
SP1_SKIP_PROGRAM_BUILD=true cargo build -q --release --manifest-path zk/operator/Cargo.toml \
  || die "could not build the operator"
cargo build -q --release -p input-exporter --bins || die "could not build the tool binaries"
mkdir -p "$WORK/bin"
cp zk/operator/target/release/operator "$WORK/bin/"
cp target/release/input-exporter target/release/envelope0-preflight "$WORK/bin/"
OPERATOR="$WORK/bin/operator"
echo "tool_dir = \"$WORK/bin\"" >> "$CONFIG"

say "== start the daemon (one process, for the whole test) =="
SUBMITTER_PRIVATE_KEY="$PK" SP1_SKIP_PROGRAM_BUILD=true \
  "$OPERATOR" --config "$CONFIG" >"$LOG" 2>&1 &
OP_PID=$!

# Deliberately NOT mining yet. anvil mines only on transactions, so the head sits at the trigger
# block and the daemon has to wait out its confirmations — which is the window this test needs. A
# background miner here would carry it past finality before the reorg could be staged.
mining() {
  ( while kill -0 "$OP_PID" 2>/dev/null; do
      cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null 2>&1; sleep 0.5
    done ) &
  MINER_PID=$!
}

await_log '"event":"triggered"' 600 || die "the daemon never froze a checkpoint"
TRIGGER_BLOCK=$(grep '"event":"triggered"' "$LOG" | head -1 | jq -r .block)
say "   checkpoint 0 frozen at block $TRIGGER_BLOCK"

# The daemon must have OBSERVED the checkpoint before the reorg, or there is no prior observation
# for the detector to compare against. Awaiting finality is that observation.
await_log '"action":"await_finality"' 300 || die "the daemon never anchored the checkpoint"
say "   anchored; the daemon is counting confirmations"

# ---------------------------------------------------------------------------------------------
say ""
say "== A. reorg away the checkpoint the daemon is counting on =="
[ "$(revert "$BEFORE_TRIGGER")" = "true" ] || die "evm_revert refused"
mine 6

# An anvil artefact, not a daemon one, and it will silently eat this test if left alone. The
# daemon's next trigger is byte-identical to the one the revert undid — same nonce, same calldata,
# same signature, so the same hash — and anvil still has that hash and declines to mine it again.
# A real chain re-broadcasts and re-mines it. Moving the submitter's nonce by one is what makes
# the re-trigger a NEW transaction, so the test measures the reorg rather than anvil's tx cache.
cast send --rpc-url "$RPC" --private-key "$PK" --value 1wei "$DEPLOYER" >/dev/null 2>&1 \
  || die "could not move the submitter nonce past the reverted trigger"
say "   reverted to block $(head_block); checkpointCount=$(cast call "$RESOLVER" 'checkpointCount()(uint256)' --rpc-url "$RPC")"

# What must NOT happen: proving against a block that no longer exists. The daemon re-triggers, and
# the first tick that sees checkpoint 0 back at a DIFFERENT block must refuse to treat it as the
# one it anchored — an equal-depth reorg leaves the number intact and swaps the contents, which is
# exactly the case a confirmations-only check calls final.
await_for_second '"event":"triggered"' 900 \
  || die "the daemon did not re-freeze a checkpoint after the reorg"
RETRIGGERS=$(grep -c '"event":"triggered"' "$LOG")
[ "$RETRIGGERS" -ge 2 ] || die "expected a second trigger after the reorg, saw $RETRIGGERS"
say "   ${GREEN}re-triggered on the canonical chain ✓${NC}"

# The stale anchor must be refused for at least one tick. Checkpoint 0 now exists again, at a
# different block, and a daemon that trusted its own prior observation would prove against a block
# that is no longer on the chain. The refusal happens on the tick that OBSERVES the new checkpoint,
# which is the one after the trigger that minted it — so this waits rather than looking immediately.
await_log 'unpinned_checkpoint' 300 \
  || die "checkpoint 0 came back at a new block and the daemon never noticed the anchor moved"
say "   ${GREEN}the stale anchor was refused before anything could be proven against it ✓${NC}"

# From here the chain has to advance on its own for confirmations to accrue.
mining

# ---------------------------------------------------------------------------------------------
say ""
say "== B. reorg away a submit that already landed =="
# Snapshot during proving: mock proving takes long enough that this is comfortably before the
# submit block, and reverting to it puts the chain back to a state where the submit never happened.
await_log '"action":"prove"' 900 || die "the daemon never decided to prove"
BEFORE_SUBMIT=$(snapshot)
[ -n "$BEFORE_SUBMIT" ] || die "anvil would not take the pre-submit snapshot"
say "   snapshot=$BEFORE_SUBMIT at block $(head_block), taken while the proof is being produced"

await_log '"event":"submitted"' 900 || die "the daemon never submitted"
SUBMIT_BLOCK=$(grep '"event":"submitted"' "$LOG" | head -1 | jq -r .block)
say "   submitted at block $SUBMIT_BLOCK; the journal is NOT yet settled ($CONFIRMATIONS confirmations required)"

kill "$MINER_PID" 2>/dev/null; wait "$MINER_PID" 2>/dev/null
[ "$(revert "$BEFORE_SUBMIT")" = "true" ] || die "evm_revert of the submit refused"
mine $((CONFIRMATIONS + 3))
APPLIED_AFTER_REORG=$(cast call "$SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
say "   reverted to block $(head_block); hasAppliedCheckpoint=$APPLIED_AFTER_REORG"
[ "$APPLIED_AFTER_REORG" = "false" ] || die "the revert did not actually undo the submit"
( while kill -0 "$OP_PID" 2>/dev/null; do cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null 2>&1; sleep 0.5; done ) &
MINER_PID=$!

await_log '"event":"submit_reorged"' 600 \
  || die "the daemon did not notice that its submit was reorged out"
say "   ${GREEN}noticed and alerted ✓${NC}"

# The proof is still held, so recovery must be a resubmit and NOT a second proof request. A journal
# that records a landing which did not survive, or that pays twice for one checkpoint, is the
# failure this whole mechanism exists to prevent.
await_log '"event":"submit_confirmed"' 900 || die "the daemon never re-landed the root after the reorg"
APPLIED=$(cast call "$SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
[ "$APPLIED" = "true" ] || die "no root on chain after the resubmit"

INTENTS=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
LANDED=$(grep -c '"outcome":"landed"' "$WORK/journal.jsonl" || echo 0)
say "   journal: $INTENTS intent(s), $LANDED landing(s)"
[ "$INTENTS" -le 2 ] \
  || die "the daemon requested $INTENTS proofs across one reorg; it should reuse the held proof"
[ "$LANDED" = "1" ] \
  || die "expected exactly one journaled landing, got $LANDED — a reorged submit was recorded as final"

say ""
say "${GREEN}REORG E2E PASS — a checkpoint reorged out from under the daemon is not proven${NC}"
say "${GREEN}against, and a submit reorged out is noticed, alerted, and resubmitted from the${NC}"
say "${GREEN}proof already in hand rather than paid for twice.${NC}"
