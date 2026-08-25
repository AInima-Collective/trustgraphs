#!/usr/bin/env bash
#
# M2 exit: `operator --once` drives trigger → prove → submit unattended, and a restart re-attaches
# rather than paying again.
#
# This is the acceptance test for the daemon, and it is deliberately separate from `run.sh`: that
# script proves the CLI path a human drives, this one proves nobody has to.
#
#   bash tests/e2e/operator.sh                # both modes, back to back
#   MODE=fallback bash tests/e2e/operator.sh  # `cargo run`, the developer loop
#   MODE=prebuilt bash tests/e2e/operator.sh  # prebuilt binaries, with NO cargo on PATH
#
# The two modes are the packaging goal's M0 exit. `fallback` is what a source checkout has always
# done and must keep doing. `prebuilt` runs the identical script against a config with
# `[ops] tool_dir` set and the Rust toolchain removed from the daemon's PATH, which is the only
# way to hold the "no compiler at runtime" claim to something rather than asserting it.
#
# Needs anvil + the SP1 toolchain (SP1_PROVER=mock runs the guest for real; only the SNARK is a
# stub, exactly as in run.sh).

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

MODE="${MODE:-both}"
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${RED}FATAL:${NC} $*" >&2; exit 1; }

if [ "$MODE" = both ]; then
  for mode in fallback prebuilt; do
    say ""
    say "############################################################"
    say "# tool resolution: $mode"
    say "############################################################"
    MODE="$mode" bash "${BASH_SOURCE[0]}" || die "operator e2e failed in $mode mode"
  done
  say ""
  say "${GREEN}OPERATOR E2E PASS in BOTH modes: from a source checkout, and from prebuilt${NC}"
  say "${GREEN}binaries with no cargo on PATH.${NC}"
  exit 0
fi
[ "$MODE" = fallback ] || [ "$MODE" = prebuilt ] || die "MODE must be fallback, prebuilt or both"

RPC="${RPC:-http://127.0.0.1:8545}"
PK="${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
WORK="${WORK:-/tmp/operator-e2e-$MODE}"
CONFIG="$WORK/operator.toml"

rm -rf "$WORK"; mkdir -p "$WORK"

# --- how the daemon is invoked ------------------------------------------------
# One function, two modes. Everything downstream calls `op <config> <args...>` and never knows
# which one it got.
TOOL_DIR=""
NOCARGO_PATH="$PATH"
if [ "$MODE" = prebuilt ]; then
  say "== build the operator and its tools, then take cargo away =="
  TOOL_DIR="$WORK/bin"
  mkdir -p "$TOOL_DIR"
  SP1_SKIP_PROGRAM_BUILD=true cargo build -q --release --manifest-path zk/operator/Cargo.toml \
    || die "could not build the operator"
  cargo build -q --release -p input-exporter --bins || die "could not build the tool binaries"
  cp zk/operator/target/release/operator "$TOOL_DIR/" || die "no operator binary to copy"
  cp target/release/input-exporter target/release/envelope0-preflight "$TOOL_DIR/" \
    || die "no tool binaries to copy"

  # Drop every PATH entry that holds a cargo. A daemon that silently shells out to a compiler
  # would otherwise pass this test on a developer's box and fail in the image.
  CARGO_DIR=$(dirname "$(command -v cargo)")
  NOCARGO_PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$CARGO_DIR" | paste -sd: -)
  if PATH="$NOCARGO_PATH" command -v cargo >/dev/null 2>&1; then
    die "cargo is still on PATH after stripping $CARGO_DIR; the no-compiler claim is untested"
  fi
  say "   tools=$TOOL_DIR   cargo removed from PATH ($CARGO_DIR)"
fi

op() {
  local cfg="$1"; shift
  if [ "$MODE" = prebuilt ]; then
    env PATH="$NOCARGO_PATH" "$TOOL_DIR/operator" --config "$cfg" "$@"
  else
    cargo run -q --release --manifest-path zk/operator/Cargo.toml -- --config "$cfg" "$@"
  fi
}

# --- chain -------------------------------------------------------------------
PORT=$(printf '%s' "$RPC" | sed -nE 's#^https?://[^/:]+:([0-9]+).*#\1#p')
PORT="${PORT:-8545}"
if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  # Honour the port $RPC names. Without this the script starts anvil on 8545 no matter what was
  # asked for, which is how a test run lands its contracts on somebody else's running stack.
  say "== starting anvil on port $PORT =="
  anvil --silent --port "$PORT" &
  ANVIL_PID=$!
  for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
fi
trap '[ -n "${KUBO_PID:-}" ] && kill "$KUBO_PID" 2>/dev/null; [ -n "${REPAIR_KUBO_PID:-}" ] && kill "$REPAIR_KUBO_PID" 2>/dev/null; [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null' EXIT
cast block-number --rpc-url "$RPC" >/dev/null || die "no chain at $RPC"
DEPLOYER=$(cast wallet address --private-key "$PK")

# --- an instance the operator can find ----------------------------------------
say "== deploy EAS + resolver + schema + snapshot =="
forge script contracts/script/DeployEasResolver.s.sol:DeployEasResolver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "DeployEasResolver failed"
EAS=$(jq -r .eas tests/e2e/deploy.json)
RESOLVER=$(jq -r .resolver tests/e2e/deploy.json)
SCHEMA=$(jq -r .schema_uid tests/e2e/deploy.json)
SNAPSHOT=$(jq -r .snapshot tests/e2e/deploy.json)
say "   snapshot=$SNAPSHOT resolver=$RESOLVER"

# An empty registry: the daemon enumerates it every tick, and a manifest instance must be found
# alongside whatever the chain describes (here, nothing).
REGISTRY=$(forge create contracts/src/registry/InstanceRegistry.sol:InstanceRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$DEPLOYER" \
  | jq -r .deployedTo)
say "   registry=$REGISTRY (empty)"

say "== attest a ring so the graph is non-empty =="
forge script contracts/script/E2eAttest.s.sol:E2eAttest --sig "run(address,bytes32)" "$EAS" "$SCHEMA" \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --skip-simulation >/dev/null 2>&1 \
  || die "E2eAttest failed"
LEAVES=$(cast call "$RESOLVER" "leafCount()(uint64)" --rpc-url "$RPC")
say "   leafCount=$LEAVES"

jq --arg s "$SCHEMA" '.schema_uid = $s' tests/e2e/params.template.json > "$WORK/params.json"

# A REAL SP1JournalVerifier pinned to this binary's guest vkey. The deploy script installs an
# accept-all verifier so the off-chain half of run.sh can work without one; the daemon refuses to
# prove against a verifier it cannot satisfy, which is the behaviour we want and which means the
# test has to give it a real one. (The SNARK itself is still stubbed at the gateway seam, exactly
# as in run.sh — SP1_PROVER=mock.)
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
say "   vkey=$VKEY verifier=$VERIFIER"

PIN_PORT=15000
PIN_GATEWAY="http://127.0.0.1:$PIN_PORT/ipfs/"
PORT="$PIN_PORT" node tests/e2e/kubo-stub.mjs &
KUBO_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PIN_PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PIN_PORT/health" >/dev/null || die "kubo stub did not start"

cat > "$CONFIG" <<EOF
rpc      = "$RPC"
registry = "$REGISTRY"

[[manifest]]
program    = "trust-graph"
snapshot   = "$SNAPSHOT"
params     = "$WORK/params.json"
eas        = "$EAS"
from_block = 0

[curated]
instances = []

[cadence]
tick_seconds = 1
subsidy_min_blocks = 0

[finality]
confirmations = 0

[gas]
max_basefee_gwei = 10000

[prover]
backend = "mock"
groth16 = true

[ipfs]
min_success = 1
retry_seconds = 1
[[ipfs.targets]]
name = "primary-stub"
api = "http://127.0.0.1:$PIN_PORT"
gateway = "$PIN_GATEWAY"

# Everything the daemon owns goes beside this config file: journal, heartbeat, per-checkpoint
# working files, both caches. Two runs of this script in different modes therefore cannot see
# each other's held proofs, and neither can a demo running out of the same checkout.
[ops]
state_dir  = "."
log_format = "json"
EOF
[ -n "$TOOL_DIR" ] && echo "tool_dir     = \"$TOOL_DIR\"" >> "$CONFIG"

export SUBMITTER_PRIVATE_KEY="$PK"
export SP1_SKIP_PROGRAM_BUILD=true

# --- dry run: decide, report, spend nothing ------------------------------------
say ""
say "== tick 1: --dry-run decides but must not send =="
BEFORE=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
op "$CONFIG" --once --dry-run 2>&1 | tee "$WORK/tick-dry.log" | grep -E '"event"' | head -5
AFTER=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
[ "$BEFORE" = "$AFTER" ] || die "--dry-run minted a checkpoint ($BEFORE -> $AFTER)"
grep -q '"action":"trigger"' "$WORK/tick-dry.log" || die "expected a Trigger decision, got: $(cat "$WORK/tick-dry.log")"
say "   ${GREEN}decided Trigger, sent nothing ✓${NC}"

# --- the real loop --------------------------------------------------------------
for i in 1 2 3; do
  say ""
  say "== tick $i =="
  op "$CONFIG" --once 2>&1 | tee "$WORK/tick-$i.log" | grep -E '"event":"(decision|triggered|proved|submitted|instance_skipped)"' | head -5
done

# --- what must be true ------------------------------------------------------------
CPS=$(cast call "$RESOLVER" "checkpointCount()(uint256)" --rpc-url "$RPC")
[ "$CPS" -ge 1 ] || die "the daemon never froze a checkpoint"
APPLIED=$(cast call "$SNAPSHOT" "hasAppliedCheckpoint()(bool)" --rpc-url "$RPC")
[ "$APPLIED" = "true" ] || die "the daemon never landed a root"
ROOT=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" \
  --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
say ""
say "   ${GREEN}root landed unattended: $ROOT ✓${NC}"

# --- the landed CID is readable, and can be reconstructed onto another target ----------------
STATE=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" \
  --rpc-url "$RPC")
CID=$(printf '%s\n' "$STATE" | grep -o 'baf[a-z0-9]*' | head -1)
[ -n "$CID" ] || die "could not read the landed CID from getLatestState: $STATE"
curl -fsS "$PIN_GATEWAY$CID" >/dev/null || die "the daemon submitted before its CID was readable"
INSTANCE_ID=$(jq -r '.instances[0].instance_id' "$WORK/status.json")
REPAIR_PORT=15001
REPAIR_GATEWAY="http://127.0.0.1:$REPAIR_PORT/ipfs/"
if curl -fsS "$REPAIR_GATEWAY$CID" >/dev/null 2>&1; then
  die "repair precondition failed: landed CID was already readable"
fi
say "== landed CID is readable; reconstruct and republish onto a fresh target =="
EXPECTED_CID="$CID" PORT="$REPAIR_PORT" node tests/e2e/kubo-stub.mjs &
REPAIR_KUBO_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$REPAIR_PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$REPAIR_PORT/health" >/dev/null \
  || die "repair kubo stub did not start"
REPAIR_CONFIG="$WORK/operator-repair.toml"
sed -e 's/name = "primary-stub"/name = "repair-stub"/' \
    -e "s|api = \"http://127.0.0.1:$PIN_PORT\"|api = \"http://127.0.0.1:$REPAIR_PORT\"|" \
    -e "s|gateway = \"$PIN_GATEWAY\"|gateway = \"$REPAIR_GATEWAY\"|" \
    "$CONFIG" > "$REPAIR_CONFIG"
op "$REPAIR_CONFIG" republish --instance "$INSTANCE_ID" --checkpoint 0 \
  >"$WORK/republish.log" 2>&1 \
  || die "republish failed: $(cat "$WORK/republish.log")"
curl -fsS "$REPAIR_GATEWAY$CID" >/dev/null || die "CID remained unreadable after republish"
pnpm --dir packages/indexer exec tsx scripts/check-merkle-ingest.ts \
  --gateway "$REPAIR_GATEWAY" --cid "$CID" --root "$ROOT" \
  >"$WORK/indexer-ingest.log" \
  || die "indexer could not ingest repaired CID: $(cat "$WORK/indexer-ingest.log")"
say "   ${GREEN}repaired CID is readable and indexer-derived entries match $ROOT ✓${NC}"

# One checkpoint, one intent, one request, one settlement. Anything else means it paid twice.
INTENTS=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
SETTLED=$(grep -c '"kind":"settled"' "$WORK/journal.jsonl" || true)
SETTLED=${SETTLED:-0}
say "   journal: $INTENTS intent(s), $SETTLED settlement(s)"
[ "$INTENTS" = "1" ] || die "expected exactly 1 intent, got $INTENTS — the daemon paid more than once"

# --- restart must re-attach, not re-pay -------------------------------------------
say ""
say "== restart on a settled checkpoint: must not request again =="
op "$CONFIG" --once 2>&1 | tee "$WORK/tick-restart.log" >/dev/null
INTENTS2=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
[ "$INTENTS2" = "$INTENTS" ] || die "a restart re-requested a settled checkpoint ($INTENTS -> $INTENTS2)"
say "   ${GREEN}re-attached, no second request ✓${NC}"

# --- a restored journal re-attaches on a box with nothing else on it ----------------
# The runbook's recovery table says a lost journal means re-requesting proofs already paid for,
# which makes "take a copy, put it on a fresh box, keep going" the one recovery drill that has to
# actually work. A FRESH state directory holds the restored journal and nothing else: no held
# proof, no reconstructed input, no cached manifest.
say ""
say "== restore a journal backup onto a fresh state directory =="
BACKUP="$WORK/journal.backup.jsonl"
cp "$WORK/journal.jsonl" "$BACKUP"
FRESH="$WORK/restored"
rm -rf "$FRESH"; mkdir -p "$FRESH"
cp "$CONFIG" "$FRESH/operator.toml"
cp "$BACKUP" "$FRESH/journal.jsonl"
[ -f "$FRESH/held.json" ] && die "the fresh state directory was supposed to hold only the journal"
op "$FRESH/operator.toml" --once 2>&1 | tee "$WORK/tick-restored.log" >/dev/null
RESTORED_INTENTS=$(grep -c '"kind":"intent"' "$FRESH/journal.jsonl" || echo 0)
[ "$RESTORED_INTENTS" = "$INTENTS" ] \
  || die "a restored journal re-requested work it had already paid for ($INTENTS -> $RESTORED_INTENTS)"
grep -q '"event":"tick"' "$WORK/tick-restored.log" \
  || die "the daemon did not complete a tick against the restored journal"
say "   ${GREEN}restored journal re-attached; no second request ✓${NC}"

# --- quiet is free -----------------------------------------------------------------
grep -q '"idle":"quiet"' "$WORK/tick-restart.log" \
  || say "   (note: not idle-quiet yet; state was $(grep -o '"action":"[a-z]*"' "$WORK/tick-restart.log" | head -1))"

# --- later inputs produce a later root ------------------------------------------------
# This is the live-demo promise: the daemon must not only bootstrap an instance. Inputs folded
# after checkpoint 0 landed have to wake the same scheduler, mint checkpoint 1, and land a root
# over the enlarged graph without a config rewrite or a human-driven proof step.
say ""
say "== attest after the first root: scheduler must prove the new graph =="
LEAVES_BEFORE=$(cast call "$RESOLVER" "leafCount()(uint64)" --rpc-url "$RPC")
# Add a genuinely new edge rather than replaying the original ring. Replaying identical vouches
# moves the append-only accumulator but reconciles to the same logical graph, for which an
# identical output root is correct.
LATER_RECIPIENT=0x90F79bf6EB2c4f870365E785982E1f101E93b906
LATER_DATA=$(cast abi-encode "f(string,uint256)" "later edge" 88)
EMPTY_UID=0x0000000000000000000000000000000000000000000000000000000000000000
LATER_REQ="($SCHEMA,($LATER_RECIPIENT,0,true,$EMPTY_UID,$LATER_DATA,0))"
cast send "$EAS" 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))' "$LATER_REQ" \
  --rpc-url "$RPC" --private-key "$PK" >/dev/null \
  || die "later attestation failed"
LEAVES_AFTER=$(cast call "$RESOLVER" "leafCount()(uint64)" --rpc-url "$RPC")
[ "$LEAVES_AFTER" -gt "$LEAVES_BEFORE" ] \
  || die "new attestations did not move the accumulator ($LEAVES_BEFORE -> $LEAVES_AFTER)"

for i in 1 2 3; do
  say "   later-root tick $i"
  op "$CONFIG" --once 2>&1 | tee "$WORK/tick-later-$i.log" \
    | grep -E '"event":"(decision|triggered|proved|submitted|instance_skipped)"' | head -5
done

APPLIED_ID=$(cast call "$SNAPSHOT" "lastAppliedCheckpoint()(uint256)" --rpc-url "$RPC")
[ "$APPLIED_ID" -ge 1 ] || die "the daemon did not apply a later checkpoint (last=$APPLIED_ID)"
ROOT2=$(cast call "$SNAPSHOT" "getLatestState()((uint256,uint256,bytes32,bytes32,string,uint256))" \
  --rpc-url "$RPC" | grep -o '0x[0-9a-f]\{64\}' | head -1)
[ "$ROOT2" != "$ROOT" ] || die "the enlarged graph produced the original root again ($ROOT2)"
INTENTS3=$(grep -c '"kind":"intent"' "$WORK/journal.jsonl" || echo 0)
[ "$INTENTS3" = "2" ] \
  || die "expected one proof request per changed graph (2 total), got $INTENTS3"
say "   ${GREEN}new inputs landed as checkpoint $APPLIED_ID with root $ROOT2 ✓${NC}"

# --- the heartbeat -------------------------------------------------------------------
jq -e '.instances | length >= 1' "$WORK/status.json" >/dev/null || die "status.json has no instances"
say "   status.json: $(jq -c '{head_block, instances: [.instances[] | {name, action: .action.action}]}' "$WORK/status.json")"

# --- the tool resolution the daemon actually used --------------------------------------
# `tools` is logged once at startup. In prebuilt mode every reconstruction must have resolved to
# a file under tool_dir; a line naming `cargo` here means the compiler was still doing the work
# and the mode proved nothing.
TOOLS=$(grep -h '"event":"tools"' "$WORK"/tick-1.log | tail -1)
[ -n "$TOOLS" ] || die "the daemon never reported how it resolved its tools"
if [ "$MODE" = prebuilt ]; then
  printf '%s' "$TOOLS" | jq -e --arg d "$TOOL_DIR" '."input-exporter" | startswith($d)' >/dev/null \
    || die "input-exporter did not resolve to $TOOL_DIR: $TOOLS"
  printf '%s' "$TOOLS" | grep -q 'cargo' \
    && die "a tool still resolves to cargo in prebuilt mode: $TOOLS"
  say "   ${GREEN}every reconstruction ran a prebuilt binary; no compiler was on PATH ✓${NC}"
else
  printf '%s' "$TOOLS" | jq -e '."input-exporter" | contains("cargo run")' >/dev/null \
    || die "the source-checkout fallback did not resolve to cargo: $TOOLS"
  say "   ${GREEN}the source-checkout fallback still works unchanged ✓${NC}"
fi

say ""
say "${GREEN}OPERATOR E2E PASS ($MODE) — trigger, prove and submit two graph versions${NC}"
say "${GREEN}unattended; repair an unreadable landed CID; and restart without paying again.${NC}"
